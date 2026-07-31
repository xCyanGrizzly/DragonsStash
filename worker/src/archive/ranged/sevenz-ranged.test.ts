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

import { readSevenZListingRanged } from "./sevenz-ranged.js";
import type { RangeReader } from "./range-reader.js";

describe("readSevenZListingRanged", () => {
  it("reads the signature + end-header regions and reconstructs for 7z l", async () => {
    const size = 5_000_000;
    const endHeaderOffset = 4_900_000; // absolute
    const nextHeaderOffset = endHeaderOffset - 32;
    const sig = Buffer.alloc(32);
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).copy(sig, 0);
    sig.writeBigUInt64LE(BigInt(nextHeaderOffset), 12);
    sig.writeBigUInt64LE(100n, 20);

    const reads: { offset: number; length: number }[] = [];
    const read: RangeReader = async (_id, offset, length) => {
      reads.push({ offset, length });
      if (offset === 0) return sig.subarray(0, length);
      return Buffer.alloc(length, 0xAB); // stand-in end-header bytes
    };

    // Inject a fake lister via the module boundary: readSevenZListingRanged
    // calls listFromSparse(parts, read7zContents). We assert the ranged reads
    // it issued; the sparse file + real 7z is covered by live verification.
    const entries = await readSevenZListingRanged(
      [{ fileId: "1", fileSize: BigInt(size), fileName: "a.7z" }],
      read,
    );
    // entries may be null here because the stand-in bytes aren't a real 7z;
    // the contract under test is the ranged-read offsets:
    expect(reads[0]).toEqual({ offset: 0, length: 32 });
    expect(reads[1]).toEqual({ offset: endHeaderOffset, length: 100 });
    expect(entries === null || Array.isArray(entries)).toBe(true);
  });
});

import { read7zNumber, locate7zEncodedHeaderPack } from "./sevenz-ranged.js";

describe("read7zNumber", () => {
  it("reads a single-byte number", () => {
    expect(read7zNumber(Buffer.from([0x2a]), 0)).toEqual({ value: 42, next: 1 });
  });
  it("reads a two-byte number (first-byte length mask + LE trailing byte)", () => {
    // 1000 = 0x03E8: low byte 0xE8, high nibble 0x03 -> first = 0x80|0x03 = 0x83, trailing 0xE8
    expect(read7zNumber(Buffer.from([0x83, 0xe8]), 0)).toEqual({ value: 1000, next: 2 });
    // 500 = 0x01F4 -> first 0x81, trailing 0xF4
    expect(read7zNumber(Buffer.from([0x81, 0xf4]), 0)).toEqual({ value: 500, next: 2 });
  });
  it("throws when pos starts past the buffer end (short read)", () => {
    expect(() => read7zNumber(Buffer.from([0x2a]), 5)).toThrow(RangeError);
    expect(() => read7zNumber(Buffer.alloc(0), 0)).toThrow(RangeError);
  });
});

describe("locate7zEncodedHeaderPack", () => {
  it("parses PackPos and summed PackSize from an encoded header", () => {
    // kEncodedHeader, kPackInfo, PackPos=1000([0x83,0xe8]), NumStreams=1([0x01]),
    // kSize, PackSize=500([0x81,0xf4])
    const enc = Buffer.from([0x17, 0x06, 0x83, 0xe8, 0x01, 0x09, 0x81, 0xf4]);
    expect(locate7zEncodedHeaderPack(enc)).toEqual({ packPos: 1000, packSize: 500 });
  });
  it("returns null for a plain (kHeader 0x01) header", () => {
    expect(locate7zEncodedHeaderPack(Buffer.from([0x01, 0x04]))).toBeNull();
  });
  it("sums multiple pack streams", () => {
    // PackPos=0([0x00]), NumStreams=2([0x02]), kSize, sizes 10([0x0a]) + 20([0x14])
    const enc = Buffer.from([0x17, 0x06, 0x00, 0x02, 0x09, 0x0a, 0x14]);
    expect(locate7zEncodedHeaderPack(enc)).toEqual({ packPos: 0, packSize: 30 });
  });
});

describe("readSevenZListingRanged (encoded header)", () => {
  it("fetches the mid-file packed-header region as a third read", async () => {
    const size = 5_000_000;
    const nextHeaderOffset = 4_000_000;      // relative to end of 32-byte sig header
    const endStart = 32 + nextHeaderOffset;  // absolute
    const packPos = 1000;                    // relative to end of sig header
    const packStart = 32 + packPos;          // absolute
    const packSize = 500;
    const sig = Buffer.alloc(32);
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).copy(sig, 0);
    sig.writeBigUInt64LE(BigInt(nextHeaderOffset), 12);
    sig.writeBigUInt64LE(8n, 20); // NextHeaderSize = 8 (the encoded-header descriptor below)
    const encHeader = Buffer.from([0x17, 0x06, 0x83, 0xe8, 0x01, 0x09, 0x81, 0xf4]);

    const reads: { offset: number; length: number }[] = [];
    const read = async (_id: string, offset: number, length: number) => {
      reads.push({ offset, length });
      if (offset === 0) return sig.subarray(0, length);
      if (offset === endStart) return encHeader.subarray(0, length);
      return Buffer.alloc(length, 0xcd); // stand-in packed-header bytes
    };

    const entries = await readSevenZListingRanged(
      [{ fileId: "1", fileSize: BigInt(size), fileName: "a.7z" }],
      read,
    );
    expect(reads[0]).toEqual({ offset: 0, length: 32 });
    expect(reads[1]).toEqual({ offset: endStart, length: 8 });
    expect(reads[2]).toEqual({ offset: packStart, length: packSize });
    expect(entries === null || Array.isArray(entries)).toBe(true);
  });
});
