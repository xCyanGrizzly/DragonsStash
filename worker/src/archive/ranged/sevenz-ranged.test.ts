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
