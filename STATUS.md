# CLI status

Last updated: 2026-09-19

## Tracking map

- STATUS.md: current state and next work.
- HISTORY.md: work journal.
- README.md: capabilities, local checks and license status.
- contracts/README.md: implemented API contract, compatibility and limits.
- contracts/SYNC-PROPOSAL.md: unimplemented remote sync semantics.

## Current state

TypeScript CLI foundation: help/version, explicit failure for unimplemented
operations, unit and installed-package checks, cross-platform GitHub CI.
Local init/status/snapshot/export/restore/recover implemented with SHA-256 integrity checks and
path/link/conflict safeguards. No networking, credential storage or npm release.
MIT license included in package contents.

PR #8 restore fixture corrected; 28 local tests, type checks and packed install
pass. GitHub run 35446115899 passed Linux/macOS/Windows quality and security.
PR #8 merged as b5da653; local main updated.

## Next

Public API contract and local snapshot schema added with 47 passing CLI tests.
Platform validates actual account/sharing HTTP responses against the same schemas.
Contract PR/CI pending. Next: bounded authenticated HTTP client, then real browser
authentication and scoped credential storage. Remote storage/encryption remains
unresolved; connect sync to the tested restore/recovery core after that decision.
