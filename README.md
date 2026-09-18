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
`prj export <snapshot-id> <new-directory>`. Run them in your project directory.
They read local project files only when requested; nothing is uploaded. Login,
push, pull, clone and search still explicitly fail as unimplemented.

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
An exclusive `.prj/lock` prevents overlapping operations. After a crash, verify
no PrjLab process is active before removing a stale lock. Interrupted exports
leave their new partial directory for inspection and do not change the source
snapshot. Pull/merge and automatic deletion are not implemented yet.

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

## Intended workflow

Anyone will be able to install the released public npm package. Hosted operations
will authenticate to PrjLab; repository access will be enforced by the API, never
trusted solely to this client. A public CLI does not expose private user projects.

## License

Licensed under the [MIT License](LICENSE). The package remains marked private
to prevent accidental npm publication until the namespace and release are ready.

See SECURITY.md for private vulnerability reporting.
