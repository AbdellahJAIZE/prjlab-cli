# PrjLab CLI

`prj` moves a project **with its context** between machines and people: the files,
the project instructions (`CLAUDE.md`, `AGENTS.md`), and what your AI coding tool
keeps outside the folder. For Claude Code that is the project's memory, its
sessions (so `claude --resume` lists them on the other machine) and its project
settings (trust, allowed tools, MCP servers). Push from one machine, clone on
another, and your coding assistant continues with the same understanding.
Run `prj context` to see what would travel. Codex and other tools come next.

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

Update the same way: `npm install -g prjlab-cli`. `prj` prints a notice when a
newer version is published (it asks registry.npmjs.org at most once a day, never
in CI or when output is piped; `PRJ_NO_UPDATE_CHECK=1` turns it off).

Every GitHub release also carries the identical tarball
(`npm install -g https://github.com/AbdellahJAIZE/prjlab-cli/releases/download/vX.Y.Z/prjlab-cli-X.Y.Z.tgz`).

Sign-in keeps your session encrypted with a key held in your operating system's
credential store (Windows Credential Manager, macOS Keychain, or Linux Secret
Service). On Linux make sure a keyring such as GNOME Keyring is running and
unlocked; there is no plaintext fallback. The native part ships prebuilt, so no
install script or compiler is needed.

## Quick start

1. Create an account at [prjlab.com](https://prjlab.com/sign-in) and pick a handle.
2. Create a repository at [prjlab.com/new](https://prjlab.com/new).
3. In your project directory:

```sh
prj login                                 # opens your browser once
prj init                                  # creates .prj/ (add it to .gitignore)
prj remote add origin you/your-repo       # link this directory, like git
prj push -m "First version"               # upload this directory as version 1
prj push -m "what changed"                # later: describe the version (up to 200 characters)
```

4. On another machine, or for a friend you invited:

```sh
prj clone you/your-repo         # into ./your-repo
cd your-repo
prj pull                        # later: fetch the newest version
prj push                        # the directory remembers its repository
```

Git habits carry over: `prj remote -v` shows the link, `prj push origin main` and
`prj push -u origin main` work (PrjLab has no branches, every push is a new
version), and the repository page link (`https://prjlab.com/you/your-repo`) works
wherever `you/your-repo` does.

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

### AI-tool context (Claude Code)

`push` also captures, for this folder:

- `~/.claude/projects/<folder>/memory/` — the project's memory;
- `~/.claude/projects/<folder>/*.jsonl` and their subagent/tool-result files —
  the sessions (`--no-sessions` leaves them out of one push; list
  `.prjcontext/agents/*/sessions/**` in `.prjignore` to leave them out always);
- the folder's entry in `~/.claude.json`, portable keys only (`allowedTools`,
  `mcpServers`, trust and MCP approvals); cost, token and session telemetry stay.

They appear in the version under `.prjcontext/agents/claude-code/` but are never
written into your folder: `prj` keeps a copy in `.prj/context/`. Paths of this
machine are replaced by placeholders, transcripts are gzipped and split into
1 MiB segments so a longer session uploads only its new tail.

`pull` and `clone` put them where Claude Code looks for **this** folder's path
(the ClaudeHub re-key): memory and sessions under the matching
`~/.claude/projects/` directory, with paths rewritten, and the settings merged into
`~/.claude.json` (a backup goes to `~/.prjlab/backups/` first, your local values
win). Local work is never overwritten: an edited memory file or a session that
changed on both machines is kept and reported; a longer transcript replaces a
shorter copy of itself. If Claude Code is running in the folder, settings are not
merged; close it and pull again. `CLAUDE_CONFIG_DIR` is honoured.

In a **public** repository, memory and sessions stay visible to members only unless
the owner publishes them in Settings, after a credential scan.

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
npm ci --ignore-scripts
npm run build
npm run typecheck && npm test && npm run test:package
```

GitHub Actions runs these checks on Linux, macOS and Windows, audits dependencies
and scans for secrets. The public API contract consumed by this client is in
[contracts/](contracts/README.md).

## License and security

[MIT](LICENSE). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).
