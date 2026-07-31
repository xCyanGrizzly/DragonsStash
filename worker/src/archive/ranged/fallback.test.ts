import { describe, it, expect, vi } from "vitest";

// logLevel is required here too (not just maxZipSizeMB/tempDir) because this
// mock replaces the config module for the whole test-file graph, including
// util/logger.ts's module-level `pino({ level: config.logLevel })` call —
// pino throws at import time if level is undefined.
vi.mock("../../util/config.js", () => ({ config: { maxZipSizeMB: 1, tempDir: "/tmp", logLevel: "info" } }));
const created: unknown[] = [];
vi.mock("../../db/client.js", () => ({
  db: { systemNotification: { create: async (a: unknown) => { created.push(a); } } },
}));

import { fullDownloadListing } from "./fallback.js";

describe("fullDownloadListing", () => {
  it("refuses to download over the size cap and records a notification", async () => {
    const res = await fullDownloadListing({
      client: {} as never,
      parts: [{ fileId: "1", fileSize: 2n * 1024n * 1024n * 1024n, fileName: "big.rar" }],
      archiveType: "RAR",
      totalSize: 2n * 1024n * 1024n * 1024n,
      fileName: "big.rar",
    });
    expect(res).toBeNull();
    expect(created).toHaveLength(1);
  });
});
