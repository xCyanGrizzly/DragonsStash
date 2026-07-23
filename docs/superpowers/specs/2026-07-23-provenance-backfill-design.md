# Provenance Backfill on Re-Index — Design

**Date:** 2026-07-23
**Status:** Approved for planning

## Summary

Recover the true origin of packages whose recorded "source" is a placeholder —
specifically the manual-upload and `rebuild.ts`-created records whose
`sourceChannelId` points at the destination (archive) channel itself. When a
real source channel is re-indexed and the worker encounters an archive that
matches such a placeholder package, it backfills the real
`sourceChannelId` / `sourceMessageId` / `sourceTopicId` / `sourceCaption` /
`creator` (and, for records that never had one, the file listing and preview)
onto the existing package — **without downloading the full archive**.

Matching is a two-stage process: a zero-download candidate lookup by
`fileName` + total `fileSize`, confirmed by a CRC32 fingerprint read from just
the archive's central directory via a **ranged (tail) download** of a few
KB–MB, instead of the multi-GB whole file.

This is the first of four linked sub-projects. The others (creator
normalization, provenance display, missing-files) are out of scope here and get
their own spec → plan cycles. "Missing files" is explicitly deferred until this
lands.

## Context

Current state (as of this design):

- `Package` records their origin via `sourceChannelId`, `sourceMessageId`,
  `sourceTopicId`, `sourceCaption`, and (for content dedup) `contentHash` and
  `remoteUniqueId`. `creator` is a free-text string extracted at ingestion.
- Two ingestion paths create records with **placeholder provenance**, where the
  "source" is the destination channel, not a real origin:
  - **Manual uploads** (`worker/src/manual-upload.ts`) set
    `sourceChannelId = destChannel.id` and `sourceMessageId = destResult.messageId`.
    They *do* populate `PackageFile` (with `crc32`) from a local central-directory
    read at upload time.
  - **`rebuild.ts`** scans the destination channel and creates minimal records
    with `fileCount == 0` and **no** `PackageFile` rows.
- The main worker upload path (`worker/src/worker.ts` → `uploadToChannel`) sends
  archives to the destination channel with **no caption**, so provenance cannot
  be recovered by re-reading destination messages — it has to come from matching
  against real source channels.
- The scan/dedup ladder in `processOneArchiveSet` (`worker/src/worker.ts:1521`)
  is entirely **source-channel-scoped**:
  1. `findPackageByRemoteUniqueId(channel.id, …)` — same channel only
  2. `packageExistsBySourceMessage(channel.id, …)` — same channel only
  3. `findRepostedPackage(channel.id, fileName, size)` — same channel only
  4. …then full download → `packageExistsByHash(contentHash)` — global, but only
     *after* downloading the whole archive.
- Because a placeholder package's `sourceChannelId` is the destination, checks
  1–3 never match it when a real source channel is scanned. Today the worker
  therefore downloads the entire archive, hits check 4, finds it is a duplicate,
  and skips — **wasting the download and leaving the wrong provenance in place.**
- There is already an in-production precedent for "match an already-known
  archive during scan and enrich its metadata": when `findRepostedPackage`
  matches, the worker backfills richer *topic* context onto the existing package
  via `updatePackageTopicContext` (`worker/src/worker.ts:1608`+). Provenance
  backfill is the same move, widened from same-channel to cross-channel.
- `remote.unique_id` is **not** a reliable cross-channel key: it identifies a
  stored file object on Telegram's servers, not the content. The same archive
  independently uploaded to two channels gets different `unique_id`s; it only
  matches for forwarded messages (same underlying file object). This is why the
  existing dedup scopes it to a single channel.

## Goals / Non-Goals

**Goals**

- Attribute true origin to placeholder-provenance packages during normal
  re-index scans, opportunistically (no separate pass).
- Do it without downloading whole archives (ranged central-directory read only).
- Be non-destructive: only ever touch packages that currently have placeholder
  provenance; never overwrite a real, non-placeholder source.
- Be idempotent: re-running a re-index does not re-mutate or duplicate.

**Non-Goals (separate sub-projects / deferred)**

- Creator name normalization / canonical creator entity.
- UI changes to display provenance.
- Recovering "missing files."
- Choosing a *preferred* origin when an archive genuinely exists in several
  source channels (first confirmed source wins).

## Design

### 1. Candidate definition

> A package is a backfill candidate iff **`sourceChannelId == destChannelId`
> OR `sourceMessageId == 0`**.

