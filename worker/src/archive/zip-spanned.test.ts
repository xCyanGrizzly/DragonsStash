import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import path from "path";
import { isSpannedZipPartSet } from "./zip-spanned.js";
import { readZipCentralDirectory } from "./zip-reader.js";
import { buildSpannedStoreZip, buildStoreZip, byteSplit } from "./testing/spanned-zip-fixture.js";

const execFileAsync = promisify(execFile);

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zip-spanned-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write volume buffers out under the given names and return their paths. */
async function writeParts(names: string[], buffers: Buffer[], sub: string): Promise<string[]> {
  const base = path.join(dir, sub);
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const p = path.join(base, names[i]);
    await writeFile(p, buffers[i]);
    paths.push(p);
  }
  return paths;
}

const FILES = [
  { name: "src/b.bin", data: Buffer.alloc(2048, 7), disk: 0 },
  { name: "src/models/dragon.stl", data: Buffer.from("DRAGON"), disk: 1 },
  { name: "src/models/", data: Buffer.alloc(0), disk: 1 },
  { name: "src/a.bin", data: Buffer.alloc(4096, 3), disk: 2 },
  { name: "readme.txt", data: Buffer.from("hello world"), disk: 3 },
];

describe("isSpannedZipPartSet", () => {
  it("recognizes a .z01 + .zip volume set", () => {
    expect(isSpannedZipPartSet(["/t/Pack.z01", "/t/Pack.z02", "/t/Pack.zip"])).toBe(true);
  });

  it("recognizes the set regardless of the order it is handed in", () => {
    expect(isSpannedZipPartSet(["/t/Pack.zip", "/t/Pack.z02", "/t/Pack.z01"])).toBe(true);
  });

  it("rejects a 7-Zip raw byte split (.zip.001)", () => {
    expect(isSpannedZipPartSet(["/t/Pack.zip.001", "/t/Pack.zip.002"])).toBe(false);
  });

  it("rejects a single .zip", () => {
    expect(isSpannedZipPartSet(["/t/Pack.zip"])).toBe(false);
  });

  it("rejects a set with no final .zip volume", () => {
    expect(isSpannedZipPartSet(["/t/Pack.z01", "/t/Pack.z02"])).toBe(false);
  });

  it("rejects a set with two .zip volumes", () => {
    expect(isSpannedZipPartSet(["/t/A.zip", "/t/B.zip"])).toBe(false);
  });
});

describe("readZipCentralDirectory on a spanned (.z01 + .zip) set", () => {
  it("lists every entry with correct paths, sizes and crc32", async () => {
    const vols = buildSpannedStoreZip(FILES, 4);
    const paths = await writeParts(["Pack.z01", "Pack.z02", "Pack.z03", "Pack.zip"], vols, "spanned");

    const entries = await readZipCentralDirectory(paths);

    expect(entries.map((e) => e.path).sort()).toEqual([
      "readme.txt",
      "src/a.bin",
      "src/b.bin",
      "src/models/dragon.stl",
    ]);
    const dragon = entries.find((e) => e.fileName === "dragon.stl")!;
    expect(dragon.uncompressedSize).toBe(6n);
    expect(dragon.extension).toBe("stl");
    expect(dragon.crc32).toMatch(/^[0-9a-f]{8}$/);
    const a = entries.find((e) => e.fileName === "a.bin")!;
    expect(a.uncompressedSize).toBe(4096n);
    expect(a.compressedSize).toBe(4096n);
  });

  it("works when the parts are handed over out of volume order", async () => {
    const vols = buildSpannedStoreZip(FILES, 4);
    const paths = await writeParts(["Pack.z01", "Pack.z02", "Pack.z03", "Pack.zip"], vols, "unordered");
    const shuffled = [paths[3], paths[1], paths[0], paths[2]];

    const entries = await readZipCentralDirectory(shuffled);
    expect(entries).toHaveLength(4);
  });

  it("reads a central directory that begins on an earlier volume and spills forward", async () => {
    // Files live on volumes 0–2; the directory starts on volume 2 and
    // continues onto the final .zip, which holds nothing else.
    const spillFiles = FILES.map((f) => ({ ...f, disk: Math.min(f.disk, 2) }));
    const vols = buildSpannedStoreZip(spillFiles, 4, { cdStartDisk: 2 });
    const paths = await writeParts(["Pack.z01", "Pack.z02", "Pack.z03", "Pack.zip"], vols, "spilled");

    const entries = await readZipCentralDirectory(paths);
    expect(entries.map((e) => e.fileName).sort()).toEqual(["a.bin", "b.bin", "dragon.stl", "readme.txt"]);
  });

  it("returns [] instead of throwing when a needed volume is missing", async () => {
    const spillFiles = FILES.map((f) => ({ ...f, disk: Math.min(f.disk, 1) }));
    const vols = buildSpannedStoreZip(spillFiles, 3, { cdStartDisk: 1 });
    const paths = await writeParts(["Pack.z01", "Pack.z02", "Pack.zip"], vols, "missing");
    // Drop Pack.z02 — the volume the central directory starts on.
    const entries = await readZipCentralDirectory([paths[0], paths[2]]);
    expect(entries).toEqual([]);
  });

  it("returns [] instead of throwing when the final volume is garbage", async () => {
    const vols = buildSpannedStoreZip([{ name: "x.stl", data: Buffer.alloc(64, 1), disk: 0 }], 2);
    const paths = await writeParts(["Pack.z01", "Pack.zip"], [vols[0], Buffer.alloc(500, 0x5a)], "garbage");
    expect(await readZipCentralDirectory(paths)).toEqual([]);
  });

  it("falls back to concatenation semantics when .z01-named parts are really a byte split", async () => {
    // Some producers name a raw byte split .z01/.zip. The EOCD then reports
    // disk 0, so concatenation — not volume mapping — is the correct reading.
    const zip = buildStoreZip([
      { name: "one.stl", data: Buffer.alloc(3000, 1) },
      { name: "two.stl", data: Buffer.alloc(3000, 2) },
    ]);
    const paths = await writeParts(["Pack.z01", "Pack.zip"], byteSplit(zip, 2), "mislabeled");
    const entries = await readZipCentralDirectory(paths);
    expect(entries.map((e) => e.fileName).sort()).toEqual(["one.stl", "two.stl"]);
  });
});

