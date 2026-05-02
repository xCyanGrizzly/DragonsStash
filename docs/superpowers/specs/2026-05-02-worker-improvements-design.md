# Worker Improvements Design

**Date:** 2026-05-02  
**Status:** Approved  
**Scope:** Dragon's Stash Telegram ingestion worker

## Problem Statement

Three issues to address:

1. **Double-uploads**: The same archive occasionally appears twice in the destination Telegram channel. Root causes: (a) the worker crashes between `uploadToChannel()` confirming success and `createPackageWithFiles()` writing to the DB — no DB record means `recoverIncompleteUploads()` can't detect the orphaned Telegram message, and the next cycle re-uploads; (b) two accounts scanning the same source channel can both pass the hash dedup check before either creates a DB record, racing to upload the same file.

2. **Sequential account processing**: Both Telegram accounts are processed one after another via `withTdlibMutex`, even though TDLib fully supports multiple concurrent clients in the same process (each with separate `databaseDirectory` and `filesDirectory`). This halves throughput unnecessarily.

3. **Premium upload limit not used**: The Premium account can upload up to 4 GB per file, but `MAX_UPLOAD_SIZE` is hardcoded at ~1,950 MB. This causes unnecessary file splitting and expensive repack operations for files that could upload directly.

## Solution Overview

Three targeted changes, no architectural overhaul:

1. Two-phase DB write + hash advisory lock (fixes double-uploads)
2. Remove TDLib mutex from the scheduler loop (enables parallel accounts)
3. Per-account `maxUploadSize` from `getMe().is_premium` (enables 4 GB for Premium)

---

## Section 1: Double-Upload Fix

### 1a. Two-Phase DB Write

**Current flow:**
```
uploadToChannel() → preview download → metadata extraction → createPackageWithFiles()
```

If the worker crashes anywhere between upload confirmation and `createPackageWithFiles()`, no DB record exists. `recoverIncompleteUploads()` only checks packages with an existing `destMessageId` in the DB — it cannot find an orphaned Telegram message with no corresponding row.

**New flow:**
```
uploadToChannel()
  → createPackageStub()          ← minimal record, destMessageId set immediately
  → preview download
  → metadata extraction
  → updatePackageWithMetadata()  ← adds file list, preview, creator, tags
```

`createPackageStub()` writes: `contentHash`, `fileName`, `fileSize`, `archiveType`, `sourceChannelId`, `sourceMessageId`, `destChannelId`, `destMessageId`, `isMultipart`, `partCount`, `ingestionRunId`. File list and preview are left empty.

If the worker crashes after the stub is written:
- `recoverIncompleteUploads()` finds the record (has `destMessageId`), verifies the Telegram message exists, keeps it.
- Next cycle: `packageExistsByHash()` returns true → skips re-upload.
- The stub has `fileCount = 0` and no file listing. The UI shows "metadata pending" rather than failing silently.

Stubs with `fileCount = 0` are valid deliverable packages (the bot can still send the file). Backfilling metadata on stubs is out of scope for this change — the crash case is rare and the stub is functional.

### 1b. Hash Advisory Lock

**The race (two accounts, shared source channel):**
```
Worker A: packageExistsByHash(X) → false  (no record yet)
Worker B: packageExistsByHash(X) → false  (no record yet)
Worker A: uploads file → destMessageId_A
Worker B: uploads file → destMessageId_B  ← duplicate Telegram message
Worker A: createPackageStub() → succeeds  (contentHash @unique satisfied)
Worker B: createPackageStub() → fails unique constraint on contentHash
```
Result: two Telegram messages, one DB record. Worker B's upload is wasted.

**Fix:** Before calling `uploadToChannel()`, acquire a PostgreSQL session advisory lock keyed on the content hash:

```sql
SELECT pg_try_advisory_lock(hash_bigint)
```

Where `hash_bigint` is the first 8 bytes of the SHA-256 content hash interpreted as a signed bigint.

- `pg_try_advisory_lock` is non-blocking. If another worker holds the lock (same file, shared channel), return `false` → treat as duplicate, skip.
- After acquiring the lock, **re-run `packageExistsByHash()`** before uploading. This catches the case where another worker finished and released the lock between the first check and this one — without the re-check, the current worker would proceed to re-upload.
- The lock is session-scoped: released automatically on DB session end. No manual cleanup needed on crash.
- The lock is released explicitly after `createPackageStub()` completes (or on any error path).

