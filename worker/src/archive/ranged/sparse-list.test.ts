import { describe, it, expect } from "vitest";
import { open } from "fs/promises";
import { listFromSparse } from "./sparse-list.js";

describe("listFromSparse", () => {
  it("writes each region at its offset into a sparse file and passes the path to the lister", async () => {
    const size = 1_000_000;
    const regions = [
      { offset: 0, bytes: Buffer.from("HEAD") },
      { offset: size - 4, bytes: Buffer.from("TAIL") },
    ];
    let seenPath = "";
    const entries = await listFromSparse(
      [{ fileName: "sample.7z", size, regions }],
      async (firstPartPath) => {
        seenPath = firstPartPath;
        const fh = await open(firstPartPath, "r");
        try {
          const head = Buffer.alloc(4); await fh.read(head, 0, 4, 0);
          const tail = Buffer.alloc(4); await fh.read(tail, 0, 4, size - 4);
          const hole = Buffer.alloc(4); await fh.read(hole, 0, 4, 500_000);
          expect(head.toString()).toBe("HEAD");
          expect(tail.toString()).toBe("TAIL");
          expect(hole.equals(Buffer.alloc(4))).toBe(true); // gap is zero
        } finally { await fh.close(); }
        return [{ path: "a/b.stl", fileName: "b.stl", extension: "stl", compressedSize: 1n, uncompressedSize: 1n, crc32: null }];
      },
    );
    expect(seenPath.endsWith("sample.7z")).toBe(true);
    expect(entries).not.toBeNull();
    expect(entries!).toHaveLength(1);
  });

  it("returns null when the lister yields no entries", async () => {
    const res = await listFromSparse(
      [{ fileName: "x.7z", size: 100, regions: [{ offset: 0, bytes: Buffer.from("A") }] }],
      async () => [],
    );
    expect(res).toBeNull();
  });
});
