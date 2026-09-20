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

History contract0.4.0 merged in PR16 as ad3bb05.111 CLI tests pass. The actual
platform/PostgreSQL interoperability suite exercises this client in CI using a
pinned public source commit; live identity issuance is still unverified.

## Next

Upload-session lifecycle and reserved-quota support, coordinated with the private
platform contract. Preserve current direct-transfer compatibility until that change
is tested end to end. The overall implementation plan remains in the private project workspace.

Live identity tenant verification, server-side device revocation, cloud operations
and release gates remain open. No production deployment or npm publication.
Logout removes local credentials. Hosted encryption remains the selected model.
