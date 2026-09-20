import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  unlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initialize, capture } from "../dist/snapshot.js";
import { push, pull } from "../dist/sync.js";
import { TransportError } from "../dist/http.js";
const origin = "https://prj.example",
  repo = randomUUID(),
  signal = new AbortController().signal;
async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "prj-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  return root;
}
function server() {
  let tip = null;
  const versions = new Map(),
    objects = new Map(),
    retries = new Map(),
    uploads = new Map(),
    beginRetries = new Map();
  return {
    loseReply: false,
    deny: false,
    async object(method, repo, hash, bytes) {
      if (this.deny) throw new TransportError("not_found");
      if (method === "PUT") {
        objects.set(hash, Buffer.from(bytes));
        return { hash, bytes: bytes.length };
      }
      return Buffer.from(objects.get(hash));
    },
    async request(method, route, options) {
      if (this.deny) throw new TransportError("not_found");
      if (route.endsWith("/uploads") && method === "POST") {
        const body = options.body;
        if (beginRetries.has(body.retryKey))
          return {
            status: 200,
            data: structuredClone(
              uploads.get(beginRetries.get(body.retryKey)).receipt,
            ),
          };
        if (body.expectedParent !== tip)
          throw new TransportError("conflict", 409);
        const id = randomUUID(),
          receipt = {
            id,
            status: "active",
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            version: null,
          };
        uploads.set(id, { receipt, body });
        beginRetries.set(body.retryKey, id);
        if (this.loseBeginReply) {
          this.loseBeginReply = false;
          throw new TransportError("network");
        }
        return { status: 200, data: structuredClone(receipt) };
      }
      if (route.includes("/uploads/")) {
        const id = route.split("/uploads/")[1].split("/")[0],
          upload = uploads.get(id);
        if (method === "GET")
          return { status: 200, data: structuredClone(upload.receipt) };
        if (upload.receipt.status === "committed")
          return {
            status: 200,
            data: {
              id: upload.receipt.version,
              parent: upload.body.expectedParent,
            },
          };
        const result = await this.request(
          "POST",
          `/api/v1/repositories/${repo}/versions`,
          { body: upload.body },
        );
        upload.receipt.status = "committed";
        upload.receipt.version = result.data.id;
        return result;
      }
      if (method === "POST") {
        const body = options.body;
        if (retries.has(body.retryKey))
          return { status: 200, data: retries.get(body.retryKey) };
        if (body.expectedParent !== tip)
          throw new TransportError("conflict", 409);
        const result = { id: randomUUID(), parent: tip };
        versions.set(result.id, {
          ...result,
          manifest: structuredClone(body.manifest),
        });
        tip = result.id;
        retries.set(body.retryKey, result);
        for (const upload of uploads.values())
          if (upload.body.retryKey === body.retryKey) {
            upload.receipt.status = "committed";
            upload.receipt.version = result.id;
          }
        if (this.loseReply) {
          this.loseReply = false;
          throw new TransportError("network");
        }
        return { status: 200, data: result };
      }
      if (route.endsWith("/tip"))
        return {
          status: 200,
          data: tip
            ? { id: tip, parent: versions.get(tip).parent }
            : { id: null, parent: null },
        };
      return {
        status: 200,
        data: structuredClone(versions.get(route.split("/").at(-1))),
      };
    },
    versions,
    uploads,
  };
}
const state = (root) =>
  readFile(path.join(root, ".prj/remote.json"), "utf8").then(JSON.parse);
