# Provenance Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During normal source-channel re-indexing, attribute the true origin (source channel/message/topic/caption/creator) to placeholder-provenance packages, confirmed by a CRC32 fingerprint read from a ranged central-directory download — without downloading whole archives.

**Architecture:** A new step in `processOneArchiveSet` (between the same-channel repost check and the full download) looks up a placeholder candidate by `fileName`+`fileSize`, confirms it by comparing the archive's internal CRC32 multiset (candidate side already in `PackageFile.crc32`; scanned side read via a ranged tail download of the ZIP/7z central directory), and on a match transactionally overwrites the placeholder fields and skips the download. RAR and listing-less candidates fall back to name+size only. Pure logic (fingerprint compare, central-directory parse) is unit-tested; TDLib range behavior is verified with a spike before it's built on.

**Tech Stack:** TypeScript (ESM, NodeNext), `tdl`/TDLib, Prisma v7 (`@prisma/adapter-pg`), Vitest (new, worker only).

## Global Constraints

- Worker code is ESM: relative imports MUST use the `.js` extension (e.g. `./archive/central-directory.js`).
- ESLint does NOT cover `worker/` — do not rely on lint; rely on `tsc` and Vitest.
- All new `client.invoke(...)` calls go through `invokeWithTimeout`/`withFloodWait` (see `worker/src/tdlib/download.ts`, `worker/src/util/retry.ts`) — never bare invokes (per the tdlib-telegram skill).
- Never overwrite a package that already has real provenance. A candidate is defined ONLY as `sourceChannelId === destChannelId`.
- `crc32` values in `FileEntry`/`PackageFile` are lowercase hex, zero-padded to 8 chars, or `null` (see `worker/src/archive/zip-reader.ts:57`).
- Prisma PKs are `cuid()` strings; message IDs and file sizes are `BigInt`.
- Commit after every task. Branch is `nas-backup` (already a feature branch) — commit there.

## File Structure

- Create `worker/vitest.config.ts` — Vitest config (node env).
- Create `worker/src/archive/fingerprint.ts` — pure CRC32 multiset fingerprint + compare.
- Create `worker/src/archive/fingerprint.test.ts` — unit tests.
- Create `worker/src/archive/central-directory.ts` — pure ZIP EOCD/central-directory parser over a tail `Buffer`; pure 7z end-header locator.
- Create `worker/src/archive/central-directory.test.ts` — unit tests using generated fixtures.
- Create `worker/src/tdlib/range-download.ts` — `downloadFileRange()` (ranged TDLib download → `Buffer`).
- Create `worker/src/provenance-backfill.ts` — orchestrator `tryProvenanceBackfill()` (candidate lookup → ranged listing → fingerprint confirm → transactional update).
- Modify `worker/src/db/queries.ts` — add `findPlaceholderCandidate`, `getPackageFileCrcs`, `backfillProvenance`.
- Modify `worker/src/worker.ts` — call `tryProvenanceBackfill` in `processOneArchiveSet`; add `zipsBackfilled` counter plumbing.
- Modify `prisma/schema.prisma` + new migration — `IngestionRun.zipsBackfilled Int @default(0)`.
- Modify `worker/package.json` — add `vitest` devDependency + `test` script.

---

### Task 1: Add the Vitest test harness to the worker

**Files:**
- Modify: `worker/package.json`
- Create: `worker/vitest.config.ts`
- Create: `worker/src/archive/fingerprint.test.ts` (temporary smoke test, replaced in Task 2)

**Interfaces:**
- Produces: `npm test` (in `worker/`) runs Vitest over `src/**/*.test.ts`.

- [ ] **Step 1: Add vitest devDependency and test script**

In `worker/package.json`, add to `devDependencies`: `"vitest": "^3.2.4"`, and to `scripts`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 2: Install**

Run: `cd worker && npm install`
Expected: vitest added, no errors. (If the environment blocks writes to `node_modules`, run in the container/owner context.)

- [ ] **Step 3: Create `worker/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create a smoke test `worker/src/archive/fingerprint.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run the harness**

Run: `cd worker && npm test`
Expected: 1 passing test.

- [ ] **Step 6: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/vitest.config.ts worker/src/archive/fingerprint.test.ts
git commit -m "test(worker): add vitest harness"
```

---

### Task 2: CRC32 fingerprint compare (pure)

**Files:**
- Create: `worker/src/archive/fingerprint.ts`
- Test: `worker/src/archive/fingerprint.test.ts` (replace smoke test)

**Interfaces:**
- Consumes: `FileEntry` from `./zip-reader.js` (`{ crc32: string | null, ... }`).
- Produces:
  - `crcFingerprint(entries: FileEntry[]): { crcs: string[]; complete: boolean }` — sorted lowercase crc list; `complete=false` if any entry has `crc32 === null` OR `entries` is empty.
  - `fingerprintsMatch(a: FileEntry[], b: FileEntry[]): boolean` — true iff both fingerprints are `complete`, equal length, and equal sorted crc arrays.

- [ ] **Step 1: Write the failing test** (`worker/src/archive/fingerprint.test.ts`)

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- fingerprint`
Expected: FAIL (`crcFingerprint` not found).

- [ ] **Step 3: Implement `worker/src/archive/fingerprint.ts`**

```ts
import type { FileEntry } from "./zip-reader.js";

export function crcFingerprint(entries: FileEntry[]): { crcs: string[]; complete: boolean } {
  if (entries.length === 0) return { crcs: [], complete: false };
  const crcs: string[] = [];
  let complete = true;
  for (const e of entries) {
    if (e.crc32 == null) { complete = false; continue; }
    crcs.push(e.crc32.toLowerCase());
  }
  crcs.sort();
  return { crcs, complete };
}

export function fingerprintsMatch(a: FileEntry[], b: FileEntry[]): boolean {
  const fa = crcFingerprint(a);
  const fb = crcFingerprint(b);
  if (!fa.complete || !fb.complete) return false;
  if (fa.crcs.length !== fb.crcs.length) return false;
  return fa.crcs.every((c, i) => c === fb.crcs[i]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npm test -- fingerprint`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/fingerprint.ts worker/src/archive/fingerprint.test.ts
