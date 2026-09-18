# History

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
