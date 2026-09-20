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

PR15 feat/remote-sync implements authenticated push/pull/clone.109 local tests
pass, including lost replies, local conflicts and interrupted recovery with a
separate remote baseline. Packed installation passes. Real platform/PostgreSQL
interoperability passes21 tests with no skips. Latest cross-platform CI pending.
The previous macOS test failure used a symlinked temporary fixture; it now uses
a resolved path while clone retains its symlink rejection policy.

## Next

Verify latest PR15 CI and companion platform PR12, then merge. Keep tracking
source pins accurate. Live identity tenant verification, history pagination,
upload sessions/cleanup, cloud operations and release gates remain open.
No production deployment or npm release. Logout deletes local credentials;
server-side device revocation remains pending. Hosted encryption selected.
