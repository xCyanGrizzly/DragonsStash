import { detectArchive } from "./detect.js";

/**
 * Decide *how* to read an already-uploaded archive's inner-file listing before
 * spending a single byte of Telegram traffic on it.
 *
 * Three outcomes matter:
 *
 *  - `ranged`   — read only the header/tail bytes that carry the listing.
 *                 Tens of kilobytes regardless of archive size.
 *  - `download` — the ranged read can't work (or already failed); pull the whole
 *                 archive down and let the on-disk reader handle it.
 *  - `skip`     — no reader can ever list this destination copy. Saying so
 *                 up-front is the whole point: the alternative is burning API
 *                 calls and bandwidth on something structurally unreadable.
 *
 * The `skip` case that motivated this module: when any source volume exceeded
 * the upload cap, the ingestion worker concatenated every volume into one file
 * and re-split it into uniform `<base>.concat.NNN` chunks. For a *byte split*
 * (`pack.zip.001`, …) that round-trips fine — the bytes are the same stream.
 * For a ZIP-spec **spanned** set (`pack.z01`, …, `pack.zip`) or a RAR volume
 * set it does not: those volumes are separate containers, and their
 * concatenation is not a valid archive in any format. The destination copy of
 * such a package is permanently unlistable, and no amount of downloading will
 * change that.
 */

/** `<base>.concat`, `<base>.concat.001`, … — the re-split repack naming. */
const CONCAT_REPACK_RE = /\.concat(?:\.\d{2,})?$/i;

export function isConcatRepackName(fileName: string): boolean {
  return CONCAT_REPACK_RE.test(fileName.trim().replace(/[.\s]+$/, ""));
}

/** Strip the `.NNN` chunk suffix, so every chunk of one repack shares a key. */
export function concatRepackBase(fileName: string): string {
  return fileName
    .trim()
    .replace(/[.\s]+$/, "")
    .replace(/\.(\d{2,})$/, "")
    .toLowerCase();
}

/** Numeric chunk index of a `<base>.concat.NNN` name; 0 for a bare `.concat`. */
export function concatChunkIndex(fileName: string): number {
  const m = fileName.trim().replace(/[.\s]+$/, "").match(/\.(\d{2,})$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * How the *source* archive was laid out, derived from the Package's own
 * fileName. This is what decides whether a `.concat.NNN` repack is survivable:
 * only a stream that was contiguous to begin with can be re-cut.
 */
export type SourceShape =
  /** `.z01`, `.z02`, … + `.zip` — ZIP-spec spanned, one container per volume. */
  | "spanned-zip"
  /** `.partN.rar` or `.rNN` — RAR volume set, one container per volume. */
  | "rar-volume-set"
  /** `.zip.001`, `.7z.001`, … — one file cut into chunks. */
  | "byte-split"
  /** A lone `.zip` / `.rar` / `.7z` / document. */
  | "single"
  | "unknown";

export function classifySourceShape(fileName: string): SourceShape {
  const info = detectArchive(fileName);
  if (!info) return "unknown";
  switch (info.pattern) {
    case "ZIP_LEGACY":
      return "spanned-zip";
    case "RAR_PART":
    case "RAR_LEGACY":
      return "rar-volume-set";
    case "ARCHIVE_NUMBERED":
      return "byte-split";
    case "SINGLE":
      return "single";
  }
}

/** True for layouts whose volumes are independent containers, not one stream. */
export function isVolumeSet(shape: SourceShape): boolean {
  return shape === "spanned-zip" || shape === "rar-volume-set";
}

export type ListingRoute =
  | { route: "ranged"; reason: string }
  | { route: "download"; reason: string }
  | { route: "skip"; reason: string };

export interface ListingPlanInput {
  /** Package.archiveType. */
  archiveType: string;
  /** Package.fileName — the *source* name, which encodes the original layout. */
  sourceFileName: string;
  /** File names of the resolved destination parts, in upload order. */
  destFileNames: string[];
  /** Total size of the destination parts. */
  totalSize: bigint;
  /** Cap on a full download (WORKER_MAX_ZIP_SIZE_MB, in bytes). */
  maxDownloadBytes: bigint;
  /** When true, the full-download fallback is off the table entirely. */
  rangedOnly: boolean;
}

const RANGED_TYPES = new Set(["ZIP", "RAR", "SEVEN_Z"]);

/**
 * Pick the first route to try for a package. `download` is only returned when
 * ranged reading is structurally impossible for the type; a ranged read that
 * fails at runtime is handled by {@link planRangedFallback}.
 */
export function planListingRead(input: ListingPlanInput): ListingRoute {
  if (!RANGED_TYPES.has(input.archiveType)) {
    return { route: "skip", reason: `archiveType ${input.archiveType} has no file-list reader` };
  }
  if (input.destFileNames.length === 0) {
    return { route: "skip", reason: "no destination parts could be resolved" };
  }

  const shape = classifySourceShape(input.sourceFileName);
  const repacked = input.destFileNames.some(isConcatRepackName);

  if (repacked && isVolumeSet(shape)) {
    return {
      route: "skip",
      reason:
        `destination copy is a .concat.NNN repack of a ${shape} — concatenated volumes ` +
        "are not a valid archive, so no reader can ever list it",
    };
  }

  if (repacked) {
    // A re-cut byte split is still the original contiguous stream, so the
    // ranged reader's whole-archive offset arithmetic applies unchanged.
    return { route: "ranged", reason: `.concat.NNN repack of a ${shape} — readable as a byte split` };
  }

  return { route: "ranged", reason: `${shape} destination copy, ${input.destFileNames.length} part(s)` };
}

/**
 * What to do once a ranged read has come back empty. Kept separate from
 * {@link planListingRead} so the "we tried cheap and it didn't work" decision
 * is explicit and testable rather than buried in a conditional.
 */
export function planRangedFallback(
  input: Pick<ListingPlanInput, "totalSize" | "maxDownloadBytes" | "rangedOnly">
): { route: "download"; reason: string } | { route: "skip"; reason: string } {
  if (input.rangedOnly) {
    return {
      route: "skip",
      reason: `ranged read failed and rangedOnly is set — not downloading ${input.totalSize} bytes`,
    };
  }
  if (input.totalSize > input.maxDownloadBytes) {
    return {
      route: "skip",
      reason: `ranged read failed and ${input.totalSize} bytes exceeds the download cap of ${input.maxDownloadBytes}`,
    };
  }
  return { route: "download", reason: `ranged read failed — falling back to a ${input.totalSize} byte download` };
}
