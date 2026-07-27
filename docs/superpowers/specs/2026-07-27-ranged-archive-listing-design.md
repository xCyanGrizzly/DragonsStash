# Ranged inner-file listing for RAR & 7z — design

**Date:** 2026-07-27
**Status:** Approved (design), pending spec review → implementation plan

## Problem

The reindex/provenance-backfill path (`worker/src/provenance-backfill.ts`) can index an
archive's inner files *without* re-downloading it, by reading the file listing from a small
ranged read of the copy already in the source/destination channel. This works **only for
ZIP** today (ZIP keeps its central directory in a tail that `parseZipCentralDirectoryFromTail`
reads). For **RAR and 7z**, `tryProvenanceBackfill` backfills provenance (creator, source
channel, `remoteUniqueId`) so the file is skipped on re-scan and never re-downloaded — but it
leaves the inner listing empty (`fileCount = 0`), because `scannedEntries` is only computed for
ZIP.

Scope of the gap (rebuild placeholders with `fileCount = 0`, as of 2026-07-27):

| Type | Count | Total | Avg | Max | Multipart |
|---|---|---|---|---|---|
| 7z | 19,646 | 14 TB | 0.73 GB | 3.9 GB | 0 |
| RAR | 12,780 | 13 TB | 1.04 GB | 116 GB | 1,016 |

A "just download the whole archive" fallback for all of these means ~27 TB of re-downloads —
the exact cost this path exists to avoid.

## Goals

- Index the inner files (names + sizes; CRCs where cheaply available) of RAR and 7z
  placeholders **without** downloading the whole archive in the common case.
- Reuse the existing, battle-tested CLI listing parsers (`parse7zOutput`,
  `parseUnrarTechnical`) rather than reimplementing filename/size/CRC extraction.
- Keep cost proportional to **file count**, not archive size (so even the 116 GB RAR is cheap).
- Guarantee a listing for the rare archives the cheap path can't handle, via a full-download
  fallback that respects the existing max-size guard.

## Non-goals

- No change to ingestion of genuinely-new files (those are downloaded in full to be re-uploaded
  regardless, so a cheap listing does not help there). This feature only affects the
  provenance-backfill / skip path.
- No new ZIP behaviour — the existing ZIP tail reader stays as-is.
- Not attempting to list password-encrypted-header archives from ranged reads (no password);
  those take the fallback and, if oversized, are flagged.

## Approach (chosen: "harvest header regions → sparse file → native CLI")

Do the *minimum* binary parsing needed to locate an archive's header bytes, fetch only those
via ranged reads, write them into a sparse temp file at their true offsets (data regions left
as unwritten zero holes → ~no disk use), then run the real `7z l` / `unrar lt` and reuse the
existing parsers. The native tools do the hard parsing (7z's LZMA-encoded headers, RAR's two
format versions, Unicode names) — we only compute where the headers are.

Rejected alternatives: full native TS parsers (most custom binary code, highest risk);
RAR5-quick-open-only (most community RARs lack it → collapses to ~13 TB of RAR downloads).

## Components

New directory `worker/src/archive/ranged/`, one focused module per concern, all returning the
existing `FileEntry[]` type from `zip-reader.ts`:

- `sparse-list.ts` — `listFromSparse(parts, runner, parse) → FileEntry[] | null`, where each
  `part` is `{ fileName, size, regions: {offset, bytes}[] }`. For each part it writes a sparse
  temp file (`truncate` to `size`, then write only the header `regions` at their offsets),
  co-locates all parts in one temp dir under their real names, invokes the supplied CLI runner
  (`7z l` / `unrar lt`) on the first part, feeds stdout to the supplied `parse` fn
  (`parse7zOutput` / `parseUnrarTechnical`), and cleans up. Single-part archives are just the
  one-element case. Returns `null` on CLI error / empty parse.
- `sevenz-ranged.ts` — `readSevenZListingRanged(client, parts) → FileEntry[] | null`.
- `rar-ranged.ts` — `readRarListingRanged(client, parts) → FileEntry[] | null`.
- Dispatcher in `provenance-backfill.ts`: `readScannedListingRanged(archiveType, client, parts)`
  replacing the current `if (archiveType === "ZIP")` branch; the destination-copy read in
  `resolveCandidateFingerprintEntries` gets the same dispatch.

`FileEntry` shape (unchanged): `{ path, fileName, extension, compressedSize, uncompressedSize, crc32 }`.

### 7z ranged listing

7z layout: 32-byte signature header at offset 0 → packed streams → end header (lists files) at
the end; the signature header stores the end header's location.

1. Ranged-read `[0, 32)`; validate magic `37 7A BC AF 27 1C`. Read LE `uint64`
   `NextHeaderOffset` (byte 12) and `NextHeaderSize` (byte 20). End header is at absolute offset
   `32 + NextHeaderOffset`, length `NextHeaderSize`.
