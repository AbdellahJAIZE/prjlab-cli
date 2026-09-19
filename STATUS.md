# CLI status

Last updated: 2026-09-19

## Tracking map

- STATUS.md: current state and next work.
- HISTORY.md: work journal.
- README.md: capabilities, local checks and license status.

## Current state

TypeScript CLI foundation: help/version, explicit failure for unimplemented
operations, unit and installed-package checks, cross-platform GitHub CI.
Local init/status/snapshot/export/restore/recover implemented with SHA-256 integrity checks and
path/link/conflict safeguards. No networking, credential storage or npm release.
MIT license included in package contents.

PR #8 restore fixture corrected; 28 local tests, type checks and packed install
pass. Cross-platform CI must pass before merging.

## Next

Define the public API contract, implement real browser authentication and scoped
credential storage. Connect remote sync to the tested restore/recovery core.
