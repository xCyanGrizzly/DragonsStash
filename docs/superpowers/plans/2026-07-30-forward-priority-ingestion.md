# Forward-Priority Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For Telegram source channels that allow forwarding, skip the download+reupload round-trip for new archives — use Telegram-native forwarding to move the file to the destination channel, and the existing ranged (no-download) inner-file listing readers to keep every archive fully indexed. Channels that block forwarding, and any specific archive where the cheap listing fails, keep using today's unchanged download+reupload pipeline.

**Architecture:** Add one fork point inside `processOneArchiveSet` (`worker/src/worker.ts`), right after the existing pre-download dedup checks and size guard. If the source channel's cached `allowsForwarding` flag is true, attempt a new forward path: read the inner-file listing via the already-built ranged readers (`worker/src/archive/ranged/*`), derive a dedup identity from the listing (no downloaded bytes available), forward the message(s) natively via TDLib, and write the same `Package`/`PackageFile` records the download path would have produced. Any failure in that path (ranged listing miss, ambiguous/blocked forward) falls straight through into the existing, unchanged download/hash/split/upload code below for that one archive.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), TDLib via `tdl`, vitest, Prisma/Postgres (`@prisma/client` v7).

**Design doc:** `docs/superpowers/specs/2026-07-30-forward-priority-ingestion-design.md` — read it before starting if anything below is unclear about *why*, not just *what*.

## Global Constraints

- TypeScript strict; ESM import specifiers end in `.js`. Copy the surrounding files' style exactly.
- ESLint does NOT cover `worker/` — but keep types clean; no `any` unless mirroring an existing pattern in the same file.
- Tests: vitest, files match `worker/src/**/*.test.ts`; run from `worker/` with `npx vitest run`.
- All TDLib calls must go through the existing FLOOD_WAIT-safe wrappers (`withFloodWait` from `worker/src/util/retry.js`, or `invokeWithTimeout` from `worker/src/tdlib/download.js`). Do not add a second wrapper on top of an already-wrapped call.
- DB migrations run from the **repo root** (the Prisma schema lives at `prisma/schema.prisma`, shared by all three services), not from `worker/`. Command: `npx prisma migrate dev --name <description>` (ensure `DATABASE_URL` is set — check `.env` at repo root first before passing it inline).
- No new test framework — this repo uses vitest only for pure/isolable logic (archive parsers, fingerprint math, request-shape builders). The large `processOneArchiveSet`/`runWorkerForAccount` orchestration in `worker.ts` has no automated test coverage today and is verified live post-deploy; this plan follows that same convention rather than inventing new orchestration-level tests.
- Deploy is local (no GitHub push): build `worker/Dockerfile` locally, recreate the `dragonsstash-worker` container from the local image WITHOUT `pull` — same recipe used by the `ranged-archive-listing` work.
- **Task 1 touches the shared `master` branch (merge + push). Do not run its merge/push commands unattended — stop and get explicit human confirmation before executing them, even when running under an autonomous execution skill.**

---

## File Structure

- Create `worker/src/archive/ranged/dispatch.ts` — the shared (no-download) archive-listing dispatcher, promoted out of `provenance-backfill.ts` so both backfill and fresh ingestion can call it. (+ `dispatch.test.ts`)
- Create `worker/src/archive/forward-identity.ts` — derives a `Package.contentHash`-compatible identity string when there are no downloaded bytes to hash. (+ `forward-identity.test.ts`)
- Create `worker/src/archive/forward-repost-check.ts` — cross-channel CRC-fingerprint duplicate check for the forward path. (+ `forward-repost-check.test.ts`)
- Create `worker/src/upload/forward.ts` — native TDLib forward from source chat to destination chat, mirroring `upload/channel.ts`'s shape. (+ `forward.test.ts`)
- Modify `prisma/schema.prisma` — `TelegramChannel.allowsForwarding`, `IngestionRun.zipsForwarded`.
- Modify `worker/src/db/queries.ts` — `setChannelAllowsForwarding`, `findFingerprintDedupCandidates`, counter plumbing (`ActivityUpdate`, `updateRunActivity`, `completeIngestionRun`).
- Modify `worker/src/provenance-backfill.ts` — import the dispatcher from its new shared location instead of defining it locally; export `resolveCandidateFingerprintEntries` and `compareFingerprints` for reuse.
- Modify `worker/src/worker.ts` — persist the per-channel forwarding flag; add the fork point + `tryForwardArchiveSet` helper; wire the new counter.

---

## Task 1: Merge `feat/ranged-archive-listing` to master, branch for this feature

**This task requires a human to confirm before the merge/push commands run.** `feat/ranged-archive-listing` is already complete and serves a different purpose (backfilling listings onto already-deduped placeholder packages) — it merges independently of this feature.

- [ ] **Step 1: Confirm the branch is clean and up to date**

```bash
cd /path/to/DragonsStash
git status
git log --oneline -5
```
Expected: working tree clean (or only expected local files), branch `feat/ranged-archive-listing` up to date with its remote.

- [ ] **Step 2: STOP — get explicit human confirmation**

Show the human the commit list that will land on `master` (`git log master..feat/ranged-archive-listing --oneline`) and ask them to confirm before proceeding. Do not continue to Step 3 without an explicit yes.

- [ ] **Step 3: Merge to master and push**

```bash
git checkout master
git pull
git merge --no-ff feat/ranged-archive-listing
git push
```
Expected: fast-forward or clean merge commit, push succeeds.

- [ ] **Step 4: Branch for this feature**

```bash
git checkout -b feat/forward-priority-ingestion
```
Expected: new branch created off the just-updated `master`.

---

## Task 2: Schema — `TelegramChannel.allowsForwarding` + `IngestionRun.zipsForwarded`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `TelegramChannel.allowsForwarding: boolean | null` (Prisma-generated type, consumed by Task 3 and Task 8), `IngestionRun.zipsForwarded: number` (consumed by Task 8).

- [ ] **Step 1: Edit `TelegramChannel`**

In `prisma/schema.prisma`, find:

```prisma
model TelegramChannel {
  id         String      @id @default(cuid())
  telegramId BigInt      @unique
  title      String
  type       ChannelType
  isForum    Boolean     @default(false)
  isActive   Boolean     @default(false)
  category   String?     @db.VarChar(64)
```

Replace with:

```prisma
model TelegramChannel {
  id         String      @id @default(cuid())
  telegramId BigInt      @unique
  title      String
  type       ChannelType
  isForum    Boolean     @default(false)
  isActive   Boolean     @default(false)
  category   String?     @db.VarChar(64)
  /// Whether this chat currently allows forwarding/saving (the inverse of
  /// TDLib's chat.has_protected_content). Null = not yet checked; treated the
  /// same as false everywhere in the worker (safe default: use the
  /// download+reupload path until this is confirmed true).
  allowsForwarding Boolean?
```

