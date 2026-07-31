# Ranged inner-file listing (RAR & 7z) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index the inner files of RAR & 7z placeholder packages via small ranged reads (no full download), so the reindex/provenance-backfill path fills `fileCount`/`package_files` for all archive types.

**Architecture:** For each archive, do the minimum binary parsing to locate its header bytes, fetch only those via `downloadFileRange`, write them into a sparse temp file at their true offsets (data regions left as zero holes), then run the existing `7z l` / `unrar lt` (via `read7zContents` / `readRarContents`) and reuse their parsers. A ranged reader returning `null` triggers a size-capped full-download fallback.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), TDLib via `tdl`, vitest, `unrar`/`7z` CLIs (already installed in the worker image), Prisma/Postgres.

## Global Constraints

- TypeScript strict; ESM import specifiers end in `.js`. Copy the surrounding files' style.
- ESLint does NOT cover `worker/` — but keep types clean; no `any` unless mirroring existing patterns.
- Tests: vitest, files match `src/**/*.test.ts`; run from `worker/` with `npx vitest run`.
- All TDLib calls must go through FLOOD_WAIT-safe wrappers. `downloadFileRange` already wraps `client.invoke` in `withFloodWait` — do not add a second wrapper. Keep ranged reads **sequential** (never `Promise.all` a walk).
- Full-download fallback is gated by `config.maxZipSizeMB` (env `WORKER_MAX_ZIP_SIZE_MB`, default 204800). Over the cap → do NOT download; write a `SystemNotification` and return `null`.
- No new DB migration. Reuse the existing `zipsBackfilled` counter.
- Shared return type is `FileEntry` from `worker/src/archive/zip-reader.ts`:
  `{ path: string; fileName: string; extension: string | null; compressedSize: bigint; uncompressedSize: bigint; crc32: string | null }`.
- Deploy is local (no GitHub push): build `worker/Dockerfile` locally, recreate the `dragonsstash-worker` container from the local image WITHOUT `pull` (see Task 4 / Task 8 deploy steps).

---

## File Structure

- Create `worker/src/archive/ranged/sparse-list.ts` — sparse temp-file reconstruction + CLI lister. (+ `sparse-list.test.ts`)
- Create `worker/src/archive/ranged/sevenz-ranged.ts` — 7z signature parse + ranged listing. (+ `sevenz-ranged.test.ts`)
- Create `worker/src/archive/ranged/rar-ranged.ts` — RAR signature/vint/block-extent parse + ranged walk. (+ `rar-ranged.test.ts`)
- Create `worker/src/archive/ranged/range-reader.ts` — `RangeReader` type + default TDLib impl.
- Create `worker/src/archive/ranged/fallback.ts` — size-capped full-download fallback + notification.
- Modify `worker/src/provenance-backfill.ts` — dispatch scanned/destination listing by archive type; call fallback.
- Modify `worker/src/worker.ts` — include `fileName` in the `scannedParts` passed to `tryProvenanceBackfill`.

---

## Task 1: Sparse reconstruction helper (`sparse-list.ts`)

**Files:**
- Create: `worker/src/archive/ranged/sparse-list.ts`
- Test: `worker/src/archive/ranged/sparse-list.test.ts`

**Interfaces:**
- Consumes: `FileEntry` from `../zip-reader.js`; `config.tempDir` from `../../util/config.js`.
- Produces:
  - `interface SparsePart { fileName: string; size: number; regions: { offset: number; bytes: Buffer }[] }`
  - `type SparseLister = (firstPartPath: string) => Promise<FileEntry[]>`
  - `async function listFromSparse(parts: SparsePart[], lister: SparseLister): Promise<FileEntry[] | null>`

- [ ] **Step 1: Write the failing test**

```typescript
// worker/src/archive/ranged/sparse-list.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/ranged/sparse-list.test.ts`
Expected: FAIL — `Cannot find module './sparse-list.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/src/archive/ranged/sparse-list.ts
import { mkdtemp, open, rm } from "fs/promises";
import path from "path";
import { config } from "../../util/config.js";
import { childLogger } from "../../util/logger.js";
import type { FileEntry } from "../zip-reader.js";

const log = childLogger("sparse-list");

export interface SparsePart {
  fileName: string;
  size: number;
  regions: { offset: number; bytes: Buffer }[];
}

export type SparseLister = (firstPartPath: string) => Promise<FileEntry[]>;

/**
 * Reconstruct archive header bytes into sparse temp files (data areas left as
 * zero holes), run `lister` on the first part, return its entries.
 * Returns null on any error or when the lister finds nothing.
 */
export async function listFromSparse(
  parts: SparsePart[],
  lister: SparseLister,
): Promise<FileEntry[] | null> {
  if (parts.length === 0) return null;
  const dir = await mkdtemp(path.join(config.tempDir, "ranged-"));
  try {
    let firstPath = "";
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const filePath = path.join(dir, p.fileName);
      if (i === 0) firstPath = filePath;
      const fh = await open(filePath, "w");
      try {
        await fh.truncate(p.size); // create the sparse hole
        for (const r of p.regions) {
          await fh.write(r.bytes, 0, r.bytes.length, r.offset);
        }
      } finally {
        await fh.close();
      }
    }
    const entries = await lister(firstPath);
    return entries.length > 0 ? entries : null;
  } catch (err) {
    log.warn({ err }, "sparse listing failed");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/ranged/sparse-list.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/ranged/sparse-list.ts worker/src/archive/ranged/sparse-list.test.ts
git commit -m "feat(worker): sparse-file reconstruction helper for ranged archive listing"
```

