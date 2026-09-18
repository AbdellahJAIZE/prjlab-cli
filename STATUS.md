# CLI status

Last updated: 2026-09-18

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

## Next

Define the public API contract, implement real browser authentication and scoped
credential storage. Connect remote sync to the tested restore/recovery core.
