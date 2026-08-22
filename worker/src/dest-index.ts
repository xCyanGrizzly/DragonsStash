import { isArchiveAttachment } from "./archive/detect.js";
import { groupArchiveSets } from "./archive/multipart.js";
import { isConcatRepackName, concatRepackBase, concatChunkIndex } from "./archive/listing-plan.js";
import type { ChatDocument } from "./tdlib/chat-documents.js";

/**
 * An index over one destination-channel scan, used to recover the destination
 * message ids of packages whose `destMessageIds` array was never populated.
 *
 * Two kinds of part set live in here:
 *
 *  - `archive-set`   — grouped by `groupArchiveSets`, i.e. the same grouping the
 *                      ingestion path uses, so a `.z01 … .zip` spanned set or a
 *                      `.zip.001 …` byte split comes back in upload order.
 *  - `concat-repack` — `<base>.concat.NNN` chunks, which match no archive
 *                      pattern at all and so are invisible to `groupArchiveSets`.
 *                      They still need grouping: a package repacked this way has
 *                      real destination messages worth recording even though its
 *                      listing can never be read back.
 */
export type DestPartSetKind = "archive-set" | "concat-repack";

export interface DestPartSet {
  kind: DestPartSetKind;
  parts: ChatDocument[];
}

export interface DestIndex {
  byMessageId: Map<string, ChatDocument>;
  setByMessageId: Map<string, DestPartSet>;
  documentCount: number;
}

export function buildDestIndex(documents: ChatDocument[]): DestIndex {
  const byMessageId = new Map<string, ChatDocument>();
  for (const doc of documents) byMessageId.set(doc.id.toString(), doc);

  const setByMessageId = new Map<string, DestPartSet>();

  // Recognized archive names: reuse the ingestion grouping verbatim so the part
  // order here matches the order the parts were uploaded in.
  const archives = documents.filter((d) => isArchiveAttachment(d.fileName));
  for (const set of groupArchiveSets(archives)) {
    if (set.parts.length === 0) continue;
    const entry: DestPartSet = { kind: "archive-set", parts: set.parts };
    for (const part of set.parts) setByMessageId.set(part.id.toString(), entry);
  }

  // `<base>.concat.NNN` repack chunks, grouped by base and ordered by chunk number.
  const concatGroups = new Map<string, ChatDocument[]>();
  for (const doc of documents) {
    if (!isConcatRepackName(doc.fileName)) continue;
    const key = concatRepackBase(doc.fileName);
    const group = concatGroups.get(key) ?? [];
    group.push(doc);
    concatGroups.set(key, group);
  }
  for (const group of concatGroups.values()) {
    group.sort((a, b) => concatChunkIndex(a.fileName) - concatChunkIndex(b.fileName));
    const entry: DestPartSet = { kind: "concat-repack", parts: group };
    for (const part of group) setByMessageId.set(part.id.toString(), entry);
  }

  return { byMessageId, setByMessageId, documentCount: documents.length };
}

export type DestResolution =
  | { ok: true; kind: DestPartSetKind; parts: ChatDocument[] }
  | { ok: false; reason: string };

/**
 * Resolve a package's full destination part set from one known message id.
 *
 * Refuses anything it cannot corroborate. In particular the recovered set must
 * hold exactly `expectedPartCount` parts: the destination channel can legitimately
 * contain two uploads sharing a base name (a re-post, a duplicate ingestion), and
 * `groupArchiveSets` merges those into one oversized set. Writing that merged set
 * back to `destMessageIds` would hand the bot a mix of two archives, so a count
 * mismatch is reported and the row is left alone.
 */
export function resolveDestPartSet(
  index: DestIndex,
  anchorMessageId: bigint,
  expectedPartCount: number
): DestResolution {
  const key = anchorMessageId.toString();
  const anchor = index.byMessageId.get(key);
  if (!anchor) {
    return {
      ok: false,
      reason: `destination message ${key} was not found in the channel scan (deleted, or outside the scanned range)`,
    };
  }

  const set = index.setByMessageId.get(key);
  if (!set) {
    if (expectedPartCount === 1) {
      return { ok: true, kind: "archive-set", parts: [anchor] };
    }
    return {
      ok: false,
      reason: `destination message ${key} ("${anchor.fileName}") matched no part set, but the package expects ${expectedPartCount} parts`,
    };
  }

  if (set.parts.length !== expectedPartCount) {
    return {
      ok: false,
      reason:
        `resolved ${set.parts.length} destination part(s) for "${anchor.fileName}" but the package records ` +
        `${expectedPartCount} — refusing to write an incomplete or merged set`,
    };
  }

  return { ok: true, kind: set.kind, parts: set.parts };
}