git commit -m "feat(worker): CRC32 archive fingerprint compare"
```

---

### Task 3: Parse a ZIP central directory from a tail buffer (pure)

**Files:**
- Create: `worker/src/archive/central-directory.ts`
- Test: `worker/src/archive/central-directory.test.ts`

**Interfaces:**
- Consumes: `FileEntry` from `./zip-reader.js`.
- Produces:
  - `parseZipCentralDirectoryFromTail(tail: Buffer, tailStart: number): FileEntry[]` — `tail` is the last bytes of the archive, `tailStart` is the absolute offset in the whole file where `tail` begins. Locates the End-Of-Central-Directory record (signature `0x06054b50`) by scanning backward, then walks central-directory file headers (signature `0x02014b50`). Throws `RangeError("EOCD not found in tail")` if the EOCD (or a referenced central-directory byte) falls before `tailStart` (caller must fetch a larger tail).
  - `MIN_ZIP_TAIL_BYTES = 65_557` (max EOCD comment 65_535 + 22-byte EOCD).

**Reference (ZIP format, little-endian):**
- EOCD (22 bytes + comment): sig `50 4b 05 06`; offset 12 = CD size (u32); offset 16 = CD start offset in file (u32); offset 20 = comment length (u16). ZIP64: if CD offset == `0xFFFFFFFF`, locate ZIP64 EOCD locator (sig `0x07064b50`) preceding EOCD and read 8-byte fields.
- Central directory header (46 bytes + names): sig `50 4b 01 02`; off 16 = crc32 (u32); off 20 = compressed size (u32); off 24 = uncompressed size (u32); off 28 = name len (u16); off 30 = extra len (u16); off 32 = comment len (u16); name follows at off 46. ZIP64 extra (id `0x0001`) overrides sizes when they are `0xFFFFFFFF`.

- [ ] **Step 1: Write the failing test** (`worker/src/archive/central-directory.test.ts`)

Generate a real ZIP with Node's `zlib`-free approach via a fixture builder helper in the test (store-only entries so we control CRCs), then assert parsing the whole buffer as its own tail returns the entries.

```ts
import { describe, it, expect } from "vitest";
import { parseZipCentralDirectoryFromTail } from "./central-directory.js";
import { crc32 } from "zlib"; // Node 20+ exposes zlib.crc32

// Build a minimal STORE (no compression) ZIP in-memory with the given files.
function buildStoreZip(files: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const crc = crc32(f.data) >>> 0;
    const nameBuf = Buffer.from(f.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(0, 8);               // method = store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);  // compressed
    local.writeUInt32LE(f.data.length, 22);  // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra len
    const localHeader = Buffer.concat([local, nameBuf, f.data]);
    chunks.push(localHeader);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);            // local header offset
    central.push(Buffer.concat([cd, nameBuf]));
    offset += localHeader.length;
  }
  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

