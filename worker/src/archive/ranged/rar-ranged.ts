const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

export function readVint(buf: Buffer, pos: number): { value: number; bytes: number } {
  let value = 0, shift = 0, bytes = 0;
  while (pos + bytes < buf.length) {
    const b = buf[pos + bytes];
    value += (b & 0x7f) * Math.pow(2, shift); // Math.pow keeps >32-bit sizes exact up to 2^53
    bytes++;
    if ((b & 0x80) === 0) return { value, bytes };
    shift += 7;
    if (shift > 63) break;
  }
  throw new RangeError("incomplete RAR vint");
}

export function detectRarSignature(buf: Buffer): { version: 4 | 5; sigLen: number } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(RAR5_SIG)) return { version: 5, sigLen: 8 };
  if (buf.length >= 7 && buf.subarray(0, 7).equals(RAR4_SIG)) return { version: 4, sigLen: 7 };
  return null;
}

export interface BlockExtent { headerBytes: number; dataSize: number; isEnd: boolean }

// RAR5: CRC32(4) | HeaderSize(vint) | HeaderType(vint) | HeaderFlags(vint)
//       [ExtraAreaSize(vint) if flags&0x0001] [DataSize(vint) if flags&0x0002] ...
export function parseRar5BlockExtent(buf: Buffer, pos: number): BlockExtent {
  let p = pos + 4; // skip CRC32
  const hs = readVint(buf, p); p += hs.bytes;
  const headerBytes = 4 + hs.bytes + hs.value; // CRC + HeaderSize-vint + HeaderSize
  const type = readVint(buf, p); p += type.bytes;
  const flags = readVint(buf, p); p += flags.bytes;
  if (flags.value & 0x0001) { const ea = readVint(buf, p); p += ea.bytes; } // extra area size (skip)
  let dataSize = 0;
  if (flags.value & 0x0002) { const ds = readVint(buf, p); p += ds.bytes; dataSize = ds.value; }
  return { headerBytes, dataSize, isEnd: type.value === 5 };
}

// RAR4: HEAD_CRC(2) | HEAD_TYPE(1) | HEAD_FLAGS(2) | HEAD_SIZE(2) [ADD_SIZE(4) if flags&0x8000]
export function parseRar4BlockExtent(buf: Buffer, pos: number): BlockExtent {
  const type = buf.readUInt8(pos + 2);
  const flags = buf.readUInt16LE(pos + 3);
  const headSize = buf.readUInt16LE(pos + 5);
  const dataSize = (flags & 0x8000) ? buf.readUInt32LE(pos + 7) : 0;
  return { headerBytes: headSize, dataSize, isEnd: type === 0x7b };
}

import type { FileEntry } from "../zip-reader.js";
import type { RangeReader } from "./range-reader.js";
import type { RangedPart } from "./sevenz-ranged.js";
import { listFromSparse, type SparsePart } from "./sparse-list.js";
import { readRarContents } from "../rar-reader.js";
import { childLogger } from "../../util/logger.js";

const rlog = childLogger("rar-ranged");
const MAX_RAR_BLOCKS = 50000;
const MAX_RAR_HEADER_BYTES = 8 * 1024 * 1024; // 8 MB — real RAR block headers are far smaller; guards against a corrupt/desynced HeaderSize
const HEADER_CHUNK = 8192;

export async function walkRarVolume(
  read: RangeReader,
  part: RangedPart,
  version: 4 | 5,
  sigLen: number,
): Promise<{ offset: number; bytes: Buffer }[] | null> {
  const size = Number(part.fileSize);
  const regions: { offset: number; bytes: Buffer }[] = [];
  let pos = sigLen;
  let blocks = 0;
  try {
    while (pos < size) {
      if (++blocks > MAX_RAR_BLOCKS) return null;
      const chunkLen = Math.min(HEADER_CHUNK, size - pos);
      let chunk = await read(part.fileId, pos, chunkLen, part.fileSize);
      const ext = version === 5 ? parseRar5BlockExtent(chunk, 0) : parseRar4BlockExtent(chunk, 0);
      if (ext.headerBytes > MAX_RAR_HEADER_BYTES) return null;
      // Ensure we have the full header bytes to harvest (long filenames).
      let headerBuf = chunk;
      if (ext.headerBytes > chunk.length) {
        headerBuf = await read(part.fileId, pos, Math.min(ext.headerBytes, size - pos), part.fileSize);
      }
      regions.push({ offset: pos, bytes: headerBuf.subarray(0, Math.min(ext.headerBytes, size - pos)) });
      if (ext.isEnd) break;
      const advance = ext.headerBytes + ext.dataSize;
      if (advance <= 0) return null;
      if (pos + advance > size) break; // data clamped at the volume boundary (multipart continuation)
      pos += advance;
    }
    return regions;
  } catch (err) {
    rlog.warn({ err, fileId: part.fileId }, "RAR volume walk failed");
    return null;
  }
}

export async function readRarListingRanged(
  parts: RangedPart[],
  read: RangeReader,
): Promise<FileEntry[] | null> {
  const sparseParts: SparsePart[] = [];
  for (const part of parts) {
    const head = await read(part.fileId, 0, 16, part.fileSize);
    const sig = detectRarSignature(head);
    if (!sig) return null;
    const regions = await walkRarVolume(read, part, sig.version, sig.sigLen);
    if (!regions) return null;
    // walkRarVolume starts at pos = sigLen and never harvests the signature
    // itself, so it must be added as its own region — otherwise the
    // reconstructed sparse file starts with zero bytes instead of the "Rar!"
    // magic, and unrar rejects it outright as "not RAR archive".
    const sigRegion = { offset: 0, bytes: head.subarray(0, sig.sigLen) };
    sparseParts.push({ fileName: part.fileName, size: Number(part.fileSize), regions: [sigRegion, ...regions] });
  }
  return listFromSparse(sparseParts, readRarContents);
}