test("two workspaces push/pull edits and deletions while preserving unrelated local work", async (t) => {
  const a = await workspace(t),
    b = await workspace(t),
    api = server();
  await writeFile(path.join(a, "note.txt"), "first");
  await push(a, origin, repo, api, signal);
  await pull(b, origin, repo, api, signal);
  assert.equal(await readFile(path.join(b, "note.txt"), "utf8"), "first");
  await writeFile(path.join(b, "local.txt"), "keep");
  await writeFile(path.join(a, "note.txt"), "second");
  await push(a, origin, repo, api, signal);
  await pull(b, origin, repo, api, signal);
  assert.equal(await readFile(path.join(b, "note.txt"), "utf8"), "second");
  assert.equal(await readFile(path.join(b, "local.txt"), "utf8"), "keep");
  await unlink(path.join(a, "note.txt"));
  await push(a, origin, repo, api, signal);
  await pull(b, origin, repo, api, signal);
  await assert.rejects(readFile(path.join(b, "note.txt")));
  assert.equal(await readFile(path.join(b, "local.txt"), "utf8"), "keep");
});
test("lost commit response retries the original snapshot once and preserves later local edits", async (t) => {
  const root = await workspace(t),
    api = server();
  await writeFile(path.join(root, "note"), "original");
  api.loseReply = true;
  await assert.rejects(push(root, origin, repo, api, signal));
  assert.ok((await state(root)).pendingPush);
  await writeFile(path.join(root, "note"), "later");
  await push(root, origin, repo, api, signal);
  assert.equal(api.versions.size, 1);
  assert.equal(await readFile(path.join(root, "note"), "utf8"), "later");
  assert.equal((await state(root)).pendingPush, undefined);
  await push(root, origin, repo, api, signal);
  assert.equal(api.versions.size, 2);
});
test("local capture never becomes a false remote baseline; conflict preserves files and remote base", async (t) => {
  const a = await workspace(t),
    b = await workspace(t),
    api = server();
  await writeFile(path.join(a, "note"), "base");
  await push(a, origin, repo, api, signal);
  await pull(b, origin, repo, api, signal);
  const before = await state(b);
  await writeFile(path.join(b, "note"), "local edit");
  await capture(b);
  await writeFile(path.join(a, "note"), "remote edit");
  await push(a, origin, repo, api, signal);
  await assert.rejects(pull(b, origin, repo, api, signal), /conflict/);
  assert.equal(await readFile(path.join(b, "note"), "utf8"), "local edit");
  assert.equal((await state(b)).baseVersion, before.baseVersion);
  api.deny = true;
  await assert.rejects(pull(b, origin, repo, api, signal));
  assert.equal(await readFile(path.join(b, "note"), "utf8"), "local edit");
  api.deny = false;
  await writeFile(path.join(b, "note"), "base");
  await pull(b, origin, repo, api, signal);
  assert.equal(await readFile(path.join(b, "note"), "utf8"), "remote edit");
});
test("stale push leaves base unchanged and permits pull; mismatched remote is rejected", async (t) => {
  const a = await workspace(t),
    b = await workspace(t),
    api = server();
  await push(a, origin, repo, api, signal);
  await pull(b, origin, repo, api, signal);
  const before = await state(b);
  await push(a, origin, repo, api, signal);
  await assert.rejects(
    push(b, origin, repo, api, signal),
    (e) => e.code === "conflict",
  );
  assert.equal((await state(b)).baseVersion, before.baseVersion);
  assert.equal((await state(b)).pendingPush, undefined);
  await pull(b, origin, repo, api, signal);
  await assert.rejects(
    pull(b, "https://other.example", repo, api, signal),
    /mismatched/,
  );
});

