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

import { read7zNumber, locate7zEncodedHeaderPack, mapRangeToVolumes, planSevenZSparseParts } from "./sevenz-ranged.js";
import type { RangedPart } from "./sevenz-ranged.js";
import type { SparsePart } from "./sparse-list.js";

describe("mapRangeToVolumes", () => {
  it("maps a range fully inside one volume", () => {
    expect(mapRangeToVolumes([100, 100, 100], 120, 30)).toEqual([
      { partIndex: 1, offset: 20, length: 30 },
    ]);
  });

  it("splits a range that straddles a volume boundary", () => {
    expect(mapRangeToVolumes([100, 100], 90, 20)).toEqual([
      { partIndex: 0, offset: 90, length: 10 },
      { partIndex: 1, offset: 0, length: 10 },
    ]);
  });

  it("spans three volumes when the range swallows a whole middle volume", () => {
    expect(mapRangeToVolumes([100, 50, 100], 90, 80)).toEqual([
      { partIndex: 0, offset: 90, length: 10 },
      { partIndex: 1, offset: 0, length: 50 },
      { partIndex: 2, offset: 0, length: 20 },
    ]);
  });

  it("degenerates to a single-volume identity mapping", () => {
    expect(mapRangeToVolumes([5_000_000], 4_900_000, 100)).toEqual([
      { partIndex: 0, offset: 4_900_000, length: 100 },
    ]);
  });

  it("returns null when the range runs past the concatenated end", () => {
    expect(mapRangeToVolumes([100, 100], 190, 20)).toBeNull();
    expect(mapRangeToVolumes([100], 100, 1)).toBeNull();
  });

  it("returns null for negative offsets or lengths", () => {
    expect(mapRangeToVolumes([100], -1, 10)).toBeNull();
    expect(mapRangeToVolumes([100], 10, -1)).toBeNull();
  });

  it("returns no slices for a zero-length range", () => {
    expect(mapRangeToVolumes([100, 100], 150, 0)).toEqual([]);
  });
});

/**
 * A `.7z.001`/`.7z.002` set is a raw byte split of one logical 7z file, so
 * fixtures are built as a single logical stream and then cut into volumes.
 * No real `7z` binary is needed (and none is installed here) because the
 * contract under test is the whole-archive-offset mapping, not `7z l` parsing.
 */
function buildLogical7z(opts: {
  total: number;
  nextHeaderStart: number; // absolute offset in the logical stream
  nextHeader: Buffer;
  pack?: { start: number; bytes: Buffer }; // absolute offset of packed header bytes
}): Buffer {
  const buf = Buffer.alloc(opts.total, 0x5a); // 0x5a stands in for file payload
  MAGIC.copy(buf, 0);
  buf.writeUInt8(0, 6); buf.writeUInt8(4, 7);
  buf.writeUInt32LE(0, 8);
  buf.writeBigUInt64LE(BigInt(opts.nextHeaderStart - 32), 12); // NextHeaderOffset
  buf.writeBigUInt64LE(BigInt(opts.nextHeader.length), 20);    // NextHeaderSize
  buf.writeUInt32LE(0, 28);
  opts.nextHeader.copy(buf, opts.nextHeaderStart);
  if (opts.pack) opts.pack.bytes.copy(buf, opts.pack.start);
  return buf;
}

function splitIntoVolumes(logical: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  for (const s of sizes) { out.push(logical.subarray(pos, pos + s)); pos += s; }
  return out;
}

function volumeSet(volumes: Buffer[]): {
  parts: RangedPart[];
  read: RangeReader;
  reads: { fileId: string; offset: number; length: number }[];
} {
  const parts = volumes.map((v, i) => ({
    fileId: `v${i + 1}`,
    fileSize: BigInt(v.length),
    fileName: `pack.7z.${String(i + 1).padStart(3, "0")}`,
  }));
  const reads: { fileId: string; offset: number; length: number }[] = [];
  const read: RangeReader = async (fileId, offset, length) => {
    reads.push({ fileId, offset, length });
    const vol = volumes[parts.findIndex((p) => p.fileId === fileId)];
    return Buffer.from(vol.subarray(offset, offset + length));
  };
  return { parts, read, reads };
}

/** Rebuild the logical stream from the sparse per-volume reconstructions. */
function reconstruct(sparseParts: SparsePart[]): Buffer {
  return Buffer.concat(
    sparseParts.map((p) => {
      const b = Buffer.alloc(p.size);
      for (const r of p.regions) r.bytes.copy(b, r.offset);
      return b;
    }),
  );
}