- [ ] **Step 2: Edit `IngestionRun`**

Find:

```prisma
  zipsIngested    Int             @default(0)
  zipsBackfilled  Int             @default(0)
  errorMessage    String?
```

Replace with:

```prisma
  zipsIngested    Int             @default(0)
  zipsBackfilled  Int             @default(0)
  zipsForwarded   Int             @default(0)
  errorMessage    String?
```

- [ ] **Step 3: Create and apply the migration**

```bash
cd /path/to/DragonsStash
npx prisma migrate dev --name add_forward_priority_ingestion
```
Expected: a new folder under `prisma/migrations/`, migration applied to the local dev DB, Prisma client regenerated (no errors).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): add TelegramChannel.allowsForwarding + IngestionRun.zipsForwarded"
```

---

## Task 3: Detect + persist per-channel forwarding permission

**Files:**
- Modify: `worker/src/db/queries.ts`
- Modify: `worker/src/worker.ts:497-518` (the existing per-channel `getChat` + `isForum` check block, inside `runWorkerForAccount`)

**Interfaces:**
- Produces: `setChannelAllowsForwarding(channelId: string, allowsForwarding: boolean): Promise<TelegramChannel>` (mirrors the existing `setChannelForum`).
- Consumes: nothing new — reuses the `getChat` call already made per channel per cycle.

- [ ] **Step 1: Add the query function**

In `worker/src/db/queries.ts`, find:

```typescript
export async function setChannelForum(channelId: string, isForum: boolean) {
  return db.telegramChannel.update({
    where: { id: channelId },
    data: { isForum },
  });
}
```

Add immediately after it:

```typescript
export async function setChannelAllowsForwarding(channelId: string, allowsForwarding: boolean) {
  return db.telegramChannel.update({
    where: { id: channelId },
    data: { allowsForwarding },
  });
}
```

- [ ] **Step 2: Capture the `getChat` response and persist the flag**

In `worker/src/worker.ts`, find (inside the per-channel loop in `runWorkerForAccount`):

```typescript
        // ── Ensure TDLib knows about this chat ──
        // getChats may not have loaded all channels (pagination, archive folder, etc.)
        // so we explicitly load each channel before scanning.
        try {
          await client.invoke({
            _: "getChat",
            chat_id: Number(channel.telegramId),
          });
        } catch (chatErr) {
          accountLog.warn(
            { err: chatErr, channelId: channel.id, title: channel.title, telegramId: channel.telegramId.toString() },
            "TDLib does not know about this chat — it may not be accessible to this account. Skipping."
          );
          continue;
        }

        // ── Check if channel is a forum ──
        const forum = await isChatForum(client, channel.telegramId);
        if (forum !== channel.isForum) {
          await setChannelForum(channel.id, forum);
          accountLog.info(
            { channelId: channel.id, title: channel.title, isForum: forum },
            "Updated channel forum status"
          );
        }
```

Replace with:

```typescript
        // ── Ensure TDLib knows about this chat ──
        // getChats may not have loaded all channels (pagination, archive folder, etc.)
        // so we explicitly load each channel before scanning. The response is
        // also where we read has_protected_content (below) to decide whether
        // this channel is eligible for the forward-priority ingestion path.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let chatInfo: any;
        try {
          chatInfo = await client.invoke({
            _: "getChat",
            chat_id: Number(channel.telegramId),
          });
        } catch (chatErr) {
          accountLog.warn(
            { err: chatErr, channelId: channel.id, title: channel.title, telegramId: channel.telegramId.toString() },
            "TDLib does not know about this chat — it may not be accessible to this account. Skipping."
          );
          continue;
        }

        // ── Check if channel is a forum ──
        const forum = await isChatForum(client, channel.telegramId);
        if (forum !== channel.isForum) {
          await setChannelForum(channel.id, forum);
          accountLog.info(
            { channelId: channel.id, title: channel.title, isForum: forum },
            "Updated channel forum status"
          );
        }

        // ── Check if channel allows forwarding ──
        // TDLib's chat.has_protected_content is documented on the general
        // Chat object (core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1chat.html),
        // but PENDING LIVE VERIFICATION here: confirm on first deploy that a
        // real chatTypeSupergroup/channel response actually populates this
        // field (some TDLib doc pages describe it in the context of basic
        // groups only). If it's ever `undefined` in practice, this block is a
        // no-op and allowsForwarding stays at its last-known/null value —
        // which safely keeps the channel on the download path.
        const hasProtectedContent: boolean | undefined = chatInfo?.has_protected_content;
        if (typeof hasProtectedContent === "boolean") {
          const allowsForwarding = !hasProtectedContent;
          if (allowsForwarding !== channel.allowsForwarding) {
            await setChannelAllowsForwarding(channel.id, allowsForwarding);
            accountLog.info(
              { channelId: channel.id, title: channel.title, allowsForwarding },
              "Updated channel forwarding permission"
            );
          }
          channel.allowsForwarding = allowsForwarding;
        }
```

- [ ] **Step 3: Typecheck**

```bash
cd worker && npx tsc --noEmit
```
Expected: no errors. (`channel.allowsForwarding` is assignable because `channel` comes from the Prisma-generated `TelegramChannel` type, which now includes the field from Task 2's migration.)

- [ ] **Step 4: Commit**

```bash
git add worker/src/db/queries.ts worker/src/worker.ts
git commit -m "feat(worker): detect + persist per-channel forwarding permission"
```

---

## Task 4: Promote the ranged-listing dispatcher to a shared module

**Files:**
- Create: `worker/src/archive/ranged/dispatch.ts`
- Test: `worker/src/archive/ranged/dispatch.test.ts`
- Modify: `worker/src/provenance-backfill.ts`

**Interfaces:**
- Consumes: `parseZipCentralDirectoryFromTail`, `MIN_ZIP_TAIL_BYTES` from `../central-directory.js`; `downloadFileRange` from `../../tdlib/range-download.js`; `readSevenZListingRanged` from `./sevenz-ranged.js`; `readRarListingRanged` from `./rar-ranged.js`; `tdlibRangeReader`, `RangeReader` from `./range-reader.js`; `RangedPart` from `./sevenz-ranged.js`; `FileEntry` from `../zip-reader.js`.
- Produces: `readScannedZipListing(client: Client, parts: { fileId: string; fileSize: bigint }[]): Promise<FileEntry[] | null>`, `readScannedListingRanged(archiveType: string, client: Client, parts: RangedPart[]): Promise<FileEntry[] | null>` — both consumed by Task 8 (worker.ts) and already-existing callers in `provenance-backfill.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// worker/src/archive/ranged/dispatch.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/ranged/dispatch.test.ts`
Expected: FAIL — `Cannot find module './dispatch.js'`.

