import { describe, it, expect } from "vitest";
import { detectArchive, isArchiveAttachment } from "./detect.js";

describe("detectArchive — 7z numbered multipart (pack.7z.001, pack.7z.002, ...)", () => {
  it("recognizes a 7z multipart part as an archive attachment", () => {
    expect(isArchiveAttachment("Lost Adventures Vol2.7z.001")).toBe(true);
  });

  it("extracts format, baseName, and partNumber", () => {
    const info = detectArchive("Lost Adventures Vol2.7z.001");
    expect(info).toEqual({
      baseName: "Lost Adventures Vol2.7z",
      partNumber: 1,
      format: "7Z",
      pattern: "SEVENZ_NUMBERED",
    });
  });

  it("groups multiple parts under the same baseName + format key regardless of part number", () => {
    const part1 = detectArchive("Lost Adventures Vol2.7z.001");
    const part2 = detectArchive("Lost Adventures Vol2.7z.010");
    expect(part1?.baseName).toBe(part2?.baseName);
    expect(part1?.format).toBe(part2?.format);
    expect(part2?.partNumber).toBe(10);
  });

  it("is case-insensitive on the .7z extension", () => {
    expect(detectArchive("Archive.7Z.002")?.format).toBe("7Z");
  });

  it("still recognizes a standalone single .7z file", () => {
    expect(detectArchive("Single Pack.7z")).toEqual({
      baseName: "Single Pack",
      partNumber: -1,
      format: "7Z",
      pattern: "SINGLE",
    });
  });
});
