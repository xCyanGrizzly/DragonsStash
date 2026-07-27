import { describe, it, expect } from "vitest";
import { parseSevenZSignatureHeader } from "./sevenz-ranged.js";

const MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

function buildSignatureHeader(nextOffset: bigint, nextSize: bigint): Buffer {
  const buf = Buffer.alloc(32);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(0, 6); buf.writeUInt8(4, 7);  // version 0.4
  buf.writeUInt32LE(0, 8);                      // StartHeaderCRC (unused here)
  buf.writeBigUInt64LE(nextOffset, 12);
  buf.writeBigUInt64LE(nextSize, 20);
  buf.writeUInt32LE(0, 28);                     // NextHeaderCRC (unused here)
  return buf;
}

describe("parseSevenZSignatureHeader", () => {
  it("reads NextHeaderOffset and NextHeaderSize", () => {
    const buf = buildSignatureHeader(1_000_000n, 4096n);
    expect(parseSevenZSignatureHeader(buf)).toEqual({ nextHeaderOffset: 1_000_000, nextHeaderSize: 4096 });
  });

  it("returns null on bad magic", () => {
    expect(parseSevenZSignatureHeader(Buffer.alloc(32))).toBeNull();
  });

  it("returns null when shorter than 32 bytes", () => {
    expect(parseSevenZSignatureHeader(MAGIC)).toBeNull();
  });
});
