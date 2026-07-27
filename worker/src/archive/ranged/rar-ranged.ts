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
