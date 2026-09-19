# CLI status

Last updated: 2026-09-19

## Tracking map

- STATUS.md: current state and next work.
- HISTORY.md: work journal.
- README.md: capabilities, local checks and license status.
- LOGIN.md: CLI authentication configuration, secure storage and recovery.
- contracts/README.md: implemented API contract, compatibility and limits.
- contracts/SYNC-PROPOSAL.md: unimplemented remote sync semantics.

## Current state

Local snapshots/export/restore/recovery and bounded HTTP transport are merged.
Login/whoami/logout are implemented on feat/cli-login and being verified. They
use PKCE/state/nonce, API account verification, scoped encrypted OS credentials,
silent refresh and local credential deletion. No plaintext token fallback.
90 local tests pass, including actual MSAL nonce checks with controlled responses.
Native Linux Secret Service save/load/delete passes in an isolated keyring.
Cross-platform native-store CI is being added; live identity tenant is unconfigured.

## Next

Finish login CI and merge. Then implement private upload/storage/version APIs and
connect CLI push/clone/pull. Hosted encryption selected on 2026-09-19; no E2EE key
sharing is required. Public visibility, cloud budget and release gates remain open.
No production deployment or npm release. Server-side device revocation is pending;
logout currently removes local credentials only. See LOGIN.md for setup/limits.
