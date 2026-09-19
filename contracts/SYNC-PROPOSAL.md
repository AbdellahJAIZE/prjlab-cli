# Remote sync proposal — not implemented

These are proposed semantics for the first private sync API. They do not add
routes to the implemented OpenAPI contract. Hosted encryption was selected on 2026-09-19. Quotas and public visibility remain
product decisions; do not upload real content based on this draft.

## Identity and state

Repository identity is a server UUID stored with the server origin in the local
link. It never depends on a folder name or absolute path. Proposed server version
IDs are UUIDs, independent of local snapshot hashes. Each version records its
repository, parent and accepted object/manifest references. Versions are immutable.

Start with one main tip. Branching and merge APIs are outside this first contract.
Every commit supplies `expectedParent: <version UUID> | null`; null means an empty
repository. The server atomically checks the current tip before committing. A stale
writer receives 409 and the current tip only if still authorized. It cannot force
an overwrite silently. The CLI preserves its actual base until adoption succeeds.

## Proposed operations

1. Read the repository tip and a bounded page of immutable version metadata.
2. Begin an upload with expected parent, declared object count/bytes and a random
   idempotency key. Validate access and reserve quota before accepting bytes.
3. Upload required objects into that repository's upload session. Check length and
   digest, keep incomplete objects invisible, and accept identical retries.
4. Commit the manifest only when every reference is present and valid. Recheck
   membership, session expiry, reservation and expected parent in one transaction.
5. Download a committed manifest and its objects through current access checks.
6. Expire abandoned sessions and release reservations; clean unreferenced objects
   without deleting objects referenced by any committed version.

Object identifiers refer to the uploaded bytes. For the selected hosted model,
files and manifests are readable by the authorized platform, sent over TLS and
protected by hosted encryption at rest. Object digests refer to file bytes, not
ciphertext. Do not expose cross-account content existence through global dedup
or missing-object queries. Concrete storage/key configuration remains to implement.

## Retries and concurrency

Scope idempotency to authenticated actor, repository and operation. Reusing a key
with different request bytes returns 409. A successful replay returns the original
result after rechecking current access; revocation takes precedence over replay.
Concurrent identical calls must create one reservation/version, not two. Persist
request digest and result transactionally. Retention/expiry needs an explicit
configured duration before implementation; do not claim a fixed duration yet.

Upload publication uses unique temporary objects and atomic immutable completion.
A commit cannot reference missing or partially uploaded objects. Concurrent
commits to one parent yield one successful tip advance and one conflict.

## Proposed error codes

Add stable codes alongside human messages when implementing sync. Existing
account endpoints currently do not supply these codes.

| HTTP | Proposed code                      | Client action                                    |
| ---- | ---------------------------------- | ------------------------------------------------ |
| 400  | invalid_manifest / invalid_request | correct local data; no blind retry               |
| 401  | authentication_required            | refresh/login; never retry indefinitely          |
| 403  | insufficient_permission            | stop; explain required access                    |
| 404  | account_required                   | complete registration (account endpoint only)    |
| 404  | resource_not_found                 | do not reveal inaccessible resource existence    |
| 409  | tip_conflict                       | fetch and reconcile; preserve local base         |
| 409  | idempotency_conflict               | do not reuse the key for different bytes         |
| 409  | incomplete_upload                  | upload missing objects; no version committed     |
| 410  | upload_expired                     | start a new bounded upload session               |
| 413  | payload_too_large                  | split/reduce within documented limits            |
| 429  | quota_exceeded / rate_limited      | respect bounded Retry-After when supplied        |
| 503  | service_unavailable                | bounded backoff; only retry safe/idempotent work |

## Limits and pagination

Publish exact manifest-byte, object-byte, object-count and aggregate-byte limits
before remote enablement. Local snapshot limits are a compatibility starting point,
not the final server quota. Enforce limits while streaming, not after buffering.
Reject declared/actual length mismatches and decompression expansion if compression
is ever supported. The first format need not support compressed uploads.

Version lists should use bounded pages and opaque cursors, with stable ordering
and repository-scoped cursors. Proposed maximum is 100 items per page. Validate
cursors; never embed private paths or credentials. Existing account lists need a
separate compatible pagination change before claiming complete enumeration.

## Required acceptance evidence

- Owner/writer push; reader reads but cannot push; stranger cannot infer objects.
- Revocation during upload/commit/download prevents subsequent authorized actions.
- Identical concurrent uploads succeed with byte-identical stored content.
- Duplicate commits consume quota once; changed replay requests are rejected.
- Stale writers cannot move the tip; no partial manifest is visible.
- Two-machine clone/edit/push/pull preserves edits, deletions and a truthful base.
- Corrupt/oversized objects and malicious paths fail before workspace mutation.
- Cancellation and crashes leave either committed state or recoverable staging.
