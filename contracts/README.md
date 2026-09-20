# PrjLab development API contract

Version: 0.3.0-development. Canonical source: this public CLI repository's
`contracts/` directory. MIT licensed. No private implementation is needed to
consume it; the platform vendors the same files for integration testing.

`openapi.json` uses [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html).
`fixtures.json` contains synthetic examples, not real accounts.
`check.cjs` is a development-only Ajv checker. It is not bundled into the CLI.
`snapshot.schema.json` describes the existing local manifest, not an approved
remote storage format. See [sync proposal](SYNC-PROPOSAL.md) for unimplemented work.

## Implemented endpoints

All routes below use `/api/v1`. Bearer JWT or browser session authentication is
required. Session mutations additionally require exact configured Origin. The
CLI will use bearer credentials; it must not copy a browser's cookie database.
An inaccessible repository returns 404; a member without a required role gets 403.

| Method and path                                      | Success                 | Access                                            |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------- |
| GET /account                                         | 200 account             | authenticated identity; 404 before registration   |
| PUT /account                                         | 200 account             | authenticated identity; same handle is idempotent |
| GET /repositories                                    | 200 array               | own/shared repositories                           |
| POST /repositories                                   | 201 summary             | registered account                                |
| GET /repositories/{id}                               | 200 detail              | owner/writer/reader                               |
| PATCH /repositories/{id}                             | 200 detail              | owner                                             |
| GET /repositories/{id}/access                        | 200 members/invitations | owner                                             |
| POST /repositories/{id}/invitations                  | 201 invitation          | owner                                             |
| DELETE /repositories/{id}/invitations/{invitationId} | 204                     | owner                                             |
| DELETE /repositories/{id}/members/{userId}           | 204                     | owner                                             |
| GET /invitations                                     | 200 array               | intended recipient                                |
| POST /invitations/{id}/accept                        | 200 repositoryId        | intended recipient                                |

Browser authorization redirect endpoints and health endpoints are intentionally
outside this CLI-facing contract. Version commit, tip and immutable manifest reads are defined below.

## Current behavior and limits

- Requests reject unknown fields. Descriptions are optional on create/update;
  missing description currently becomes an empty string, including on PATCH.
- Handles: 3–39 lowercase letters/digits/hyphens, first character a letter.
  Repository slugs: 1–63 characters, first character alphanumeric. Reserved names
  are rejected; identifiers are UUID strings.
- API JSON body limit is 64 KiB. Description validation additionally limits
  JavaScript string length to 500 UTF-16 code units; the schema's 500-character
  bound does not capture that stricter astral-character behavior.
- Repository lists and invitation inboxes return at most 100 items without a
  continuation cursor. This is truncation, not complete pagination. Owner access
  lists currently have no explicit cap. Do not describe list-all as complete.
- Each account currently has a 100-owned-repository ceiling; this is a development
  limit, not a published beta quota or pricing promise.
- Repository details include owner_id; summaries do not. Schemas reject extra
  response fields so newly added database columns cannot silently become a public API.
- HTTP 400/401/403/404/409/413/500/503 are documented. Error messages are for people,
  not stable machine codes. A client must not distinguish handle conflicts, quota
  conflicts or missing accounts by matching English text. Future sync needs codes.
- Binary object PUT/GET uses `/repositories/{id}/objects/{hash}`. PUT accepts raw
  application/octet-stream and returns `{hash, bytes}`; GET returns bytes. SHA-256
  must match the lowercase hash. Owners/writers upload; all members download.
  Development limits are 5 MiB/object, 100 MiB/repository and 1,000 objects.
  Repeated identical uploads are idempotent. No rate-limit policy is implemented.
- Responses are private/no-store. Clients must bound response bytes and time,
  reject redirects carrying credentials, and avoid logging server error bodies.

## Snapshot compatibility

Local format version 1: entries contain path, SHA-256 hash, byte size and kind
(file/instruction/memory/session). Limits: 1,000 entries, 5 MiB per file, 100 MiB
aggregate, and 240 UTF-8 bytes per portable path. Empty files have size zero.

JSON Schema covers shape and per-field limits. It is not the whole validation:
CLI validateSnapshot also enforces total bytes, duplicate/case/ancestor conflicts,
Unicode normalization, portable reserved names, metadata protection and safe paths.
Restore also checks filesystem links and containment. Passing the schema alone
never authorizes a write or makes an imported project safe to execute.

The local snapshot ID hashes its serialized manifest bytes. It is not a global
repository identity or a promised remote version ID. Imported code/instructions
must never execute automatically.

## Updating and vendoring

1. Update schema, fixtures and protocol notes together in the public CLI repo.
2. Run CLI tests and validate changes against actual platform integration responses.
3. Copy the four machine/test files byte-for-byte into the platform's contracts/.
4. Record the public source commit and SHA-256 hashes in the platform vendor record.
5. Run platform route inventory and real database integration tests.
6. Coordinate incompatible changes before releasing either side; this development
   contract is not a declaration of production backward compatibility.

Do not copy private platform plans into this directory. Neither a contract change
nor a green fixture test establishes live identity/storage availability.

## Immutable versions

POST `/repositories/{id}/versions` accepts `{expectedParent, retryKey, manifest}`.
Both IDs are UUIDs; expectedParent is null for an empty repository. It returns
`{id, parent}` with HTTP200 for creation or identical retry. GET `/repositories/{id}/tip`
returns `{id,parent}` (both null initially); GET `/repositories/{id}/versions/{version}`
returns `{id,parent,manifest}`. Owners/writers commit; current members read.

Manifest semantics come from MIT-licensed `src/manifest.ts`, shared by the CLI and
platform. Normalized manifest limit:60KiB; enclosing request:64KiB; maximum1000
versions per repository (development limits). Encrypted manifests are separate
from file-object quota. Retry keys are scoped to actor/repository and retained
for version lifetime. Changed replay data conflicts; revocation precedes replay.
A stale expected parent returns409 tip_conflict. Incomplete references return409
incomplete_upload. History pagination, upload sessions and full CLI sync remain
unimplemented. No public visibility or production storage promise is implied.
