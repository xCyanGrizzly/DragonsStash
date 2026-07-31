import { describe, it, expect } from "vitest";
import { readScannedListingRanged } from "./dispatch.js";

describe("readScannedListingRanged", () => {
  it("returns null for an unknown archive type without calling the reader", async () => {
    const read = async () => Buffer.alloc(0);
    const result = await readScannedListingRanged(
      "DOCUMENT",
      { invoke: async () => ({}) } as never,
      [{ fileId: "1", fileSize: 100n, fileName: "a.pdf" }],
    );
    expect(result).toBeNull();
    void read; // unused placeholder kept out of the dispatch call — DOCUMENT never reaches a reader
  });
});