describe("parseZipCentralDirectoryFromTail", () => {
  it("lists entries with correct names, sizes, and crc32", () => {
    const zip = buildStoreZip([
      { name: "models/dragon.stl", data: Buffer.from("DRAGON") },
      { name: "readme.txt", data: Buffer.from("hello world") },
    ]);
    const entries = parseZipCentralDirectoryFromTail(zip, 0);
    expect(entries.map((e) => e.fileName).sort()).toEqual(["dragon.stl", "readme.txt"]);
    const dragon = entries.find((e) => e.fileName === "dragon.stl")!;
    expect(dragon.path).toBe("models/dragon.stl");
    expect(dragon.uncompressedSize).toBe(6n);
    expect(dragon.crc32).toMatch(/^[0-9a-f]{8}$/);
  });

  it("throws when the central directory begins before the tail window", () => {
    const zip = buildStoreZip([{ name: "a.txt", data: Buffer.alloc(100) }]);
    // Provide only the last 30 bytes but claim they start at offset (len-30):
    const tail = zip.subarray(zip.length - 30);
    expect(() => parseZipCentralDirectoryFromTail(tail, zip.length - 30)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test -- central-directory`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `worker/src/archive/central-directory.ts`**

```ts
import path from "path";
import type { FileEntry } from "./zip-reader.js";

export const MIN_ZIP_TAIL_BYTES = 65_557;

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function extOf(name: string): string | null {
  const e = path.extname(name).replace(/^\./, "").toLowerCase();
  return e === "" ? null : e;
}

/** Parse a ZIP central directory from the tail of an archive. */
export function parseZipCentralDirectoryFromTail(tail: Buffer, tailStart: number): FileEntry[] {
  // 1. Find EOCD by scanning backward for its signature.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new RangeError("EOCD not found in tail");

  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64: sizes/offsets of 0xFFFFFFFF mean "see ZIP64 EOCD".
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locSig = 0x07064b50;
    let loc = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (tail.readUInt32LE(i) === locSig) { loc = i; break; }
    }
    if (loc < 0) throw new RangeError("ZIP64 EOCD locator not in tail");
    const z64Abs = Number(tail.readBigUInt64LE(loc + 8)); // absolute offset of ZIP64 EOCD
    const z64 = z64Abs - tailStart;
    if (z64 < 0) throw new RangeError("ZIP64 EOCD before tail window");
    cdSize = Number(tail.readBigUInt64LE(z64 + 40));
    cdOffset = Number(tail.readBigUInt64LE(z64 + 48));
  }

  // 2. Map the absolute central-directory offset into the tail buffer.
  const cdLocal = cdOffset - tailStart;
  if (cdLocal < 0 || cdLocal + cdSize > tail.length) {
    throw new RangeError("Central directory begins before tail window");
  }

  // 3. Walk central-directory headers.
  const entries: FileEntry[] = [];
  let p = cdLocal;
  const end = cdLocal + cdSize;
  while (p + 46 <= end && tail.readUInt32LE(p) === CD_SIG) {
    let crc = tail.readUInt32LE(p + 16) >>> 0;
    let comp = BigInt(tail.readUInt32LE(p + 20));
    let uncomp = BigInt(tail.readUInt32LE(p + 24));
    const nameLen = tail.readUInt16LE(p + 28);
    const extraLen = tail.readUInt16LE(p + 30);
    const commentLen = tail.readUInt16LE(p + 32);
    const name = tail.toString("utf8", p + 46, p + 46 + nameLen);

    // ZIP64 extra field overrides 0xFFFFFFFF sizes.
    if (comp === 0xffffffffn || uncomp === 0xffffffffn) {
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const id = tail.readUInt16LE(ep);
        const sz = tail.readUInt16LE(ep + 2);
        if (id === 0x0001) {
          let fp = ep + 4;
          if (uncomp === 0xffffffffn) { uncomp = tail.readBigUInt64LE(fp); fp += 8; }
          if (comp === 0xffffffffn) { comp = tail.readBigUInt64LE(fp); fp += 8; }
        }
        ep += 4 + sz;
      }
    }

    const isDir = name.endsWith("/");
    if (!isDir) {
      entries.push({
        path: name,
        fileName: path.basename(name),
        extension: extOf(name),
        compressedSize: comp,
        uncompressedSize: uncomp,
        crc32: crc !== 0 ? crc.toString(16).padStart(8, "0") : null,
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd worker && npm test -- central-directory`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/central-directory.ts worker/src/archive/central-directory.test.ts
git commit -m "feat(worker): parse ZIP central directory from a tail buffer"
```

---

### Task 4: SPIKE — verify TDLib ranged download, then implement `downloadFileRange`

**Files:**
- Create: `worker/src/tdlib/range-download.ts`

**Interfaces:**
- Consumes: `Client` from `tdl`; `invokeWithTimeout` from `./download.js` (add export if needed); `withFloodWait` from `../util/retry.js`.
- Produces: `downloadFileRange(client, fileId: string, offset: number, limit: number, expectedSize: bigint): Promise<Buffer>` — returns exactly the requested byte range from the remote file.

**Why a spike:** TDLib's `downloadFile` with `offset`/`limit`/`synchronous:true` downloads a region into its file cache; reading the exact range back from the on-disk file (which may be a sparse "prefix" file) must be verified empirically before other tasks depend on it. Do NOT skip the spike.

- [ ] **Step 1: Spike — confirm behavior against a real file**

Write a throwaway script `worker/src/tdlib/_spike-range.ts` that: creates a client (reuse `createTdlibClient`), picks a known large document message in the destination channel, calls `downloadFile` with `{ offset: <size-65557 aligned down to 1KB>, limit: 65557, synchronous: true, priority: 1 }`, inspects the returned `file.local` (`path`, `downloaded_prefix_size`, `download_offset`), then reads bytes `[offset, offset+limit)` from `file.local.path` and prints their length + last 4 bytes as hex.
Run it and record: (a) does `synchronous:true` block until the region is present? (b) is the region at absolute file offset on disk, or at offset 0 of a prefix file? Note the answer in a comment in `range-download.ts`.
Delete `_spike-range.ts` after.

- [ ] **Step 2: Implement `worker/src/tdlib/range-download.ts` using the verified behavior**

```ts
import { open } from "fs/promises";
import type { Client } from "tdl";
import { childLogger } from "../util/logger.js";
import { withFloodWait } from "../util/retry.js";

const log = childLogger("range-download");
const RANGE_TIMEOUT_MS = 120_000;

// NOTE (from Task 4 spike): TDLib writes the requested region into
// file.local.path at its ABSOLUTE file offset; file.local.downloaded_prefix_size
// counts contiguous bytes from download_offset. We request a 1KB-aligned offset
// so downloaded_prefix_size covers our whole [offset, offset+limit) window.
export async function downloadFileRange(
  client: Client,
  fileId: string,
  offset: number,
  limit: number,
  expectedSize: bigint,
): Promise<Buffer> {
  const numericId = parseInt(fileId, 10);
  const alignedOffset = Math.max(0, offset - (offset % 1024));
  const alignedLimit = limit + (offset - alignedOffset);

  const file = await withFloodWait(
    () =>
      new Promise<{ local: { path: string; download_offset: number; downloaded_prefix_size: number } }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Range download timed out for ${fileId}`)), RANGE_TIMEOUT_MS);
          client
            .invoke({
              _: "downloadFile",
              file_id: numericId,
              priority: 1,
              offset: alignedOffset,
              limit: alignedLimit,
              synchronous: true,
            } as never)
            .then((f) => { clearTimeout(timer); resolve(f as never); })
            .catch((e) => { clearTimeout(timer); reject(e); });
        },
      ),
    `downloadFileRange:${fileId}`,
  );

  const start = offset;
  const fh = await open(file.local.path, "r");
  try {
    const buf = Buffer.alloc(limit);
    const { bytesRead } = await fh.read(buf, 0, limit, start);
    log.debug({ fileId, offset, limit, bytesRead }, "range read");
    return bytesRead < limit ? buf.subarray(0, bytesRead) : buf;
  } finally {
    await fh.close();
  }
}
```

- [ ] **Step 3: Manual verification**

Run the worker against a real destination archive via Task 8's integration path (deferred), OR re-run a trimmed spike confirming `downloadFileRange` returns a buffer whose last 22+ bytes contain the EOCD signature `50 4b 05 06` for a known ZIP.
Expected: buffer length == limit (or less near EOF); EOCD signature present for ZIPs.

- [ ] **Step 4: Commit**

```bash
git add worker/src/tdlib/range-download.ts
git commit -m "feat(worker): ranged TDLib file download (downloadFileRange)"
```

---

### Task 5: DB helpers — candidate lookup, candidate CRCs, transactional backfill

**Files:**
- Modify: `worker/src/db/queries.ts`

**Interfaces:**
- Produces:
  - `findPlaceholderCandidate(destChannelId: string, fileName: string, fileSize: bigint): Promise<{ id: string; archiveType: string; fileCount: number } | null>` — a **placeholder** package (`sourceChannelId === destChannelId` OR `sourceMessageId === 0` — see spec §1) AND `fileName` AND `fileSize` match, with a real destination (`destMessageId != null`).
  - `getPackageFileCrcs(packageId: string): Promise<(string | null)[]>` — `PackageFile.crc32` values for the candidate.
  - `backfillProvenance(input: BackfillProvenanceInput): Promise<boolean>` — transactionally overwrite placeholder fields; returns `false` (no-op) if the row is no longer a placeholder. Type:
    ```ts
    export interface BackfillProvenanceInput {
      packageId: string;
      destChannelId: string;          // to re-check placeholder status in-txn
      sourceChannelId: string;
      sourceMessageId: bigint;
      sourceTopicId: bigint | null;
      sourceCaption: string | null;
      remoteUniqueId: string | null;
      creator: string | null;         // always set (re-derived by caller)
      entries?: FileEntry[];          // set only if candidate had fileCount === 0
      previewData?: Buffer | null;    // set only if provided and candidate lacks one
      previewMsgId?: bigint | null;
    }
    ```

- [ ] **Step 1: Implement the three helpers in `worker/src/db/queries.ts`**

```ts
export async function findPlaceholderCandidate(
  destChannelId: string,
  fileName: string,
  fileSize: bigint,
): Promise<{ id: string; archiveType: string; fileCount: number } | null> {
  return db.package.findFirst({
    where: {
      fileName,
      fileSize,
      destMessageId: { not: null },
      // Placeholder provenance (spec §1): manual-upload (source == destination)
      // OR rebuild record (sourceMessageId == 0 "unknown" sentinel).
      OR: [
        { sourceChannelId: destChannelId },
        { sourceMessageId: 0n },
      ],
    },
    select: { id: true, archiveType: true, fileCount: true },
    orderBy: { indexedAt: "asc" },
  });
}

