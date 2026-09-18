# CLI status

Last updated: 2026-09-18

## Tracking map

- STATUS.md: current state and next work.
- HISTORY.md: work journal.
- README.md: capabilities, local checks and license status.

## Current state

TypeScript CLI foundation: help/version, explicit failure for unimplemented
operations, unit and installed-package checks, cross-platform GitHub CI.
No npm release, networking, credentials or capture/restore yet. License pending.

## Next

Define the public API contract, implement real browser authentication and scoped
credential storage, then port safe capture/restore with regression tests.
