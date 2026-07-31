import { describe, it, expect } from "vitest";
import { crcFingerprint, fingerprintsMatch } from "./fingerprint.js";
import type { FileEntry } from "./zip-reader.js";

const fe = (crc: string | null): FileEntry => ({
  path: "a", fileName: "a", extension: null,
  compressedSize: 0n, uncompressedSize: 0n, crc32: crc,
});

describe("crcFingerprint", () => {
  it("sorts crcs and marks complete", () => {
    expect(crcFingerprint([fe("00ff"), fe("00aa")])).toEqual({ crcs: ["00aa", "00ff"], complete: true });
  });
  it("is incomplete when any crc is null", () => {
    expect(crcFingerprint([fe("00aa"), fe(null)]).complete).toBe(false);
  });
  it("is incomplete when empty", () => {
    expect(crcFingerprint([]).complete).toBe(false);
  });
});

describe("fingerprintsMatch", () => {
  it("matches identical crc multisets regardless of order", () => {
    expect(fingerprintsMatch([fe("01"), fe("02")], [fe("02"), fe("01")])).toBe(true);
  });
  it("rejects different counts", () => {
    expect(fingerprintsMatch([fe("01")], [fe("01"), fe("02")])).toBe(false);
  });
  it("rejects disjoint sets", () => {
    expect(fingerprintsMatch([fe("01")], [fe("09")])).toBe(false);
  });
  it("rejects when either side is incomplete", () => {
    expect(fingerprintsMatch([fe("01"), fe(null)], [fe("01"), fe("02")])).toBe(false);
  });
});
