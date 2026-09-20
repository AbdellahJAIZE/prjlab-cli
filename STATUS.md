# CLI status

Last updated: 2026-09-20

## Tracking map

- STATUS.md: current state and next work.
- HISTORY.md: work journal.
- README.md: capabilities and local checks.
- LOGIN.md: identity setup, secure storage and recovery.
- SYNC.md: private push/pull/clone and retry behavior.
- contracts/README.md: public development API and compatibility.
- contracts/SYNC-PROPOSAL.md: original proposal; remaining sessions/cleanup work.

## Current state

Local snapshot/export/restore/recovery, secure login and bounded JSON/binary
transport are merged. Login storage passed native Linux/macOS/Windows CI.
Shared portable manifest validator and version contract are merged (PR13).

Private push/pull/clone merged in PR15 as c74af43 after all Linux/macOS/Windows
quality and security checks. Durable pending operations preserve a truthful remote
base independently of local snapshots. Recovery, conflicts, lost replies and safe
clone destinations are tested; packed installation passes.

Contract0.5 mergedfb02b61. Session-aware push merged303cab2 (PR19) after
Linux/macOS/Windows quality and security checks.117 tests and packed installation
pass. The actual platform/PostgreSQL suite verifies lost successful begin/commit
replies without duplicate sessions or versions. Live identity remains unverified.

## Next

Storage reference inventory and crash-safe reclamation are private-platform work.
The overall plan and exact current cross-repository checkpoint live in the owning
project workspace. Keep legacy pending pushes recoverable during future upgrades.

Live identity verification, server-side device revocation, cloud operations and
release gates remain open. No production deployment or npm publication.
Logout removes local credentials. Hosted encryption remains the selected model.
