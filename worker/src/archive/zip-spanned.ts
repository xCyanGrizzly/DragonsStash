import { open as fsOpen, stat as fsStat } from "fs/promises";
import path from "path";
import { findEocdOffset, walkCentralDirectory, MIN_ZIP_TAIL_BYTES } from "./central-directory.js";
import { childLogger } from "../util/logger.js";
import type { FileEntry } from "./zip-reader.js";

const log = childLogger("zip-spanned");

const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

/** Refuse to allocate a buffer for an absurd central-directory size. */
const MAX_CD_BYTES = 256 * 1024 * 1024;

/**
 * A `.z01`/`.z02`/…/`.zip` set is a ZIP-spec **spanned (multi-disk)** archive:
 * a genuinely different on-disk format from a 7-Zip raw byte split
 * (`.zip.001`, `.zip.002`, …), which is one ZIP file cut into chunks.
 *
 * The distinction matters because a byte split is read by concatenating the
 * chunks, whereas in a spanned archive each volume is its own unit: the EOCD's
 * central-directory offset is relative to the start of the volume that holds
 * the directory, and central-directory records carry a volume number. Feeding
 * a spanned set to a concatenating reader yields nonsense offsets (and yauzl
 * refuses outright: "multi-disk zip files are not supported").
 *
 * Detected from filename shape rather than the detector's multipart `pattern`
 * so this stays independent of how `detect.ts` labels the two variants.
 * Order-independent: the caller may hand the volumes over in any order.
 */
export function isSpannedZipPartSet(filePaths: string[]): boolean {
  if (filePaths.length < 2) return false;
  const names = filePaths.map((p) => path.basename(p));
  const finals = names.filter((n) => /\.zip$/i.test(n));
  const volumes = names.filter((n) => /\.z\d{2,}$/i.test(n));
  return finals.length === 1 && volumes.length === names.length - 1;
}

export type SpannedZipResult =
  /** Successfully read; `entries` may legitimately be empty for an empty archive. */
  | { kind: "entries"; entries: FileEntry[] }
  /** The EOCD reports a single disk — the parts are really a byte split, so the
   *  caller should fall back to reading them as one concatenated stream. */
  | { kind: "not-spanned" }
  | { kind: "failed"; reason: string };

/**
 * Read the central directory of a ZIP-spec spanned archive.
 *
 * Only the volume holding the central directory (plus any it spills onto) is
 * read, and only the directory bytes themselves — the file payloads are never
 * touched, so this is cheap regardless of archive size.
 *
 * Coverage: STORE/DEFLATE and ZIP64 spanned archives are handled. Archives
 * whose central directory is itself encrypted (strong encryption / "hide
 * filenames") cannot be listed by any header-only reader and return `failed`.
 */
export async function readSpannedZipCentralDirectory(filePaths: string[]): Promise<SpannedZipResult> {
  const volumes = new Map<number, string>();
  let finalVolume: string | undefined;
  for (const p of filePaths) {
    const base = path.basename(p);
    const m = base.match(/\.z(\d{2,})$/i);
    if (m) {
      // .z01 is volume 0, .z02 is volume 1, … (APPNOTE numbers disks from 0).
      volumes.set(parseInt(m[1], 10) - 1, p);
    } else if (/\.zip$/i.test(base)) {
      finalVolume = p;
    }
  }
  if (!finalVolume) return { kind: "failed", reason: "no final .zip volume" };

  const finalSize = (await fsStat(finalVolume)).size;
  const tailLen = Math.min(finalSize, MIN_ZIP_TAIL_BYTES);
  const tailStart = finalSize - tailLen;
  const tail = await readBytes(finalVolume, tailStart, tailLen);

  const eocdPos = findEocdOffset(tail);
  if (eocdPos < 0) return { kind: "failed", reason: "EOCD not found in final volume" };

  let thisDisk = tail.readUInt16LE(eocdPos + 4);
  let cdStartDisk = tail.readUInt16LE(eocdPos + 6);
  let cdSize = tail.readUInt32LE(eocdPos + 12);
  let cdOffset = tail.readUInt32LE(eocdPos + 16);

  // ZIP64: any saturated field means the real values live in the ZIP64 EOCD
  // record, which in a spanned archive may sit on a different volume.
  if (
    thisDisk === 0xffff ||
    cdStartDisk === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    const locPos = findZip64Locator(tail, eocdPos);
    if (locPos < 0) return { kind: "failed", reason: "ZIP64 locator not found" };
    const locDisk = tail.readUInt32LE(locPos + 4);
    const locOffset = Number(tail.readBigUInt64LE(locPos + 8));

    // The locator's disk number counts the final volume too, so resolve it
    // through the same map, treating the final .zip as the highest volume.
    const z64Path =
      locDisk === thisDisk || locDisk === 0xffff ? finalVolume : volumes.get(locDisk) ?? finalVolume;
    const z64 = await readBytes(z64Path, locOffset, 56);
    if (z64.length < 56 || z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
      return { kind: "failed", reason: "ZIP64 EOCD record unreadable" };
    }
    thisDisk = z64.readUInt32LE(16);
    cdStartDisk = z64.readUInt32LE(20);
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }

  // A byte split named .z01/.zip still reports a single disk — concatenation,
  // not volume mapping, is the correct reading for it.
  if (thisDisk === 0 && cdStartDisk === 0) return { kind: "not-spanned" };

  if (cdSize < 0 || cdSize > MAX_CD_BYTES) {
    return { kind: "failed", reason: `implausible central directory size ${cdSize}` };
  }

  // The final .zip file is the highest-numbered volume.
  volumes.set(thisDisk, finalVolume);

  // Read cdSize bytes from (cdStartDisk, cdOffset), spilling onto later
  // volumes if the directory straddles a volume boundary.
  const chunks: Buffer[] = [];
  let remaining = cdSize;
  let disk = cdStartDisk;
  let offset = cdOffset;
  while (remaining > 0) {
    const volPath = volumes.get(disk);
    if (!volPath) return { kind: "failed", reason: `volume ${disk + 1} of the set is missing` };
    const chunk = await readBytes(volPath, offset, remaining);
    if (chunk.length === 0) {
      return { kind: "failed", reason: `volume ${disk + 1} ended before the central directory did` };
    }
    chunks.push(chunk);
    remaining -= chunk.length;
    disk++;
    offset = 0;
  }

  const cdBuf = Buffer.concat(chunks);
  const entries = walkCentralDirectory(cdBuf, 0, cdSize);
  log.debug(
    { volumes: volumes.size, thisDisk, cdStartDisk, cdSize, entries: entries.length },
    "Read spanned ZIP central directory"
  );
  return { kind: "entries", entries };
}

/** Find the ZIP64 EOCD locator, which sits just before the EOCD record. */
function findZip64Locator(tail: Buffer, eocdPos: number): number {
  for (let i = Math.min(eocdPos - 20, tail.length - 20); i >= 0; i--) {
    if (tail.readUInt32LE(i) === ZIP64_LOCATOR_SIG) return i;
  }
  return -1;
}

/** Read up to `length` bytes at `offset`; a short read means end of file. */
async function readBytes(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fh = await fsOpen(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