- [ ] **Step 3: Create `dispatch.ts` — move `readScannedZipListing` and `readScannedListingRanged` out of `provenance-backfill.ts`**

```typescript
// worker/src/archive/ranged/dispatch.ts
import type { Client } from "tdl";
import { downloadFileRange } from "../../tdlib/range-download.js";
import { parseZipCentralDirectoryFromTail, MIN_ZIP_TAIL_BYTES } from "../central-directory.js";
import { childLogger } from "../../util/logger.js";
import type { FileEntry } from "../zip-reader.js";
import { readSevenZListingRanged, type RangedPart } from "./sevenz-ranged.js";
import { readRarListingRanged } from "./rar-ranged.js";
import { tdlibRangeReader } from "./range-reader.js";

const log = childLogger("ranged-dispatch");

/**
 * Read a ZIP central directory from the tail of a (possibly multipart)
 * archive. `parts` is ordered; only the LAST part carries the EOCD record.
 * `fileSize` on each part is that part's own size (NOT the whole-archive
 * total) so the download offset stays within that part's bounds, while
 * `tailStart` passed to the parser is the logical whole-archive offset
 * (preceding parts' sizes + the offset within the last part).
 */
export async function readScannedZipListing(
  client: Client,
  parts: { fileId: string; fileSize: bigint }[],
): Promise<FileEntry[] | null> {
  if (parts.length === 0) return null;
  const lastPart = parts[parts.length - 1];
  const precedingSize = parts.slice(0, -1).reduce((sum, p) => sum + Number(p.fileSize), 0);
  const lastSize = Number(lastPart.fileSize);
  for (const tailBytes of [MIN_ZIP_TAIL_BYTES, MIN_ZIP_TAIL_BYTES * 4]) {
    const partOffset = Math.max(0, lastSize - tailBytes);
    const downloadLen = Math.min(tailBytes, lastSize);
    try {
      const buf = await downloadFileRange(client, lastPart.fileId, partOffset, downloadLen, lastPart.fileSize);
      const tailStart = precedingSize + partOffset;
      return parseZipCentralDirectoryFromTail(buf, tailStart);
    } catch (err) {
      if (err instanceof RangeError) continue; // try a larger tail
      log.warn({ err, fileId: lastPart.fileId }, "ranged ZIP listing failed");
      return null;
    }
  }
  return null;
}

/**
 * Dispatch a (no-download) inner-file listing read by archive type. Used both
 * by the provenance-backfill path (reading an already-uploaded copy) and the
 * forward-priority ingestion path (reading the source channel's copy before
 * any download/forward decision is made) — the read itself only needs
 * {fileId, fileSize, fileName}, so it doesn't matter which channel the file
 * currently lives in.
 */
export async function readScannedListingRanged(
  archiveType: string,
  client: Client,
  parts: RangedPart[],
): Promise<FileEntry[] | null> {
  const read = tdlibRangeReader(client);
  if (archiveType === "ZIP") return readScannedZipListing(client, parts);
  if (archiveType === "SEVEN_Z") return readSevenZListingRanged(parts, read);
  if (archiveType === "RAR") return readRarListingRanged(parts, read);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/ranged/dispatch.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Update `provenance-backfill.ts` to import instead of define**

In `worker/src/provenance-backfill.ts`, delete the `readScannedZipListing` function body (lines ~47-69) and the `readScannedListingRanged` function body (lines ~109-119).

Change the top-of-file imports from:

```typescript
import { downloadFileRange } from "./tdlib/range-download.js";
import { invokeWithTimeout } from "./tdlib/download.js";
import { parseZipCentralDirectoryFromTail, MIN_ZIP_TAIL_BYTES } from "./archive/central-directory.js";
import { fingerprintsMatch, crcFingerprint } from "./archive/fingerprint.js";
```

to:

```typescript
import { invokeWithTimeout } from "./tdlib/download.js";
import { fingerprintsMatch, crcFingerprint } from "./archive/fingerprint.js";
import { readScannedZipListing, readScannedListingRanged } from "./archive/ranged/dispatch.js";
```

(`downloadFileRange`, `parseZipCentralDirectoryFromTail`, and `MIN_ZIP_TAIL_BYTES` are no longer used directly in this file — they're now only used inside `dispatch.ts`. `readSevenZListingRanged`, `readRarListingRanged`, and `tdlibRangeReader` stay imported in `provenance-backfill.ts` as-is; `resolveCandidateFingerprintEntries` still calls them directly for the destination-copy read.)

- [ ] **Step 6: Typecheck + run the full suite**

```bash
cd worker && npx tsc --noEmit && npx vitest run
```
Expected: no TS errors; all existing tests still pass (this is a pure move — behavior is unchanged).

- [ ] **Step 7: Commit**

```bash
git add worker/src/archive/ranged/dispatch.ts worker/src/archive/ranged/dispatch.test.ts worker/src/provenance-backfill.ts
git commit -m "refactor(worker): promote ranged-listing dispatcher to a shared module"
```

---

## Task 5: Dedup-identity derivation for forward-path packages

**Files:**
- Create: `worker/src/archive/forward-identity.ts`
- Test: `worker/src/archive/forward-identity.test.ts`

**Interfaces:**
- Consumes: `FileEntry` from `./zip-reader.js`; `crcFingerprint` from `./fingerprint.js`.
- Produces: `deriveForwardContentHash(entries: FileEntry[], remoteUniqueId: string | null, sourceChannelId: string, sourceMessageId: bigint): string` — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

```typescript
// worker/src/archive/forward-identity.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/forward-identity.test.ts`
Expected: FAIL — `Cannot find module './forward-identity.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/src/archive/forward-identity.ts
import { createHash } from "crypto";
import { crcFingerprint } from "./fingerprint.js";
import type { FileEntry } from "./zip-reader.js";

/**
 * Derive a Package.contentHash-compatible identity string for a forward-path
 * package (no downloaded bytes exist to hash directly). Priority order:
 *   1. A CRC32-fingerprint hash, when the ranged listing's CRCs are complete
 *      (ZIP/RAR today) — the strongest available signal, since it lets
 *      forward-path and download-path copies of the same archive still
 *      collide/dedupe on identical content.
 *   2. TDLib's remote.unique_id, when CRCs are incomplete (7z today has none).
 *   3. sourceChannelId+sourceMessageId, as a last-resort unique value so the
 *      required-unique Package.contentHash column is always satisfiable.
 * Follows the same `<prefix>:<value>` synthetic-hash convention already used
 * by `rebuild.ts`'s `rebuild:${destChannelId}:${destMessageId}` placeholder.
 */
export function deriveForwardContentHash(
  entries: FileEntry[],
  remoteUniqueId: string | null,
  sourceChannelId: string,
  sourceMessageId: bigint,
): string {
  const fp = crcFingerprint(entries);
  if (fp.complete && fp.crcs.length > 0) {
    const hash = createHash("sha256").update(fp.crcs.join(",")).digest("hex");
    return `fingerprint:${hash}`;
  }
  if (remoteUniqueId) {
    return `forward:${remoteUniqueId}`;
  }
  return `forward:${sourceChannelId}:${sourceMessageId}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/forward-identity.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add worker/src/archive/forward-identity.ts worker/src/archive/forward-identity.test.ts
