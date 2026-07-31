import { describe, it, expect } from "vitest";
import { parseZipCentralDirectoryFromTail } from "./central-directory.js";
import { crc32 } from "zlib"; // Node 20+ exposes zlib.crc32

// Build a minimal STORE (no compression) ZIP in-memory with the given files.
function buildStoreZip(files: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const crc = crc32(f.data) >>> 0;
    const nameBuf = Buffer.from(f.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(0, 8);               // method = store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);  // compressed
    local.writeUInt32LE(f.data.length, 22);  // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra len
    const localHeader = Buffer.concat([local, nameBuf, f.data]);
    chunks.push(localHeader);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);            // local header offset
    central.push(Buffer.concat([cd, nameBuf]));
    offset += localHeader.length;
  }
  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

describe("parseZipCentralDirectoryFromTail", () => {
  it("lists entries with correct names, sizes, and crc32", () => {
    const zip = buildStoreZip([
      { name: "models/dragon.stl", data: Buffer.from("DRAGON") },
      { name: "readme.txt", data: Buffer.from("hello world") },
    ]);
    const entries = parseZipCentralDirectoryFromTail(zip, 0);
    expect(entries.map((e) => e.fileName).sort()).toEqual(["dragon.stl", "readme.txt"]);
    const dragon = entries.find((e) => e.fileName === "dragon.stl")!;
    expect(dragon.path).toBe("models/dragon.stl");
    expect(dragon.uncompressedSize).toBe(6n);
    expect(dragon.crc32).toMatch(/^[0-9a-f]{8}$/);
  });

  it("throws when the central directory begins before the tail window", () => {
    const zip = buildStoreZip([{ name: "a.txt", data: Buffer.alloc(100) }]);
    // Provide only the last 30 bytes but claim they start at offset (len-30):
    const tail = zip.subarray(zip.length - 30);
    expect(() => parseZipCentralDirectoryFromTail(tail, zip.length - 30)).toThrow(RangeError);
  });
});