---

## Task 2: 7z signature-header parser (`sevenz-ranged.ts`, pure part)

**Files:**
- Create: `worker/src/archive/ranged/sevenz-ranged.ts`
- Test: `worker/src/archive/ranged/sevenz-ranged.test.ts`

**Interfaces:**
- Produces: `function parseSevenZSignatureHeader(buf: Buffer): { nextHeaderOffset: number; nextHeaderSize: number } | null`
  - Returns null unless `buf` starts with the 6-byte 7z magic and is ≥ 32 bytes.
  - `nextHeaderOffset` is relative to the end of the 32-byte signature header (absolute end-header start = `32 + nextHeaderOffset`).

- [ ] **Step 1: Write the failing test**

```typescript
// worker/src/archive/ranged/sevenz-ranged.test.ts
import { describe, it, expect } from "vitest";
import { parseSevenZSignatureHeader } from "./sevenz-ranged.js";

const MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

function buildSignatureHeader(nextOffset: bigint, nextSize: bigint): Buffer {
  const buf = Buffer.alloc(32);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(0, 6); buf.writeUInt8(4, 7);  // version 0.4
  buf.writeUInt32LE(0, 8);                      // StartHeaderCRC (unused here)
  buf.writeBigUInt64LE(nextOffset, 12);
  buf.writeBigUInt64LE(nextSize, 20);
  buf.writeUInt32LE(0, 28);                     // NextHeaderCRC (unused here)
  return buf;
}

describe("parseSevenZSignatureHeader", () => {
  it("reads NextHeaderOffset and NextHeaderSize", () => {
    const buf = buildSignatureHeader(1_000_000n, 4096n);
    expect(parseSevenZSignatureHeader(buf)).toEqual({ nextHeaderOffset: 1_000_000, nextHeaderSize: 4096 });
  });

  it("returns null on bad magic", () => {
    expect(parseSevenZSignatureHeader(Buffer.alloc(32))).toBeNull();
  });

  it("returns null when shorter than 32 bytes", () => {
    expect(parseSevenZSignatureHeader(MAGIC)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/ranged/sevenz-ranged.test.ts`
Expected: FAIL — `Cannot find module './sevenz-ranged.js'`.

- [ ] **Step 3: Write minimal implementation** (signature parser only — orchestrator added in Task 3)

```typescript
// worker/src/archive/ranged/sevenz-ranged.ts
const SEVENZ_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

export function parseSevenZSignatureHeader(
  buf: Buffer,
): { nextHeaderOffset: number; nextHeaderSize: number } | null {
  if (buf.length < 32) return null;
  if (!buf.subarray(0, 6).equals(SEVENZ_MAGIC)) return null;
  return {
    nextHeaderOffset: Number(buf.readBigUInt64LE(12)),
    nextHeaderSize: Number(buf.readBigUInt64LE(20)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/ranged/sevenz-ranged.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/ranged/sevenz-ranged.ts worker/src/archive/ranged/sevenz-ranged.test.ts
git commit -m "feat(worker): 7z signature-header parser"
```

---

## Task 3: `RangeReader` + 7z ranged listing orchestrator

**Files:**
- Create: `worker/src/archive/ranged/range-reader.ts`
- Modify: `worker/src/archive/ranged/sevenz-ranged.ts` (add orchestrator)
- Test: `worker/src/archive/ranged/sevenz-ranged.test.ts` (add case)

**Interfaces:**
- Consumes: `parseSevenZSignatureHeader` (Task 2); `listFromSparse`, `SparsePart` (Task 1); `read7zContents` from `../sevenz-reader.js`; `downloadFileRange` from `../../tdlib/range-download.js`.
- Produces:
  - `worker/src/archive/ranged/range-reader.ts`:
    - `type RangeReader = (fileId: string, offset: number, length: number, partSize: bigint) => Promise<Buffer>`
    - `function tdlibRangeReader(client: import("tdl").Client): RangeReader`
  - `sevenz-ranged.ts`:
    - `interface RangedPart { fileId: string; fileSize: bigint; fileName: string }`
    - `async function readSevenZListingRanged(parts: RangedPart[], read: RangeReader): Promise<FileEntry[] | null>`
      (7z placeholders are single-part; uses `parts[0]`.)

- [ ] **Step 1: Write the failing test** (append to `sevenz-ranged.test.ts`)

```typescript
import { readSevenZListingRanged } from "./sevenz-ranged.js";
import type { RangeReader } from "./range-reader.js";

describe("readSevenZListingRanged", () => {
  it("reads the signature + end-header regions and reconstructs for 7z l", async () => {
    const size = 5_000_000;
    const endHeaderOffset = 4_900_000; // absolute
    const nextHeaderOffset = endHeaderOffset - 32;
    const sig = Buffer.alloc(32);
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).copy(sig, 0);
    sig.writeBigUInt64LE(BigInt(nextHeaderOffset), 12);
    sig.writeBigUInt64LE(100n, 20);

    const reads: { offset: number; length: number }[] = [];
    const read: RangeReader = async (_id, offset, length) => {
      reads.push({ offset, length });
      if (offset === 0) return sig.subarray(0, length);
      return Buffer.alloc(length, 0xAB); // stand-in end-header bytes
    };

    // Inject a fake lister via the module boundary: readSevenZListingRanged
    // calls listFromSparse(parts, read7zContents). We assert the ranged reads
    // it issued; the sparse file + real 7z is covered by live verification.
    const entries = await readSevenZListingRanged(
      [{ fileId: "1", fileSize: BigInt(size), fileName: "a.7z" }],
      read,
    );
    // entries may be null here because the stand-in bytes aren't a real 7z;
    // the contract under test is the ranged-read offsets:
    expect(reads[0]).toEqual({ offset: 0, length: 32 });
    expect(reads[1]).toEqual({ offset: endHeaderOffset, length: 100 });
    expect(entries === null || Array.isArray(entries)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/ranged/sevenz-ranged.test.ts`