Two placeholder shapes exist (verified against live data 2026-07-23):
- **Manual uploads** (`manual-upload.ts`): `sourceChannelId == destChannelId`,
  real `contentHash`, real `sourceMessageId`, has a `PackageFile` listing.
- **Rebuild records** (`rebuild.ts`): `sourceMessageId == 0n` (deliberate
  "unknown" sentinel), synthetic `contentHash = "rebuild:<destChannelId>:<destMessageId>"`,
  `fileCount == 0`, and `sourceChannelId` set to an **arbitrary fallback source
  channel** (`sourceChannels[0]`) — NOT the destination. (This is the common
  case: e.g. 59,893 records after a destination rebuild.)

Normal ingestion always sets a real `sourceMessageId` (> 0) and a real source
channel, so neither marker matches a genuinely-sourced package. Both markers are
overwritten on backfill (source channel + message become real), so a record
stops being a candidate once fixed — this is what makes re-scans idempotent.

**Known limitation:** backfill does NOT rewrite a rebuild record's synthetic
`"rebuild:"` `contentHash` (the true content hash would require a full download,
which this feature avoids). That is acceptable — dedup after backfill relies on
`remoteUniqueId` + name/size within the source channel, not on `contentHash`.

### 2. Where it hooks

A new step is inserted into `processOneArchiveSet` **between check #3
(`findRepostedPackage`) and the full download**. It runs only after the
same-channel checks have missed (so genuine same-channel reposts keep their
existing fast paths).

Flow for the scanned archive set:

1. Stage A — **candidate lookup (zero download).** Query for a package where
   `(sourceChannelId == destChannelId OR sourceMessageId == 0)` AND
   `fileName == archiveName` AND `fileSize == totalArchiveSize`.
   (`Package` has `@@index([fileName])`.)
   - No candidate → fall through to normal ingestion unchanged.
2. Stage B — **fingerprint confirmation (tiny download).** See §3.
3. On confirmation → **backfill** (see §4) and return `null` (treated as a
   duplicate; no full download, no new package). Increment a `zipsBackfilled`
   counter.
4. On mismatch / failure / ambiguity → fall through to normal ingestion (see §6).

### 3. Fingerprint confirmation

