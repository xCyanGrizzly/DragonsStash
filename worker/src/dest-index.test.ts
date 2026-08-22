import { describe, it, expect } from "vitest";
import { buildDestIndex, resolveDestPartSet } from "./dest-index.js";
import type { ChatDocument } from "./tdlib/chat-documents.js";

let nextId = 100;
function doc(fileName: string, opts: { id?: number; size?: number } = {}): ChatDocument {
  const id = opts.id ?? nextId++;
  return {
    id: BigInt(id),
    fileName,
    fileId: `f${id}`,
    fileSize: BigInt(opts.size ?? 1024),
    date: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("buildDestIndex + resolveDestPartSet — spanned ZIP recovery", () => {
  it("recovers the complete ordered volume set from the .z01 message alone", () => {
    const z01 = doc("Pack.z01", { id: 10 });
    const z02 = doc("Pack.z02", { id: 11 });
    const zip = doc("Pack.zip", { id: 12 });
    const index = buildDestIndex([z01, z02, zip, doc("Unrelated.zip", { id: 13 })]);

    const resolved = resolveDestPartSet(index, 10n, 3);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // .z01, .z02, then the bare .zip as the FINAL volume — the order the
    // EOCD-bearing tail read depends on.
    expect(resolved.parts.map((p) => p.fileName)).toEqual(["Pack.z01", "Pack.z02", "Pack.zip"]);
    expect(resolved.parts.map((p) => Number(p.id))).toEqual([10, 11, 12]);
    expect(resolved.kind).toBe("archive-set");
  });

  it("carries fileId and size through, so no getMessage call is needed per part", () => {
    const index = buildDestIndex([
      doc("Pack.z01", { id: 10, size: 500 }),
      doc("Pack.zip", { id: 11, size: 700 }),
    ]);
    const resolved = resolveDestPartSet(index, 10n, 2);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.parts.map((p) => p.fileId)).toEqual(["f10", "f11"]);
    expect(resolved.parts.map((p) => Number(p.fileSize))).toEqual([500, 700]);
  });
});

describe("resolveDestPartSet — refusing to guess", () => {
  it("reports a missing anchor message instead of inventing a set", () => {
    const index = buildDestIndex([doc("Pack.z01", { id: 10 }), doc("Pack.zip", { id: 11 })]);
    const resolved = resolveDestPartSet(index, 999n, 2);
    expect(resolved).toMatchObject({ ok: false });
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/was not found in the channel scan/);
  });

  it("refuses a set whose part count disagrees with the package", () => {
    // Two uploads sharing a base name get merged by groupArchiveSets into one
    // oversized set — writing that back would mix two archives together.
    const index = buildDestIndex([
      doc("Pack.z01", { id: 10 }),
      doc("Pack.z02", { id: 11 }),
      doc("Pack.zip", { id: 12 }),
    ]);
    const resolved = resolveDestPartSet(index, 10n, 2);
    expect(resolved).toMatchObject({ ok: false });
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/refusing to write an incomplete or merged set/);
  });

  it("resolves a genuine single-part package from its one message", () => {
    const index = buildDestIndex([doc("Solo.zip", { id: 20 })]);
    const resolved = resolveDestPartSet(index, 20n, 1);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    expect(resolved.parts.map((p) => p.fileName)).toEqual(["Solo.zip"]);
  });
});

describe("buildDestIndex — .concat.NNN repacks", () => {
  it("groups repack chunks that no archive pattern matches", () => {
    // These names are invisible to archive/detect.ts, so without their own
    // grouping a repacked package looks identical to one whose messages are gone.
    const index = buildDestIndex([
      doc("Pack.concat.003", { id: 32 }),
      doc("Pack.concat.001", { id: 30 }),
      doc("Pack.concat.002", { id: 31 }),
    ]);
    const resolved = resolveDestPartSet(index, 30n, 3);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.kind).toBe("concat-repack");
    expect(resolved.parts.map((p) => p.fileName)).toEqual([
      "Pack.concat.001",
      "Pack.concat.002",
      "Pack.concat.003",
    ]);
  });

  it("keeps two different repacks apart", () => {
    const index = buildDestIndex([
      doc("A.concat.001", { id: 40 }),
      doc("A.concat.002", { id: 41 }),
      doc("B.concat.001", { id: 50 }),
      doc("B.concat.002", { id: 51 }),
    ]);
    const a = resolveDestPartSet(index, 40n, 2);
    expect(a).toMatchObject({ ok: true });
    if (!a.ok) return;
    expect(a.parts.map((p) => Number(p.id))).toEqual([40, 41]);
  });
});