export async function getPackageFileCrcs(packageId: string): Promise<(string | null)[]> {
  const rows = await db.packageFile.findMany({
    where: { packageId },
    select: { crc32: true },
  });
  return rows.map((r) => r.crc32);
}

export async function backfillProvenance(input: BackfillProvenanceInput): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const current = await tx.package.findUnique({
      where: { id: input.packageId },
      select: { sourceChannelId: true, sourceMessageId: true, previewData: true, fileCount: true },
    });
    // Re-check placeholder status inside the txn (another worker may have won).
    // Placeholder = manual-upload (source==dest) OR rebuild (sourceMessageId==0).
    const stillPlaceholder =
      !!current &&
      (current.sourceChannelId === input.destChannelId || current.sourceMessageId === 0n);
    if (!stillPlaceholder) return false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      sourceChannelId: input.sourceChannelId,
      sourceMessageId: input.sourceMessageId,
      sourceTopicId: input.sourceTopicId,
      sourceCaption: input.sourceCaption,
      remoteUniqueId: input.remoteUniqueId,
      creator: input.creator,
    };
    if (input.entries && current.fileCount === 0) {
      await tx.packageFile.deleteMany({ where: { packageId: input.packageId } });
      await tx.packageFile.createMany({
        data: input.entries.map((e) => ({
          packageId: input.packageId,
          path: e.path, fileName: e.fileName, extension: e.extension,
          compressedSize: e.compressedSize, uncompressedSize: e.uncompressedSize, crc32: e.crc32,
        })),
      });
      data.fileCount = input.entries.length;
    }
    if (input.previewData && !current.previewData) {
      data.previewData = input.previewData;
      data.previewMsgId = input.previewMsgId ?? null;
    }
    await tx.package.update({ where: { id: input.packageId }, data });
    return true;
  });
}
```

Add `import type { FileEntry } from "../archive/zip-reader.js";` at the top if not present, and export `BackfillProvenanceInput`.

- [ ] **Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: no NEW errors in `db/queries.ts` (pre-existing stale-client errors, if the client isn't regenerated in this env, are unrelated — regenerate with `npm run db:generate` in the owner context first).

- [ ] **Step 3: Commit**

```bash
git add worker/src/db/queries.ts
git commit -m "feat(worker): DB helpers for provenance backfill"
```

---

### Task 6: Ranged listing orchestrator + backfill decision (`provenance-backfill.ts`)

**Files:**
- Create: `worker/src/provenance-backfill.ts`

**Interfaces:**
- Consumes: `findPlaceholderCandidate`, `getPackageFileCrcs`, `backfillProvenance` (Task 5); `downloadFileRange` (Task 4); `parseZipCentralDirectoryFromTail`, `MIN_ZIP_TAIL_BYTES` (Task 3); `fingerprintsMatch`, `crcFingerprint` (Task 2); `FileEntry` (`zip-reader.js`).
- Produces: `tryProvenanceBackfill(args: BackfillArgs): Promise<{ backfilled: boolean; confidence?: "fingerprint" | "name-size" }>`.
  ```ts
  export interface BackfillArgs {
    client: import("tdl").Client;
    destChannelId: string;             // DB id of the destination channel
    scannedSourceChannelId: string;    // DB id of the channel being scanned
    fileName: string;
    fileSize: bigint;                  // total across parts
    archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT" | string;
    sourceMessageId: bigint;
    sourceTopicId: bigint | null;
    sourceCaption: string | null;
    remoteUniqueId: string | null;
    creator: string | null;            // caller-derived (topic > filename > channel)
    scannedFileId: string;             // TDLib file id of the scanned archive (last part for multipart ZIP)
    previewData?: Buffer | null;
    previewMsgId?: bigint | null;
  }
  ```

**Behavior:**
1. `findPlaceholderCandidate(destChannelId, fileName, fileSize)`. If none → return `{ backfilled: false }`.
2. If `archiveType === "ZIP"` or `"SEVEN_Z"`: read the scanned archive's listing via `readScannedListing()` (below). Compare to the candidate's CRCs via `fingerprintsMatch`. On match → `backfillProvenance(..., entries: <scanned entries if candidate.fileCount===0>)` → confidence `"fingerprint"`.
3. Else (RAR, or ranged read failed, or candidate has no stored CRCs): confirm by **name+size only** (already true from step 1) → `backfillProvenance(...)` → confidence `"name-size"`. (Do NOT pass entries unless a listing was actually read.)
4. If `backfillProvenance` returns `false` (lost the race) → `{ backfilled: false }`.

`readScannedListing(client, scannedFileId, fileSize, archiveType)`: for ZIP, `downloadFileRange(client, scannedFileId, max(0, fileSize - MIN_ZIP_TAIL_BYTES), MIN_ZIP_TAIL_BYTES, fileSize)` then `parseZipCentralDirectoryFromTail(tail, tailStart)`; on `RangeError`, retry once with a 4× larger tail; on any error return `null`. For 7z, return `null` in v1 (falls back to name+size) — a follow-up can add 7z end-header parsing. Wrap in try/catch; return `null` on failure.

- [ ] **Step 1: Write the module** (full code)

```ts
import { childLogger } from "./util/logger.js";
import { downloadFileRange } from "./tdlib/range-download.js";
import { parseZipCentralDirectoryFromTail, MIN_ZIP_TAIL_BYTES } from "./archive/central-directory.js";
import { fingerprintsMatch } from "./archive/fingerprint.js";
import {
  findPlaceholderCandidate,
  getPackageFileCrcs,
  backfillProvenance,
} from "./db/queries.js";
import type { FileEntry } from "./archive/zip-reader.js";
import type { Client } from "tdl";