The confirmation signal is the **multiset of internal CRC32s** of the archive's
entries (CRC32 of each entry's *uncompressed* data). This value is a property of
the archive contents and is identical regardless of which channel hosts the
file.

- **Candidate side:** for manual uploads, `PackageFile.crc32` is already
  populated from the local central-directory read — zero cost. For **rebuild
  records** (`fileCount == 0`, no `crc32`), there is nothing stored to compare
  against; obtain the candidate's fingerprint with a **second ranged tail read
  of its destination copy** (ZIP/7z — still no full download). RAR candidates
  cannot be tail-read on either side, so they fall back to name+size (see §5).
- **Scanned-source side:** read via a **ranged (tail) download** of the central
  directory:
  - **ZIP** (incl. multipart): the End-of-Central-Directory record + central
    directory live at the tail of the last part. Download only that tail and
    parse entries. (Reuses the lightweight-listing mechanism that is
    sub-project 4's core.)
  - **7z**: a start header at byte 0 points to an end header at the tail; fetch
    both small pieces.
  - **RAR**: headers are scattered through the file — no cheap tail read. See §5.
- **Match rule:** confirmed iff the sorted CRC32 multisets are equal **and** file
  counts are equal.

The comparison logic (CRC32 multiset equality) and the candidate-match predicate
are implemented as **pure functions** with no TDLib dependency, so they are unit
testable (see §7).

### 4. What gets written

On a confirmed match, update the candidate package in a single transaction,
overwriting only placeholder/empty fields:

| Field | New value | Condition |
|---|---|---|
| `sourceChannelId` | scanned `channel.id` | always |
| `sourceMessageId` | scanned `parts[0].id` | always |
| `sourceTopicId` | `ctx.sourceTopicId` | always |
| `sourceCaption` | scanned message caption | always |
| `remoteUniqueId` | scanned `firstRemoteUniqueId` | always (enables future same-channel dedup via check #1) |
| `creator` | re-derived from source (topic > filename > channel) | **always** — un-normalized; the later creator-normalization sub-project cleans it up |
| `fileCount` + `PackageFile[]` | from the central-directory read | only if candidate had none (`fileCount == 0`) — folds in the sub-project 4 outcome for rebuild records |
| `previewData` / `previewMsgId` | matched preview from scan | only if candidate has none |

**Left untouched:** `contentHash`, `destChannelId`, `destMessageId`,
`destMessageIds` — the bytes physically live in the destination channel; that is
correct and must not change.

**Transaction safety:** re-check `sourceChannelId == destChannelId` *inside* the
transaction before writing, so a concurrent worker that already backfilled the
record causes this one to no-op (mirrors the existing `backfill.ts` guard).

### 5. RAR handling

RAR sources cannot be tail-read, so no cheap CRC fingerprint is available.
Decision: **backfill RAR matches on `fileName` + `fileSize` alone**, flagged as
lower-confidence in logs and via a `SystemNotification`, so they can be audited.
No full download.

This name+size-only fallback applies to any candidate that cannot produce a
CRC32 fingerprint cheaply: a RAR **source**, a RAR **candidate**, or a rebuild
candidate whose destination copy is RAR. ZIP/7z rebuild candidates are still
confirmed by fingerprint via the second tail read described in §3.

### 6. Conflict, mismatch, ambiguity

- **Fingerprint mismatch** → the scanned archive is genuinely different content
  that merely shares name+size. Fall through to **normal ingestion** (download +
  index) — it is a new package for this source.
- **Ambiguous candidates** (2+ match name+size and the fingerprint cannot
  disambiguate) → log a `SystemNotification`, backfill nothing, and fall through
  to normal ingestion; the post-download `packageExistsByHash` check still
  dedups it safely.
- **Same archive in multiple source channels** → the **first re-indexed source
  that confirms wins.** After backfill the package has a real source, so it is no
  longer a candidate; later scans treat it as an ordinary duplicate via checks #1
  (the `remoteUniqueId` we set) or #3.

### 7. Idempotency

Falls out of the candidate definition. Once backfilled:
- `sourceChannelId` is the real channel → no longer a candidate.
- A re-scan of that source hits check #1 (`remoteUniqueId`, now set) or check #3
  (`findRepostedPackage`) → normal dedup skip. No re-mutation, no duplicate.

### 8. Error handling

- **Tail-download failure** (network / `FLOOD_WAIT`) → cannot confirm this round.
  Do **not** fall back to a full download and do **not** guess: leave the
  candidate untouched and let the next re-index retry. Wrap the ranged read in
  `withFloodWait` (per the TDLib skill).
- All new TDLib calls follow the skill's patterns: `withFloodWait`, listener
  attached before the async op, client closed in `finally`.

### 9. Visibility

- Add a `zipsBackfilled` counter to `IngestionRun` activity so a re-index run
  reports "N provenance backfills" instead of silently mutating records.
- Info log per backfill (candidate id, old vs new source, confidence:
  fingerprint | name+size-RAR).
- `SystemNotification` for ambiguous-candidate cases.

## Testing

The repo currently has no test framework (`CLAUDE.md`: "testing is manual"). This
work introduces a **lightweight test harness** for the worker (e.g. `vitest` or
node's built-in `node:test`) and unit-tests the correctness-critical pure logic:

- **Unit (automated):**
  - CRC32 multiset fingerprint equality (equal sets, different order, differing
    counts, disjoint sets).
  - Candidate-match predicate (name+size+placeholder true/false cases).
  - Field-merge rules (which fields overwrite, which only fill-if-empty).
- **Manual integration checklist:**
  1. Re-index a real source channel containing a known manually-uploaded pack →
     verify `sourceChannelId`/`sourceMessageId`/`sourceCaption`/`creator` are
     backfilled and no full download occurs.
  2. A rebuild-created record (`fileCount == 0`) → verify listing + provenance
     are both populated from the single tail read.
  3. A RAR pack → verify name+size backfill with the lower-confidence log/notice.
  4. Re-run the same re-index → verify it is a no-op (idempotent).
  5. A genuine name+size collision (different content) → verify it ingests as a
     new package rather than being mis-attributed.

## Open Questions

None blocking. Preferred-origin selection among multiple real sources is
deliberately out of scope (first confirmed wins).

## Affected Code (indicative, for planning)

- `worker/src/worker.ts` — `processOneArchiveSet`: new Stage A/B step; new counter.
- `worker/src/archive/` — ranged central-directory reader (ZIP/7z tail); shared
  with sub-project 4. Pure CRC32-fingerprint compare helper.
- `worker/src/tdlib/download.ts` — ranged/partial download support (`offset`/`limit`).
- `worker/src/db/queries.ts` — candidate lookup + transactional backfill update.
- `prisma/schema.prisma` — `IngestionRun.zipsBackfilled` (and run-counter plumbing).
- Worker test harness + first unit tests.
