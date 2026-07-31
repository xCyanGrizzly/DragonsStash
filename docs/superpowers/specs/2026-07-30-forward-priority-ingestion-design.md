# Forward-priority ingestion — design

**Date:** 2026-07-30
**Status:** Approved (design), pending spec review → implementation plan

## Problem

The worker ingests every archive the same way regardless of whether it needs to: download the
full file from the source channel, then re-upload the full file to the destination (archive)
channel. That download+reupload round-trip was originally necessary because some source channels
have "restrict saving content" (protected content) enabled, which blocks Telegram-native
forwarding — for those channels there is no alternative to moving the bytes through the worker.

But most source channels do NOT restrict forwarding. For those, the round-trip is pure waste:
Telegram can copy the message from source chat to destination chat server-side, with no bytes
ever passing through the worker. The worker still needs to end up with the same outcome it has
today — a destination-channel copy, a dedup-safe identity, and a full inner-file listing — just
without paying for a download and re-upload to get there.

Separately, `feat/ranged-archive-listing` (merged to master ahead of this feature) already built
exactly the missing piece: reading a ZIP/RAR/7z archive's inner-file listing via small ranged
reads against the file wherever it currently lives (source channel, destination channel — doesn't
matter), with no full download. It was built for backfilling listings onto already-deduped
placeholder packages. This feature generalizes that same capability to fresh ingestion, and pairs
it with a new native-forward upload path.

## Goals

- For channels that allow forwarding: skip download and re-upload entirely for new archives. Use
  Telegram-native forwarding from source chat to destination chat, and the existing ranged-listing
  readers to index inner files, with no full download in the common case.
- For channels that block forwarding (or when forwarding isn't yet known): keep today's
  download+reupload pipeline exactly as-is.
- Every ingested package — regardless of path — ends up with the same outcome as today: a
  `Package` row with a valid dedup identity, `destMessageId`/`destMessageIds`, creator, tags, and a
  full inner-file listing (`PackageFile` rows). Indexing completeness must not regress.
- If the cheap ranged listing fails for a specific archive (bad/unsupported header, CLI error,
  etc.) in an otherwise-forwarding-eligible channel, fall back to today's full download+reupload
  pipeline for that one archive — never forward with an empty or partial listing.

## Non-goals

- No ranged single-entry preview extraction. Forward-path packages still get a preview when a
  channel photo message matches (cheap, unrelated to archive bytes); when there's no matching
  photo, forward-path packages simply have no preview, same as any package where preview
  extraction fails today. In-archive preview extraction (unzip/unrar/7z against a local file) stays
  as a download-path-only feature. May be revisited as a follow-up if it turns out to matter.
- No reprocessing of already-ingested packages. This only changes behavior for newly-scanned
  archives going forward.
- No change to the bot's user-delivery leg (`bot/src/tdlib/client.ts` `copyMessageToUser`) — it
  already sends via `inputFileRemote` with no download, and is unaffected by this feature.
- No change to `config.maxZipSizeMB` or the multipart byte-level split/repack logic. The existing
  size guard runs before either path is chosen, so nothing above the cap reaches the forward path's
  fallback-to-download step either. Splitting simply never engages on the forward path — a
  forwarded message is already within whatever size Telegram accepted when it was first uploaded.

## Approaches considered

**A — Branch inside the existing pipeline (chosen).** Add one fork point in
`processOneArchiveSet`, immediately after the existing pre-download dedup checks: if the channel
allows forwarding, attempt the ranged-listing + forward path; on any failure, fall through into
today's download-based code for that one archive, unchanged. Smallest diff; reuses the existing
dedup/retry/watermark machinery as-is; matches the file's existing forum-vs-non-forum branching
style.

**B — Separate pipeline per channel.** Decide once per channel and route the whole channel through
either a "forward module" or the existing "download module." Cleaner separation on paper, but
duplicates the SkippedPackage/stall/watermark bookkeeping that currently lives once in
`processArchiveSets`/`processOneArchiveSet` — higher regression risk in a large orchestration file
with no tests at that level. Rejected.

**C — Strategy-object refactor.** Extract an `IngestStrategy` interface (`download` / `forward`)
and slim `processOneArchiveSet` to delegate to it. The more "proper" abstraction, but it's a
structural refactor of already-battle-tested code that doesn't need it for this feature to work.
Rejected — can revisit later if a third strategy ever appears.

## Sequencing

`feat/ranged-archive-listing` merges to master first, as-is (it's complete and serves a different
purpose already). This feature is built on a fresh branch off master afterward.

## Components

### 1. `TelegramChannel.allowsForwarding` (new column, new migration)

`Boolean?` — nullable, `null` means "not yet checked". Refreshed from TDLib's chat
protected-content flag (exact field name to be confirmed against the pinned `tdl`/TDLib version
via docs lookup during implementation — expected to be `chat.has_protected_content`) at the same
point the worker already calls `getChat` per channel per cycle, mirroring the existing
`isForum`/`setChannelForum` read-and-persist pattern precisely. `null` or `false` both route to the
download path — a channel never uses the forward path on unverified permission.

### 2. Shared ranged-listing dispatcher

`readScannedListingRanged` (plus `RangedPart`, `tdlibRangeReader`, and the format-specific
ZIP/RAR/7z readers) currently live inside `provenance-backfill.ts`. Promote the dispatcher (and
whatever it depends on) into a shared module (e.g. `worker/src/archive/ranged/dispatch.ts`) so
`worker.ts` can call the same no-download listing logic for fresh ingestion without a circular
import. `provenance-backfill.ts` switches to importing from the new shared location; behavior
unchanged for the existing backfill path.

### 3. `forwardArchiveToChannel` (new, `worker/src/upload/forward.ts`)

Mirrors `uploadToChannel`'s shape and return type (`{ messageId, messageIds }`). Uses TDLib
`forwardMessages` to copy all parts of an archive set from the source chat to the destination chat
in one batch call (message IDs in original order), wrapped in the same flood-wait/retry handling
style as `uploadToChannel`. Followed by the same destination read-back verification style as
today's post-upload check (`getMessage` on each new destination message ID, confirm a document is
present).

