/**
 * Payload parsing for the `backfill_filelists` pg_notify request.
 *
 * The original payload shape was `{limit, archiveType}` — both optional, both
 * defaulted. That made the *unbounded* sweep the easiest thing to trigger:
 * `SELECT pg_notify('backfill_filelists', '{}')` selected every Package with
 * `fileCount = 0` of every archive type, oldest first, and started downloading.
 * On a real catalogue that is multiple terabytes of traffic aimed at packages
 * nobody asked to repair.
 *
 * So the rule here is: **a request must name what it wants**. A payload with no
 * selector is rejected outright, and the broad "every empty package of type X"
 * sweep has to opt in explicitly via `allowBroadSweep`. Omitting a field can
 * only ever narrow the job or fail it — never widen it.
 */

export type BackfillArchiveType = "ZIP" | "RAR" | "SEVEN_Z";

const ARCHIVE_TYPES: BackfillArchiveType[] = ["ZIP", "RAR", "SEVEN_Z"];

/** Hard ceiling on `limit`, so even a deliberate broad sweep stays bounded. */
export const MAX_BACKFILL_LIMIT = 2000;
/** Hard ceiling on an explicit id list — keeps the SQL `IN (...)` sane. */
export const MAX_BACKFILL_PACKAGE_IDS = 2000;
export const DEFAULT_BACKFILL_LIMIT = 200;

/** Minimum literal characters in a `fileNameLike` pattern, so `%` can't stand alone. */
const MIN_FILENAME_LITERAL = 3;

/** Prisma-shaped filename filter — a closed set of forms, never raw SQL. */
export type FileNameFilter =
  | { equals: string }
  | { startsWith: string }
  | { endsWith: string }
  | { contains: string };

export interface BackfillSelector {
  /** Explicit package ids: the most tightly bounded selector there is. */
  packageIds?: string[];
  fileName?: FileNameFilter;
  archiveType?: BackfillArchiveType;
}

export interface BackfillPlan {
  selector: BackfillSelector;
  limit: number;
  /**
   * Never fall back to a full `downloadFile` of the archive, even when the
   * cheap ranged read fails. Set this for repairs where the full-download cost
   * would be absurd (a spanned set's listing lives in ~64KB of its final
   * volume; downloading the set to reach it can be hundreds of gigabytes).
   */
  rangedOnly: boolean;
  /**
   * Allow one scan of the destination channel to recover `destMessageIds` for
   * candidates that have none. Opt-in because the scan itself costs a few
   * hundred paginated `searchChatMessages` calls.
   */
  recoverDestIds: boolean;
  /** Compact description of the scope, for the batch log line. */
  describe: string;
}

export type ParsedBackfillPayload =
  | { ok: true; plan: BackfillPlan }
  | { ok: false; error: string };

/**
 * Translate a restricted LIKE pattern into a Prisma filter.
 *
 * Only leading and/or trailing `%` are accepted — an interior `%`, a `_`
 * wildcard, or a pattern with too little literal text is rejected rather than
 * quietly matching far more than the caller meant.
 */
export function parseFileNameLike(pattern: string): FileNameFilter | { error: string } {
  if (typeof pattern !== "string") return { error: "fileNameLike must be a string" };
  const raw = pattern.trim();
  if (raw.length === 0) return { error: "fileNameLike must not be empty" };

  const leading = raw.startsWith("%");
  const trailing = raw.endsWith("%");
  const literal = raw.slice(leading ? 1 : 0, trailing && raw.length > 1 ? -1 : undefined);

  if (literal.includes("%")) {
    return { error: "fileNameLike supports a leading and/or trailing % only (no interior wildcard)" };
  }
  if (literal.includes("_")) {
    return { error: "fileNameLike does not support the _ wildcard — use % or a literal name" };
  }
  if (literal.length < MIN_FILENAME_LITERAL) {
    return {
      error: `fileNameLike needs at least ${MIN_FILENAME_LITERAL} literal characters (got "${literal}")`,
    };
  }

  if (leading && trailing) return { contains: literal };
  if (leading) return { endsWith: literal };
  if (trailing) return { startsWith: literal };
  return { equals: literal };
}

