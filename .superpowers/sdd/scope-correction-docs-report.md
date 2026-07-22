# Backup Scope-Correction Documentation Report

**Date:** 2026-07-22

## Changed files

- `docs/superpowers/specs/2026-07-21-database-and-file-backups-design.md`
- `docs/superpowers/plans/2026-07-21-database-and-file-backups.md`
- `.superpowers/sdd/scope-correction-docs-report.md`

## Rationale

The backup design and implementation plan now define the protected data set as a PostgreSQL logical dump plus the `tdlib_state` and `tdlib_bot_state` session volumes. They continue to require a host-restricted Synology NFS repository, Restic encryption, 30 daily snapshots, service quiescing, guarded restore, and session persistence.

`manual_uploads` and `tmp_zips` are explicitly excluded. The documents no longer require local retention of completed STL binaries, worker cleanup changes, database lifecycle fields for retained uploads, restored local STL files, or file-path validation. They state that STL binaries remain in Telegram and that the restored database preserves the metadata and mappings required to locate and send them.

Future Telegram channel-forwarding behavior and archive/STL-content integrity validation are explicitly identified as out of scope and future work.

## Checks run

- `git diff --check`
- Scope scan of both documents for `manual_uploads`, `tmp_zips`, local STL retention, file-path validation, channel forwarding, and integrity language.
- Reviewed the final diff to confirm the removed implementation work is limited to the specified backup-scope correction.
- `git status --short` to confirm the commit stages only the two requested documents and this required report.

## Concerns

- This change intentionally updates documentation only. It does not modify backup scripts, Docker Compose, database schema, worker cleanup, or Telegram behavior.
- A future implementation should validate its actual backup manifests and Compose mounts against this corrected plan before deployment.

---

# Monthly Backup Verification Documentation Follow-up

**Date:** 2026-07-22

## Fix

Aligned the approved backup design and implementation plan on the missing recurring operational work. The deployment operator now owns a documented monthly manual runbook task to run full `restic check --read-data`, perform a disposable restore rehearsal, and record the date, snapshot ID, integrity-check result, restore/health result, and cleanup result.

The plan verifies the first full-read check and rehearsal during acceptance, then carries the same procedure into the monthly runbook without adding a second systemd timer, script, or other production implementation. The Synology wording now precisely identifies the dedicated shared folder's NFS export as restricted to the Docker host's fixed IP.

## Scope preserved

The recovery set remains the PostgreSQL logical dump plus `tdlib_state` and `tdlib_bot_state` only. `manual_uploads`, STL binaries, archive/STL-content integrity, and future channel-forwarding checks remain outside this work.

## Checks completed

- `git diff --check` completed with no whitespace errors.
- Focused assertions passed: `restic check --read-data` (4 matches), `deployment operator` (3), `disposable restore rehearsal` (6), `manual_uploads` (8), and `archive/STL-content integrity` (4) across the two approved documents.
- Final diff review confirmed that this follow-up changes documentation only; no backup scripts, Compose configuration, or other production implementation files were modified.

---

# Monthly Backup Verification Review-Finding Fix

**Date:** 2026-07-22

## Fix

Confirmed and kept the approved design and implementation plan aligned on the reviewer finding: monthly recovery verification is an operator-owned operational task, consisting of a full `restic check --read-data` and a disposable restore rehearsal.

## Scope

The approved docs continue to limit the protected recovery set to the PostgreSQL logical dump, `tdlib_state`, and `tdlib_bot_state`. They do not add `manual_uploads`, STL-binary restore/checks, archive-content integrity checks, future channel-forwarding checks, or any new production timer/script.

## Checks

- `git diff --check`
- Focused scope assertions over the two approved docs for monthly full Restic check/rehearsal wording and exclusions.
- Staged-file review before commit to confirm the commit contains documentation/report files only.