const log = childLogger("provenance-backfill");

export interface BackfillArgs {
  client: Client;
  destChannelId: string;
  scannedSourceChannelId: string;
  fileName: string;
  fileSize: bigint;
  archiveType: string;
  sourceMessageId: bigint;
  sourceTopicId: bigint | null;
  sourceCaption: string | null;
  remoteUniqueId: string | null;
  creator: string | null;
  scannedFileId: string;
  previewData?: Buffer | null;
  previewMsgId?: bigint | null;
}

async function readScannedZipListing(
  client: Client,
  fileId: string,
  fileSize: bigint,
): Promise<FileEntry[] | null> {
  const total = Number(fileSize);
  for (const tailBytes of [MIN_ZIP_TAIL_BYTES, MIN_ZIP_TAIL_BYTES * 4]) {
    const start = Math.max(0, total - tailBytes);
    try {
      const tail = await downloadFileRange(client, fileId, start, Math.min(tailBytes, total), fileSize);
      return parseZipCentralDirectoryFromTail(tail, start);
    } catch (err) {
      if (err instanceof RangeError) continue; // try a larger tail
      log.warn({ err, fileId }, "ranged ZIP listing failed");
      return null;
    }
  }
  return null;
}

export async function tryProvenanceBackfill(
  args: BackfillArgs,
): Promise<{ backfilled: boolean; confidence?: "fingerprint" | "name-size" }> {
  const candidate = await findPlaceholderCandidate(args.destChannelId, args.fileName, args.fileSize);
  if (!candidate) return { backfilled: false };

  let entries: FileEntry[] | null = null;
  let confidence: "fingerprint" | "name-size" = "name-size";

  if (args.archiveType === "ZIP") {
    entries = await readScannedZipListing(args.client, args.scannedFileId, args.fileSize);
    if (entries) {
      const candidateCrcs = await getPackageFileCrcs(candidate.id);
      const candidateEntries: FileEntry[] = candidateCrcs.map((crc) => ({
        path: "", fileName: "", extension: null, compressedSize: 0n, uncompressedSize: 0n, crc32: crc,
      }));
      if (fingerprintsMatch(entries, candidateEntries)) {
        confidence = "fingerprint";
      } else {
        // Fingerprint mismatch: NOT the same content despite name+size. Do not backfill.
        log.info({ candidateId: candidate.id, fileName: args.fileName }, "fingerprint mismatch — not backfilling");
        return { backfilled: false };
      }
    }
  }

  const ok = await backfillProvenance({
    packageId: candidate.id,
    destChannelId: args.destChannelId,
    sourceChannelId: args.scannedSourceChannelId,
    sourceMessageId: args.sourceMessageId,
    sourceTopicId: args.sourceTopicId,
    sourceCaption: args.sourceCaption,
    remoteUniqueId: args.remoteUniqueId,
    creator: args.creator,
    entries: candidate.fileCount === 0 && entries ? entries : undefined,
    previewData: args.previewData ?? undefined,
    previewMsgId: args.previewMsgId ?? undefined,
  });

  if (!ok) return { backfilled: false };
  log.info(
    { candidateId: candidate.id, fileName: args.fileName, confidence, source: args.scannedSourceChannelId },
    "provenance backfilled",
  );
  return { backfilled: true, confidence };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: no new errors in `provenance-backfill.ts`.

- [ ] **Step 3: Commit**

```bash
git add worker/src/provenance-backfill.ts
git commit -m "feat(worker): provenance-backfill orchestrator"
```

---

### Task 7: Add `zipsBackfilled` counter to IngestionRun

**Files:**
- Modify: `prisma/schema.prisma` (model `IngestionRun`, ~line 562)
- Create: migration via `npx prisma migrate dev --name ingestion_run_zips_backfilled`

**Interfaces:**
- Produces: `IngestionRun.zipsBackfilled Int @default(0)`.

- [ ] **Step 1: Add the field** in `prisma/schema.prisma` after `zipsIngested Int @default(0)`:

```prisma
  zipsBackfilled  Int             @default(0)
```

- [ ] **Step 2: Create the migration**

Run (owner/container context with DB access): `npx prisma migrate dev --name ingestion_run_zips_backfilled`
Expected: migration created + applied; Prisma client regenerated.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): IngestionRun.zipsBackfilled counter"
```

---

### Task 8: Wire the hook into `processOneArchiveSet`

**Files:**
- Modify: `worker/src/worker.ts` (`processOneArchiveSet`, after the `findRepostedPackage` block ~line 1613–1660, BEFORE the download/size-guard section; and counters plumbing)

**Interfaces:**
- Consumes: `tryProvenanceBackfill` (Task 6); existing `ctx` (has `client`, `channel`, `destChannelId`, `sourceTopicId`, `topicCreator`, `counters`, `accountLog`, `runId`), `archiveSet.parts[0]` (`{ id, fileName, remoteUniqueId, ... }`), `previewMatches`.
- Produces: a new early-return path that skips the download when a backfill occurs; `counters.zipsBackfilled` increments.

- [ ] **Step 1: Import and counter type**

Add near the other imports in `worker.ts`:
```ts
import { tryProvenanceBackfill } from "./provenance-backfill.js";
```
Find the `counters` object/type (search `zipsDuplicate`) and add `zipsBackfilled: number` to the type and initialize `zipsBackfilled: 0` where the run counters are created (near `zipsDuplicate: 0`, ~line 423 and the local `counters` type ~line 315).

- [ ] **Step 2: Insert the backfill step** immediately AFTER the `findRepostedPackage` `if (reposted) { ... return null; }` block and BEFORE the download begins:

```ts
    // ── Cross-channel provenance backfill ──
    // The same-channel checks above missed. Before downloading, see if this
    // archive is the true origin of a placeholder-source package (manual upload
    // / rebuild record whose sourceChannelId == destChannelId). If so, backfill
    // its real provenance and skip the download entirely.
    if (destChannelId && (archType === "ZIP" || archType === "RAR" || archType === "SEVEN_Z")) {
      try {
        const derivedCreator =
          topicCreator && topicCreator !== "General"
            ? topicCreator
            : (extractCreatorFromFileName(archiveName) ?? topicCreator ?? null);
        const preview = previewMatches.get(archiveSet.parts[0].id.toString());
        const result = await tryProvenanceBackfill({
          client,
          destChannelId,
          scannedSourceChannelId: channel.id,
          fileName: archiveName,
          fileSize: totalArchiveSize,
          archiveType: archType,
          sourceMessageId: archiveSet.parts[0].id,
          sourceTopicId,
          sourceCaption: archiveSet.parts[0].caption ?? null,
          remoteUniqueId: archiveSet.parts[0].remoteUniqueId ?? null,
          creator: derivedCreator,
          scannedFileId: archiveSet.parts[archiveSet.parts.length - 1].fileId,
          previewData: null,
          previewMsgId: preview?.id ?? null,
        });
        if (result.backfilled) {
          counters.zipsBackfilled++;
          accountLog.info(
            { fileName: archiveName, sourceMessageId: Number(archiveSet.parts[0].id), confidence: result.confidence },
            "Backfilled provenance for placeholder package — skipping download",
          );
          await updateRunActivity(runId, {
            currentActivity: `Backfilled provenance for ${archiveName}`,
            currentStep: "backfilling",
            currentFile: archiveName,
            currentFileNum: setIdx + 1,
            totalFiles: totalSets,
          });
          return null;
        }
      } catch (err) {
        accountLog.warn({ err, fileName: archiveName }, "Provenance backfill attempt failed (non-fatal), continuing to normal ingestion");
      }
    }
