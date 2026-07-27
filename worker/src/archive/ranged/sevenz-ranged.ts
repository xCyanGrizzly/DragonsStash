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
