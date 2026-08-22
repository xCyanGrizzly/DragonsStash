import type { FileEntry } from "../zip-reader.js";
import { read7zContents } from "../sevenz-reader.js";
import { listFromSparse, type SparsePart } from "./sparse-list.js";
import type { RangeReader } from "./range-reader.js";
import { childLogger } from "../../util/logger.js";

const log = childLogger("sevenz-ranged");

const SEVENZ_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

const K_HEADER = 0x01;
const K_ENCODED_HEADER = 0x17;
const K_PACK_INFO = 0x06;
const K_SIZE = 0x09;

const SIG_HEADER_BYTES = 32;

/** Read a 7z variable-length number: first byte is a length mask, followed by
 *  little-endian bytes. Math.pow keeps values exact above 2^31. */
export function read7zNumber(buf: Buffer, pos: number): { value: number; next: number } {
  if (pos >= buf.length) throw new RangeError("7z number reads past buffer end");
  const first = buf[pos];
  let mask = 0x80;
  let value = 0;
  let p = pos + 1;
  for (let i = 0; i < 8; i++) {
    if ((first & mask) === 0) {
      value += (first & (mask - 1)) * Math.pow(2, 8 * i);
      return { value, next: p };
    }
    if (p >= buf.length) throw new RangeError("7z number overruns buffer");
    value += buf[p] * Math.pow(2, 8 * i);
    p++;
    mask >>= 1;
  }
  return { value, next: p };
}

/** For an encoded (kEncodedHeader) 7z next-header, return the absolute-ish
 *  location of the packed header stream(s): PackPos (relative to end of the
 *  32-byte signature header) and the summed PackSize. Null if not encoded or
 *  the StreamsInfo doesn't start with PackInfo as expected. */
export function locate7zEncodedHeaderPack(
  nextHeader: Buffer,
): { packPos: number; packSize: number } | null {
  let p = 0;
  if (nextHeader[p] !== K_ENCODED_HEADER) return null;
  p++;
  if (nextHeader[p] !== K_PACK_INFO) return null;
  p++;
  const packPos = read7zNumber(nextHeader, p); p = packPos.next;
  const numStreams = read7zNumber(nextHeader, p); p = numStreams.next;
  if (nextHeader[p] !== K_SIZE) return null;
  p++;
  let total = 0;
  for (let i = 0; i < numStreams.value; i++) {
    const s = read7zNumber(nextHeader, p); p = s.next;
    total += s.value;
  }
  return { packPos: packPos.value, packSize: total };
}

export function parseSevenZSignatureHeader(
  buf: Buffer,
): { nextHeaderOffset: number; nextHeaderSize: number } | null {
  if (buf.length < SIG_HEADER_BYTES) return null;
  if (!buf.subarray(0, 6).equals(SEVENZ_MAGIC)) return null;
  return {
    nextHeaderOffset: Number(buf.readBigUInt64LE(12)),
    nextHeaderSize: Number(buf.readBigUInt64LE(20)),
  };
}

export interface RangedPart { fileId: string; fileSize: bigint; fileName: string }

/** One volume's share of a whole-archive byte range. */
export interface VolumeSlice { partIndex: number; offset: number; length: number }

/**
 * A `.7z.001`/`.7z.002`/… set produced by 7-Zip's `-v` switch is a **raw byte
 * split** of one logical `.7z` file, not a ZIP-style spanned archive with
 * per-volume structure: `cat pack.7z.00*` reproduces the original archive
 * byte-for-byte. So every offset in the 7z headers is an offset into the
 * concatenation of the volumes, and the only correct way to read them is to
 * treat the set as one logical byte stream.
 *
 * That matters most for the next header (the archive index), which a 7z file
 * keeps at its *end* — i.e. in the **last** volume, never the first. Reading
 * only `parts[0]` therefore fails for every multi-volume set.
 *
 * Map a whole-archive `[start, start + length)` range onto per-volume reads,
 * splitting it when it straddles a volume boundary. Returns null when the
 * range falls outside the concatenated stream.
 */
export function mapRangeToVolumes(
  sizes: number[],
  start: number,
  length: number,
): VolumeSlice[] | null {
  const total = sizes.reduce((sum, s) => sum + s, 0);
  if (!Number.isFinite(start) || !Number.isFinite(length)) return null;
  if (start < 0 || length < 0 || start + length > total) return null;

  const slices: VolumeSlice[] = [];
  let pos = start;
  let remaining = length;
  let base = 0;
  for (let i = 0; i < sizes.length && remaining > 0; i++) {
    const end = base + sizes[i];
    if (pos < end) {
      const offset = pos - base;
      const take = Math.min(remaining, sizes[i] - offset);
      if (take > 0) {
        slices.push({ partIndex: i, offset, length: take });
        pos += take;
        remaining -= take;
      }
    }
    base = end;
  }
  return remaining === 0 ? slices : null;
}

