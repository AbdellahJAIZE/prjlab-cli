# CLI status

Last updated: 2026-10-05

## Tracking map

- STATUS.md: current state and next work.
- HISTORY.md: work journal.
- README.md: capabilities and local checks.
- LOGIN.md: identity setup, secure storage and recovery.
- SYNC.md: private push/pull/clone and retry behavior.
- contracts/README.md: public development API and compatibility.
- contracts/SYNC-PROPOSAL.md: original proposal; remaining sessions/cleanup work.

## Current state

Released: **1.1.0** on npm (`prjlab-cli`); **1.1.1** (Node 20–26) on main.

- **Git repositories**: `prj login` registers a credential helper scoped to the PrjLab
  origin, `prj init` links a git clone and installs context hooks (pre-push, post-merge,
  post-checkout), `prj clone` is git clone plus init, `prj context push|pull` moves the
  AI context by hand. In a git repository whose origin is PrjLab, `prj push` and
  `prj pull` move the context only.
- **Inner repositories**: `prj submodules` lists the git repositories inside a git
  folder; `prj submodules publish` gives each its own PrjLab repository and links it as
  a submodule; `prj clone` is recursive; `prj init` makes switch, pull, merge and push
  submodule-aware; `prj create`/`prj init` say when inner repositories are not linked.
- **Folders without git** (and git folders whose origin is elsewhere) use versions:
  `prj create`, `prj remote`, `prj push`, `prj pull`, `prj clone`.
- **Context**: Claude Code memory, sessions and project settings. A broad `.prjignore`
  rule cannot drop it; the `Context:` line reports what the version carries and warns
  about what it does not; a session line over 8 MiB is split across segments.
- **Limits** (contract 0.9): 5,000 entries, 25 MiB per file, 500 MiB per repository.
  An over-limit folder is explained and, on a terminal, the person chooses what stays out.
- Local snapshots, export, restore and recovery are unchanged.

173 tests; CI on Linux, macOS and Windows plus a security scan on every pull request.
A GitHub release `vX.Y.Z` publishes to npm through trusted publishing (publish.yml).

## Next

- A version pushed with a line cut across segments shows that one row as unreadable in
  the web session viewer (it restores correctly); the viewer should join segments first.
- Codex and other tools (docs/19 of the workspace) are not started.
- The interactive "what stays out" prompt is covered by tests of its logic, not by a
  terminal test.
- The overall plan and cross-repository checkpoints live in the owning project workspace.