**Implementation location:** New helper `tryAcquireHashLock(contentHash)` / `releaseHashLock(contentHash)` in `worker/src/db/locks.ts`, reusing the existing DB client pattern.

---

## Section 2: Parallel Account Processing

### Current Constraint

`withTdlibMutex` in `scheduler.ts` serializes all TDLib operations across accounts. This was a conservative guard, but TDLib explicitly supports multiple concurrent clients in the same process provided each has its own `databaseDirectory` and `filesDirectory`.

The codebase already satisfies this requirement:
```typescript
// worker/src/tdlib/client.ts
const dbPath = path.join(config.tdlibStateDir, account.id);
const client = createClient({
  databaseDirectory: dbPath,
  filesDirectory: path.join(dbPath, "files"),
});
```

Each account gets `<TDLIB_STATE_DIR>/<account.id>/` — fully isolated.

### Change

Replace the sequential `for` loop in `scheduler.ts` with `Promise.allSettled()`:

```typescript
// Before
for (const account of accounts) {
  await withTdlibMutex(`ingest:${account.phone}`, () => runWorkerForAccount(account));
}

// After
await Promise.allSettled(accounts.map((account) => runWorkerForAccount(account)));
```

The per-account PostgreSQL advisory lock in `db/locks.ts` already prevents any account from being processed twice simultaneously. `Promise.allSettled()` ensures one account's failure doesn't abort the other.

The `withTdlibMutex` wrapper can be removed from the ingest path entirely. The auth path (`authenticateAccount`) should also be run in parallel but may remain guarded if TDLib auth flows have ordering dependencies — verify during implementation.

**No Docker Compose changes needed.** Both accounts run in the same container.

### Speed Limit Notifications

TDLib fires `updateSpeedLimitNotification` when an account's upload or download speed is throttled (non-Premium accounts). Log this event at `warn` level in the client update handler so it's visible in logs without being actionable.

---

## Section 3: Per-Account Premium Upload Limit

### Premium Detection

After successful authentication, call `getMe()` and read `is_premium: bool` from the returned `user` object. Store this on `TelegramAccount.isPremium` (new boolean field, default `false`, updated on each successful auth).

```typescript
const me = await client.invoke({ _: 'getMe' }) as { is_premium?: boolean };
await updateAccountPremiumStatus(account.id, me.is_premium ?? false);
```

### Upload Size Limits

| Account type | `maxUploadSize` | Effect |
|---|---|---|
| Premium | 3,950 MB | Parts ≤ 3.95 GB upload as-is; repack only for parts >3.95 GB (extremely rare) |
| Non-Premium | 1,950 MB | Current behavior unchanged |

Pass `maxUploadSize` into `processOneArchiveSet()` as a parameter (currently hardcoded as `MAX_UPLOAD_SIZE` at `worker.ts:1023` and in `archive/split.ts`).

The `hasOversizedPart` check and `byteLevelSplit` call both use this value, so the repack step is effectively eliminated for Premium accounts in practice — no separate "skip repack" flag needed.

### Migration

```prisma
model TelegramAccount {
  // ... existing fields
  isPremium Boolean @default(false)
}
```

One migration, one new query `updateAccountPremiumStatus(accountId, isPremium)`.

---

## Files to Change

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `isPremium Boolean @default(false)` to `TelegramAccount` |
| `worker/src/db/queries.ts` | Add `updateAccountPremiumStatus()`, `createPackageStub()`, `updatePackageWithMetadata()` |
| `worker/src/db/locks.ts` | Add `tryAcquireHashLock()`, `releaseHashLock()` |
| `worker/src/tdlib/client.ts` | Call `getMe()` after auth, return `isPremium` from `createTdlibClient()` |
| `worker/src/worker.ts` | Two-phase write, hash lock acquire/release, pass `maxUploadSize` per account |
| `worker/src/archive/split.ts` | Accept `maxPartSize` parameter instead of hardcoded constant |
| `worker/src/scheduler.ts` | Replace sequential loop with `Promise.allSettled()`, remove `withTdlibMutex` from ingest path |

---

## What Is Explicitly Out of Scope

- Backfilling metadata on stub records (rare crash case, functional without it)
- Download pre-fetching / pipeline parallelism within one account
- Two separate worker containers (single container is sufficient)
- Bot or app changes (worker-only)