git commit -m "feat(worker): derive a dedup identity for forward-path packages without bytes"
```

---

## Task 6: Cross-channel CRC-fingerprint repost check

**Files:**
- Modify: `worker/src/db/queries.ts`
- Modify: `worker/src/provenance-backfill.ts`
- Create: `worker/src/archive/forward-repost-check.ts`
- Test: `worker/src/archive/forward-repost-check.test.ts`

**Interfaces:**
- Consumes: `PlaceholderCandidate` type from `../db/queries.js`.
- Produces:
  - `db/queries.ts`: `findFingerprintDedupCandidates(fileName: string, fileSize: bigint): Promise<PlaceholderCandidate[]>`.
  - `provenance-backfill.ts`: `resolveCandidateFingerprintEntries` and `compareFingerprints` become exported (unchanged behavior, just no longer private).
  - `forward-repost-check.ts`: `checkFingerprintRepost(client: Client, entries: FileEntry[], fileName: string, fileSize: bigint): Promise<{ isDuplicate: boolean; matchedPackageId: string | null }>` — consumed by Task 8.

- [ ] **Step 1: Extract the shared row-enrichment helper and add the new query**

In `worker/src/db/queries.ts`, find `findPlaceholderCandidates` (around line 1032):

```typescript
export async function findPlaceholderCandidates(
  destChannelId: string,
  fileName: string,
  fileSize: bigint,
): Promise<PlaceholderCandidate[]> {
  const rows = await db.package.findMany({
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
    select: {
      id: true, archiveType: true, fileName: true, fileCount: true, fileSize: true,
      destMessageId: true, destMessageIds: true, destChannelId: true,
    },
    orderBy: { indexedAt: "asc" },
  });
  if (rows.length === 0) return [];

  const destChannelIds = [...new Set(rows.map((r) => r.destChannelId).filter((id): id is string => !!id))];
  const channels = destChannelIds.length
    ? await db.telegramChannel.findMany({
        where: { id: { in: destChannelIds } },
        select: { id: true, telegramId: true },
      })
    : [];
  const telegramIdById = new Map(channels.map((c) => [c.id, c.telegramId]));

  return rows.map((row) => ({
```

(the function continues with the `.map` return — leave that as-is). Extract the row shape + enrichment into a shared helper by adding this function right ABOVE `findPlaceholderCandidates`:

```typescript
type PlaceholderRow = {
  id: string; archiveType: string; fileName: string; fileCount: number; fileSize: bigint;
  destMessageId: bigint | null; destMessageIds: bigint[]; destChannelId: string | null;
};

async function enrichWithDestChannel(rows: PlaceholderRow[]): Promise<PlaceholderCandidate[]> {
  if (rows.length === 0) return [];
  const destChannelIds = [...new Set(rows.map((r) => r.destChannelId).filter((id): id is string => !!id))];
  const channels = destChannelIds.length
    ? await db.telegramChannel.findMany({
        where: { id: { in: destChannelIds } },
        select: { id: true, telegramId: true },
      })
    : [];
  const telegramIdById = new Map(channels.map((c) => [c.id, c.telegramId]));
  return rows.map((row) => ({
    id: row.id, archiveType: row.archiveType, fileName: row.fileName, fileCount: row.fileCount, fileSize: row.fileSize,
    destMessageId: row.destMessageId, destMessageIds: row.destMessageIds,
    destChannel: row.destChannelId && telegramIdById.has(row.destChannelId)
      ? { telegramId: telegramIdById.get(row.destChannelId)! }
      : null,
  }));
}
```

Then simplify `findPlaceholderCandidates` to use it — replace the whole function body with:

```typescript
export async function findPlaceholderCandidates(
  destChannelId: string,
  fileName: string,
  fileSize: bigint,
): Promise<PlaceholderCandidate[]> {
  const rows = await db.package.findMany({
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
    select: {
      id: true, archiveType: true, fileName: true, fileCount: true, fileSize: true,
      destMessageId: true, destMessageIds: true, destChannelId: true,
    },
    orderBy: { indexedAt: "asc" },
  });
  return enrichWithDestChannel(rows);
}
```

Add the new, broader query right after it (no placeholder-only restriction — matches ANY package, any channel, so a forward-path candidate can dedupe against a normal fully-downloaded package elsewhere):

```typescript
/**
 * Find every uploaded Package (any provenance, any channel) matching
 * name+size, for the forward-priority path's cross-channel CRC-fingerprint
 * dedup check. Unlike findPlaceholderCandidates, this is NOT restricted to
 * placeholder rows — it exists to catch the case where the exact same
 * archive was independently uploaded (not reposted/forwarded) to two
 * different source channels.
 */
export async function findFingerprintDedupCandidates(
  fileName: string,
  fileSize: bigint,
): Promise<PlaceholderCandidate[]> {
  const rows = await db.package.findMany({
    where: { fileName, fileSize, destMessageId: { not: null } },
    select: {
      id: true, archiveType: true, fileName: true, fileCount: true, fileSize: true,
      destMessageId: true, destMessageIds: true, destChannelId: true,
    },
    orderBy: { indexedAt: "asc" },
  });
  return enrichWithDestChannel(rows);
}
```

- [ ] **Step 2: Export the two helpers already defined in `provenance-backfill.ts`**

In `worker/src/provenance-backfill.ts`, find:

```typescript
async function resolveCandidateFingerprintEntries(
```

Change to:

```typescript
export async function resolveCandidateFingerprintEntries(
```

Find:

```typescript
function compareFingerprints(a: FileEntry[], b: FileEntry[]): "match" | "mismatch" | "incomplete" {
```

Change to:

```typescript
export function compareFingerprints(a: FileEntry[], b: FileEntry[]): "match" | "mismatch" | "incomplete" {
```

No other changes in this file — both functions' bodies and all existing call sites are untouched.

- [ ] **Step 3: Write the failing test for the new orchestrator**

```typescript
// worker/src/archive/forward-repost-check.test.ts
import { describe, it, expect, vi } from "vitest";

const candidate = {
  id: "pkg-1", archiveType: "ZIP", fileName: "a.zip", fileCount: 3, fileSize: 100n,
  destMessageId: 1n, destMessageIds: [1n], destChannel: { telegramId: 999n },
};

vi.mock("../db/queries.js", () => ({
  findFingerprintDedupCandidates: vi.fn(async () => [candidate]),
}));
const resolveMock = vi.fn(async () => [{ path: "x", fileName: "x", extension: null, compressedSize: 1n, uncompressedSize: 1n, crc32: "AAAA" }]);
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd worker && npx vitest run src/archive/forward-repost-check.test.ts`
Expected: FAIL — `Cannot find module './forward-repost-check.js'`.

- [ ] **Step 5: Write minimal implementation**

```typescript
// worker/src/archive/forward-repost-check.ts
import type { Client } from "tdl";
import type { FileEntry } from "./zip-reader.js";
import { compareFingerprints, resolveCandidateFingerprintEntries } from "../provenance-backfill.js";
import { findFingerprintDedupCandidates } from "../db/queries.js";

export interface FingerprintRepostResult {
  isDuplicate: boolean;
  matchedPackageId: string | null;
}

/**
 * Cross-channel duplicate check for the forward-priority path: compare the
 * new archive's CRC fingerprint against every existing Package sharing its
 * name+size, regardless of which channel or ingestion path produced them.
 * This is what lets a forwarded copy dedupe against a previously
 * fully-downloaded copy of the same archive, despite never sharing a
 * byte-hash-derived contentHash.
 */
export async function checkFingerprintRepost(
  client: Client,
  entries: FileEntry[],
  fileName: string,
  fileSize: bigint,
): Promise<FingerprintRepostResult> {
  const candidates = await findFingerprintDedupCandidates(fileName, fileSize);
  for (const candidate of candidates) {
    const candidateEntries = await resolveCandidateFingerprintEntries(client, candidate);
    if (compareFingerprints(entries, candidateEntries) === "match") {
      return { isDuplicate: true, matchedPackageId: candidate.id };
    }
  }
  return { isDuplicate: false, matchedPackageId: null };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd worker && npx vitest run src/archive/forward-repost-check.test.ts`
Expected: PASS (2 passed).

- [ ] **Step 7: Typecheck the whole worker**

```bash
cd worker && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add worker/src/db/queries.ts worker/src/provenance-backfill.ts worker/src/archive/forward-repost-check.ts worker/src/archive/forward-repost-check.test.ts
git commit -m "feat(worker): cross-channel CRC-fingerprint repost check for the forward path"
```

---

## Task 7: `forwardArchiveToChannel`

**Files:**
- Create: `worker/src/upload/forward.ts`
- Test: `worker/src/upload/forward.test.ts`

**Interfaces:**
- Consumes: `withFloodWait` from `../util/retry.js`.
- Produces: `interface ForwardResult { messageId: bigint; messageIds: bigint[] }`, `forwardArchiveToChannel(client: Client, fromChatId: bigint, toChatId: bigint, sourceMessageIds: bigint[]): Promise<ForwardResult>` — consumed by Task 8.

TDLib reference (confirmed via docs, `forwardMessages`): `chat_id` (destination), `topic_id` (pass `null`), `from_chat_id` (source), `message_ids` (int53 array, **must be in strictly increasing order**, max 100 per call), `options` (pass `null` for defaults), `send_copy` (`false` = plain forward, keeps "Forwarded from" attribution; the destination archive channel is not user-facing so this plan keeps it simple and forwards plainly), `remove_caption` (`false`, only relevant when `send_copy` is true). Response is `{ messages: (Message | null)[] }` in the same order as the request — Telegram returns `null` for any message that couldn't be forwarded (e.g. if `has_protected_content` blocks it), which this function treats as a failure.

- [ ] **Step 1: Write the failing test**

```typescript
// worker/src/upload/forward.test.ts
import { describe, it, expect, vi } from "vitest";
import { forwardArchiveToChannel } from "./forward.js";

function fakeClient(response: unknown) {
  return { invoke: vi.fn(async () => response) } as never;
}

describe("forwardArchiveToChannel", () => {
  it("sorts message ids ascending and sends them via forwardMessages", async () => {
    const invoke = vi.fn(async (req: { message_ids: number[] }) => ({
      messages: req.message_ids.map((id) => ({ id: id + 1000 })),
    }));
    const client = { invoke } as never;

    const result = await forwardArchiveToChannel(client, 111n, 222n, [30n, 10n, 20n]);

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        _: "forwardMessages",
        chat_id: 222,
        from_chat_id: 111,
        message_ids: [10, 20, 30],
        send_copy: false,
      }),
    );
    expect(result.messageId).toBe(1010n);
    expect(result.messageIds).toEqual([1010n, 1020n, 1030n]);
  });

  it("throws when Telegram returns null for a message (can't be forwarded)", async () => {
    const client = fakeClient({ messages: [{ id: 1001 }, null] });
    await expect(forwardArchiveToChannel(client, 111n, 222n, [10n, 20n])).rejects.toThrow(/could not forward/);
  });

  it("throws when the response has the wrong number of messages", async () => {
    const client = fakeClient({ messages: [{ id: 1001 }] });
    await expect(forwardArchiveToChannel(client, 111n, 222n, [10n, 20n])).rejects.toThrow(/expected 2/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run src/upload/forward.test.ts`
Expected: FAIL — `Cannot find module './forward.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// worker/src/upload/forward.ts
import type { Client } from "tdl";
import { childLogger } from "../util/logger.js";
import { withFloodWait } from "../util/retry.js";

const log = childLogger("forward");

export interface ForwardResult {
  messageId: bigint;
  messageIds: bigint[];
}

/**
 * Forward all parts of an archive set from the source chat directly to the
 * destination chat via TDLib's forwardMessages — no download, no re-upload.
 * Only usable when the source channel allows forwarding
 * (TelegramChannel.allowsForwarding); the caller is responsible for that
 * check. message_ids must be in strictly increasing order per the TDLib API,
 * so this always sorts them regardless of the order they're passed in.
 */
export async function forwardArchiveToChannel(
  client: Client,
  fromChatId: bigint,
  toChatId: bigint,
  sourceMessageIds: bigint[],
): Promise<ForwardResult> {
  const sortedIds = [...sourceMessageIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const numericIds = sortedIds.map((id) => Number(id));

  log.info(
    { fromChatId: Number(fromChatId), toChatId: Number(toChatId), count: numericIds.length },
    "Forwarding archive to destination channel"
  );

  const result = (await withFloodWait(
    () =>
      client.invoke({
        _: "forwardMessages",
        chat_id: Number(toChatId),
        topic_id: null,
        from_chat_id: Number(fromChatId),
        message_ids: numericIds,
        options: null,
        send_copy: false,
        remove_caption: false,
      } as never),
    "forwardMessages"
  )) as { messages: ({ id: number } | null)[] };

  const forwarded = result.messages;
  if (!forwarded || forwarded.length !== numericIds.length) {
    throw new Error(
      `forwardMessages returned ${forwarded?.length ?? 0} messages, expected ${numericIds.length}`
    );
  }

  const messageIds: bigint[] = [];
  for (let i = 0; i < forwarded.length; i++) {
    const msg = forwarded[i];
    if (!msg) {
      throw new Error(
        `forwardMessages could not forward source message ${sortedIds[i]} (Telegram returned null — message may not be forwardable)`
      );
    }
    messageIds.push(BigInt(msg.id));
  }

  log.info(
    { fromChatId: Number(fromChatId), toChatId: Number(toChatId), messageIds: messageIds.map(Number) },
    "Forward confirmed by Telegram"
  );

  return { messageId: messageIds[0], messageIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && npx vitest run src/upload/forward.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add worker/src/upload/forward.ts worker/src/upload/forward.test.ts
git commit -m "feat(worker): native TDLib forward from source to destination channel"
```

---

## Task 8: Wire the fork point into `processOneArchiveSet`

**Files:**
- Modify: `worker/src/db/queries.ts` (counter plumbing)
- Modify: `worker/src/worker.ts` (fork point, new helper function, counter wiring, `inferSkipReason`)

**Interfaces:**
- Consumes: `readScannedListingRanged` (Task 4), `deriveForwardContentHash` (Task 5), `checkFingerprintRepost` (Task 6), `forwardArchiveToChannel` (Task 7).
- Produces: no new exports — this is the integration task. No isolated unit test (matches this file's existing convention of live-only verification for orchestration code); verified in Tasks 9-11.

- [ ] **Step 1: Add `zipsForwarded` to the counter plumbing in `db/queries.ts`**

Find the `ActivityUpdate` interface's `zipsBackfilled` field (around line 379):

```typescript
  zipsBackfilled?: number;
}
```

Add a sibling field:

```typescript
  zipsBackfilled?: number;
  zipsForwarded?: number;
}
```

Find, in `updateRunActivity` (around line 403):

```typescript
      ...(activity.zipsBackfilled !== undefined && { zipsBackfilled: activity.zipsBackfilled }),
```

Add immediately after:

```typescript
      ...(activity.zipsBackfilled !== undefined && { zipsBackfilled: activity.zipsBackfilled }),
      ...(activity.zipsForwarded !== undefined && { zipsForwarded: activity.zipsForwarded }),
```

Find `completeIngestionRun`'s counters parameter type (around line 429):

```typescript
  counters: {
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    zipsBackfilled: number;
  }
```

Add a sibling field:

```typescript
  counters: {
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    zipsBackfilled: number;
    zipsForwarded: number;
  }
```

- [ ] **Step 2: Add `zipsForwarded` to `PipelineContext.counters` and its initializer in `worker.ts`**

Find (around line 313-319):

```typescript
  counters: {
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    zipsBackfilled: number;
  };
```

Replace with:

```typescript
  counters: {
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    zipsBackfilled: number;
    zipsForwarded: number;
  };
```

Find (around line 422-428):

```typescript
    const counters = {
      messagesScanned: 0,
      zipsFound: 0,
      zipsDuplicate: 0,
      zipsIngested: 0,
      zipsBackfilled: 0,
    };
```

Replace with:

```typescript
    const counters = {
      messagesScanned: 0,
      zipsFound: 0,
      zipsDuplicate: 0,
      zipsIngested: 0,
      zipsBackfilled: 0,
      zipsForwarded: 0,
    };
```

- [ ] **Step 3: Add the new imports**

Find the import block at the top of `worker.ts` (near the other `archive/*` imports):

```typescript
import { readZipCentralDirectory } from "./archive/zip-reader.js";
import { readRarContents } from "./archive/rar-reader.js";
import { read7zContents } from "./archive/sevenz-reader.js";
```

Add immediately after:

```typescript
import { readScannedListingRanged } from "./archive/ranged/dispatch.js";
import { deriveForwardContentHash } from "./archive/forward-identity.js";
import { checkFingerprintRepost } from "./archive/forward-repost-check.js";
import { forwardArchiveToChannel } from "./upload/forward.js";
```

- [ ] **Step 4: Extend `inferSkipReason` to recognize forward failures**

Find:

```typescript
function inferSkipReason(errMsg: string): "DOWNLOAD_FAILED" | "UPLOAD_FAILED" | "EXTRACT_FAILED" {
  const lower = errMsg.toLowerCase();
  if (lower.includes("upload") || lower.includes("too many requests") || lower.includes("retry after") || lower.includes("send")) {
    return "UPLOAD_FAILED";
  }
```

Replace with:

```typescript
function inferSkipReason(errMsg: string): "DOWNLOAD_FAILED" | "UPLOAD_FAILED" | "EXTRACT_FAILED" {
  const lower = errMsg.toLowerCase();
  if (lower.includes("upload") || lower.includes("forward") || lower.includes("too many requests") || lower.includes("retry after") || lower.includes("send")) {
    return "UPLOAD_FAILED";
  }
```

- [ ] **Step 5: Add the `tryForwardArchiveSet` helper**

Find the closing brace of `processOneArchiveSet` (search for `async function deleteFiles(paths: string[])` — the helper goes right BEFORE that function, i.e. right after `processOneArchiveSet` ends). Insert:

```typescript
/**
 * Attempt the forward-priority path for one archive set: ranged listing (no
 * download) + native Telegram forward to the destination channel.
 *
 * Returns `undefined` when the forward path isn't usable for this specific
 * archive (ranged listing failed, or the forward itself failed) — the caller
 * falls through to the existing download+reupload pipeline in that case, so
 * indexing completeness never regresses.
 *
 * Returns `null` when the archive is a confirmed duplicate (skip, same
 * contract as the pre-download dedup checks earlier in the caller).
 *
 * Returns the new Package id on success.
 */
async function tryForwardArchiveSet(
  ctx: PipelineContext,
  archiveSet: ArchiveSet,
  setIdx: number,
  totalSets: number,
  previewMatches: Map<string, { id: bigint; fileId: string }>,
  ingestionRunId: string,
): Promise<string | null | undefined> {
  const {
    client, channelTitle, channel,
    destChannelTelegramId, destChannelId,
    counters, topicCreator, sourceTopicId, accountLog,
  } = ctx;
  void setIdx;
  void totalSets;

  const archiveName = archiveSet.parts[0].fileName;
  const archType = archiveSet.type === "7Z" ? ("SEVEN_Z" as const) : archiveSet.type;
  if (archType !== "ZIP" && archType !== "RAR" && archType !== "SEVEN_Z") {
    // The ranged listing readers only cover archive formats. Standalone
    // DOCUMENT attachments always go through the existing download path,
    // which for DOCUMENT is already cheap (no extraction, single entry).
    return undefined;
  }

  const scannedParts = archiveSet.parts.map((p) => ({
    fileId: p.fileId,
    fileSize: p.fileSize,
    fileName: p.fileName,
  }));

  const entries = await readScannedListingRanged(archType, client, scannedParts);
  if (!entries) return undefined;

  const totalArchiveSize = archiveSet.parts.reduce((sum, p) => sum + p.fileSize, 0n);
  const firstRemoteUniqueId = archiveSet.parts[0].remoteUniqueId ?? null;
  const contentHash = deriveForwardContentHash(
    entries,
    firstRemoteUniqueId,
    channel.id,
    archiveSet.parts[0].id,
  );

  if (await packageExistsByHash(contentHash)) {
    counters.zipsDuplicate++;
    accountLog.debug({ fileName: archiveName, contentHash }, "Forward-path duplicate (hash), skipping");
    return null;
  }

  const repost = await checkFingerprintRepost(client, entries, archiveName, totalArchiveSize);
  if (repost.isDuplicate) {
    counters.zipsDuplicate++;
    accountLog.info(
      { fileName: archiveName, matchedPackageId: repost.matchedPackageId },
      "Forward-path duplicate (CRC fingerprint match against another channel's copy), skipping"
    );
    return null;
  }

  const hashLockAcquired = await tryAcquireHashLock(contentHash);
  if (!hashLockAcquired) {
    counters.zipsDuplicate++;
    accountLog.info(
      { fileName: archiveName, contentHash },
      "Hash lock held by another worker — skipping concurrent duplicate"
    );
    return null;
  }

  try {
    if (await packageExistsByHash(contentHash)) {
      counters.zipsDuplicate++;
      return null;
    }

    let destResult: { messageId: bigint; messageIds: bigint[] };
    try {
      destResult = await forwardArchiveToChannel(
        client,
        channel.telegramId,
        destChannelTelegramId,
        archiveSet.parts.map((p) => p.id),
      );
    } catch (forwardErr) {
      accountLog.warn(
        { err: forwardErr, fileName: archiveName },
        "Forward failed — falling back to download+reupload for this archive"
      );
      return undefined;
    }

    await deleteOrphanedPackageByHash(contentHash);

    const creator =
      topicCreator ??
      extractCreatorFromFileName(archiveName) ??
      extractCreatorFromChannelTitle(channelTitle) ??
      null;

    const tags: string[] = [];
    if (channel.category) tags.push(channel.category);
    for (const tag of extractSlicerTags(entries)) {
      if (!tags.includes(tag)) tags.push(tag);
    }

    const stub = await createPackageStub({
      contentHash,
      fileName: archiveName,
      fileSize: totalArchiveSize,
      archiveType: archType,
      sourceChannelId: channel.id,
      sourceMessageId: archiveSet.parts[0].id,
      sourceTopicId,
      remoteUniqueId: firstRemoteUniqueId,
      destChannelId,
      destMessageId: destResult.messageId,
      destMessageIds: destResult.messageIds,
      isMultipart: archiveSet.parts.length > 1,
      partCount: archiveSet.parts.length,
      ingestionRunId,
      creator,
      tags,
    });

    counters.zipsForwarded++;
    await deleteSkippedPackage(channel.id, archiveSet.parts[0].id);

    let previewData: Buffer | null = null;
    let previewMsgId: bigint | null = null;
    const matchedPhoto = previewMatches.get(archiveSet.baseName);
    if (matchedPhoto) {
      previewData = await downloadPhotoThumbnail(client, matchedPhoto.fileId);
      if (previewData) previewMsgId = matchedPhoto.id;
    }

    await updatePackageWithMetadata(stub.id, { files: entries, previewData, previewMsgId });

    accountLog.info(
      { fileName: archiveName, contentHash, fileCount: entries.length, creator },
      "Archive forwarded (no download)"
    );

    return stub.id;
  } finally {
    await releaseHashLock(contentHash);
  }
}
```

- [ ] **Step 6: Insert the fork point in `processOneArchiveSet`**

Find the end of the size-guard block:

```typescript
    await upsertSkippedPackage({
      fileName: archiveName,
      fileSize: totalArchiveSize,
      reason: "SIZE_LIMIT",
      sourceChannelId: channel.id,
      sourceMessageId: archiveSet.parts[0].id,
      sourceTopicId: ctx.sourceTopicId,
      isMultipart: archiveSet.isMultipart,
      partCount: archiveSet.parts.length,
      accountId: ctx.accountId,
    });
    return null;
  }

  const tempPaths: string[] = [];
```

Replace with:

```typescript
    await upsertSkippedPackage({
      fileName: archiveName,
      fileSize: totalArchiveSize,
      reason: "SIZE_LIMIT",
      sourceChannelId: channel.id,
      sourceMessageId: archiveSet.parts[0].id,
      sourceTopicId: ctx.sourceTopicId,
      isMultipart: archiveSet.isMultipart,
      partCount: archiveSet.parts.length,
      accountId: ctx.accountId,
    });
    return null;
  }

  // ── Forward-priority path ──
  // If the source channel allows forwarding, try to index + forward without a
  // local download. Any failure (ranged listing miss, blocked/failed forward)
  // falls through into the existing download pipeline below so indexing
  // completeness never regresses.
  if (channel.allowsForwarding === true) {
    const forwardResult = await tryForwardArchiveSet(
      ctx, archiveSet, setIdx, totalSets, previewMatches, ingestionRunId
    );
    if (forwardResult !== undefined) {
      return forwardResult;
    }
    accountLog.info(
      { fileName: archiveName },
      "Forward path unavailable for this archive — falling back to download+reupload"
    );
  }

  const tempPaths: string[] = [];
```

- [ ] **Step 7: Thread `zipsForwarded` through the final run summary**

Find, near the end of `runWorkerForAccount`:

```typescript
      await throttled.flush();
      await completeIngestionRun(activeRunId, counters);
      accountLog.info({ counters }, "Ingestion run completed");
```

This already passes the whole `counters` object, which now includes `zipsForwarded` from Step 2 — no change needed here, just confirming it flows through. (No edit — verification only.)

- [ ] **Step 8: Typecheck**

```bash
cd worker && npx tsc --noEmit
```
Expected: no errors. `archiveSet.parts[0].id` is `bigint` (from `TelegramMessage.id`); `channel.telegramId` is `bigint` (from Prisma) — both line up with `forwardArchiveToChannel`'s signature.

- [ ] **Step 9: Commit**

```bash
git add worker/src/db/queries.ts worker/src/worker.ts
git commit -m "feat(worker): fork to the forward-priority path in processOneArchiveSet"
```

---

## Task 9: Full typecheck + test suite

- [ ] **Step 1: Run the full worker test suite**

```bash
cd worker && npx tsc --noEmit && npx vitest run
```
Expected: no TS errors; all tests pass (existing archive/ranged/*.test.ts tests plus all new tests added in Tasks 4-7).

- [ ] **Step 2: Fix anything that fails, then re-run until clean.**

---

## Task 10: Local build + deploy (no push)

Same recipe as the `ranged-archive-listing` work — this repo does not push worker images to a registry; the container is rebuilt and recreated locally.

- [ ] **Step 1: Build**

```bash
cd /path/to/DragonsStash
docker build -f worker/Dockerfile -t git.samagsteribbe.nl/admin/dragonsstash-worker:latest .
```
Expected: image builds successfully.

- [ ] **Step 2: Recreate the running container**

```bash
docker compose --project-name dragonsstash --project-directory /opt/stacks/DragonsStash \
  -f /opt/stacks/DragonsStash/docker-compose.yml up -d --no-deps --force-recreate worker
```
Expected: `dragonsstash-worker` container recreated from the local image, starts cleanly.

- [ ] **Step 3: Watch startup logs**

```bash
docker logs -f --since 30s dragonsstash-worker
```
Expected: no errors on startup; first ingestion cycle begins on schedule.

---

## Task 11: Live verification

Requires two test source channels already linked to a worker account: one with forwarding allowed, one with "restrict saving content" enabled (create/toggle via `toggleChatHasProtectedContent` or the Telegram client UI if you don't already have one).

- [ ] **Step 1: Watch for the forwarding-permission detection**

```bash
docker logs -f --since 30s dragonsstash-worker 2>&1 | grep -iE "Updated channel forwarding permission"
```
Expected: both test channels get their `allowsForwarding` flag set correctly on the next scan cycle (confirm against the DB: `SELECT title, "allowsForwarding" FROM telegram_channels WHERE title IN ('<forward-ok channel>', '<protected channel>');`).

- [ ] **Step 2: Post a fresh archive into the forwarding-enabled test channel**

```bash
docker logs -f --since 30s dragonsstash-worker 2>&1 | grep -iE "Archive forwarded|Forward path unavailable|Forward failed"
```
Expected: `Archive forwarded (no download)` appears, with no matching `Downloading archive part` log line for that file.

DB check:
```sql
SELECT "fileName", "contentHash", "fileCount", "destMessageId", "archiveType"
FROM packages ORDER BY "indexedAt" DESC LIMIT 5;
```
Expected: the new row has `fileCount > 0`, a `contentHash` prefixed `fingerprint:` or `forward:`, and a non-null `destMessageId`. Spot-check `fileCount` against a real `unzip -l` / `unrar lt` / `7z l` on a manually-downloaded copy of the same file.

- [ ] **Step 3: Post a fresh archive into the protected-content test channel**

Expected: the existing download+reupload path runs unchanged (`Downloading archive part` appears in logs), and the resulting Package has a normal sha256-style `contentHash` (no `fingerprint:`/`forward:` prefix).

- [ ] **Step 4: Force a ranged-listing failure in the forwarding-enabled channel**

Post a deliberately-corrupted or unsupported-format archive (e.g. a password-protected-header 7z) into the forwarding-enabled test channel.

Expected: `Forward path unavailable for this archive — falling back to download+reupload` appears, followed by the normal download pipeline completing successfully — the package still ends up with `fileCount > 0`.

- [ ] **Step 5: Confirm bot delivery still works for a forwarded package**

Use the bot to request the forwarded package from Step 2. Expected: delivery succeeds via the existing `copyMessageToUser` path (unaffected by this feature — it already reads `destMessageId` the same way regardless of how the package was ingested).

---

## Self-Review

- **Spec coverage:** sequencing/merge-first (Task 1) ✓; `allowsForwarding` schema + detection (Tasks 2-3) ✓; shared ranged-listing dispatcher (Task 4) ✓; dedup identity incl. rebuild:-style fallback chain (Task 5) ✓; cross-channel fingerprint repost check (Task 6) ✓; native forward (Task 7) ✓; fork point + fallback-to-download semantics + zipsForwarded observability (Task 8) ✓; typecheck/tests (Task 9) ✓; local no-push deploy (Task 10) ✓; live verification of both channel types plus the ranged-listing-failure fallback (Task 11) ✓. Non-goals from the spec (no ranged single-entry preview extraction, no reprocessing existing packages, no bot-delivery changes, no size-guard/split changes) require no tasks — confirmed nothing in this plan touches them.
- **Placeholder scan:** no TBD/TODO; every code step has full code; every command has an expected outcome. The one open item (`has_protected_content` field availability on supergroup/channel chats) is explicitly flagged as PENDING LIVE VERIFICATION in Task 3, Step 2's comment and covered by Task 11, Step 1 — not a placeholder, a spike already scheduled for live verification, matching this repo's own established convention for the same kind of TDLib-behavior uncertainty (`range-download.ts`'s absolute-offset note).
- **Type consistency:** `RangedPart` (`{fileId, fileSize, fileName}`), `FileEntry`, `PlaceholderCandidate`, `ForwardResult` (`{messageId, messageIds}`), and `deriveForwardContentHash`/`checkFingerprintRepost`/`forwardArchiveToChannel`/`tryForwardArchiveSet` signatures are consistent everywhere they're referenced across tasks. ✓
