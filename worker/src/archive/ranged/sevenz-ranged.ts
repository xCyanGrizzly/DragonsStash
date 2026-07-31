import type { FileEntry } from "../zip-reader.js";
import { read7zContents } from "../sevenz-reader.js";
import { listFromSparse } from "./sparse-list.js";
import type { RangeReader } from "./range-reader.js";
import { childLogger } from "../../util/logger.js";

const log = childLogger("sevenz-ranged");

const SEVENZ_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

const K_HEADER = 0x01;
const K_ENCODED_HEADER = 0x17;
const K_PACK_INFO = 0x06;
const K_SIZE = 0x09;

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
  if (buf.length < 32) return null;
  if (!buf.subarray(0, 6).equals(SEVENZ_MAGIC)) return null;
  return {
    nextHeaderOffset: Number(buf.readBigUInt64LE(12)),
    nextHeaderSize: Number(buf.readBigUInt64LE(20)),
  };
}

export interface RangedPart { fileId: string; fileSize: bigint; fileName: string }

export async function readSevenZListingRanged(
  parts: RangedPart[],
  read: RangeReader,
): Promise<FileEntry[] | null> {
  const part = parts[0];
  if (!part) return null;
  const size = Number(part.fileSize);
  try {
    const sig = await read(part.fileId, 0, 32, part.fileSize);
    const parsed = parseSevenZSignatureHeader(sig);
    if (!parsed) return null;
    const endStart = 32 + parsed.nextHeaderOffset;
    if (endStart < 0 || endStart + parsed.nextHeaderSize > size) return null;
    const endHeader = await read(part.fileId, endStart, parsed.nextHeaderSize, part.fileSize);

    const regions = [
      { offset: 0, bytes: sig },
      { offset: endStart, bytes: endHeader },
    ];

    const headerType = endHeader[0];
    if (headerType === K_ENCODED_HEADER) {
      // Compressed header: its packed bytes live mid-file, not at EOF. Fetch them.
      const pack = locate7zEncodedHeaderPack(endHeader);
      if (!pack) return null;
      const packStart = 32 + pack.packPos;
      if (packStart < 0 || packStart + pack.packSize > size) return null;
      const packBytes = await read(part.fileId, packStart, pack.packSize, part.fileSize);
      regions.push({ offset: packStart, bytes: packBytes });
    } else if (headerType !== K_HEADER) {
      return null; // unknown next-header type
    }

    return listFromSparse([{ fileName: part.fileName, size, regions }], read7zContents);
  } catch (err) {
    log.warn({ err, fileId: part.fileId }, "ranged 7z listing failed");
    return null;
  }
}
