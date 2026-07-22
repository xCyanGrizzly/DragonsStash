# Disposable restore documentation fix report

## Scope

Updated `scripts/backup/README.md` only for the documentation change. This
report is the requested verification artifact.

## Change

The monthly recovery rehearsal now documents a unique disposable Compose
project with project-labeled volumes, snapshot selection, staging restore,
PostgreSQL import, restoration of uploads and both TDLib volumes, disposable
service startup, health and log checks, retained-file validation, known STL
checksum and metadata comparison, narrowly scoped cleanup, and an evidence
template.

The guide explicitly warns operators not to use production project names or
volumes, and states that this documentation update did not run the rehearsal.

## Verification

- Focused text check: passed. Confirmed the guide contains the unique project
  warning, snapshot selection, staging restore, PostgreSQL import, all three
  protected volume restores, health check, retained-file validation, checksum
  comparison, scoped cleanup, evidence template, and the statement that the
  rehearsal was not run.
- `git diff --check`: passed.
- No recovery, Docker, Restic, PostgreSQL, or health-check commands were run;
  this change documents the operator procedure only.
