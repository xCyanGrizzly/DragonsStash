import { describe, it, expect } from "vitest";
import {
  planListingRead,
  planRangedFallback,
  classifySourceShape,
  isConcatRepackName,
  concatRepackBase,
  concatChunkIndex,
  isVolumeSet,
} from "./listing-plan.js";

const GB = 1024n * 1024n * 1024n;

/** Defaults for a plan input; individual tests override what they care about. */
function input(over: Partial<Parameters<typeof planListingRead>[0]>) {
  return {
    archiveType: "ZIP",
    sourceFileName: "Pack.z01",
    destFileNames: ["Pack.z01", "Pack.zip"],
    totalSize: 10n * GB,
    maxDownloadBytes: 200n * GB,
    rangedOnly: false,
    ...over,
  };
}

describe("classifySourceShape", () => {
  it("separates spanned ZIP volumes from a raw byte split", () => {
    expect(classifySourceShape("Pack.z01")).toBe("spanned-zip");
    expect(classifySourceShape("Pack.z12")).toBe("spanned-zip");
    expect(classifySourceShape("Pack.zip.001")).toBe("byte-split");
    expect(classifySourceShape("Pack.7z.001")).toBe("byte-split");
  });

  it("recognizes RAR volume sets and lone archives", () => {
    expect(classifySourceShape("Pack.part1.rar")).toBe("rar-volume-set");
    expect(classifySourceShape("Pack.r00")).toBe("rar-volume-set");
    expect(classifySourceShape("Pack.zip")).toBe("single");
    expect(classifySourceShape("notes.txt")).toBe("unknown");
  });

  it("marks exactly the layouts whose volumes are independent containers", () => {
    expect(isVolumeSet("spanned-zip")).toBe(true);
    expect(isVolumeSet("rar-volume-set")).toBe(true);
    expect(isVolumeSet("byte-split")).toBe(false);
    expect(isVolumeSet("single")).toBe(false);
  });
});

describe("concat repack naming", () => {
  it("recognizes the repack chunk names the uploader produces", () => {
    expect(isConcatRepackName("Pack.concat.001")).toBe(true);
    expect(isConcatRepackName("Pack.concat.017")).toBe(true);
    expect(isConcatRepackName("Pack.concat")).toBe(true);
    expect(isConcatRepackName("Pack.z01")).toBe(false);
    expect(isConcatRepackName("Pack.zip.001")).toBe(false);
    // "concat" appearing mid-name must not count
    expect(isConcatRepackName("concat-models.zip")).toBe(false);
  });

  it("groups and orders chunks of one repack", () => {
    expect(concatRepackBase("Pack.concat.002")).toBe("pack.concat");
    expect(concatRepackBase("Pack.concat")).toBe("pack.concat");
    expect(concatChunkIndex("Pack.concat.017")).toBe(17);
    expect(concatChunkIndex("Pack.concat")).toBe(0);
  });
});

describe("planListingRead", () => {
  it("routes a spanned ZIP set to the ranged read", () => {
    const plan = planListingRead(input({}));
    expect(plan.route).toBe("ranged");
    expect(plan.reason).toContain("spanned-zip");
  });

  it("skips a concatenated spanned ZIP set — no reader can ever list it", () => {
    const plan = planListingRead(
      input({ sourceFileName: "Pack.z01", destFileNames: ["Pack.concat.001", "Pack.concat.002"] })
    );
    expect(plan.route).toBe("skip");
    expect(plan.reason).toContain("not a valid archive");
  });

  it("skips a concatenated RAR volume set for the same reason", () => {
    const plan = planListingRead(
      input({
        archiveType: "RAR",
        sourceFileName: "Pack.part1.rar",
        destFileNames: ["Pack.concat.001", "Pack.concat.002"],
      })
    );
    expect(plan.route).toBe("skip");
    expect(plan.reason).toContain("rar-volume-set");
  });

  it("still reads a concatenated BYTE SPLIT — re-cutting one stream is lossless", () => {
    const plan = planListingRead(
      input({ sourceFileName: "Pack.zip.001", destFileNames: ["Pack.concat.001", "Pack.concat.002"] })
    );
    expect(plan.route).toBe("ranged");
    expect(plan.reason).toContain("byte split");
  });

  it("skips archive types with no file-list reader without touching the API", () => {
    expect(planListingRead(input({ archiveType: "DOCUMENT" }))).toMatchObject({ route: "skip" });
  });

  it("skips when no destination part could be resolved", () => {
    expect(planListingRead(input({ destFileNames: [] }))).toMatchObject({ route: "skip" });
  });
});

describe("planRangedFallback", () => {
  it("refuses to download when rangedOnly is set, however large the archive", () => {
    const plan = planRangedFallback({ totalSize: 35n * GB, maxDownloadBytes: 200n * GB, rangedOnly: true });
    expect(plan.route).toBe("skip");
    expect(plan.reason).toContain("rangedOnly");
  });

  it("refuses to download past the size cap", () => {
    const plan = planRangedFallback({ totalSize: 300n * GB, maxDownloadBytes: 200n * GB, rangedOnly: false });
    expect(plan.route).toBe("skip");
    expect(plan.reason).toContain("exceeds the download cap");
  });

  it("falls back to a download when it is allowed and affordable", () => {
    const plan = planRangedFallback({ totalSize: 2n * GB, maxDownloadBytes: 200n * GB, rangedOnly: false });
    expect(plan.route).toBe("download");
  });
});
