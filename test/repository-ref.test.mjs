import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseRepositoryRef,
  resolveRepository,
  defaultCloneDirectory,
  linkedRepository,
} from "../dist/repository-ref.js";
import { ProjectError } from "../dist/snapshot.js";
import { TransportError } from "../dist/http.js";
const id = "11111111-1111-4111-8111-111111111111";
const listing = (items, status = 200) => ({
  calls: [],
  async request(method, route, options) {
    this.calls.push([method, route, options?.signal instanceof AbortSignal]);
    if (route.startsWith("/api/v1/repositories/lookup/"))
      return { status: 404, data: {} };
    return { status, data: items };
  },
});
test("references accept an ID or handle/name and reject anything else", () => {
  assert.deepEqual(parseRepositoryRef(id.toUpperCase()), { kind: "id", id });
  assert.deepEqual(parseRepositoryRef("Alice/Field-Notes"), {
    kind: "name",
    handle: "alice",
    slug: "field-notes",
  });
  for (const bad of [
    undefined,
    "",
    "alice",
    "alice/",
    "/notes",
    "a/notes",
    "alice/notes/extra",
    "alice/-notes",
    "1alice/notes",
    "alice/" + "n".repeat(64),
    "../alice/notes",
  ])
    assert.throws(() => parseRepositoryRef(bad), ProjectError, String(bad));
});
test("handle/name resolves against the caller's repository list", async () => {
  const api = listing([
    { id, handle: "alice", slug: "notes", role: "owner" },
    { id: id.replace(/1/g, "2"), handle: "bob", slug: "notes", role: "reader" },
  ]);
  const signal = new AbortController().signal;
  assert.equal(
    await resolveRepository(
      { kind: "name", handle: "bob", slug: "notes" },
      api,
      signal,
    ),
    id.replace(/1/g, "2"),
  );
  assert.deepEqual(api.calls, [["GET", "/api/v1/repositories", true]]);
  assert.equal(await resolveRepository({ kind: "id", id }, api), id);
  assert.equal(api.calls.length, 1, "IDs never hit the network");
  await assert.rejects(
    resolveRepository({ kind: "name", handle: "alice", slug: "other" }, api),
    /alice\/other was not found in your repositories and is not public/,
  );
  assert.deepEqual(api.calls.at(-1), [
    "GET",
    "/api/v1/repositories/lookup/alice/other",
    false,
  ]);
  // A public repository that is not in the caller's list resolves via lookup.
  const publicId = id.replace(/1/g, "3");
  const withLookup = {
    calls: [],
    request: async (method, route, options) => {
      withLookup.calls.push([method, route]);
      if (route === "/api/v1/repositories") return { status: 200, data: [] };
      if (route.startsWith("/api/v1/repositories/lookup/"))
        return {
          status: 200,
          data: { id: publicId, handle: "carol", slug: "open", role: "reader" },
        };
      return { status: 404, data: {} };
    },
  };
  assert.equal(
    await resolveRepository(
      { kind: "name", handle: "carol", slug: "open" },
      withLookup,
    ),
    publicId,
  );
  await assert.rejects(
    resolveRepository(
      { kind: "name", handle: "carol", slug: "open" },
      {
        request: async (method, route) =>
          route === "/api/v1/repositories"
            ? { status: 200, data: [] }
            : { status: 200, data: { id: "bad" } },
      },
    ),
    TransportError,
  );
  await assert.rejects(
    resolveRepository(
      { kind: "name", handle: "alice", slug: "notes" },
      {
        request: async () => ({ status: 200, data: { not: "a list" } }),
      },
    ),
    TransportError,
  );
  // A malformed list entry is never trusted; the lookup fallback then sees the
  // same malformed stub and refuses it as an invalid response.
  await assert.rejects(
    resolveRepository(
      { kind: "name", handle: "alice", slug: "notes" },
      {
        request: async () => ({
          status: 200,
          data: [{ id: "bad", handle: "alice", slug: "notes" }],
        }),
      },
    ),
    TransportError,
  );
});
test("clone directory defaults to the repository name", () => {
  assert.equal(
    defaultCloneDirectory({ kind: "name", handle: "alice", slug: "notes" }),
    "notes",
  );
  assert.equal(defaultCloneDirectory({ kind: "id", id }), id);
});
test("push and pull reuse the linked repository of the directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "prj-ref-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    linkedRepository(root, "https://prjlab.com"),
    /no remote yet\. Run prj remote add origin/,
  );
  await mkdir(path.join(root, ".prj"));
  const file = path.join(root, ".prj", "remote.json");
  await writeFile(file, "{not json");
  await assert.rejects(
    linkedRepository(root, "https://prjlab.com"),
    ProjectError,
  );
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      origin: "https://prjlab.com",
      repository: id.toUpperCase(),
      baseVersion: null,
      baseSnapshot: null,
    }),
  );
  assert.equal(await linkedRepository(root, "https://prjlab.com"), id);
  await assert.rejects(
    linkedRepository(root, "https://other.example"),
    /linked to a different server/,
  );
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      origin: "https://prjlab.com",
      repository: "nope",
    }),
  );
  await assert.rejects(
    linkedRepository(root, "https://prjlab.com"),
    ProjectError,
  );
});
