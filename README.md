# PrjLab CLI

Public CLI foundation for PrjLab. **Early development, not released to npm.**
Package/command names are provisional. This repository does not contain the
private hosted platform or its credentials.

## Build locally

Requires Node 22 and npm 10+:

```sh
npm ci --ignore-scripts
npm run build
node dist/bin.js --help
node dist/bin.js --version
```

Implemented local commands: `prj init`, `prj status`, `prj snapshot`, and
`prj export <snapshot-id> <new-directory>`, `prj restore <snapshot-id>`, and
`prj recover`. Run them in your project directory.
They read local project files only when requested; nothing is uploaded.
`prj login`, `prj whoami` and `prj logout` support configured identity applications
and secure OS credentials; see [login setup](LOGIN.md). Live tenant setup is still
pending. Push, pull, clone and search explicitly fail as unimplemented.

## Local snapshots

`init` creates `.prj/` metadata. Add `.prj/` to your Git ignore rules. `snapshot`
captures regular files into a SHA-256-verified local store and updates the local
HEAD only after capture succeeds. `status` reports additions, edits and deletions
without moving that baseline. `export` verifies all objects and writes to a new
directory; it refuses an existing target and does not execute imported code.
Exports use private file permissions and do not preserve executable bits yet.

Root/nested `.gitignore` and root `.prjignore` filter captures. Fixed exclusions
include Git/PrjLab metadata, dependencies/build outputs, environment secrets
(except `.env.example`), key files, cloud credential folders and Claude trust/hook
settings. These filename rules are not a complete secret scanner. Review your
files before capturing or sharing. Local snapshots are not encrypted.

Curated context can be placed in `.prjcontext/memory/`, `.prjcontext/sessions/`
and `.prjcontext/instructions/`. It is captured with explicit content types.
`CLAUDE.md` and `AGENTS.md` are classified as instructions. Global assistant
folders and unrelated projects are never scanned automatically.

Current development limits: 1,000 files, 5 MiB per file, 100 MiB per snapshot.
Symlinks, hardlinks, unsafe portable paths and case collisions are rejected.
An exclusive `.prj/lock` prevents overlapping operations. Interrupted exports
leave their new partial directory for inspection and do not change the source
snapshot.

`restore` compares the current files, local baseline and requested snapshot. It
preserves unrelated edits/untracked files, applies unchanged tracked deletions,
and refuses conflicting edits before changing anything. File/directory type
changes require manual reconciliation in this first version.

A journal records the operation before writes. A failed restore rolls back; an
interrupted process leaves a recoverable journal and does not advance HEAD.
`recover` removes a lock only when its process is no longer running, then restores
the prior state. It refuses to overwrite edits made after interruption. A journal
left after a successful HEAD commit is safely cleared. Tests cover process exit,
not power-loss durability. Remote pull/merge is not connected yet.

## Check changes

```sh
npm run typecheck
npm test
npm run test:package
```

GitHub Actions runs these checks on Linux, macOS and Windows, audits dependencies,
and scans for vulnerabilities and secrets. Package tests inspect the tarball,
install it into an isolated directory and execute the installed CLI. No npm
publishing workflow or registry credentials are configured.

## API contract

The [public development contract](contracts/README.md) describes implemented
account/repository endpoints and the local snapshot format. A separate sync
proposal marks remote storage and error semantics as unimplemented. Contract
fixtures are checked here and against real HTTP responses in platform tests.

## HTTP transport foundation

`ApiTransport` in `src/http.ts` is a library for future remote commands, not a
login or sync command. It now supports the login account check. Credentials must be scoped to the selected HTTPS origin.
Explicit loopback HTTP is available only for local development. Redirects are
rejected, cookies are not retained, and requests are never retried automatically.

JSON requests are capped at 64 KiB; response reads, including decompressed bytes,
are capped at 1 MiB with a 10-second default deadline covering headers and body.
Callers can cancel requests. Errors contain fixed messages/status categories,
not tokens, URLs, raw server errors or fetch causes. The result data is `unknown`:
callers must validate it against the public contract before using it. This layer
does not itself persist credentials or refresh tokens; the login layer handles
those tasks. It does not enable sync commands.

## Intended workflow

Anyone will be able to install the released public npm package. Hosted operations
will authenticate to PrjLab; repository access will be enforced by the API, never
trusted solely to this client. A public CLI does not expose private user projects.

## License

Licensed under the [MIT License](LICENSE). The package remains marked private
to prevent accidental npm publication until the namespace and release are ready.

See SECURITY.md for private vulnerability reporting.

Private development sync commands are documented in [SYNC.md](SYNC.md). Login and
an existing repository UUID are required. Files upload only when push is invoked.