describe("readSevenZListingRanged — multi-volume (.7z.001, .7z.002, ...)", () => {
  it("reads the next header from the LAST volume, not the first", async () => {
    // Volume 1 is 200 bytes; the index sits at logical 280 — inside volume 2.
    const nextHeader = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(19, 0x11)]);
    const logical = buildLogical7z({ total: 300, nextHeaderStart: 280, nextHeader });
    const { parts, read, reads } = volumeSet(splitIntoVolumes(logical, [200, 100]));

    const sparse = await planSevenZSparseParts(parts, read);
    expect(sparse).not.toBeNull();

    expect(reads).toEqual([
      { fileId: "v1", offset: 0, length: 32 },   // signature header: volume 1
      { fileId: "v2", offset: 80, length: 20 },  // next header: volume 2 @ 280-200
    ]);
    // Both volumes are reconstructed so `7z l pack.7z.001` can concatenate them.
    expect(sparse!.map((p) => [p.fileName, p.size])).toEqual([
      ["pack.7z.001", 200],
      ["pack.7z.002", 100],
    ]);
    const rebuilt = reconstruct(sparse!);
    expect(rebuilt.length).toBe(300);
    expect(rebuilt.subarray(0, 32).equals(logical.subarray(0, 32))).toBe(true);
    expect(rebuilt.subarray(280, 300).equals(nextHeader)).toBe(true);
  });

  it("fetches an encoded header's packed bytes from whichever middle volume holds them", async () => {
    // 3 volumes of 100. Packed header bytes at logical 150 (volume 2), index at 270 (volume 3).
    // kEncodedHeader, kPackInfo, PackPos=118, NumStreams=1, kSize, PackSize=24
    const encHeader = Buffer.from([0x17, 0x06, 0x76, 0x01, 0x09, 0x18]);
    const packBytes = Buffer.alloc(24, 0x77);
    const logical = buildLogical7z({
      total: 300,
      nextHeaderStart: 270,
      nextHeader: encHeader,
      pack: { start: 150, bytes: packBytes },
    });
    const { parts, read, reads } = volumeSet(splitIntoVolumes(logical, [100, 100, 100]));

    const sparse = await planSevenZSparseParts(parts, read);
    expect(sparse).not.toBeNull();
    expect(reads).toEqual([
      { fileId: "v1", offset: 0, length: 32 },
      { fileId: "v3", offset: 70, length: 6 },   // index in the last volume
      { fileId: "v2", offset: 50, length: 24 },  // packed header in the middle volume
    ]);
    expect(sparse!).toHaveLength(3);
    const rebuilt = reconstruct(sparse!);
    expect(rebuilt.subarray(150, 174).equals(packBytes)).toBe(true);
    expect(rebuilt.subarray(270, 276).equals(encHeader)).toBe(true);
  });

  it("splits a header range that straddles a volume boundary into two reads", async () => {
    // Index is 40 bytes starting at logical 180: last 20 bytes of volume 2 (100..200)
    // and first 20 bytes of volume 3.
    const nextHeader = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(39, 0x22)]);
    const logical = buildLogical7z({ total: 300, nextHeaderStart: 180, nextHeader });
    const { parts, read, reads } = volumeSet(splitIntoVolumes(logical, [100, 100, 100]));

    const sparse = await planSevenZSparseParts(parts, read);
    expect(sparse).not.toBeNull();
    expect(reads).toEqual([
      { fileId: "v1", offset: 0, length: 32 },
      { fileId: "v2", offset: 80, length: 20 },
      { fileId: "v3", offset: 0, length: 20 },
    ]);
    // Byte-exact across the seam.
    expect(reconstruct(sparse!).subarray(180, 220).equals(nextHeader)).toBe(true);
  });

  it("splits an encoded header's packed bytes across a volume boundary", async () => {
    // PackPos=58 -> packStart 90, PackSize=30 -> 90..120 straddles volumes 1|2.
    const encHeader = Buffer.from([0x17, 0x06, 0x3a, 0x01, 0x09, 0x1e]);
    const packBytes = Buffer.alloc(30, 0x99);
    const logical = buildLogical7z({
      total: 300,
      nextHeaderStart: 290,
      nextHeader: encHeader,
      pack: { start: 90, bytes: packBytes },
    });
    const { parts, read, reads } = volumeSet(splitIntoVolumes(logical, [100, 100, 100]));

    const sparse = await planSevenZSparseParts(parts, read);
    expect(sparse).not.toBeNull();
    expect(reads).toEqual([
      { fileId: "v1", offset: 0, length: 32 },
      { fileId: "v3", offset: 90, length: 6 },
      { fileId: "v1", offset: 90, length: 10 },
      { fileId: "v2", offset: 0, length: 20 },
    ]);
    expect(reconstruct(sparse!).subarray(90, 120).equals(packBytes)).toBe(true);
  });

  it("keeps a single-volume .7z reading exactly as before", async () => {
    const nextHeader = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(19, 0x33)]);
    const logical = buildLogical7z({ total: 300, nextHeaderStart: 280, nextHeader });
    const { parts, read, reads } = volumeSet([logical]);

    const sparse = await planSevenZSparseParts(parts, read);
    expect(reads).toEqual([
      { fileId: "v1", offset: 0, length: 32 },
      { fileId: "v1", offset: 280, length: 20 },
    ]);
    expect(sparse!).toHaveLength(1);
    expect(sparse![0].size).toBe(300);
    expect(reconstruct(sparse!).subarray(280, 300).equals(nextHeader)).toBe(true);
  });

  it("returns null when the next-header offset points past the whole set", async () => {
    const nextHeader = Buffer.from([0x01, 0x00]);
    // Claim the index lives at 5000 while the set totals only 300 bytes.
    const logical = buildLogical7z({ total: 300, nextHeaderStart: 280, nextHeader });
    logical.writeBigUInt64LE(BigInt(5000 - 32), 12);
    const { parts, read } = volumeSet(splitIntoVolumes(logical, [200, 100]));
    expect(await planSevenZSparseParts(parts, read)).toBeNull();
  });

  it("returns null on an unrecognized next-header type", async () => {
    const logical = buildLogical7z({
      total: 300,
      nextHeaderStart: 280,
      nextHeader: Buffer.from([0x42, 0x00]),
    });
    const { parts, read } = volumeSet(splitIntoVolumes(logical, [200, 100]));
    expect(await planSevenZSparseParts(parts, read)).toBeNull();
  });

  it("returns null when the first volume has no 7z signature", async () => {
    const logical = Buffer.alloc(300, 0x00);
    const { parts, read } = volumeSet(splitIntoVolumes(logical, [200, 100]));
    expect(await planSevenZSparseParts(parts, read)).toBeNull();
  });

  it("returns null for an empty part list", async () => {
    expect(await planSevenZSparseParts([], async () => Buffer.alloc(0))).toBeNull();
  });
});

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
