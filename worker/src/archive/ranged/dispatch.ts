import type { Client } from "tdl";
import { parseZipCentralDirectoryFromTail, findEocdOffset, MIN_ZIP_TAIL_BYTES } from "../central-directory.js";
import { isSpannedZipPartSet } from "../zip-spanned.js";
import { childLogger } from "../../util/logger.js";
import type { FileEntry } from "../zip-reader.js";
import { readSevenZListingRanged, type RangedPart } from "./sevenz-ranged.js";
import { readRarListingRanged } from "./rar-ranged.js";
import { tdlibRangeReader, type RangeReader } from "./range-reader.js";

const log = childLogger("ranged-dispatch");

/**
 * Read a ZIP central directory from the tail of a (possibly multipart)
 * archive. `parts` is ordered; only the LAST part carries the EOCD record.
 * `fileSize` on each part is that part's own size (NOT the whole-archive
 * total) so the download offset stays within that part's bounds.
 *
 * Which logical offset the EOCD's central-directory pointer is measured from
 * depends on the multipart shape:
 *
 *  - 7-Zip raw byte split (`.zip.001`, …): the parts are one ZIP file cut into
 *    chunks, so the pointer is a whole-archive offset → `tailStart` is the
 *    preceding parts' sizes plus the offset within the last part.
 *  - ZIP-spec spanned archive (`.z01`, …, `.zip`): each volume is its own unit
 *    and the pointer is relative to the start of the volume holding the
 *    directory → `tailStart` is just the offset within that final volume.
 *
 * Getting this wrong makes the computed directory offset wildly negative, and
 * the parser then throws RangeError on every tail size — which is exactly how
 * spanned sets ended up indexed with no file list at all.
 */
export async function readScannedZipListing(
  parts: RangedPart[],
  read: RangeReader,
): Promise<FileEntry[] | null> {
  if (parts.length === 0) return null;
  const lastPart = parts[parts.length - 1];
  const spanned = isSpannedZipPartSet(parts.map((p) => p.fileName));
  const precedingSize = spanned
    ? 0
    : parts.slice(0, -1).reduce((sum, p) => sum + Number(p.fileSize), 0);
  const lastSize = Number(lastPart.fileSize);
  for (const tailBytes of [MIN_ZIP_TAIL_BYTES, MIN_ZIP_TAIL_BYTES * 4]) {
    const partOffset = Math.max(0, lastSize - tailBytes);
    const downloadLen = Math.min(tailBytes, lastSize);
    try {
      const buf = await read(lastPart.fileId, partOffset, downloadLen, lastPart.fileSize);
      if (spanned && !cdStartsOnFinalVolume(buf)) {
        // The directory begins on an earlier volume; reaching it would mean
        // ranged-reading that volume too. Leave it to the full-download path.
        log.debug({ fileId: lastPart.fileId }, "spanned ZIP central directory is not on the final volume");
        return null;
      }
      return parseZipCentralDirectoryFromTail(buf, partOffset + precedingSize);
    } catch (err) {
      if (err instanceof RangeError) continue; // try a larger tail
      log.warn({ err, fileId: lastPart.fileId }, "ranged ZIP listing failed");
      return null;
    }
  }
  return null;
}

/**
 * For a spanned archive, whether the EOCD says the central directory starts on
 * the very volume that EOCD lives on (the usual case). ZIP64's saturated
 * 0xFFFF disk fields are treated as "yes" — the ZIP64 record that supersedes
 * them is itself in this tail, and the parser resolves it there.
 */
function cdStartsOnFinalVolume(tail: Buffer): boolean {
  const eocd = findEocdOffset(tail);
  if (eocd < 0) return true; // let the parser report the real problem
  const thisDisk = tail.readUInt16LE(eocd + 4);
  const cdStartDisk = tail.readUInt16LE(eocd + 6);
  return thisDisk === cdStartDisk || thisDisk === 0xffff || cdStartDisk === 0xffff;
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
  if (archiveType === "ZIP") return readScannedZipListing(parts, read);
  if (archiveType === "SEVEN_Z") return readSevenZListingRanged(parts, read);
  if (archiveType === "RAR") return readRarListingRanged(parts, read);
  return null;
}