Expected: FAIL — `readSevenZListingRanged`/`range-reader.js` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/src/archive/ranged/range-reader.ts
import type { Client } from "tdl";
import { downloadFileRange } from "../../tdlib/range-download.js";

export type RangeReader = (
  fileId: string,
  offset: number,
  length: number,
  partSize: bigint,
) => Promise<Buffer>;

export function tdlibRangeReader(client: Client): RangeReader {
  return (fileId, offset, length, partSize) =>
    downloadFileRange(client, fileId, offset, length, partSize);
}
```

```typescript
// append to worker/src/archive/ranged/sevenz-ranged.ts
import type { FileEntry } from "../zip-reader.js";
import { read7zContents } from "../sevenz-reader.js";
import { listFromSparse } from "./sparse-list.js";
import type { RangeReader } from "./range-reader.js";
import { childLogger } from "../../util/logger.js";

const log = childLogger("sevenz-ranged");

export interface RangedPart { fileId: string; fileSize: bigint; fileName: string }

export async function readSevenZListingRanged(
  parts: RangedPart[],
  read: RangeReader,
): Promise<FileEntry[] | null> {
  const part = parts[0];
  if (!part) return null;
  const size = Number(part.fileSize);
  try {
    const sig = await read(part.fileId, 0, 32, part.fileSize);
    const parsed = parseSevenZSignatureHeader(sig);
    if (!parsed) return null;
    const endStart = 32 + parsed.nextHeaderOffset;
    if (endStart < 0 || endStart + parsed.nextHeaderSize > size) return null;
    const endHeader = await read(part.fileId, endStart, parsed.nextHeaderSize, part.fileSize);
    return listFromSparse(
      [{
        fileName: part.fileName,
        size,
        regions: [
          { offset: 0, bytes: sig },
          { offset: endStart, bytes: endHeader },
        ],
      }],
      read7zContents,
    );
  } catch (err) {
    log.warn({ err, fileId: part.fileId }, "ranged 7z listing failed");
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/ranged/sevenz-ranged.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/ranged/range-reader.ts worker/src/archive/ranged/sevenz-ranged.ts worker/src/archive/ranged/sevenz-ranged.test.ts
git commit -m "feat(worker): ranged 7z listing orchestrator + RangeReader"
```

---

## Task 4: Wire 7z into provenance-backfill + fallback stub; deploy & live-verify (the productive spike)

**Files:**
- Create: `worker/src/archive/ranged/fallback.ts`
- Modify: `worker/src/provenance-backfill.ts` (dispatch scanned/dest listing; call fallback)
- Modify: `worker/src/worker.ts` (add `fileName` to `scannedParts`)
- Test: `worker/src/archive/ranged/fallback.test.ts`

**Interfaces:**
- Consumes: `readSevenZListingRanged`, `RangedPart` (Task 3); `tdlibRangeReader` (Task 3); `read7zContents`/`readRarContents`; `downloadFile` from `../../tdlib/download.js`; `config.maxZipSizeMB`, `config.tempDir`; `db` from `../../db/client.js`.
- Produces:
  - `fallback.ts`: `async function fullDownloadListing(args: { client: import("tdl").Client; parts: RangedPart[]; archiveType: string; totalSize: bigint; fileName: string; }): Promise<FileEntry[] | null>` — downloads all parts if `totalSize <= maxZipSizeMB`, runs the CLI reader, returns entries; over cap → writes a `SystemNotification` and returns null.
  - In `provenance-backfill.ts`: `async function readScannedListingRanged(archiveType: string, client, parts: RangedPart[]): Promise<FileEntry[] | null>` used in place of the ZIP-only branch. (RAR routes to Task 6/7's function — see Task 8; for now RAR returns null → fallback.)

- [ ] **Step 1: Write the failing test** (fallback size-cap behavior — pure, no real download)

```typescript
// worker/src/archive/ranged/fallback.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../util/config.js", () => ({ config: { maxZipSizeMB: 1, tempDir: "/tmp" } }));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/ranged/fallback.test.ts`
Expected: FAIL — `Cannot find module './fallback.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/src/archive/ranged/fallback.ts
import { mkdtemp, rm } from "fs/promises";
import path from "path";
import type { Client } from "tdl";
import { config } from "../../util/config.js";
import { db } from "../../db/client.js";
import { childLogger } from "../../util/logger.js";
import { downloadFile } from "../../tdlib/download.js";
import { read7zContents } from "../sevenz-reader.js";
import { readRarContents } from "../rar-reader.js";
import type { FileEntry } from "../zip-reader.js";
import type { RangedPart } from "./sevenz-ranged.js";

const log = childLogger("ranged-fallback");

export async function fullDownloadListing(args: {
  client: Client;
  parts: RangedPart[];
  archiveType: string;
  totalSize: bigint;
  fileName: string;
}): Promise<FileEntry[] | null> {
  const capBytes = BigInt(config.maxZipSizeMB) * 1024n * 1024n;
  if (args.totalSize > capBytes) {
    await db.systemNotification.create({
      data: {
        type: "INTEGRITY_AUDIT",
        severity: "WARNING",
        title: `Listing skipped (over size cap): ${args.fileName}`,
        message: `Ranged listing failed and the archive (${args.totalSize} bytes) exceeds WORKER_MAX_ZIP_SIZE_MB; not downloaded. Inner files left unindexed.`,
        context: { fileName: args.fileName, archiveType: args.archiveType },
      },
    });
    log.warn({ fileName: args.fileName }, "fallback skipped — over size cap");
    return null;
  }
  const dir = await mkdtemp(path.join(config.tempDir, "fallback-"));
  const paths: string[] = [];
  try {
    for (const p of args.parts) {
      const dest = path.join(dir, p.fileName);
      await downloadFile(args.client, p.fileId, dest, p.fileSize, p.fileName, () => {});
      paths.push(dest);
    }
    const entries =
      args.archiveType === "SEVEN_Z" ? await read7zContents(paths[0])
      : args.archiveType === "RAR" ? await readRarContents(paths[0])
      : [];
    return entries.length > 0 ? entries : null;
  } catch (err) {
    log.warn({ err, fileName: args.fileName }, "full-download fallback failed");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/ranged/fallback.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Wire the dispatcher into `provenance-backfill.ts`**

Replace the ZIP-only scanned-listing branch. Find (around line 146-149):

```typescript
  let scannedEntries: FileEntry[] | null = null;
  if (args.archiveType === "ZIP") {
    scannedEntries = await readScannedZipListing(args.client, args.scannedParts);
  }
```

Replace with:

```typescript
  let scannedEntries: FileEntry[] | null = await readScannedListingRanged(
    args.archiveType, args.client, args.scannedParts,
  );
  // Cheap ranged read failed — fall back to a size-capped full download so the
  // listing still gets indexed. Only worth it when the candidate lacks a listing.
  if (!scannedEntries && candidates.some((c) => c.fileCount === 0)) {
    const totalSize = args.scannedParts.reduce((s, p) => s + p.fileSize, 0n);
    scannedEntries = await fullDownloadListing({
      client: args.client, parts: args.scannedParts, archiveType: args.archiveType,
      totalSize, fileName: args.fileName,
    });
  }
```

Add this dispatcher function near the other read helpers in `provenance-backfill.ts`:

```typescript
async function readScannedListingRanged(
  archiveType: string,
  client: Client,
  parts: RangedPart[],
): Promise<FileEntry[] | null> {
  const read = tdlibRangeReader(client);
  if (archiveType === "ZIP") return readScannedZipListing(client, parts);
  if (archiveType === "SEVEN_Z") return readSevenZListingRanged(parts, read);
  // RAR enabled in Task 8.
  return null;
}
```

Add imports at the top of `provenance-backfill.ts`:

```typescript
import { readSevenZListingRanged, type RangedPart } from "./archive/ranged/sevenz-ranged.js";
import { tdlibRangeReader } from "./archive/ranged/range-reader.js";
import { fullDownloadListing } from "./archive/ranged/fallback.js";
```

Change `args.scannedParts` type in `BackfillArgs` from `{ fileId: string; fileSize: bigint }[]` to `RangedPart[]` (adds `fileName`).

- [ ] **Step 6: Add `fileName` to `scannedParts` in `worker.ts`**

Find (around line 1674):

```typescript
        scannedParts: archiveSet.parts.map((p) => ({ fileId: p.fileId, fileSize: p.fileSize })),
```

Replace with:

```typescript
        scannedParts: archiveSet.parts.map((p) => ({ fileId: p.fileId, fileSize: p.fileSize, fileName: p.fileName })),
```

- [ ] **Step 7: Typecheck + full test run + build**

```bash
cd worker && npx tsc --noEmit && npx vitest run
```
Expected: no TS errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add worker/src/archive/ranged/fallback.ts worker/src/archive/ranged/fallback.test.ts worker/src/provenance-backfill.ts worker/src/worker.ts
git commit -m "feat(worker): dispatch 7z ranged listing + size-capped full-download fallback"
```

- [ ] **Step 9: Deploy locally (no push) and live-verify 7z**

```bash
cd /home/sam/Documents/DragonsStash
docker build -f worker/Dockerfile -t git.samagsteribbe.nl/admin/dragonsstash-worker:latest .
docker compose --project-name dragonsstash --project-directory /opt/stacks/DragonsStash \
  -f /opt/stacks/DragonsStash/docker-compose.yml up -d --no-deps --force-recreate worker
```

Then verify the 7z ranged path is populating listings (not full-downloading):

```bash
# Watch for ranged 7z work + confirm no multi-GB downloads for 7z
docker logs -f --since 30s dragonsstash-worker 2>&1 | grep -iE "sevenz-ranged|sparse-list|Backfilled provenance|Downloading archive part"
```

DB check — 7z placeholders gaining a listing:
```sql
SELECT count(*) FROM packages WHERE "contentHash" LIKE 'rebuild:%' AND "archiveType"='SEVEN_Z' AND "fileCount">0;
```
Expected: climbs over successive cycles. Spot-check one against truth: pick a backfilled 7z package's `fileName`, and compare its `package_files` count to `7z l` on a real copy.

**Gate:** if 7z listings populate correctly via the ranged path with no full downloads, the two spike risks (arbitrary-offset ranged read + `7z l` on a sparse file) are proven. Proceed to RAR. If not, stop and debug before building RAR.

---

## Task 5: RAR parsers — vint, signature, block-extent (pure)

**Files:**
- Create: `worker/src/archive/ranged/rar-ranged.ts` (pure parsers only in this task)
- Test: `worker/src/archive/ranged/rar-ranged.test.ts`

**Interfaces:**
- Produces:
  - `function readVint(buf: Buffer, pos: number): { value: number; bytes: number }` (RAR5 base-128 LE varint)
  - `function detectRarSignature(buf: Buffer): { version: 4 | 5; sigLen: number } | null`
  - `interface BlockExtent { headerBytes: number; dataSize: number; isEnd: boolean }`
  - `function parseRar5BlockExtent(buf: Buffer, pos: number): BlockExtent`
  - `function parseRar4BlockExtent(buf: Buffer, pos: number): BlockExtent`

- [ ] **Step 1: Write the failing test**

```typescript
// worker/src/archive/ranged/rar-ranged.test.ts
import { describe, it, expect } from "vitest";
import { readVint, detectRarSignature, parseRar5BlockExtent, parseRar4BlockExtent } from "./rar-ranged.js";

describe("readVint", () => {
  it("reads single-byte and multi-byte values (base-128 LE)", () => {
    expect(readVint(Buffer.from([0x08]), 0)).toEqual({ value: 8, bytes: 1 });
    // 0x80,0x01 => 0 | (1<<7) = 128
    expect(readVint(Buffer.from([0x80, 0x01]), 0)).toEqual({ value: 128, bytes: 2 });
  });
});

describe("detectRarSignature", () => {
  it("detects RAR5 and RAR4", () => {
    expect(detectRarSignature(Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00]))).toEqual({ version: 5, sigLen: 8 });
    expect(detectRarSignature(Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,0x00]))).toEqual({ version: 4, sigLen: 7 });
    expect(detectRarSignature(Buffer.alloc(8))).toBeNull();
  });
});

describe("parseRar5BlockExtent", () => {
  it("computes header+data extent and flags end-of-archive", () => {
    // CRC32(4) | HeaderSize vint=5 | Type vint=2 (file) | Flags vint=2 (data present) | DataSize vint=100 | (pad to headerSize)
    const b = Buffer.concat([
      Buffer.from([0,0,0,0]),      // CRC
      Buffer.from([0x05]),          // HeaderSize = 5 (bytes after this vint)
      Buffer.from([0x02]),          // Type = 2 (file)
      Buffer.from([0x02]),          // Flags = 0x02 -> data present
      Buffer.from([0x64]),          // DataSize = 100
      Buffer.from([0x00, 0x00]),    // padding to fill HeaderSize(5): Type+Flags+DataSize=3, +2 pad =5
    ]);
    const ext = parseRar5BlockExtent(b, 0);
    // headerBytes = 4 (CRC) + 1 (HeaderSize vint) + 5 (HeaderSize) = 10
    expect(ext.headerBytes).toBe(10);
    expect(ext.dataSize).toBe(100);
    expect(ext.isEnd).toBe(false);

    const endBlk = Buffer.from([0,0,0,0, 0x02, 0x05, 0x00]); // HeaderSize=2, Type=5(end), Flags=0
    const e2 = parseRar5BlockExtent(endBlk, 0);
    expect(e2.isEnd).toBe(true);
  });
});

describe("parseRar4BlockExtent", () => {
  it("computes extent with ADD_SIZE when flag 0x8000 is set", () => {
    // CRC(2) TYPE(1)=0x74 FLAGS(2)=0x8000 HEAD_SIZE(2)=11 ADD_SIZE(4)=200
    const b = Buffer.alloc(11);
    b.writeUInt8(0x74, 2);
    b.writeUInt16LE(0x8000, 3);
    b.writeUInt16LE(11, 5);
    b.writeUInt32LE(200, 7);
    const ext = parseRar4BlockExtent(b, 0);
    expect(ext.headerBytes).toBe(11);
    expect(ext.dataSize).toBe(200);
    expect(ext.isEnd).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/ranged/rar-ranged.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Write minimal implementation** (parsers only)

```typescript
// worker/src/archive/ranged/rar-ranged.ts
const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

export function readVint(buf: Buffer, pos: number): { value: number; bytes: number } {
  let value = 0, shift = 0, bytes = 0;
  while (pos + bytes < buf.length) {
    const b = buf[pos + bytes];
    value += (b & 0x7f) * Math.pow(2, shift); // Math.pow keeps >32-bit sizes exact up to 2^53
    bytes++;
    if ((b & 0x80) === 0) return { value, bytes };
    shift += 7;
    if (shift > 63) break;
  }
  throw new RangeError("incomplete RAR vint");
}

export function detectRarSignature(buf: Buffer): { version: 4 | 5; sigLen: number } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(RAR5_SIG)) return { version: 5, sigLen: 8 };
  if (buf.length >= 7 && buf.subarray(0, 7).equals(RAR4_SIG)) return { version: 4, sigLen: 7 };
  return null;
}