describe("readZipCentralDirectory regressions for the shapes that already worked", () => {
  it("still reads a 7-Zip raw byte split (.zip.001 …)", async () => {
    const zip = buildStoreZip([
      { name: "models/knight.stl", data: Buffer.alloc(5000, 9) },
      { name: "license.txt", data: Buffer.from("MIT") },
    ]);
    const paths = await writeParts(
      ["Pack.zip.001", "Pack.zip.002", "Pack.zip.003"],
      byteSplit(zip, 3),
      "bytesplit"
    );
    const entries = await readZipCentralDirectory(paths);
    expect(entries.map((e) => e.fileName).sort()).toEqual(["knight.stl", "license.txt"]);
    expect(entries.find((e) => e.fileName === "knight.stl")!.uncompressedSize).toBe(5000n);
  });

  it("still reads a plain single .zip", async () => {
    const zip = buildStoreZip([{ name: "solo.stl", data: Buffer.from("SOLO") }]);
    const paths = await writeParts(["Pack.zip"], [zip], "single");
    const entries = await readZipCentralDirectory(paths);
    expect(entries.map((e) => e.fileName)).toEqual(["solo.stl"]);
  });
});

// ── Cross-checks against real Info-ZIP output ────────────────────────────
// Skipped automatically where the `zip` CLI is unavailable; the hand-built
// fixtures above are the authoritative, portable coverage.

const HAS_ZIP_CLI = await execFileAsync("zip", ["-v"]).then(
  () => true,
  () => false
);

/** Collect Pack.z01 … Pack.zip from a directory, in volume order. */
async function collectVolumes(work: string): Promise<string[]> {
  const names = await readdir(work);
  const vols = names.filter((n) => /^Pack\.z\d{2,}$/i.test(n)).sort();
  const final = names.find((n) => /^Pack\.zip$/i.test(n));
  expect(final).toBeDefined();
  expect(vols.length).toBeGreaterThan(0);
  return [...vols, final!].map((n) => path.join(work, n));
}

describe.skipIf(!HAS_ZIP_CLI)("readZipCentralDirectory against archives produced by Info-ZIP `zip -s`", () => {
  it("lists a genuine spanned archive", async () => {
    const work = path.join(dir, "real");
    await mkdir(path.join(work, "src/models"), { recursive: true });
    await writeFile(path.join(work, "src/big.bin"), Buffer.alloc(300_000, 4));
    await writeFile(path.join(work, "src/models/dragon.stl"), Buffer.alloc(200_000, 5));
    await writeFile(path.join(work, "src/readme.txt"), "hello world");
    await execFileAsync("zip", ["-r", "-0", "-s", "100k", "Pack.zip", "src"], { cwd: work });

    const entries = await readZipCentralDirectory(await collectVolumes(work));
    expect(entries.map((e) => e.path).sort()).toEqual([
      "src/big.bin",
      "src/models/dragon.stl",
      "src/readme.txt",
    ]);
    expect(entries.find((e) => e.fileName === "dragon.stl")!.uncompressedSize).toBe(200_000n);
  });

  it("lists a genuine ZIP64 spanned archive", async () => {
    const work = path.join(dir, "real64");
    await mkdir(work, { recursive: true });
    await writeFile(path.join(work, "big.bin"), Buffer.alloc(300_000, 6));
    await writeFile(path.join(work, "note.txt"), "zip64 spanned");
    // -fz forces ZIP64 structures even though the payload is small.
    await execFileAsync("zip", ["-0", "-fz", "-s", "100k", "Pack.zip", "big.bin", "note.txt"], { cwd: work });

    const entries = await readZipCentralDirectory(await collectVolumes(work));
    expect(entries.map((e) => e.fileName).sort()).toEqual(["big.bin", "note.txt"]);
    expect(entries.find((e) => e.fileName === "big.bin")!.uncompressedSize).toBe(300_000n);
  });
});