function parsePackageIds(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value)) return { error: "packageIds must be an array of package ids" };
  if (value.length === 0) return { error: "packageIds must not be empty" };
  if (value.length > MAX_BACKFILL_PACKAGE_IDS) {
    return { error: `packageIds holds ${value.length} ids — the maximum is ${MAX_BACKFILL_PACKAGE_IDS}` };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return { error: "packageIds must contain only strings" };
    const id = entry.trim();
    // cuid()s are alphanumeric; the character class also rules out anything
    // that could confuse a log line or a hand-written SQL check.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return { error: `packageIds contains an id that is not a valid identifier: "${entry}"` };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function describeSelector(selector: BackfillSelector, plan: Pick<BackfillPlan, "limit" | "rangedOnly" | "recoverDestIds">): string {
  const bits: string[] = [];
  if (selector.packageIds) bits.push(`packageIds=${selector.packageIds.length}`);
  if (selector.fileName) {
    const [key, value] = Object.entries(selector.fileName)[0];
    bits.push(`fileName.${key}=${JSON.stringify(value)}`);
  }
  bits.push(`archiveType=${selector.archiveType ?? "ZIP|RAR|SEVEN_Z"}`);
  bits.push(`limit=${plan.limit}`);
  if (plan.rangedOnly) bits.push("rangedOnly");
  if (plan.recoverDestIds) bits.push("recoverDestIds");
  return bits.join(" ");
}

/**
 * Parse and validate a `backfill_filelists` payload.
 *
 * Accepted fields (all optional except that *some* selector is required):
 *   packageIds      string[]  — repair exactly these packages
 *   fileNameLike    string    — restricted LIKE: "%.z01", "Pack%", "%dragon%"
 *   archiveType     ZIP|RAR|SEVEN_Z
 *   limit           number    — 1..MAX_BACKFILL_LIMIT, default DEFAULT_BACKFILL_LIMIT
 *   rangedOnly      boolean   — refuse the full-download fallback
 *   recoverDestIds  boolean   — allow one destination-channel scan to recover ids
 *   allowBroadSweep boolean   — required to run with no narrowing selector
 */
export function parseBackfillPayload(payloadJson: string): ParsedBackfillPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson === "" ? "{}" : payloadJson);
  } catch {
    return { ok: false, error: "payload is not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const raw = parsed as Record<string, unknown>;

  const known = new Set([
    "packageIds",
    "fileNameLike",
    "archiveType",
    "limit",
    "rangedOnly",
    "recoverDestIds",
    "allowBroadSweep",
  ]);
  const unknownKeys = Object.keys(raw).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    // Fail rather than ignore: a typo'd `packageIDs` would otherwise silently
    // become "no selector" and — worse, if allowBroadSweep were also set —
    // a full sweep.
    return { ok: false, error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  let limit = DEFAULT_BACKFILL_LIMIT;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    if (raw.limit > MAX_BACKFILL_LIMIT) {
      return { ok: false, error: `limit ${raw.limit} exceeds the maximum of ${MAX_BACKFILL_LIMIT}` };
    }
    limit = raw.limit;
  }

  for (const flag of ["rangedOnly", "recoverDestIds", "allowBroadSweep"] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") {
      return { ok: false, error: `${flag} must be a boolean` };
    }
  }
  const rangedOnly = raw.rangedOnly === true;
  const recoverDestIds = raw.recoverDestIds === true;
  const allowBroadSweep = raw.allowBroadSweep === true;

  const selector: BackfillSelector = {};

  if (raw.packageIds !== undefined) {
    const ids = parsePackageIds(raw.packageIds);
    if (!Array.isArray(ids)) return { ok: false, error: ids.error };
    selector.packageIds = ids;
  }

  if (raw.fileNameLike !== undefined) {
    const filter = parseFileNameLike(raw.fileNameLike as string);
    if ("error" in filter) return { ok: false, error: filter.error };
    selector.fileName = filter;
  }

  if (raw.archiveType !== undefined) {
    if (typeof raw.archiveType !== "string" || !ARCHIVE_TYPES.includes(raw.archiveType as BackfillArchiveType)) {
      return { ok: false, error: `archiveType must be one of ${ARCHIVE_TYPES.join(", ")}` };
    }
    selector.archiveType = raw.archiveType as BackfillArchiveType;
  }

  const isNarrowed = selector.packageIds !== undefined || selector.fileName !== undefined;
  if (!isNarrowed && !allowBroadSweep) {
    return {
      ok: false,
      error:
        "refusing an unbounded backfill: pass packageIds or fileNameLike to scope it, " +
        'or set {"allowBroadSweep":true} to deliberately sweep every empty package',
    };
  }
  if (allowBroadSweep && isNarrowed) {
    return { ok: false, error: "allowBroadSweep is for unscoped sweeps only — drop it or drop the selector" };
  }

  return {
    ok: true,
    plan: {
      selector,
      limit,
      rangedOnly,
      recoverDestIds,
      describe: describeSelector(selector, { limit, rangedOnly, recoverDestIds }),
    },
  };
}
