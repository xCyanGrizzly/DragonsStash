import type { Client } from "tdl";
import { downloadFileRange } from "../../tdlib/range-download.js";
import { parseZipCentralDirectoryFromTail, MIN_ZIP_TAIL_BYTES } from "../central-directory.js";
import { childLogger } from "../../util/logger.js";
import type { FileEntry } from "../zip-reader.js";
import { readSevenZListingRanged, type RangedPart } from "./sevenz-ranged.js";
import { readRarListingRanged } from "./rar-ranged.js";
import { tdlibRangeReader } from "./range-reader.js";

const log = childLogger("ranged-dispatch");

/**
 * Read a ZIP central directory from the tail of a (possibly multipart)
 * archive. `parts` is ordered; only the LAST part carries the EOCD record.
 * `fileSize` on each part is that part's own size (NOT the whole-archive
 * total) so the download offset stays within that part's bounds, while
 * `tailStart` passed to the parser is the logical whole-archive offset
 * (preceding parts' sizes + the offset within the last part).
 */
export async function readScannedZipListing(
  client: Client,
  parts: { fileId: string; fileSize: bigint }[],
): Promise<FileEntry[] | null> {
  if (parts.length === 0) return null;
  const lastPart = parts[parts.length - 1];
  const precedingSize = parts.slice(0, -1).reduce((sum, p) => sum + Number(p.fileSize), 0);
  const lastSize = Number(lastPart.fileSize);
  for (const tailBytes of [MIN_ZIP_TAIL_BYTES, MIN_ZIP_TAIL_BYTES * 4]) {
    const partOffset = Math.max(0, lastSize - tailBytes);
    const downloadLen = Math.min(tailBytes, lastSize);
    try {
      const buf = await downloadFileRange(client, lastPart.fileId, partOffset, downloadLen, lastPart.fileSize);
      const tailStart = precedingSize + partOffset;
      return parseZipCentralDirectoryFromTail(buf, tailStart);
    } catch (err) {
      if (err instanceof RangeError) continue; // try a larger tail
      log.warn({ err, fileId: lastPart.fileId }, "ranged ZIP listing failed");
      return null;
    }
  }
  return null;
}

/**
 * Dispatch a (no-download) inner-file listing read by archive type. Used both
 * by the provenance-backfill path (reading an already-uploaded copy) and the
 * forward-priority ingestion path (reading the source channel's copy before
 * any download/forward decision is made) — the read itself only needs
 * {fileId, fileSize, fileName}, so it doesn't matter which channel the file
 * currently lives in.
 */
export async function readScannedListingRanged(
  archiveType: string,
  client: Client,
  parts: RangedPart[],
): Promise<FileEntry[] | null> {
  const read = tdlibRangeReader(client);
  if (archiveType === "ZIP") return readScannedZipListing(client, parts);
  if (archiveType === "SEVEN_Z") return readSevenZListingRanged(parts, read);
  if (archiveType === "RAR") return readRarListingRanged(parts, read);
  return null;
}
