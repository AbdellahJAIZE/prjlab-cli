# Sync: push, pull and clone

Sign in with `prj login` and create a repository at https://prjlab.com/new. Name it
as `<handle>/<name>` (the owner's handle and the repository name); a repository ID
from the web app works too.

```
prj init
prj remote add origin <handle>/<name> # link this directory (like git remote add)
prj remote -v                         # show the link
prj push                              # upload; also: prj push origin main, prj push .
prj push <handle>/<name>              # alternative: the first push links too
prj push -m "what changed"            # describe the version; shown in the web app
prj clone <handle>/<name> [<dir>]     # new directory, defaults to <name>
prj pull                              # bring the directory up to the newest version
prj remote set-url origin <handle>/<name>  # point at another repository
prj remote remove origin              # forget the link; files and snapshots stay
prj push --no-sessions                # this version without AI sessions
prj context                           # what AI-tool context would travel
```

Claude Code memory, sessions and project settings travel with every push and are
restored for the new folder path on pull and clone; see README "AI-tool context".

PrjLab keeps one remote, `origin`, and has no branches: `prj push origin main` and
`prj push -u origin main` are accepted out of habit and upload a new version. A
repository page link such as `https://prjlab.com/alice/notes` works wherever
`<handle>/<name>` does. `prj remote add` checks that the repository exists and that
you can reach it, without uploading anything.

Push and pull act on the current initialized directory. `<handle>/<name>` is looked
up in your own and shared repositories, so a repository you were not invited to is
reported as not found. Clone requires a new path with existing safe parent
directories; it never replaces an existing folder. If a clone fails part-way, enter
the directory and run `prj pull`. No downloaded code or instructions execute
automatically.

Push uploads files selected by the snapshot scanner and ignore rules (see README).
Review exclusions and project content before running it. Local snapshot, status,
export and restore commands remain offline. `status` describes the local snapshot,
not the remote tip. Remote origin, repository ID and adopted base live in
`.prj/remote.json`; they cannot silently switch when environment settings change,
and push/pull refuse a directory linked to a different server.

## Conflicts and recovery

One project lock covers staging and adoption. Pull validates every path, digest
and length before changing workspace files. It uses the adopted remote snapshot
as the three-way baseline, independently of later local captures. Unrelated local
changes survive; conflicting edits cause failure with no planned changes applied.
Resolve conflicts locally, then retry pull. There is no force overwrite option.

Pending push records retain a retry key and the exact captured snapshot. If a commit
reply is lost, retry the same push: it completes the original snapshot without a
second server version. Later local edits remain untouched; push again to upload
them. An unknown push outcome blocks pull until the push is resolved. A definitive
begin/commit conflict clears the pending push and preserves the old base so pull can
run. An object-transfer conflict retains pending state until session status resolves it.

Pending pull records permit adoption to resume after a local metadata write
failure. Current remote access is checked before resuming. Interrupted filesystem
restores may require `prj recover` before retrying. Keep `.prj` intact; deleting
retry metadata can destroy the information needed to reconcile a network failure.

New pushes persist an upload-session retry key before networking, then persist the
returned session ID before transferring bytes. A lost begin reply reuses the same
key. A lost commit reply reads session status and adopts its original version.
Only a confirmed expired/aborted session permits a fresh retry key; retry push to
resume the same saved snapshot. Sessions expire after 24 hours without renewal.

## Transport and limits

Transfers use bearer credentials for the configured origin, reject redirects,
validate SHA-256 and limit each request to 10 seconds. A sync command has a
5-minute deadline. Token refresh happens before the command; an expired token
during transfer fails with saved retry state. There is no background sync,
automatic retry or credential logging.

Limits: 5 MiB per file, 100 MiB per snapshot, 1,000 entries; the normalized
remote manifest must fit in 512 KiB within a 1 MiB request. Repository object and
version quotas also apply, and history keeps every pushed object, so a repository
can fill with historical content.
