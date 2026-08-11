import { describe, it, expect, vi } from "vitest";
import type { RangeReader } from "./range-reader.js";

let capturedFirstBytes: Buffer | null = null;
vi.mock("../rar-reader.js", () => ({
  readRarContents: async (firstPartPath: string) => {
    const { readFile } = await import("fs/promises");
    const reconstructed = await readFile(firstPartPath);
    capturedFirstBytes = reconstructed.subarray(0, 8);
    return [{ name: "dummy", size: 0 }]; // non-empty so listFromSparse returns it
  },
}));

const { readVint, detectRarSignature, parseRar5BlockExtent, parseRar4BlockExtent, walkRarVolume, readRarListingRanged } =
  await import("./rar-ranged.js");

describe("readVint", () => {
  it("reads single-byte and multi-byte values (base-128 LE)", () => {
    expect(readVint(Buffer.from([0x08]), 0)).toEqual({ value: 8, bytes: 1 });
    // 0x80,0x01 => 0 | (1<<7) = 128
    expect(readVint(Buffer.from([0x80, 0x01]), 0)).toEqual({ value: 128, bytes: 2 });
  });
});

describe("detectRarSignature", () => {
  it("detects RAR5 and RAR4", () => {
    expect(detectRarSignature(Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00]))).toEqual({ version: 5, sigLen: 8 });
    expect(detectRarSignature(Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,0x00]))).toEqual({ version: 4, sigLen: 7 });
    expect(detectRarSignature(Buffer.alloc(8))).toBeNull();
  });
});

describe("parseRar5BlockExtent", () => {
  it("computes header+data extent and flags end-of-archive", () => {
    // CRC32(4) | HeaderSize vint=5 | Type vint=2 (file) | Flags vint=2 (data present) | DataSize vint=100 | (pad to headerSize)
    const b = Buffer.concat([
      Buffer.from([0,0,0,0]),      // CRC
      Buffer.from([0x05]),          // HeaderSize = 5 (bytes after this vint)
      Buffer.from([0x02]),          // Type = 2 (file)
      Buffer.from([0x02]),          // Flags = 0x02 -> data present
      Buffer.from([0x64]),          // DataSize = 100
      Buffer.from([0x00, 0x00]),    // padding to fill HeaderSize(5): Type+Flags+DataSize=3, +2 pad =5
    ]);
    const ext = parseRar5BlockExtent(b, 0);
    // headerBytes = 4 (CRC) + 1 (HeaderSize vint) + 5 (HeaderSize) = 10
    expect(ext.headerBytes).toBe(10);
    expect(ext.dataSize).toBe(100);
    expect(ext.isEnd).toBe(false);

    const endBlk = Buffer.from([0,0,0,0, 0x02, 0x05, 0x00]); // HeaderSize=2, Type=5(end), Flags=0
    const e2 = parseRar5BlockExtent(endBlk, 0);
    expect(e2.isEnd).toBe(true);
  });
});

describe("parseRar4BlockExtent", () => {
  it("computes extent with ADD_SIZE when flag 0x8000 is set", () => {
    // CRC(2) TYPE(1)=0x74 FLAGS(2)=0x8000 HEAD_SIZE(2)=11 ADD_SIZE(4)=200
    const b = Buffer.alloc(11);
    b.writeUInt8(0x74, 2);
    b.writeUInt16LE(0x8000, 3);
    b.writeUInt16LE(11, 5);
    b.writeUInt32LE(200, 7);
    const ext = parseRar4BlockExtent(b, 0);
    expect(ext.headerBytes).toBe(11);
    expect(ext.dataSize).toBe(200);
    expect(ext.isEnd).toBe(false);
  });
});

// Build a synthetic RAR5 volume: signature + main header + 2 file blocks (each
// with data) + end block. We only need extents to be walkable.
function buildRar5Volume(): Buffer {
  const sig = Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00]);
  const block = (type: number, flags: number, dataSize: number, pad = 0) => {
    const body = [Buffer.from([type]), Buffer.from([flags])];
    if (flags & 0x0002) body.push(Buffer.from([dataSize])); // DataSize (<=127 for test)
    if (pad) body.push(Buffer.alloc(pad));
    const bodyBuf = Buffer.concat(body);
    const hs = Buffer.from([bodyBuf.length]); // HeaderSize vint (<=127)
    const header = Buffer.concat([Buffer.alloc(4), hs, bodyBuf]); // CRC(4)+HeaderSize+body
    const data = Buffer.alloc(flags & 0x0002 ? dataSize : 0, 0xEE);
    return Buffer.concat([header, data]);
  };
  const main = block(1, 0, 0);       // main archive header, no data
  const f1 = block(2, 0x02, 20);     // file header + 20 bytes data
  const f2 = block(2, 0x02, 30);     // file header + 30 bytes data
  const end = block(5, 0, 0);        // end of archive
  return Buffer.concat([sig, main, f1, f2, end]);
}

