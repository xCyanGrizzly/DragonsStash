import { describe, it, expect, vi } from "vitest";

const candidate = {
  id: "pkg-1", archiveType: "ZIP", fileName: "a.zip", fileCount: 3, fileSize: 100n,
  destMessageId: 1n, destMessageIds: [1n], destChannel: { telegramId: 999n },
};

vi.mock("../db/queries.js", () => ({
  findFingerprintDedupCandidates: vi.fn(async () => [candidate]),
}));
const resolveMock = vi.fn(async (..._args: unknown[]) => [{ path: "x", fileName: "x", extension: null, compressedSize: 1n, uncompressedSize: 1n, crc32: "AAAA" }]);
const compareMock = vi.fn();
vi.mock("../provenance-backfill.js", () => ({
  resolveCandidateFingerprintEntries: (...args: unknown[]) => resolveMock(...args),
  compareFingerprints: (...args: unknown[]) => compareMock(...args),
}));

import { checkFingerprintRepost } from "./forward-repost-check.js";
import type { FileEntry } from "./zip-reader.js";

const newEntries: FileEntry[] = [{ path: "x", fileName: "x", extension: null, compressedSize: 1n, uncompressedSize: 1n, crc32: "AAAA" }];

describe("checkFingerprintRepost", () => {
  it("reports a duplicate when a candidate's fingerprint matches", async () => {
    compareMock.mockReturnValueOnce("match");
    const result = await checkFingerprintRepost({} as never, newEntries, "a.zip", 100n);
    expect(result).toEqual({ isDuplicate: true, matchedPackageId: "pkg-1" });
  });

  it("reports no duplicate when no candidate matches", async () => {
    compareMock.mockReturnValueOnce("mismatch");
    const result = await checkFingerprintRepost({} as never, newEntries, "a.zip", 100n);
    expect(result).toEqual({ isDuplicate: false, matchedPackageId: null });
  });
});