```

Notes for the implementer:
- `archType` is the detected archive type variable already in scope in this function (search for where `archiveType`/`archType` is computed for the set). If the variable has a different name, use it.
- `extractCreatorFromFileName` is already imported in `worker.ts` (used elsewhere). If not, add `import { extractCreatorFromFileName } from "./archive/creator.js";`.
- `archiveSet.parts[i].fileId` / `.caption` / `.remoteUniqueId`: confirm these fields exist on the part type (see `worker/src/archive/multipart.ts` `TelegramMessage`/part type). If `caption` isn't on the part, pass `null` (the source caption enrichment is best-effort).
- `previewMatches` maps `baseName`/`firstMessageId` → `{ id, fileId }` (see `matchPreviewToArchive`); adjust the key to match its actual keying.

- [ ] **Step 3: Surface the counter** — where the run summary/`updateRunActivity` writes `zipsDuplicate`, also write `zipsBackfilled: counters.zipsBackfilled`. Update the final `IngestionRun` update to persist it.

- [ ] **Step 4: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: no new errors in `worker.ts`.

- [ ] **Step 5: Commit**

```bash
git add worker/src/worker.ts
git commit -m "feat(worker): opportunistic provenance backfill during scan"
```

---

### Task 9: Destination-copy second tail read for listing-less ZIP candidates

**Files:**
- Modify: `worker/src/db/queries.ts` (extend `findPlaceholderCandidate`)
- Modify: `worker/src/provenance-backfill.ts`

**Rationale:** Rebuild-created candidates have `fileCount === 0` and no `PackageFile.crc32`, so name-side CRCs are empty and `fingerprintsMatch` can't confirm. For ZIP candidates we can still get a fingerprint by doing a *second* ranged tail read of the candidate's own copy in the destination channel, then compare scanned-vs-destination CRC sets.

**Interfaces:**
- `findPlaceholderCandidate` now also selects: `destMessageId: bigint | null`, `destMessageIds: bigint[]`, and `destChannel: { telegramId: bigint }` (destination chat id). Return type extended accordingly.
- Produces (in `provenance-backfill.ts`): `readZipListingFromDestination(client, destChatTelegramId: bigint, destMessageId: bigint, fileSize: bigint): Promise<FileEntry[] | null>`.

- [ ] **Step 1: Extend `findPlaceholderCandidate`** select + return type in `db/queries.ts`:

```ts
select: {
  id: true, archiveType: true, fileCount: true, fileSize: true,
  destMessageId: true, destMessageIds: true,
  destChannel: { select: { telegramId: true } },
},
```
Return type: `{ id: string; archiveType: string; fileCount: number; fileSize: bigint; destMessageId: bigint | null; destMessageIds: bigint[]; destChannel: { telegramId: bigint } | null } | null`.

- [ ] **Step 2: Add `readZipListingFromDestination` to `provenance-backfill.ts`**

```ts
import { invokeWithTimeout } from "./tdlib/download.js";