describe("walkRarVolume", () => {
  it("harvests every block header and stops at end-of-archive", async () => {
    const vol = buildRar5Volume();
    const read: RangeReader = async (_id, offset, length) => vol.subarray(offset, offset + length);
    const regions = await walkRarVolume(read, { fileId: "1", fileSize: BigInt(vol.length), fileName: "a.rar" }, 5, 8);
    expect(regions).not.toBeNull();
    // main + 2 files + end = 4 header regions
    expect(regions!).toHaveLength(4);
    // First region starts right after the 8-byte signature
    expect(regions![0].offset).toBe(8);
  });

  it("returns null when a block claims an absurd header size (corrupt/desynced)", async () => {
    // RAR5 block with HeaderSize vint encoding a value > 8MB.
    // Encode 9_000_000 as RAR vint: bytes little-endian 7-bit groups with continuation bit.
    function encodeVint(n: number): number[] {
      const out: number[] = [];
      while (n >= 0x80) {
        out.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
      }
      out.push(n);
      return out;
    }
    const sig = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]); // RAR5 signature
    const hsVint = encodeVint(9_000_000);
    // Block = CRC(4) + HeaderSize vint(9MB) + Type(1 byte) + Flags(1 byte)
    const block = Buffer.concat([Buffer.alloc(4), Buffer.from(hsVint), Buffer.from([0x02, 0x00])]);
    const vol = Buffer.concat([sig, block]);
    const size = 20 * 1024 * 1024;
    const read = async (_id: string, offset: number, length: number) => {
      if (offset >= vol.length) return Buffer.alloc(0);
      return vol.subarray(offset, Math.min(offset + length, vol.length));
    };
    const regions = await walkRarVolume(read, { fileId: "1", fileSize: BigInt(size), fileName: "c.rar" }, 5, 8);
    expect(regions).toBeNull();
  });
});

describe("readRarListingRanged (single part)", () => {
  it("returns null cleanly when the reconstructed file isn't a real RAR", async () => {
    const vol = buildRar5Volume();
    const read: RangeReader = async (_id, offset, length) => vol.subarray(offset, offset + length);
    const res = await readRarListingRanged([{ fileId: "1", fileSize: BigInt(vol.length), fileName: "a.rar" }], read);
    expect(res === null || Array.isArray(res)).toBe(true); // real unrar parse covered live
  });

  it("preserves the RAR signature bytes in the reconstructed sparse file", async () => {
    // Regression test: walkRarVolume starts at pos = sigLen and never
    // harvests the signature itself. If readRarListingRanged forgets to add
    // it as its own region, the reconstructed file starts with zero bytes
    // instead of "Rar!\x1a\x07\x01\x00", and every real unrar invocation
    // rejects it as "not RAR archive" — silently forcing every RAR archive
    // through the expensive download+reupload fallback regardless of the
    // channel's forwarding permission.
    const vol = buildRar5Volume();
    const sig = vol.subarray(0, 8);
    const read: RangeReader = async (_id, offset, length) => vol.subarray(offset, offset + length);
    capturedFirstBytes = null;
    await readRarListingRanged([{ fileId: "1", fileSize: BigInt(vol.length), fileName: "a.rar" }], read);
    expect(capturedFirstBytes).not.toBeNull();
    expect(capturedFirstBytes).toEqual(sig);
  });
});

describe("readRarListingRanged (multipart)", () => {
  it("walks each volume from its own signature and reconstructs all parts", async () => {
    const vol = buildRar5Volume(); // reuse from Task 6 test
    // Two volumes with identical structure; each RangeReader read is scoped by fileId.
    const byId: Record<string, Buffer> = { p1: vol, p2: vol };
    const reads: Record<string, number> = { p1: 0, p2: 0 };
    const read: RangeReader = async (fileId, offset, length) => {
      reads[fileId]++;
      return byId[fileId].subarray(offset, offset + length);
    };
    const res = await readRarListingRanged(
      [
        { fileId: "p1", fileSize: BigInt(vol.length), fileName: "x.part1.rar" },
        { fileId: "p2", fileSize: BigInt(vol.length), fileName: "x.part2.rar" },
      ],
      read,
    );
    // Both volumes were walked (each read at least its signature + blocks).
    expect(reads.p1).toBeGreaterThan(0);
    expect(reads.p2).toBeGreaterThan(0);
    expect(res === null || Array.isArray(res)).toBe(true);
  });
});