/**
 * Fetch the 7z header regions of a (possibly multi-volume) archive and return
 * them as per-volume sparse reconstructions — the header bytes at their real
 * offsets, file payloads left as zero holes.
 *
 * Exported for testing: it is the whole-archive-offset mapping that is worth
 * asserting, and the final `7z l` step needs the real binary.
 */
export async function planSevenZSparseParts(
  parts: RangedPart[],
  read: RangeReader,
): Promise<SparsePart[] | null> {
  const first = parts[0];
  if (!first) {
    log.warn({ partCount: parts.length }, "ranged 7z listing aborted — no parts supplied");
    return null;
  }
  const sizes = parts.map((p) => Number(p.fileSize));
  const total = sizes.reduce((sum, s) => sum + s, 0);
  // Log context shared by every bail-out below; the first part names the set.
  const ctx = { fileId: first.fileId, fileName: first.fileName, partCount: parts.length, total };
  const regions: { offset: number; bytes: Buffer }[][] = parts.map(() => []);

  /**
   * Read a whole-archive range, recording each volume's slice as a region so
   * the sparse reconstruction places the bytes where 7z expects them.
   */
  const fetchLogical = async (start: number, length: number, what: string): Promise<Buffer | null> => {
    const slices = mapRangeToVolumes(sizes, start, length);
    if (!slices) {
      log.warn({ ...ctx, what, start, length, sizes }, `ranged 7z listing aborted — ${what} region out of bounds`);
      return null;
    }
    const chunks: Buffer[] = [];
    for (const s of slices) {
      const part = parts[s.partIndex];
      const bytes = await read(part.fileId, s.offset, s.length, part.fileSize);
      if (bytes.length < s.length) {
        log.warn(
          { ...ctx, what, volume: s.partIndex + 1, volumeFileId: part.fileId, offset: s.offset, wanted: s.length, got: bytes.length },
          `ranged 7z listing aborted — short read on ${what}`,
        );
        return null;
      }
      regions[s.partIndex].push({ offset: s.offset, bytes });
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  };

  try {
    // The signature header is at the very start of volume 1.
    const sig = await fetchLogical(0, Math.min(SIG_HEADER_BYTES, total), "signature-header");
    if (!sig) return null;
    const parsed = parseSevenZSignatureHeader(sig);
    if (!parsed) {
      log.warn({ ...ctx, head: sig.subarray(0, 16).toString("hex") }, "ranged 7z listing aborted — signature header did not parse");
      return null;
    }

    // NextHeaderOffset is measured from the end of the signature header, into
    // the concatenated stream — so this normally lands in the LAST volume.
    const endStart = SIG_HEADER_BYTES + parsed.nextHeaderOffset;
    if (parsed.nextHeaderSize <= 0) {
      log.warn({ ...ctx, endStart, nextHeaderSize: parsed.nextHeaderSize }, "ranged 7z listing aborted — empty next header (no index to read)");
      return null;
    }
    const endHeader = await fetchLogical(endStart, parsed.nextHeaderSize, "next-header");
    if (!endHeader) return null;

    const headerType = endHeader[0];
    if (headerType === K_ENCODED_HEADER) {
      // Compressed header: its packed bytes live mid-stream, not at EOF, so
      // they may sit in any volume — or straddle two.
      const pack = locate7zEncodedHeaderPack(endHeader);
      if (!pack) {
        log.warn(
          { ...ctx, endStart, nextHeaderSize: parsed.nextHeaderSize, head: endHeader.subarray(0, 16).toString("hex") },
          "ranged 7z listing aborted — encoded-header PackInfo did not parse",
        );
        return null;
      }
      const packStart = SIG_HEADER_BYTES + pack.packPos;
      const packBytes = await fetchLogical(packStart, pack.packSize, "packed-header");
      if (!packBytes) return null;
    } else if (headerType !== K_HEADER) {
      log.warn({ ...ctx, endStart, headerType }, "ranged 7z listing aborted — unknown next-header type");
      return null;
    }

    return parts.map((p, i) => ({ fileName: p.fileName, size: sizes[i], regions: regions[i] }));
  } catch (err) {
    log.warn({ err, ...ctx }, "ranged 7z listing failed");
    return null;
  }
}

export async function readSevenZListingRanged(
  parts: RangedPart[],
  read: RangeReader,
): Promise<FileEntry[] | null> {
  const sparseParts = await planSevenZSparseParts(parts, read);
  if (!sparseParts) return null;
  // 7-Zip opens `pack.7z.001` as a split archive and concatenates the set
  // itself, so the whole reconstructed set must be on disk, not just part 1.
  return listFromSparse(sparseParts, read7zContents);
}
