import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { deriveForwardContentHash } from "./forward-identity.js";
import type { FileEntry } from "./zip-reader.js";

function entry(crc32: string | null): FileEntry {
  return { path: "a", fileName: "a", extension: null, compressedSize: 1n, uncompressedSize: 1n, crc32 };
}

describe("deriveForwardContentHash", () => {
  it("hashes the sorted CRC list when all entries have a CRC32 (ZIP/RAR)", () => {
    const entries = [entry("BBBB"), entry("AAAA")];
    const expectedHash = createHash("sha256").update(["aaaa", "bbbb"].join(",")).digest("hex");
    expect(deriveForwardContentHash(entries, "unique-1", "chan-1", 42n)).toBe(`fingerprint:${expectedHash}`);
  });

  it("falls back to remoteUniqueId when CRCs are incomplete (7z today)", () => {
    const entries = [entry(null), entry("AAAA")];
    expect(deriveForwardContentHash(entries, "unique-42", "chan-1", 42n)).toBe("forward:unique-42");
  });

  it("falls back to sourceChannelId+sourceMessageId when there's no CRC and no remoteUniqueId", () => {
    const entries = [entry(null)];
    expect(deriveForwardContentHash(entries, null, "chan-1", 42n)).toBe("forward:chan-1:42");
  });

  it("falls back past an empty entries list the same way", () => {
    expect(deriveForwardContentHash([], null, "chan-1", 7n)).toBe("forward:chan-1:7");
  });
});
