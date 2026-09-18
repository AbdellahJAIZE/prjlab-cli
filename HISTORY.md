# History

## 2026-09-18 — Cross-platform checkout correction

Initial CI passed Linux/macOS and security scanning. Windows exposed Git CRLF
checkout conflicting with the LF formatting policy. Added .gitattributes so
all supported systems test identical source line endings.

## 2026-09-18 — Foundation

Added TypeScript entry point, help/version behavior, explicit unsupported-command
errors, unit tests, isolated packed-package test and Linux/macOS/Windows CI.
No platform code or private design files included. License/release remain pending.
