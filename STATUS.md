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

## 2026-09-20 version contract checkpoint

Branch refactor/shared-manifest: portable validation extracted into src/manifest.ts;
public0.3.0 contract adds version commit/tip/read. 98 tests pass. Platform uses
byte-identical validator under MIT. CI and merge pending; CLI sync still pending.

## 2026-09-20 sync checkpoint

Branch feat/remote-sync: push/pull/clone wired to secure login and verified binary
transport. Durable pending operations and remote base are independent of local
capture HEAD.108 tests pass. Real platform interoperability and CI remain pending.
See SYNC.md for supported behavior and limits.