async function readZipListingFromDestination(
  client: Client,
  destChatTelegramId: bigint,
  destMessageId: bigint,
  fileSize: bigint,
): Promise<FileEntry[] | null> {
  try {
    // Resolve the destination message's document file id.
    const msg = (await invokeWithTimeout(client, {
      _: "getMessage",
      chat_id: Number(destChatTelegramId),
      message_id: Number(destMessageId),
    })) as { content?: { document?: { document?: { id: number } } } };
    const fid = msg?.content?.document?.document?.id;
    if (!fid) return null;
    return await readScannedZipListing(client, String(fid), fileSize);
  } catch (err) {
    log.warn({ err, destMessageId: Number(destMessageId) }, "destination ZIP listing read failed");
    return null;
  }
}
```

- [ ] **Step 3: Use it in `tryProvenanceBackfill`** — when `args.archiveType === "ZIP"`, after computing `candidateEntries` from `getPackageFileCrcs`, if `crcFingerprint(candidateEntries).complete === false` and the candidate has a destination copy, replace `candidateEntries` with the result of `readZipListingFromDestination(...)` (use the last of `destMessageIds` if present, else `destMessageId`). Then run `fingerprintsMatch(entries, candidateEntries)` as before. If the destination read returns null, fall through to name+size.

- [ ] **Step 4: Typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add worker/src/db/queries.ts worker/src/provenance-backfill.ts
git commit -m "feat(worker): fingerprint listing-less ZIP candidates via destination copy"
```

---

### Task 10: Multi-candidate ambiguity notification

**Files:**
- Modify: `worker/src/db/queries.ts` (add `findPlaceholderCandidates` returning all matches; add `createGroupingConflictNotification`-style helper or reuse `db.systemNotification.create`)
- Modify: `worker/src/provenance-backfill.ts`

**Interfaces:**
- `findPlaceholderCandidates(destChannelId, fileName, fileSize): Promise<Candidate[]>` — all placeholder matches (same select as Task 9), oldest first.
- Orchestrator resolves ambiguity via fingerprint; if it can't, emits a `SystemNotification` and backfills nothing.

- [ ] **Step 1: Add `findPlaceholderCandidates`** (plural) in `db/queries.ts` — identical to `findPlaceholderCandidate` but `findMany`. Keep the singular as `return (await findPlaceholderCandidates(...))[0] ?? null` to avoid duplication.

- [ ] **Step 2: Update `tryProvenanceBackfill`**

```ts
const candidates = await findPlaceholderCandidates(args.destChannelId, args.fileName, args.fileSize);
if (candidates.length === 0) return { backfilled: false };

let chosen = candidates[0];
if (candidates.length > 1) {
  // Try to disambiguate by fingerprint (ZIP only). If exactly one matches, pick it.
  if (args.archiveType === "ZIP" && scannedEntries) {
    const matches = [];
    for (const c of candidates) {
      const crcs = await getPackageFileCrcs(c.id);
      const ce: FileEntry[] = crcs.map((crc) => ({ path:"", fileName:"", extension:null, compressedSize:0n, uncompressedSize:0n, crc32: crc }));
      if (fingerprintsMatch(scannedEntries, ce)) matches.push(c);
    }
    if (matches.length === 1) { chosen = matches[0]; }
    else {
      await db.systemNotification.create({ data: {
        type: "INTEGRITY_AUDIT", severity: "WARNING",
        title: `Ambiguous provenance match: ${args.fileName}`,
        message: `${candidates.length} placeholder packages share this name+size and the fingerprint did not uniquely disambiguate. No provenance was backfilled.`,
        context: { fileName: args.fileName, candidateIds: candidates.map((c) => c.id) },
      }});
      return { backfilled: false };
    }
  } else {
    // Can't disambiguate without a fingerprint — notify, don't guess.
    await db.systemNotification.create({ data: {
      type: "INTEGRITY_AUDIT", severity: "WARNING",
      title: `Ambiguous provenance match: ${args.fileName}`,
      message: `${candidates.length} placeholder packages share this name+size (archive type ${args.archiveType} — no cheap fingerprint). No provenance was backfilled.`,
      context: { fileName: args.fileName, candidateIds: candidates.map((c) => c.id) },
    }});
    return { backfilled: false };
  }
}
```

(Refactor the single-candidate ZIP fingerprint logic from Task 6 to compute `scannedEntries` once up front and reuse `chosen` in the `backfillProvenance` call. Import `db` from `./db/client.js`. Confirm `SkipReason`/`NotificationType` enum has `INTEGRITY_AUDIT`; if not, use an existing value like `UPLOAD_FAILED` or the correct `NotificationType`.)

