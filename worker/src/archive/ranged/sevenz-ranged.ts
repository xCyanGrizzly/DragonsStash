import type { FileEntry } from "../zip-reader.js";
import { read7zContents } from "../sevenz-reader.js";
import { listFromSparse } from "./sparse-list.js";
import type { RangeReader } from "./range-reader.js";
import { childLogger } from "../../util/logger.js";

const log = childLogger("sevenz-ranged");

const SEVENZ_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

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
    return listFromSparse(
      [{
        fileName: part.fileName,
        size,
        regions: [
          { offset: 0, bytes: sig },
          { offset: endStart, bytes: endHeader },
        ],
      }],
      read7zContents,
    );
  } catch (err) {
    log.warn({ err, fileId: part.fileId }, "ranged 7z listing failed");
    return null;
  }
}
