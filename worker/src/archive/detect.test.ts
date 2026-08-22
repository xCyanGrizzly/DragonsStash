import { describe, it, expect } from "vitest";
import { detectArchive, isArchiveAttachment } from "./detect.js";

describe("detectArchive — numbered volumes (pack.EXT.001, pack.EXT.002, ...)", () => {
  it("recognizes a 7z multipart part as an archive attachment", () => {
    expect(isArchiveAttachment("Lost Adventures Vol2.7z.001")).toBe(true);
  });

  it("extracts format, baseName, and partNumber", () => {
    const info = detectArchive("Lost Adventures Vol2.7z.001");
    expect(info).toEqual({
      baseName: "Lost Adventures Vol2.7z",
      partNumber: 1,
      format: "7Z",
      pattern: "ARCHIVE_NUMBERED",
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

  it("recognizes numbered ZIP volumes", () => {
    expect(detectArchive("Big Pack.zip.001")).toEqual({
      baseName: "Big Pack.zip",
      partNumber: 1,
      format: "ZIP",
      pattern: "ARCHIVE_NUMBERED",
    });
  });

  it("recognizes numbered RAR volumes (previously dropped silently)", () => {
    expect(detectArchive("Big Pack.rar.001")).toEqual({
      baseName: "Big Pack.rar",
      partNumber: 1,
      format: "RAR",
      pattern: "ARCHIVE_NUMBERED",
    });
  });

  it("derives the format from the archive extension, not a hardcoded value", () => {
    expect(detectArchive("A.zip.004")?.format).toBe("ZIP");
    expect(detectArchive("A.RAR.004")?.format).toBe("RAR");
    expect(detectArchive("A.7z.004")?.format).toBe("7Z");
  });

  it("accepts hand-renamed two-digit volumes for every format", () => {
    expect(detectArchive("Pack.zip.01")).toEqual({
      baseName: "Pack.zip",
      partNumber: 1,
      format: "ZIP",
      pattern: "ARCHIVE_NUMBERED",
    });
    expect(detectArchive("Pack.rar.02")?.partNumber).toBe(2);
    expect(detectArchive("Pack.7z.03")?.partNumber).toBe(3);
  });

  it("still accepts four-or-more-digit volumes", () => {
    expect(detectArchive("Pack.7z.0001")).toEqual({
      baseName: "Pack.7z",
      partNumber: 1,
      format: "7Z",
      pattern: "ARCHIVE_NUMBERED",
    });
    expect(detectArchive("Pack.zip.10001")?.partNumber).toBe(10001);
  });

  it("does not match a single-digit suffix (too ambiguous with real extensions)", () => {
    expect(detectArchive("Pack.zip.1")).toBeNull();
  });
});

describe("detectArchive — pattern ordering safety", () => {
  it("does not let ZIP_LEGACY swallow a .7z.NNN name", () => {
    expect(detectArchive("Pack.7z.001")?.pattern).toBe("ARCHIVE_NUMBERED");
    expect(detectArchive("Pack.7z.001")?.format).toBe("7Z");
  });

  it("does not let ARCHIVE_NUMBERED swallow legacy .zNN names", () => {
    expect(detectArchive("Pack.z01")).toEqual({
      baseName: "Pack",
      partNumber: 1,
      format: "ZIP",
      pattern: "ZIP_LEGACY",
    });
  });

  it("does not let ARCHIVE_NUMBERED swallow legacy .rNN names", () => {
    expect(detectArchive("Pack.r00")).toEqual({
      baseName: "Pack",
      partNumber: 0,
      format: "RAR",
      pattern: "RAR_LEGACY",
    });
    expect(detectArchive("Pack.r01")?.pattern).toBe("RAR_LEGACY");
  });

  it("keeps .partN.rar on the RAR_PART pattern", () => {
    expect(detectArchive("Pack.part2.rar")).toEqual({
      baseName: "Pack",
      partNumber: 2,
      format: "RAR",
      pattern: "RAR_PART",
    });
  });
});

describe("detectArchive — filename normalization", () => {
  it("recognizes a name with a trailing space and reports the trimmed baseName", () => {
    expect(detectArchive("Pack.zip ")).toEqual({
      baseName: "Pack",
      partNumber: -1,
      format: "ZIP",
      pattern: "SINGLE",
    });
  });

  it("recognizes a name with a leading space", () => {
    expect(detectArchive("  Pack.rar")).toEqual({
      baseName: "Pack",
      partNumber: -1,
      format: "RAR",
      pattern: "SINGLE",
    });
  });

  it("recognizes a multipart name with surrounding whitespace", () => {
    expect(detectArchive("\tPack.rar.002 \n")).toEqual({
      baseName: "Pack.rar",
      partNumber: 2,
      format: "RAR",
      pattern: "ARCHIVE_NUMBERED",
    });
  });

  it("recognizes a name with a trailing dot", () => {
    expect(detectArchive("Pack.zip.")).toEqual({
      baseName: "Pack",
      partNumber: -1,
      format: "ZIP",
      pattern: "SINGLE",
    });
  });

  it("recognizes a name with a trailing dot followed by a space", () => {
    expect(detectArchive("Pack.part3.rar. ")?.pattern).toBe("RAR_PART");
  });

  it("still returns null for a whitespace-only or empty name", () => {
    expect(detectArchive("   ")).toBeNull();
    expect(detectArchive("")).toBeNull();
  });
});

describe("detectArchive — self-extracting RAR first volume (.partN.exe)", () => {
  it("recognizes Pack.part1.exe as the first volume of a RAR_PART set", () => {
    expect(detectArchive("Pack.part1.exe")).toEqual({
      baseName: "Pack",
      partNumber: 1,
      format: "RAR",
      pattern: "RAR_PART",
    });
  });

  it("groups the SFX first volume with its .rar continuation volumes", () => {
    const sfx = detectArchive("Pack.part1.exe");
    const cont = detectArchive("Pack.part2.rar");
    expect(sfx?.baseName).toBe(cont?.baseName);
    expect(sfx?.format).toBe(cont?.format);
  });

  it("does not open the door to arbitrary .exe attachments", () => {
    expect(detectArchive("Installer.exe")).toBeNull();
    expect(detectArchive("Pack.exe")).toBeNull();
  });
});

describe("detectArchive — standalone documents", () => {
  it("keeps recognizing the pre-existing document extensions", () => {
    expect(detectArchive("Model.stl")).toEqual({
      baseName: "Model",
      partNumber: -1,
      format: "DOCUMENT",
      pattern: "SINGLE",
    });
    expect(detectArchive("Sheet.pdf")?.format).toBe("DOCUMENT");
  });

  it("recognizes slicer-project formats", () => {
    for (const name of [
      "Bust.lys",
      "Bust.lyt",
      "Bust.lymesh",
      "Bust.chitubox",
      "Bust.ctp",
      "Bust.ctb",
      "Bust.cbddlp",
      "Bust.photon",
      "Bust.pwmx",
      "Bust.pwmo",
      "Bust.pws",
      "Bust.sl1",
      "Bust.goo",
      "Bust.phz",
      "Bust.pm3",
      "Bust.form",
    ]) {
      expect(detectArchive(name), name).toEqual({
        baseName: "Bust",
        partNumber: -1,
        format: "DOCUMENT",
        pattern: "SINGLE",
      });
    }
  });

  it("recognizes 3D-model and CAD formats", () => {
    for (const name of [
      "Bust.fbx",
      "Bust.ply",
      "Bust.glb",
      "Bust.gltf",
      "Bust.3ds",
      "Bust.max",
      "Bust.c4d",
      "Bust.ztl",
      "Bust.zpr",
      "Bust.mtl",
      "Bust.f3d",
      "Bust.scad",
      "Bust.igs",
      "Bust.iges",
      "Bust.sldprt",
      "Bust.skp",
      "Bust.wrl",
    ]) {
      expect(detectArchive(name), name).toEqual({
        baseName: "Bust",
        partNumber: -1,
        format: "DOCUMENT",
        pattern: "SINGLE",
      });
    }
  });

  it("recognizes the .blend1 autosave sibling of .blend", () => {
    expect(detectArchive("Scene.blend")?.format).toBe("DOCUMENT");
    expect(detectArchive("Scene.blend1")).toEqual({
      baseName: "Scene",
      partNumber: -1,
      format: "DOCUMENT",
      pattern: "SINGLE",
    });
  });

  it("does NOT recognize image attachments (they must not become packages)", () => {
    for (const name of ["Preview.jpg", "Preview.jpeg", "Preview.png", "Preview.webp", "Preview.gif"]) {
      expect(detectArchive(name), name).toBeNull();
    }
  });

  it("returns null for unrelated files", () => {
    expect(detectArchive("notes.txt")).toBeNull();
    expect(detectArchive("song.mp3")).toBeNull();
    expect(detectArchive("noextension")).toBeNull();
  });
});
