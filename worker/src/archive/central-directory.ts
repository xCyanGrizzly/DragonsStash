import path from "path";
import type { FileEntry } from "./zip-reader.js";

export const MIN_ZIP_TAIL_BYTES = 65_557;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function extOf(name: string): string | null {
  const e = path.extname(name).replace(/^\./, "").toLowerCase();
  return e === "" ? null : e;
}

/** Parse a ZIP central directory from the tail of an archive. */
export function parseZipCentralDirectoryFromTail(tail: Buffer, tailStart: number): FileEntry[] {
  // 1. Find EOCD by scanning backward for its signature.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new RangeError("EOCD not found in tail");

  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64: sizes/offsets of 0xFFFFFFFF mean "see ZIP64 EOCD".
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locSig = 0x07064b50;
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (tail.readUInt32LE(i) === locSig) { loc = i; break; }
    }
    if (loc < 0) throw new RangeError("ZIP64 EOCD locator not in tail");
    const z64Abs = Number(tail.readBigUInt64LE(loc + 8)); // absolute offset of ZIP64 EOCD
    const z64 = z64Abs - tailStart;
    if (z64 < 0) throw new RangeError("ZIP64 EOCD before tail window");
    cdSize = Number(tail.readBigUInt64LE(z64 + 40));
    cdOffset = Number(tail.readBigUInt64LE(z64 + 48));
  }

  // 2. Map the absolute central-directory offset into the tail buffer.
  const cdLocal = cdOffset - tailStart;
  if (cdLocal < 0 || cdLocal + cdSize > tail.length) {
    throw new RangeError("Central directory begins before tail window");
  }

  // 3. Walk central-directory headers.
  const entries: FileEntry[] = [];
  let p = cdLocal;
  const end = cdLocal + cdSize;
  while (p + 46 <= end && tail.readUInt32LE(p) === CD_SIG) {
    let crc = tail.readUInt32LE(p + 16) >>> 0;
    let comp = BigInt(tail.readUInt32LE(p + 20));
    let uncomp = BigInt(tail.readUInt32LE(p + 24));
    const nameLen = tail.readUInt16LE(p + 28);
    const extraLen = tail.readUInt16LE(p + 30);
    const commentLen = tail.readUInt16LE(p + 32);
    const name = tail.toString("utf8", p + 46, p + 46 + nameLen);

    // ZIP64 extra field overrides 0xFFFFFFFF sizes.
    if (comp === 0xffffffffn || uncomp === 0xffffffffn) {
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = tail.readUInt16LE(ep);
        const sz = tail.readUInt16LE(ep + 2);
        if (id === 0x0001) {
          let fp = ep + 4;
          if (uncomp === 0xffffffffn) { uncomp = tail.readBigUInt64LE(fp); fp += 8; }
          if (comp === 0xffffffffn) { comp = tail.readBigUInt64LE(fp); fp += 8; }
        }
        ep += 4 + sz;
      }
    }

    const isDir = name.endsWith("/");
    if (!isDir) {
      entries.push({
        path: name,
        fileName: path.basename(name),
        extension: extOf(name),
        compressedSize: comp,
        uncompressedSize: uncomp,
        crc32: crc !== 0 ? crc.toString(16).padStart(8, "0") : null,
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