2. Ranged-read `[32 + NextHeaderOffset, NextHeaderSize)`.
3. `listFromSparse` with regions `{0: sigHeader}` and `{32+NextHeaderOffset: endHeader}`, total
   = file size, runner = `7z l`. `parse7zOutput` yields names+sizes (`crc32: null`, as today).
4. Return `null` on bad magic / read failure / CLI error.

`7z l` seeks to the end header (incl. decoding an LZMA-encoded header via the real binary) and
never reads the packed-stream gap, so the sparse holes are untouched. All 7z placeholders are
single-part.

### RAR ranged listing

RAR has no index; walk the block chain, parsing only each block's **size fields** to step
forward and harvest header bytes.

1. Read first ~16 bytes; detect **RAR4** (`52 61 72 21 1A 07 00`) vs **RAR5** (`…07 01 00`) and
   the signature length.
2. From just after the signature, loop:
   - Ranged-read a header chunk (start 8 KB; if parsed `HeaderSize` exceeds it — long filenames
     — re-read exactly).
   - Minimal block-extent parse:
     - RAR5: `CRC32(4)` + vint `HeaderSize` + vint `HeaderType` + vint `HeaderFlags`; if the
       "extra area" flag (`0x0001`) → vint `ExtraAreaSize`; if the "data present" flag
       (`0x0002`) → vint `DataSize`. Next block = `pos + 4 + len(HeaderSize vint) + HeaderSize
       + DataSize`.
     - RAR4: `HEAD_CRC(2)` + `HEAD_TYPE(1)` + `HEAD_FLAGS(2)` + `HEAD_SIZE(2)`; if flag `0x8000`
       → `ADD_SIZE(4)`. Next block = `pos + HEAD_SIZE + ADD_SIZE`.
   - Harvest `[blockOffset, blockOffset + HeaderSize)` into the regions list.
   - Stop at the end-of-archive block or EOF.
3. `listFromSparse` (headers present, data sparse) → `unrar lt` → `parseUnrarTechnical`. RAR
   headers carry CRC32, so RAR contributes CRCs (fingerprint disambiguation keeps working).

**Multipart RAR** (1,016): each volume starts with its own signature + headers. Walk **each
part from its own signature**, reconstruct one sparse temp file per part with correct names
(`name.part1.rar`, `.part2.rar`, …) co-located in a temp dir, and run `unrar lt` on part 1 —
`unrar` auto-discovers co-located siblings (per the existing reader's note). The global-offset →
`(part, offsetInPart)` mapping reuses the multipart size math the ZIP path already uses.

## Fallback & integration

- A ranged reader returning `null` = cheap read failed (bad magic, read error, walk gave up, or
  CLI error on the sparse file) → **full-download fallback**: download the whole archive, run the
  existing `readRarContents` / `read7zContents`, backfill.
- The fallback is gated by `config.maxZipSizeMB` (the same guard used at ingest). Over the cap →
  no download; write a `SystemNotification` (`INTEGRITY_AUDIT`, WARNING) and leave the listing
  empty for manual review. This ensures nothing pathological (e.g. the 116 GB RAR) is pulled.
- Downstream is unchanged: `compareFingerprints` already treats null/incomplete CRCs as
  "incomplete" (name-size path), and `backfillProvenance` writes entries when the candidate's
  `fileCount === 0`.
- Observability: reuse the `zipsBackfilled` counter; add structured logs with
  `confidence: "ranged" | "full-download-fallback"` and a WARN on fallback so miss-rate is
  visible.

## Risks & de-risking spike (do before the full build)

On 3–4 real placeholder archives per format:

1. Confirm `downloadFileRange` returns correct bytes at **arbitrary (non-tail) offsets** —
   currently only tail-verified in production. Underpins everything; if it fails, stop and
   rethink. (Note: `range-download.ts` flags absolute-offset behaviour as pending live
   verification; tail reads are proven by the 43 ZIP backfills done 2026-07-26.)
2. Confirm `7z l` and `unrar lt` list correctly from a **sparse reconstructed file** — single
   part first, then multipart RAR (the highest-risk case).

If multipart-RAR sparse reconstruction proves unreliable in the spike, multipart RAR uses the
full-download fallback (respecting the size cap → oversized ones flagged, not downloaded).

## Testing

- **Unit (vitest, alongside `central-directory.test.ts`):** 7z signature-header parse; RAR4 &
  RAR5 block-extent walk against committed small fixtures; `sparse-list` writes the correct
  regions. Pure logic, no TDLib.
- **Live post-deploy:** watch `zipsBackfilled` climb for RAR/7z via the ranged path; spot-check
  a handful of backfilled packages' `package_files` against a real `unrar lt` / `7z l` on a full
  download of the same file; confirm the fallback/flag path fires on a deliberately-broken case.

## Rollout

Local build + deploy (no GitHub push required), per the established recipe: build
`worker/Dockerfile` locally, recreate the `dragonsstash-worker` container from the local image
(no `pull`). No new DB migration. The scheduler re-runs hourly and will backfill RAR/7z
placeholders on subsequent cycles.
