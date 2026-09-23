# PrjLab CLI

`prj` moves a project **with its context** between machines and people: the files,
the project instructions (`CLAUDE.md`, `AGENTS.md`), the notes you keep in
`.prjcontext/memory/` and the conversations you choose to keep in
`.prjcontext/sessions/`. Push from one machine, clone on another, and your coding
assistant continues with the same understanding.

The hosted service lives at [prjlab.com](https://prjlab.com). Repositories are
private by default; you share them by inviting people by handle. This client is
MIT licensed and does not contain the platform or any credentials.

## Install

Requires Node 22. The package is published on npm as
[`prjlab-cli`](https://www.npmjs.com/package/prjlab-cli):

```sh
npm install -g prjlab-cli
prj --version
```

Every GitHub release also carries the identical tarball
(`npm install -g https://github.com/AbdellahJAIZE/prjlab-cli/releases/download/vX.Y.Z/prjlab-cli-X.Y.Z.tgz`).

Sign-in stores an encrypted credential in your operating system's keychain
(Windows Credential Manager, macOS Keychain, or Linux Secret Service). On Linux
install `libsecret` and make sure a keyring such as GNOME Keyring is unlocked; there
is no plaintext fallback. If you installed with `--ignore-scripts`, run
`npm rebuild -g keytar` once.

## Quick start

1. Create an account at [prjlab.com](https://prjlab.com/sign-in) and pick a handle.
2. Create a repository at [prjlab.com/new](https://prjlab.com/new).
3. In your project directory:

```sh
prj login                       # opens your browser once
prj init                        # creates .prj/ (add it to .gitignore)
prj push you/your-repo          # upload this directory as version 1
prj push -m "what changed"      # later: describe the version (up to 200 characters)
```

4. On another machine, or for a friend you invited:

```sh
prj clone you/your-repo         # into ./your-repo
cd your-repo
prj pull                        # later: fetch the newest version
prj push                        # the directory remembers its repository
```

Run `prj --help` for the full command list. The guide with screenshots is at
[prjlab.com/docs](https://prjlab.com/docs).

## What travels

`push` captures regular files under the current directory, filtered by your
`.gitignore` files and an optional root `.prjignore`. Always excluded: Git and
PrjLab metadata, dependency and build output folders, environment files except
`.env.example`, key files, cloud credential folders and assistant trust/hook
settings. These name rules are not a complete secret scanner: review `prj status`
before pushing. Context is picked up from `.prjcontext/memory/`,
`.prjcontext/sessions/` and `.prjcontext/instructions/`; `CLAUDE.md` and
`AGENTS.md` count as instructions.

Limits: 1,000 files, 5 MiB per file, 100 MiB per snapshot. Symlinks, hard links,
unsafe paths and case collisions are rejected.

## Local snapshots

`init` creates `.prj/`. `snapshot` records the current files into a SHA-256
verified local store; `status` shows what changed since. `export <id> <new-dir>`
writes a snapshot into a new directory, `restore <id>` returns tracked files to a
snapshot while preserving unrelated edits, and `recover` finishes a restore that was
interrupted. Local snapshots stay on this machine and are not encrypted.

Details on sync behaviour, conflicts and recovery are in [SYNC.md](SYNC.md);
sign-in and credential storage are described in [LOGIN.md](LOGIN.md).

## Self-hosting and development

The CLI talks to prjlab.com by default. To point it at another PrjLab server set
`PRJ_SERVER`, `PRJ_AUTHORITY`, `PRJ_CLIENT_ID` and `PRJ_API_SCOPE` (see LOGIN.md).

```sh
npm ci --ignore-scripts && npm rebuild keytar
npm run build
npm run typecheck && npm test && npm run test:package
```

GitHub Actions runs these checks on Linux, macOS and Windows, audits dependencies
and scans for secrets. The public API contract consumed by this client is in
[contracts/](contracts/README.md).

## License and security

[MIT](LICENSE). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).
