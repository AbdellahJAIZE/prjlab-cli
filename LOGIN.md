# CLI sign-in (development)

`prj login`, `prj whoami`, and `prj logout` are implemented for configured
applications. Live PrjLab customer-tenant sign-in is not configured or verified yet.
Push/pull/clone remain unavailable. Local project commands do not require login.

## Application settings

Set these public identifiers in your shell environment, not in command arguments:

- `PRJ_SERVER`: exact HTTPS PrjLab API origin, without a path.
- `PRJ_AUTHORITY`: `https://<tenant>.ciamlogin.com/<tenant-UUID>`.
- `PRJ_CLIENT_ID`: registered public/native CLI application UUID.
- `PRJ_API_SCOPE`: `api://<API-application-UUID>/<delegated-scope>`.

Register `http://localhost` as the public client's loopback redirect. The CLI
binds only IPv4 loopback with an ephemeral port. Add its client ID to the API's
approved AUTH_CLIENT_IDS and grant the delegated API permission in the customer
tenant. Do not put a web client secret in the public CLI. Initial real tenant
consent/Google/email flows still require setup and verification.

`PRJ_ALLOW_LOOPBACK_HTTP=1` permits a numeric loopback HTTP API origin for isolated
development only; it never allows remote unencrypted HTTP or non-HTTPS identity
providers. Server, authority, client and API scope form the credential namespace.
Changing any of them selects a different saved session.

## Commands

- `prj login`: open the system browser, complete PKCE/state/nonce checks, verify
  the API accepts the access token, then save encrypted credentials. A failed
  provider/API attempt leaves the prior saved login intact. Sign-in has a five-minute
  callback/network deadline; Ctrl+C cancels it. OS keychain prompts depend on the OS.
- `prj whoami`: load the scoped account, refresh through MSAL when needed, verify
  current API access, and show the account handle. Missing account registration
  prompts completion in the web app. A login is saved only after the API returns
  a valid account; a generic 404 is not treated as proof of authenticated identity.
- `prj logout`: remove this configuration's local credentials. It does not revoke
  already issued access tokens or sign out the provider globally. Server-side
  device/token revocation is a separate unfinished feature.

No access/refresh token is printed. Errors do not include provider details,
authorization codes or credentials. Imported project instructions never run.
HTTP response data is checked before displaying an account handle.

## Secure storage

MSAL Node handles authorization and token refresh. MSAL Node Extensions uses
Windows DPAPI, macOS Keychain or Linux Secret Service. There is no plaintext fallback.
The encrypted cache includes refresh tokens and is scoped to one application/server.
Metadata/lock files live under `~/.prjlab/auth/<scope-hash>/`; Linux/macOS cache
markers contain no tokens. Windows cache bytes are DPAPI-encrypted.

Normal npm installation runs the native keytar dependency's install step.
If installing with `--ignore-scripts`, run `npm rebuild keytar` before login.
Linux requires libsecret and an available, unlocked Secret Service. Headless systems
without one fail clearly; they do not write a plaintext token file. Help, snapshots
and other local commands still work without native credential support.

Only one credential operation per configuration runs at a time. Failed writes
attempt verified restoration of the prior encrypted cache. If the store cannot
recover, the error says so; power-loss durability is not claimed.

After a killed process, an `operation.lock` may remain. Inspect its PID and verify
that process is gone before removing that specific lock. Never remove a live lock
or the whole credential directory as a shortcut. Automatic stale-lock recovery is
not implemented, because it must not race another process or erase credentials.

## Verification

Unit tests exercise real loopback callbacks, wrong state/Host/path, duplicate codes,
replay, cancellation, failed login preservation, partial-save rollback and scope
mismatches. Tests invoke the actual MSAL code exchange with controlled provider
responses to check PKCE and nonce handling; these are not live identity tests.
Native-store tests use synthetic data and verify save/read/delete without plaintext
files. Linux uses an isolated DBus/keyring session; CI covers all three OSes.

References:

- [Microsoft External ID CLI example](https://learn.microsoft.com/en-us/samples/azure-samples/ms-identity-ciam-javascript-tutorial/ms-identity-ciam-javascript-tutorial-6-sign-in-node-cli-app/).
- [MSAL Node Extensions storage](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/extensions/msal-node-extensions/README.md).
