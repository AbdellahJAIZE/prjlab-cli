# CLI sign-in

`prj login` opens your browser, you sign in to PrjLab, and the CLI stores an
encrypted credential in your operating system's keychain. `prj whoami` shows the
signed-in handle; `prj logout` removes the credential from this machine. Local
commands (`init`, `status`, `snapshot`, `export`, `restore`, `recover`) never need
login.

## Hosted service

No configuration is needed for prjlab.com: the server, identity authority, client
application and API scope are built into the CLI. They are public identifiers, not
secrets.

## Other servers (self-hosting, development)

Set these in your shell environment, never in command arguments:

- `PRJ_SERVER`: exact HTTPS API origin, without a path.
- `PRJ_AUTHORITY`: `https://<tenant>.ciamlogin.com/<tenant-UUID>`.
- `PRJ_CLIENT_ID`: registered public/native CLI application UUID.
- `PRJ_API_SCOPE`: `api://<API-application-UUID>/<delegated-scope>`.

Register `http://localhost` as the public client's loopback redirect. The CLI
binds only IPv4 loopback with an ephemeral port. Add its client ID to the API's
approved AUTH_CLIENT_IDS and grant the delegated API permission in the customer
tenant. Never put a client secret in a public CLI.

`PRJ_ALLOW_LOOPBACK_HTTP=1` permits a numeric loopback HTTP API origin for isolated
development only; it never allows remote unencrypted HTTP or non-HTTPS identity
providers. Server, authority, client and API scope form the credential namespace,
so changing any of them selects a different saved session. An invalid override
fails before any browser or network use instead of falling back to prjlab.com.

## Commands

- `prj login`: open the system browser, complete PKCE/state/nonce checks, verify
  the API accepts the access token, then save encrypted credentials. A failed
  provider/API attempt leaves the prior saved login intact. Sign-in has a five-minute
  callback/network deadline; Ctrl+C cancels it. OS keychain prompts depend on the OS.
- `prj whoami`: load the scoped account, refresh through MSAL when needed, verify
  current API access, and show the account handle. If the account has no handle yet,
  finish setup in the web app first.
- `prj logout`: remove this configuration's local credentials. It does not revoke
  already issued access tokens or sign out the provider globally.

No access/refresh token is printed. Errors do not include provider details,
authorization codes or credentials. Imported project instructions never run.

## Secure storage

MSAL Node handles authorization and token refresh. The saved session (MSAL token
cache, including refresh tokens) is encrypted with AES-256-GCM and written to
`~/.prjlab/auth/<scope-hash>/session.enc` (mode 0600, atomic replace). The random
256-bit key lives only in the OS credential store, through
[`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node): Windows
Credential Manager, macOS Keychain or Linux Secret Service (never the session-only
kernel keyring). The file alone reveals nothing; the key is bound to one
application/server scope, and a tampered file is refused. There is no plaintext
fallback: without an available, unlocked credential store, sign-in fails clearly.

The native module ships prebuilt for each platform as an optional dependency; no
install script runs. CLI 0.4.0 replaced the archived `keytar` module (and the
deprecated `prebuild-install` warning it caused); sessions saved by 0.3.x cannot
be read by 0.4.0, so run `prj login` once after upgrading. The old entry is removed
on the next login or logout where the OS store allows it.

Only one credential operation per configuration runs at a time. Failed writes
attempt verified restoration of the prior encrypted cache. If the store cannot
recover, the error says so; power-loss durability is not claimed.

After a killed process, an `operation.lock` may remain. Inspect its PID and verify
that process is gone before removing that specific lock. Never remove a live lock
or the whole credential directory as a shortcut.

## Verification

Unit tests exercise real loopback callbacks, wrong state/Host/path, duplicate codes,
replay, cancellation, failed login preservation, partial-save rollback and scope
mismatches. Tests invoke the actual MSAL code exchange with controlled provider
responses to check PKCE and nonce handling. Native-store tests use synthetic data
and verify save/read/delete without plaintext files. Linux uses an isolated
DBus/keyring session; CI covers all three OSes. The release checks also run the
real browser sign-in against prjlab.com from an isolated keyring.

References:

- [Microsoft External ID CLI example](https://learn.microsoft.com/en-us/samples/azure-samples/ms-identity-ciam-javascript-tutorial/ms-identity-ciam-javascript-tutorial-6-sign-in-node-cli-app/).
- [@napi-rs/keyring](https://github.com/Brooooooklyn/keyring-node) (Rust `keyring` crate bindings).