test("clone requires a new safe destination and preserves existing files", async (t) => {
  const { clone } = await import("../dist/sync.js");
  const a = await workspace(t),
    api = server();
  await writeFile(path.join(a, "note"), "shared");
  await push(a, origin, repo, api, signal);
  const parent = await realpath(
    await mkdtemp(path.join(tmpdir(), "prj-clone-")),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const destination = path.join(parent, "new");
  await clone(destination, origin, repo, api, signal);
  assert.equal(
    await readFile(path.join(destination, "note"), "utf8"),
    "shared",
  );
  await assert.rejects(clone(destination, origin, repo, api, signal));
  assert.equal(
    await readFile(path.join(destination, "note"), "utf8"),
    "shared",
  );
});
test("corrupt downloads and cancellation never mutate working files or advance remote base", async (t) => {
  const a = await workspace(t),
    b = await workspace(t),
    api = server();
  await writeFile(path.join(a, "note"), "base");
  await push(a, origin, repo, api, signal);
  await pull(b, origin, repo, api, signal);
  const before = await state(b);
  await writeFile(path.join(a, "note"), "next");
  await push(a, origin, repo, api, signal);
  const original = api.object;
  api.object = async () => Buffer.from("corrupt");
  await assert.rejects(pull(b, origin, repo, api, signal), /integrity/);
  api.object = original;
  assert.equal(await readFile(path.join(b, "note"), "utf8"), "base");
  assert.deepEqual(await state(b), before);
  await assert.rejects(pull(b, origin, repo, api, AbortSignal.abort()));
  assert.equal(await readFile(path.join(b, "note"), "utf8"), "base");
  assert.equal((await state(b)).baseVersion, before.baseVersion);
  await pull(b, origin, repo, api, signal);
  assert.equal(await readFile(path.join(b, "note"), "utf8"), "next");
});

test("interrupted remote adoption recovers even when local HEAD differs from remote base", async (t) => {
  const { withSync, recover } = await import("../dist/snapshot.js"),
    { createHash } = await import("node:crypto");
  const root = await workspace(t);
  await writeFile(path.join(root, "note"), "base");
  const base = await capture(root);
  await writeFile(path.join(root, "local"), "keep");
  const local = await capture(root);
  const bytes = Buffer.from("remote"),
    hash = createHash("sha256").update(bytes).digest("hex");
  await assert.rejects(
    withSync(root, async (project) => {
      const target = await project.stage(
        {
          version: 1,
          entries: [{ path: "note", hash, size: bytes.length, kind: "file" }],
        },
        async () => bytes,
      );
      await project.adopt(target, base.id, async () => {
        await writeFile(path.join(root, "note"), "external interference");
        throw new Error("injected");
      });
    }),
    /needs recovery/,
  );
  assert.equal(
    (await readFile(path.join(root, ".prj/HEAD"), "utf8")).trim(),
    local.id,
  );
  await writeFile(path.join(root, "note"), "remote");
  await recover(root);
  assert.equal(await readFile(path.join(root, "note"), "utf8"), "base");
  assert.equal(await readFile(path.join(root, "local"), "utf8"), "keep");
});

test("lost begin reply reuses one reservation and the original saved snapshot", async (t) => {
  const root = await workspace(t),
    api = server();
  await writeFile(path.join(root, "note"), "original");
  api.loseBeginReply = true;
  await assert.rejects(push(root, origin, repo, api, signal));
  const saved = (await state(root)).pendingPush;
  assert.equal(saved.protocol, "sessions");
  assert.equal(saved.session, undefined);
  await writeFile(path.join(root, "note"), "later");
  await push(root, origin, repo, api, signal);
  assert.equal(api.uploads.size, 1);
  assert.equal(api.versions.size, 1);
  assert.equal(await readFile(path.join(root, "note"), "utf8"), "later");
});
test("confirmed expiry rotates the retry key without changing snapshot or remote base", async (t) => {
  const root = await workspace(t),
    api = server();
  await writeFile(path.join(root, "note"), "saved");
  const object = api.object;
  api.object = async () => {
    throw new TransportError("network");
  };
  await assert.rejects(push(root, origin, repo, api, signal));
  const saved = (await state(root)).pendingPush;
  api.uploads.get(saved.session).receipt.status = "expired";
  api.object = object;
  await assert.rejects(push(root, origin, repo, api, signal), /session closed/);
  const reset = await state(root);
  assert.equal(reset.baseVersion, null);
  assert.equal(reset.pendingPush.snapshot, saved.snapshot);
  assert.notEqual(reset.pendingPush.retryKey, saved.retryKey);
  assert.equal(reset.pendingPush.session, undefined);
  await push(root, origin, repo, api, signal);
  assert.equal(api.versions.size, 1);
});
test("a closed-session object conflict keeps the unknown commit outcome recoverable", async (t) => {
  const root = await workspace(t),
    api = server();
  await writeFile(path.join(root, "note"), "saved");
  const object = api.object;
  api.object = async () => {
    throw new TransportError("conflict", 409);
  };
  await assert.rejects(push(root, origin, repo, api, signal));
  assert.ok((await state(root)).pendingPush.session);
  api.object = object;
  await push(root, origin, repo, api, signal);
  assert.equal(api.versions.size, 1);
});
test("pre-session pending pushes retain their original legacy retry key", async (t) => {
  const root = await workspace(t),
    api = server();
  await writeFile(path.join(root, "note"), "legacy");
  const snapshot = await capture(root),
    retryKey = randomUUID();
  await writeFile(
    path.join(root, ".prj/remote.json"),
    JSON.stringify({
      version: 1,
      origin,
      repository: repo,
      baseVersion: null,
      baseSnapshot: null,
      pendingPush: { snapshot: snapshot.id, retryKey, parent: null },
    }),
  );
  api.loseReply = true;
  await assert.rejects(push(root, origin, repo, api, signal));
  assert.equal((await state(root)).pendingPush.retryKey, retryKey);
  await push(root, origin, repo, api, signal);
  assert.equal(api.uploads.size, 0);
  assert.equal(api.versions.size, 1);
});
