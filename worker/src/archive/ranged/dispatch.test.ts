import { describe, it, expect } from "vitest";
import { readScannedListingRanged, readScannedZipListing } from "./dispatch.js";
import type { RangeReader } from "./range-reader.js";
import { buildSpannedStoreZip, buildStoreZip, byteSplit } from "../testing/spanned-zip-fixture.js";

/** Serve ranged reads out of in-memory part buffers keyed by fileId. */
function readerFor(parts: { fileId: string; buf: Buffer }[]): RangeReader {
  const byId = new Map(parts.map((p) => [p.fileId, p.buf]));
  return async (fileId, offset, length) => {
    const buf = byId.get(fileId);
    if (!buf) throw new Error(`unknown fileId ${fileId}`);
    return buf.subarray(offset, offset + length);
  };
}

const FILES = [
  { name: "src/b.bin", data: Buffer.alloc(2048, 7), disk: 0 },
  { name: "src/models/dragon.stl", data: Buffer.from("DRAGON"), disk: 1 },
  { name: "readme.txt", data: Buffer.from("hello world"), disk: 2 },
];

describe("readScannedListingRanged", () => {
  it("returns null for an unknown archive type without calling the reader", async () => {
    const result = await readScannedListingRanged(
      "DOCUMENT",
      { invoke: async () => ({}) } as never,
      [{ fileId: "1", fileSize: 100n, fileName: "a.pdf" }],
    );
    expect(result).toBeNull();
  });
});

describe("readScannedZipListing", () => {
  it("lists a ZIP-spec spanned set (.z01 … .zip) from the final volume's tail", async () => {
    const vols = buildSpannedStoreZip(FILES, 3);
    const names = ["Pack.z01", "Pack.z02", "Pack.zip"];
    const parts = vols.map((buf, i) => ({ fileId: String(i), fileSize: BigInt(buf.length), fileName: names[i] }));

    const entries = await readScannedZipListing(
      parts,
      readerFor(parts.map((p, i) => ({ fileId: p.fileId, buf: vols[i] }))),
    );

    expect(entries).not.toBeNull();
    expect(entries!.map((e) => e.path).sort()).toEqual([
      "readme.txt",
      "src/b.bin",
      "src/models/dragon.stl",
    ]);
  });

  it("only reads the final volume — the earlier volumes are never downloaded", async () => {
    const vols = buildSpannedStoreZip(FILES, 3);
    const names = ["Pack.z01", "Pack.z02", "Pack.zip"];
    const parts = vols.map((buf, i) => ({ fileId: String(i), fileSize: BigInt(buf.length), fileName: names[i] }));
    const touched: string[] = [];
    const base = readerFor(parts.map((p, i) => ({ fileId: p.fileId, buf: vols[i] })));

    await readScannedZipListing(parts, async (id, off, len, size) => {
      touched.push(id);
      return base(id, off, len, size);
    });

    expect([...new Set(touched)]).toEqual(["2"]);
  });

  it("still lists a 7-Zip raw byte split (.zip.001 …) using whole-archive offsets", async () => {
    const zip = buildStoreZip([
      { name: "models/knight.stl", data: Buffer.alloc(5000, 9) },
      { name: "license.txt", data: Buffer.from("MIT") },
    ]);
    const chunks = byteSplit(zip, 3);
    const names = ["Pack.zip.001", "Pack.zip.002", "Pack.zip.003"];
    const parts = chunks.map((buf, i) => ({ fileId: String(i), fileSize: BigInt(buf.length), fileName: names[i] }));

    const entries = await readScannedZipListing(
      parts,
      readerFor(parts.map((p, i) => ({ fileId: p.fileId, buf: chunks[i] }))),
    );

    expect(entries!.map((e) => e.fileName).sort()).toEqual(["knight.stl", "license.txt"]);
  });

  it("returns null for a spanned set whose central directory starts on an earlier volume", async () => {
    const vols = buildSpannedStoreZip(
      FILES.map((f) => ({ ...f, disk: Math.min(f.disk, 1) })),
      3,
      { cdStartDisk: 1 },
    );
    const names = ["Pack.z01", "Pack.z02", "Pack.zip"];
    const parts = vols.map((buf, i) => ({ fileId: String(i), fileSize: BigInt(buf.length), fileName: names[i] }));

    const entries = await readScannedZipListing(
      parts,
      readerFor(parts.map((p, i) => ({ fileId: p.fileId, buf: vols[i] }))),
    );
    expect(entries).toBeNull();
  });

  it("returns null when there are no parts", async () => {
    expect(await readScannedZipListing([], readerFor([]))).toBeNull();
  });
});