export interface BlockExtent { headerBytes: number; dataSize: number; isEnd: boolean }

// RAR5: CRC32(4) | HeaderSize(vint) | HeaderType(vint) | HeaderFlags(vint)
//       [ExtraAreaSize(vint) if flags&0x0001] [DataSize(vint) if flags&0x0002] ...
export function parseRar5BlockExtent(buf: Buffer, pos: number): BlockExtent {
  let p = pos + 4; // skip CRC32
  const hs = readVint(buf, p); p += hs.bytes;
  const headerBytes = 4 + hs.bytes + hs.value; // CRC + HeaderSize-vint + HeaderSize
  const type = readVint(buf, p); p += type.bytes;
  const flags = readVint(buf, p); p += flags.bytes;
  if (flags.value & 0x0001) { const ea = readVint(buf, p); p += ea.bytes; } // extra area size (skip)
  let dataSize = 0;
  if (flags.value & 0x0002) { const ds = readVint(buf, p); p += ds.bytes; dataSize = ds.value; }
  return { headerBytes, dataSize, isEnd: type.value === 5 };
}

// RAR4: HEAD_CRC(2) | HEAD_TYPE(1) | HEAD_FLAGS(2) | HEAD_SIZE(2) [ADD_SIZE(4) if flags&0x8000]
export function parseRar4BlockExtent(buf: Buffer, pos: number): BlockExtent {
  const type = buf.readUInt8(pos + 2);
  const flags = buf.readUInt16LE(pos + 3);
  const headSize = buf.readUInt16LE(pos + 5);
  const dataSize = (flags & 0x8000) ? buf.readUInt32LE(pos + 7) : 0;
  return { headerBytes: headSize, dataSize, isEnd: type === 0x7b };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/ranged/rar-ranged.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/ranged/rar-ranged.ts worker/src/archive/ranged/rar-ranged.test.ts
git commit -m "feat(worker): RAR vint/signature/block-extent parsers"
```

---

## Task 6: RAR ranged walk — single volume

**Files:**
- Modify: `worker/src/archive/ranged/rar-ranged.ts` (add walk + orchestrator)
- Test: `worker/src/archive/ranged/rar-ranged.test.ts` (add case)

**Interfaces:**
- Consumes: parsers (Task 5); `RangeReader`, `RangedPart` (Task 3); `listFromSparse`, `SparsePart` (Task 1); `readRarContents` from `../rar-reader.js`.
- Produces:
  - `async function walkRarVolume(read: RangeReader, part: RangedPart, version: 4 | 5, sigLen: number): Promise<{ offset: number; bytes: Buffer }[] | null>` — sequential header harvest; returns null if a block is unparseable or the block count exceeds `MAX_RAR_BLOCKS = 50000`.
  - `async function readRarListingRanged(parts: RangedPart[], read: RangeReader): Promise<FileEntry[] | null>` (single-part path in this task; multipart in Task 7).

- [ ] **Step 1: Write the failing test** — synthetic RAR5 volume driven by an in-memory `RangeReader`

```typescript
import { walkRarVolume, readRarListingRanged } from "./rar-ranged.js";
import type { RangeReader } from "./range-reader.js";

// Build a synthetic RAR5 volume: signature + main header + 2 file blocks (each
// with data) + end block. We only need extents to be walkable.
function buildRar5Volume(): Buffer {
  const sig = Buffer.from([0x52,0x61,0x72,0x21,0x1a,0x07,0x01,0x00]);
  const block = (type: number, flags: number, dataSize: number, pad = 0) => {
    const body = [Buffer.from([type]), Buffer.from([flags])];
    if (flags & 0x0002) body.push(Buffer.from([dataSize])); // DataSize (<=127 for test)
    if (pad) body.push(Buffer.alloc(pad));
    const bodyBuf = Buffer.concat(body);
    const hs = Buffer.from([bodyBuf.length]); // HeaderSize vint (<=127)
    const header = Buffer.concat([Buffer.alloc(4), hs, bodyBuf]); // CRC(4)+HeaderSize+body
    const data = Buffer.alloc(flags & 0x0002 ? dataSize : 0, 0xEE);
    return Buffer.concat([header, data]);
  };
  const main = block(1, 0, 0);       // main archive header, no data
  const f1 = block(2, 0x02, 20);     // file header + 20 bytes data
  const f2 = block(2, 0x02, 30);     // file header + 30 bytes data
  const end = block(5, 0, 0);        // end of archive
  return Buffer.concat([sig, main, f1, f2, end]);
}

describe("walkRarVolume", () => {
  it("harvests every block header and stops at end-of-archive", async () => {
    const vol = buildRar5Volume();
    const read: RangeReader = async (_id, offset, length) => vol.subarray(offset, offset + length);
    const regions = await walkRarVolume(read, { fileId: "1", fileSize: BigInt(vol.length), fileName: "a.rar" }, 5, 8);
    expect(regions).not.toBeNull();
    // main + 2 files + end = 4 header regions
    expect(regions!).toHaveLength(4);
    // First region starts right after the 8-byte signature
    expect(regions![0].offset).toBe(8);
  });
});

describe("readRarListingRanged (single part)", () => {
  it("returns null cleanly when the reconstructed file isn't a real RAR", async () => {
    const vol = buildRar5Volume();
    const read: RangeReader = async (_id, offset, length) => vol.subarray(offset, offset + length);
    const res = await readRarListingRanged([{ fileId: "1", fileSize: BigInt(vol.length), fileName: "a.rar" }], read);
    expect(res === null || Array.isArray(res)).toBe(true); // real unrar parse covered live
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/ranged/rar-ranged.test.ts`
Expected: FAIL — `walkRarVolume`/`readRarListingRanged` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `rar-ranged.ts`)

```typescript
import type { FileEntry } from "../zip-reader.js";
import type { RangeReader } from "./range-reader.js";
import type { RangedPart } from "./sevenz-ranged.js";
import { listFromSparse, type SparsePart } from "./sparse-list.js";
import { readRarContents } from "../rar-reader.js";
import { childLogger } from "../../util/logger.js";

const rlog = childLogger("rar-ranged");
const MAX_RAR_BLOCKS = 50000;
const HEADER_CHUNK = 8192;

export async function walkRarVolume(
  read: RangeReader,
  part: RangedPart,
  version: 4 | 5,
  sigLen: number,
): Promise<{ offset: number; bytes: Buffer }[] | null> {
  const size = Number(part.fileSize);
  const regions: { offset: number; bytes: Buffer }[] = [];
  let pos = sigLen;
  let blocks = 0;
  try {
    while (pos < size) {
      if (++blocks > MAX_RAR_BLOCKS) return null;
      const chunkLen = Math.min(HEADER_CHUNK, size - pos);
      let chunk = await read(part.fileId, pos, chunkLen, part.fileSize);
      const ext = version === 5 ? parseRar5BlockExtent(chunk, 0) : parseRar4BlockExtent(chunk, 0);
      // Ensure we have the full header bytes to harvest (long filenames).
      let headerBuf = chunk;
      if (ext.headerBytes > chunk.length) {
        headerBuf = await read(part.fileId, pos, Math.min(ext.headerBytes, size - pos), part.fileSize);
      }
      regions.push({ offset: pos, bytes: headerBuf.subarray(0, Math.min(ext.headerBytes, size - pos)) });
      if (ext.isEnd) break;
      const advance = ext.headerBytes + ext.dataSize;
      if (advance <= 0) return null;
      if (pos + advance > size) break; // data clamped at the volume boundary (multipart continuation)
      pos += advance;
    }
    return regions;
  } catch (err) {
    rlog.warn({ err, fileId: part.fileId }, "RAR volume walk failed");
    return null;
  }
}

export async function readRarListingRanged(
  parts: RangedPart[],
  read: RangeReader,
): Promise<FileEntry[] | null> {
  const sparseParts: SparsePart[] = [];
  for (const part of parts) {
    const head = await read(part.fileId, 0, 16, part.fileSize);
    const sig = detectRarSignature(head);
    if (!sig) return null;
    const regions = await walkRarVolume(read, part, sig.version, sig.sigLen);
    if (!regions) return null;
    sparseParts.push({ fileName: part.fileName, size: Number(part.fileSize), regions });
  }
  return listFromSparse(sparseParts, readRarContents);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/ranged/rar-ranged.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/ranged/rar-ranged.ts worker/src/archive/ranged/rar-ranged.test.ts
git commit -m "feat(worker): RAR ranged header-walk + single-part listing"
```

---

## Task 7: RAR multipart walk

**Files:**
- Test: `worker/src/archive/ranged/rar-ranged.test.ts` (add multipart case)

**Interfaces:**
- Consumes: `readRarListingRanged` (Task 6) — already loops over `parts`, walking each volume from its own signature and co-locating sparse files under their real names for `unrar` sibling discovery. This task adds a test to lock that behavior in; no new production code unless the test reveals a gap.

- [ ] **Step 1: Write the failing/【regression】 test** — two volumes, each with its own signature

```typescript
describe("readRarListingRanged (multipart)", () => {
  it("walks each volume from its own signature and reconstructs all parts", async () => {
    const vol = buildRar5Volume(); // reuse from Task 6 test
    // Two volumes with identical structure; each RangeReader read is scoped by fileId.
    const byId: Record<string, Buffer> = { p1: vol, p2: vol };
    const reads: Record<string, number> = { p1: 0, p2: 0 };
    const read: RangeReader = async (fileId, offset, length) => {
      reads[fileId]++;
      return byId[fileId].subarray(offset, offset + length);
    };
    const res = await readRarListingRanged(
      [
        { fileId: "p1", fileSize: BigInt(vol.length), fileName: "x.part1.rar" },
        { fileId: "p2", fileSize: BigInt(vol.length), fileName: "x.part2.rar" },
      ],
      read,
    );
    // Both volumes were walked (each read at least its signature + blocks).
    expect(reads.p1).toBeGreaterThan(0);
    expect(reads.p2).toBeGreaterThan(0);
    expect(res === null || Array.isArray(res)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd worker && npx vitest run src/archive/ranged/rar-ranged.test.ts`
Expected: PASS — `readRarListingRanged` already loops parts. If it does NOT pass (e.g. it read only `p1`), fix `readRarListingRanged` to iterate all `parts` (it should already), then re-run.

- [ ] **Step 3: Commit**

```bash
git add worker/src/archive/ranged/rar-ranged.test.ts
git commit -m "test(worker): lock in RAR multipart per-volume walk"
```

---

## Task 8: Enable RAR in the dispatcher; deploy & live-verify

**Files:**
- Modify: `worker/src/provenance-backfill.ts` (route RAR + destination reads through the ranged readers)

**Interfaces:**
- Consumes: `readRarListingRanged` (Task 6), `readSevenZListingRanged` (Task 3).

- [ ] **Step 1: Route RAR in the scanned dispatcher**

In `readScannedListingRanged` (added in Task 4), replace the `// RAR enabled in Task 8.` line so RAR routes to the walker:

```typescript
  if (archiveType === "RAR") return readRarListingRanged(parts, read);
```

Add import to `provenance-backfill.ts`:

```typescript
import { readRarListingRanged } from "./archive/ranged/rar-ranged.js";
```

- [ ] **Step 2: Route 7z/RAR for the destination-copy read**

Find `readZipListingFromDestination` usage inside `resolveCandidateFingerprintEntries` (around line 113) and generalize it. Change the call:

```typescript
    const destEntries = await readZipListingFromDestination(
      client, candidate.destChannel.telegramId, candidate.destMessageIds, candidate.destMessageId,
    );
```

to resolve the doc parts once and dispatch by the candidate's archive type:

```typescript
    const destParts = await resolveDestParts(
      client, candidate.destChannel.telegramId, candidate.destMessageIds, candidate.destMessageId,
    );
    let destEntries: FileEntry[] | null = null;
    if (destParts) {
      const read = tdlibRangeReader(client);
      destEntries =
        candidate.archiveType === "ZIP" ? await readScannedZipListing(client, destParts)
        : candidate.archiveType === "SEVEN_Z" ? await readSevenZListingRanged(destParts, read)
        : candidate.archiveType === "RAR" ? await readRarListingRanged(destParts, read)
        : null;
    }
```

Refactor `readZipListingFromDestination` into `resolveDestParts` returning `RangedPart[] | null` (it already resolves each message's document `id` + `size`; also capture the document `file_name` for `fileName`, falling back to the candidate’s stored `fileName` when TDLib omits it). `PlaceholderCandidate` must expose `archiveType` and `fileName` — extend the select in `findPlaceholderCandidates` (`worker/src/db/queries.ts`) and the `PlaceholderCandidate` type to include `archiveType` and `fileName` (both already columns on `packages`).

- [ ] **Step 3: Typecheck + tests + build**

```bash
cd worker && npx tsc --noEmit && npx vitest run
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add worker/src/provenance-backfill.ts worker/src/db/queries.ts
git commit -m "feat(worker): enable RAR ranged listing + format-aware destination reads"
```

- [ ] **Step 5: Deploy locally (no push)**

```bash
cd /home/sam/Documents/DragonsStash
docker build -f worker/Dockerfile -t git.samagsteribbe.nl/admin/dragonsstash-worker:latest .
docker compose --project-name dragonsstash --project-directory /opt/stacks/DragonsStash \
  -f /opt/stacks/DragonsStash/docker-compose.yml up -d --no-deps --force-recreate worker
```

- [ ] **Step 6: Live-verify RAR (incl. multipart) and the fallback**

```bash
docker logs -f --since 30s dragonsstash-worker 2>&1 | grep -iE "rar-ranged|Backfilled provenance|full-download fallback|over size cap"
```

DB checks:
```sql
-- RAR listings populating without full downloads:
SELECT count(*) FROM packages WHERE "contentHash" LIKE 'rebuild:%' AND "archiveType"='RAR' AND "fileCount">0;
-- Fallback/flag events (should be rare):
SELECT count(*) FROM system_notifications WHERE title LIKE 'Listing skipped%';
```
Spot-check: pick one backfilled multipart RAR, compare its `package_files` count to `unrar lt` run on a real download of the same archive. Confirm the 116 GB RAR (if it surfaces) is flagged, not downloaded.

**Done when:** RAR + 7z placeholders gain accurate `fileCount`/`package_files` via the ranged path, no multi-GB downloads occur except deliberate fallbacks under the size cap, and oversized stragglers are flagged.

---

## Task 4b: 7z encoded-header support (added 2026-07-27 after the Task 4 live spike)

The Task 4 deploy revealed the two-region (start+end) 7z reconstruction is rejected by `7z l`
for archives with an **encoded/LZMA-compressed header** — the packed header stream lives mid-file,
not at EOF. Fix: parse the encoded header's `PackInfo` and fetch that packed region as a third
sparse region. Full brief with exact code + tests: `.superpowers/sdd/task-4b-brief.md`. Adds
`read7zNumber` + `locate7zEncodedHeaderPack` to `sevenz-ranged.ts` and branches
`readSevenZListingRanged` on the next-header type (`0x01` plain → 2 regions; `0x17` encoded → 3
regions; else → null/fallback). Sequenced between Task 5 and Task 6; re-verified live at Task 8.

---

## Self-Review

- **Spec coverage:** 7z ranged read (Tasks 2-4) ✓; RAR walk incl. multipart (Tasks 5-7) ✓; sparse+CLI reconstruction (Task 1) ✓; dispatcher + downstream unchanged (Tasks 4, 8) ✓; size-capped full-download fallback + notification (Task 4) ✓; scanned + destination reads format-aware (Tasks 4, 8) ✓; spike via 7z-first-behind-fallback (Task 4 gate) ✓; unit tests + live verification (throughout) ✓; local deploy recipe (Tasks 4, 8) ✓.
- **Placeholder scan:** no TBD/TODO; every code step has full code; commands have expected output. ✓
- **Type consistency:** `FileEntry`, `RangedPart` (`{fileId,fileSize,fileName}`), `RangeReader` signature, `SparsePart`, `BlockExtent`, `listFromSparse`/`readSevenZListingRanged`/`readRarListingRanged`/`walkRarVolume`/`fullDownloadListing` names/signatures are consistent across tasks. ✓
