# Private sync — development CLI

Configure login as described in LOGIN.md, sign in, and create a private repository
in the web app. Use its repository UUID (not its slug) with these commands:

```
prj init
prj push <repository-id>
prj clone <repository-id> <new-directory>
prj pull <repository-id>
```

Push and pull act on the current initialized directory. Clone requires a new
path with existing safe parent directories. It never replaces an existing folder.
Clone failure may leave an initialized directory; enter it and retry pull using
the same repository ID. No downloaded code or instructions execute automatically.

Push uploads files selected by the existing snapshot scanner/ignore rules.
Review exclusions and project content before running it. Local snapshot/status/
export/restore commands remain offline. Status describes the local snapshot HEAD,
not the remote server tip. Remote origin, repository ID and adopted base live in
.prj/remote.json; they cannot silently switch when environment settings change.

One project lock covers staging and adoption. Pull validates every path, digest
and length before changing workspace files. It uses the adopted remote snapshot
as the three-way baseline, independently of later local captures. Unrelated local
changes survive; conflicting edits cause failure with no planned changes applied.
Resolve conflicts locally, then retry pull. No force overwrite option is provided.

Pending push records retain a retry key and exact captured snapshot. If a commit
reply is lost, retry the same push: it completes the original snapshot without a
second server version. Later local edits remain untouched; push again to upload
them. An unknown push outcome blocks pull until the push is resolved. A definitive
409 conflict clears the pending push and preserves the old base so pull can run.

Pending pull records permit adoption to resume after a local metadata write
failure. Current remote access is checked before resuming. Interrupted filesystem
restores may require `prj recover` before retrying. Keep .prj intact; deleting retry
metadata can destroy the information needed to reconcile a network failure.

Transfers use configured-origin bearer credentials, reject redirects, validate
SHA-256 and limit each request to10 seconds. A sync command has a5-minute deadline.
Token refresh happens before the command; an expired token during transfer fails
with saved retry state. No automatic background sync, retries or credential logging.

Development limits:5MiB/file,100MiB aggregate snapshot,1000 entries; normalized
remote manifest60KiB within64KiB request; repository object/version quotas also
apply. Repositories can fill with historical or uncommitted objects. Upload
sessions, quota reclamation, history pagination and cloud storage remain pending.
Do not call this production-ready. Live External ID issuance still needs a real
tenant verification; automated sync tests use isolated synthetic identities.