### 4. Dedup identity for forward-path packages

`Package.contentHash` stays a required unique string, but forward-path packages can't hash real
bytes. Derivation order:
1. If the ranged listing's CRC32s are complete (ZIP/RAR today) — hash the sorted CRC32 list into a
   synthetic `fingerprint:<hash>` value, reusing `archive/fingerprint.ts`'s existing
   `crcFingerprint`.
2. Otherwise (7z, or any incomplete-CRC case) — synthesize `forward:<remoteUniqueId>`, following
   the existing `rebuild:`-prefixed placeholder-hash precedent in `rebuild.ts`.

Additionally, extend repost detection: before committing to the forward path, compare the new
listing's CRC fingerprint (via the existing `compareFingerprints`/`fingerprintsMatch` logic already
used in `provenance-backfill.ts`'s ambiguous-candidate disambiguation) against recent Packages
sharing the same file name + size. A fingerprint match is treated as a duplicate and skipped, same
as today's `findRepostedPackage` handling — this is what lets a forwarded copy and a previously
fully-downloaded copy of the same archive still dedupe against each other, despite never sharing a
byte-hash-derived `contentHash`.

### 5. Fork point in `processOneArchiveSet`

All existing pre-download checks run first, completely unchanged, in the same order:
`remote.unique_id` match → `packageExistsBySourceMessage` → `findRepostedPackage` (name+size) →
cross-channel provenance backfill → size guard (`maxZipSizeMB`).

Then:

```
if channel.allowsForwarding === true:
    entries = readScannedListingRanged(archiveType, client, scannedParts)
    if entries is not null:
        contentHash = deriveForwardContentHash(entries, remoteUniqueId)
        if fingerprintRepostCheck(entries, fileName, fileSize) finds a match:
            → treat as duplicate, skip (same bookkeeping as today's dup path)
        destResult = forwardArchiveToChannel(client, sourceChatId, partMessageIds, destChatId)
        creator, tags ← derived from entries/filename/channel/topic, same as today
        preview ← channel-photo match only (no in-archive extraction)
        createPackageStub(...) + updatePackageWithMetadata(...), same as today
        counters.zipsForwarded++
        → done
    else:
        → fall through into the existing download/hash/split/upload flow below, unchanged
        (log the fallback for observability)
else:
    → existing download/hash/split/upload flow, completely unchanged
```

### 6. Observability

New `zipsForwarded` counter alongside the existing `zipsFound`/`zipsDuplicate`/`zipsIngested`/
`zipsBackfilled` counters, surfaced the same way (run activity, ingestion run summary). A WARN-level
log line when a forwarding-eligible archive falls back to download (mirrors the existing
`confidence: "ranged" | "full-download-fallback"` logging convention from the ranged-listing
backfill work), so the fallback rate is visible without digging through debug logs.

## Data flow

```
scan → pre-download dedup + size guard (unchanged)
     → channel.allowsForwarding?
         true  → ranged listing
                   ok   → fingerprint dedup check → forward → stub + entries + tags (no in-archive preview) → done
                   null → [fall through] existing download pipeline
         false/unknown → existing download pipeline (unchanged)
```

## Error handling

- `forwardMessages` failure (permission revoked mid-run, rate limit, transient Telegram error) —
  same `SkippedPackage`/`SystemNotification` bookkeeping as today's upload failures. Extend
  `inferSkipReason` to recognize forward-specific error text the same way it already recognizes
  upload errors.
- Fingerprint-repost check finds multiple ambiguous same-name/size candidates that can't be
  uniquely disambiguated — same `INTEGRITY_AUDIT` notification pattern already used in
  `provenance-backfill.ts`: don't guess, surface for manual triage.
- `allowsForwarding` unknown (channel just linked, not yet scanned by the refresh point) — treated
  as `false`; the download path runs. No channel uses an unverified forwarding permission.
- Ranged listing throwing instead of returning `null` — treated identically to returning `null`
  (fall through to download), consistent with how the existing ranged readers already treat
  internal errors (they catch and return `null` themselves).

## Testing

- Unit tests (vitest, alongside the existing `archive/*.test.ts` and `archive/ranged/*.test.ts`
  files): the dedup-identity derivation function (fingerprint-hash vs remoteUniqueId-fallback
  branches), the extended fingerprint-based repost check, and `forwardArchiveToChannel`'s
  request-building logic against a mocked TDLib client — same style as the existing ranged-reader
  tests (pure logic, no live TDLib).
- Live verification (manual — matches this repo's existing convention that the large
  `worker.ts`/`worker.py`-equivalent orchestration function has no automated test coverage and is
  verified live post-deploy): one forwarding-enabled test channel and one protected-content test
  channel. Confirm forward-path packages land with correct entries/tags/dedup identity and
  `destMessageIds`; confirm the protected channel still goes through the unchanged full pipeline;
  confirm a deliberately-unparseable archive in a forwarding-enabled channel correctly falls back
  to download+reupload and still ends up fully indexed.

## Rollout

Local build + deploy, following the same recipe as the ranged-archive-listing work: build
`worker/Dockerfile` locally, recreate the `dragonsstash-worker` container from the local image (no
`pull`, no GitHub push required). New DB migration for `TelegramChannel.allowsForwarding`. No
changes required to the bot or app services.