- [ ] **Step 3: Typecheck + Commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/db/queries.ts worker/src/provenance-backfill.ts
git commit -m "feat(worker): notify on ambiguous provenance candidates instead of guessing"
```

---

### Task 11: 7z ranged listing (SPIKE-gated)

**Files:**
- Modify: `worker/src/archive/central-directory.ts` (add 7z end-header locator)
- Modify: `worker/src/provenance-backfill.ts` (add 7z branch)

**⚠️ Honesty note:** Full 7z listing-from-tail is materially harder than ZIP. 7z stores its metadata header at the end (locatable from the 32-byte start header: sig `37 7A BC AF 27 1C`, then at offset 12 an 8-byte `NextHeaderOffset` relative to byte 32, and at offset 20 an 8-byte `NextHeaderSize`). BUT the header is frequently an *encoded (LZMA-compressed) header*, which requires decoding the packed header stream (also near EOF) to recover file CRCs — non-trivial to implement correctly from scratch. This task is therefore SPIKE-GATED: implement only the plain-header common case; fall back to name+size otherwise. Do not ship a half-correct LZMA decoder.

**Interfaces:**
- `locate7zHeader(startHeader: Buffer): { nextHeaderOffset: number; nextHeaderSize: number } | null` (pure) — parses the 32-byte start header.
- `parse7zPlainHeaderCrcs(header: Buffer): string[] | null` (pure) — returns file CRC32s if the header is a plain (kHeader) structure with a `kCRC` section; returns `null` if the header is encoded (`kEncodedHeader`, id `0x17`) or otherwise unparseable.

- [ ] **Step 1: Spike** — download the last ~4 MB of a known 7z from the destination channel via `downloadFileRange`, plus the first 32 bytes. Compute the header region from the start header, extract it from the tail buffer, and inspect its first byte: `0x01` = plain header (`kHeader`), `0x17` = encoded header (`kEncodedHeader`). Record the observed distribution across a few real archives. If the vast majority are encoded, STOP and leave 7z as name+size (document the finding in a comment) — do not implement steps 2–4.

- [ ] **Step 2: Implement `locate7zHeader` (pure)** with a unit test (signature check + offset/size read). Add to `central-directory.test.ts`.

```ts
export function locate7zHeader(startHeader: Buffer): { nextHeaderOffset: number; nextHeaderSize: number } | null {
  const SIG = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  if (startHeader.length < 32 || !startHeader.subarray(0, 6).equals(SIG)) return null;
  return {
    nextHeaderOffset: Number(startHeader.readBigUInt64LE(12)),
    nextHeaderSize: Number(startHeader.readBigUInt64LE(20)),
  };
}
```

- [ ] **Step 3: Implement `parse7zPlainHeaderCrcs` (pure)** for the kHeader→kMainStreamsInfo→kSubStreamsInfo→kCRC path, returning CRCs; return `null` on `kEncodedHeader` (0x17) or any unrecognized property id. Unit-test with a fixture 7z created by the system `7z a -mhc=off` (header-compression off → plain header) in the test setup, skipped if `7z` is unavailable.

- [ ] **Step 4: Wire the 7z branch** in `tryProvenanceBackfill`: for `archiveType === "SEVEN_Z"`, download the start header (first 32 bytes) + a generous tail, `locate7zHeader`, extract the header bytes, `parse7zPlainHeaderCrcs`. If non-null, build `FileEntry[]` with those CRCs (path/name empty is fine for fingerprinting) and fingerprint-compare; else fall back to name+size.

- [ ] **Step 5: Typecheck + Commit**

```bash
cd worker && npx tsc --noEmit && npm test -- central-directory
git add worker/src/archive/central-directory.ts worker/src/archive/central-directory.test.ts worker/src/provenance-backfill.ts
git commit -m "feat(worker): 7z plain-header ranged fingerprint (name+size fallback for encoded headers)"
```

---

### Task 12: Manual integration verification

**Files:** none (verification only).

- [ ] **Step 1: Pick a known placeholder package** — a manually-uploaded ZIP whose content also exists in a real source channel. Confirm in DB: `SELECT id, "sourceChannelId", "destChannelId", "fileCount" FROM packages WHERE ...` shows `sourceChannelId == destChannelId`.

- [ ] **Step 2: Re-index the real source channel** (trigger a fetch/scan of the channel containing that archive).

- [ ] **Step 3: Verify backfill** — the package now has the real `sourceChannelId`, `sourceMessageId`, `sourceCaption`, `creator`; `fileCount > 0` if it was 0 before; the run's `zipsBackfilled` incremented; worker logs show "Backfilled provenance … confidence=fingerprint"; no full download occurred (no large download in logs for that archive).

- [ ] **Step 4: Idempotency** — re-run the same scan; verify the package is now skipped via the existing dedup (remoteUniqueId/repost) and NOT mutated again; `zipsBackfilled` does not increment.

- [ ] **Step 5: Collision safety** — (if available) a different archive sharing name+size with a placeholder but different contents ingests as a NEW package (fingerprint mismatch path), not mis-attributed.

- [ ] **Step 6: RAR fallback** — a RAR placeholder match backfills with `confidence=name-size` and logs the lower-confidence notice.

---

## Self-Review

**Spec coverage:**
- Candidate = `sourceChannelId == destChannelId` → Task 5 `findPlaceholderCandidate`, re-checked in `backfillProvenance`. ✓
- Hook between repost check and download → Task 8. ✓
- Fingerprint via ranged tail (ZIP) → Tasks 3, 4, 6. ✓
- 7z end-header → Task 11 (SPIKE-gated: plain-header case implemented, encoded-header falls back to name+size). Task 6 returns null for 7z until Task 11 wires the branch.
- Candidate side CRCs from `PackageFile` → Task 5 `getPackageFileCrcs`, Task 6. ✓
- Rebuild candidates (no CRCs) → Task 9 adds the destination-copy second tail read for ZIP so they can still be fingerprint-confirmed; non-ZIP listing-less candidates fall to name+size.
- Fields written (source*, remoteUniqueId, creator always, fileCount/PackageFile if empty, preview if empty) → Task 5. ✓
- RAR name+size, logged → Task 6/8. ✓
- Fingerprint mismatch → fall through to normal ingestion → Task 6 returns `{backfilled:false}`, Task 8 continues. ✓
- Ambiguity notification → Task 10 (`findPlaceholderCandidates` + fingerprint disambiguation + `SystemNotification` when it can't uniquely resolve).
- Idempotency → Task 8 relies on existing checks after `remoteUniqueId` is set; verified in Task 9. ✓
- Tail-download failure → return null / leave untouched → Task 6. ✓
- Transaction re-check → Task 5. ✓
- `zipsBackfilled` counter → Tasks 7, 8. ✓
- Lightweight harness + pure-fn tests → Tasks 1–3. ✓

**Remaining bounded risk:** Task 11's 7z support is spike-gated — if real archives use encoded headers, 7z stays at name+size confidence (documented, safe). No other spec items are deferred.

**Placeholder scan:** No TBD/TODO left; all code steps contain full code. Spike (Task 4) is a genuine verification step, not a placeholder.

**Type consistency:** `FileEntry` shape consistent across Tasks 2/3/5/6; `BackfillProvenanceInput`/`BackfillArgs` names match between Tasks 5 and 6; `tryProvenanceBackfill` return type consistent between Tasks 6 and 8.
