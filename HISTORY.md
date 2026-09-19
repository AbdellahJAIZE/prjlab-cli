# History

## 2026-09-19 — Bounded authenticated HTTP transport

Added ApiTransport with origin-scoped credentials, HTTPS enforcement, redirect
refusal, 64 KiB requests, 1 MiB streamed/decompressed response cap, deadlines,
cancellation and fixed redacted error categories. No automatic retries or cookie
persistence. Response data remains unknown until caller contract validation.
71 tests pass, including real HTTP redirects, all error statuses, stalled headers/
bodies, gzip expansion, malformed UTF-8/JSON, cancellation and connection failure.
Types, formatting, packed install and audit pass. PR/CI pending.
CLI contract PR #9 merged as c414d49 after cross-platform/security CI passed.
Login/push/pull/clone remain explicitly unavailable; no live credentials used.

## 2026-09-19 — Versioned public API contract

Added OpenAPI 3.1.1 for 12 implemented account/repository operations, synthetic
fixtures, local snapshot JSON Schema and development-only Ajv checks. Documented
current limits and a separate unimplemented sync/idempotency/error proposal.
All 47 CLI tests, types, format, packed installation and dependency audit pass.
Same fixtures validate real platform HTTP responses. No remote commands enabled.
Contract PR/CI pending; runtime has no new dependencies.

## 2026-09-19 — Restore CI fixture correction

Reproduced the failing ignored case-variant test from PR #8 on Linux. The
case-insensitive ignore rule excluded the incoming file before capture, so the
two snapshots were identical and restore correctly did nothing. Moved the rule
after capture, asserted actual incoming entries, and covered both leaf and parent
directory collisions. No runtime behavior changed. All 28 local tests, type
checks and packed installation checks pass. GitHub run 35446115899 passed all
three operating systems and security; PR #8 merged as b5da653.

## 2026-09-18 — Conflict-safe restore and recovery

Added three-way local restore, tracked deletions and preservation of unrelated
edits/untracked files. Conflicts fail before mutation. Journaled operations roll
back on failure; killed processes can recover without a false baseline advance.
Recovery refuses to overwrite edits made after interruption. 27 tests now cover
these cases, including real child-process termination and portable case collisions.
Remote pull is not connected; no claim of power-loss durability.

## 2026-09-18 — Safe local snapshots

Added init/status/snapshot/export, bounded capture with ignore rules and typed
curated context. SHA-256 checks, exclusive locks, safe portable paths, link refusal
and no-overwrite export protect local work. HEAD changes only after capture succeeds.
18 local tests cover traversal, corrupt objects, links, concurrency, ignore rules,
status and round trips. Installed-package test now exercises capture/export.
Remote authentication/sync and conflict-safe pull remain unimplemented.

## 2026-09-18 — MIT license

Owner selected MIT for the public CLI. Added LICENSE and package metadata,
including the license in the packed artifact. npm publication remains disabled.

## 2026-09-18 — Cross-platform checkout correction

Initial CI passed Linux/macOS and security scanning. Windows exposed Git CRLF
checkout conflicting with the LF formatting policy. Added .gitattributes so
all supported systems test identical source line endings.

## 2026-09-18 — Foundation

Added TypeScript entry point, help/version behavior, explicit unsupported-command
errors, unit tests, isolated packed-package test and Linux/macOS/Windows CI.
No platform code or private design files included. License/release remain pending.
