import { describe, it, expect } from "vitest";
import { groupArchiveSets, type TelegramMessage } from "./multipart.js";

let nextId = 1000n;

function msg(fileName: string): TelegramMessage {
  const id = nextId++;
  return {
    id,
    fileName,
    fileId: `file-${id}`,
    fileSize: 1024n,
    date: new Date("2026-01-01T00:00:00Z"),
  };
}

function names(files: string[]): string[] {
  const sets = groupArchiveSets(files.map(msg));
  expect(sets).toHaveLength(1);
  return sets[0].parts.map((p) => p.fileName);
}

describe("groupArchiveSets — legacy split part ordering", () => {
  it("puts the bare .rar FIRST in a RAR_LEGACY set (it is volume 1)", () => {
    expect(names(["Pack.r01", "Pack.rar", "Pack.r00"])).toEqual([
      "Pack.rar",
      "Pack.r00",
      "Pack.r01",
    ]);
  });

  it("puts the bare .zip LAST in a ZIP_LEGACY set (it is the final disk)", () => {
    expect(names(["Pack.z02", "Pack.zip", "Pack.z01"])).toEqual([
      "Pack.z01",
      "Pack.z02",
      "Pack.zip",
    ]);
  });

  it("marks both legacy sets as multipart with the right format", () => {
    const rar = groupArchiveSets([msg("Pack.rar"), msg("Pack.r00")])[0];
    expect(rar.isMultipart).toBe(true);
    expect(rar.type).toBe("RAR");

    const zip = groupArchiveSets([msg("Pack.zip"), msg("Pack.z01")])[0];
    expect(zip.isMultipart).toBe(true);
    expect(zip.type).toBe("ZIP");
  });

  it("orders numbered volume sets by part number", () => {
    expect(names(["Pack.rar.003", "Pack.rar.001", "Pack.rar.002"])).toEqual([
      "Pack.rar.001",
      "Pack.rar.002",
      "Pack.rar.003",
    ]);
  });

  it("orders .partN sets by part number with an SFX first volume", () => {
    expect(names(["Pack.part3.rar", "Pack.part1.exe", "Pack.part2.rar"])).toEqual([
      "Pack.part1.exe",
      "Pack.part2.rar",
      "Pack.part3.rar",
    ]);
  });

  it("treats unrelated singles as their own non-multipart sets", () => {
    const sets = groupArchiveSets([msg("A.zip"), msg("B.rar")]);
    expect(sets).toHaveLength(2);
    expect(sets.every((s) => !s.isMultipart)).toBe(true);
    expect(sets.every((s) => s.parts.length === 1)).toBe(true);
  });
});
