import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
  link,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  initialize,
  capture,
  status,
  exportSnapshot,
  safePath,
  validateSnapshot,
} from "../dist/snapshot.js";
import { local } from "../dist/local.js";
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "prj-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  await mkdir(root);
  await initialize(root);
  return { dir, root };
}
const hash = (content) => createHash("sha256").update(content).digest("hex");
test("captures code and curated context; excludes secrets and tool trust settings", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, ".prjcontext", "memory"), { recursive: true });
  await mkdir(path.join(root, ".claude"));
  await writeFile(path.join(root, "README.md"), "hello");
  await writeFile(path.join(root, "AGENTS.md"), "instructions");
  await writeFile(
    path.join(root, ".prjcontext", "memory", "decisions.md"),
    "memory",
  );
  await writeFile(path.join(root, ".env"), "secret");
  await writeFile(path.join(root, ".env.example"), "EXAMPLE=");
  await writeFile(
    path.join(root, ".claude", "settings.json"),
    "untrusted hooks",
  );
  const snapshot = await capture(root);
  assert.deepEqual(
    snapshot.entries.map((e) => e.path),
    [
      ".env.example",
      ".prjcontext/memory/decisions.md",
      "AGENTS.md",
      "README.md",
    ],
  );
  assert.equal(snapshot.entries[1].kind, "memory");
  assert.equal(snapshot.entries[2].kind, "instruction");
  assert.deepEqual(await status(root), {
    head: snapshot.id,
    added: [],
    modified: [],
    deleted: [],
    context: [],
  });
});
test("respects nested ignore rules and explicit child exceptions", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, ".gitignore"), "*.log\n");
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", ".gitignore"), "!keep.log\n");
  await writeFile(path.join(root, "nested", "keep.log"), "keep");
  await writeFile(path.join(root, "nested", "skip.log"), "skip");
  await writeFile(path.join(root, ".prjignore"), "excluded.txt\n");
  await writeFile(path.join(root, "excluded.txt"), "skip");
  const snapshot = await capture(root);
  assert.ok(snapshot.entries.some((e) => e.path === "nested/keep.log"));
  assert.ok(
    !snapshot.entries.some(
      (e) => e.path.endsWith("skip.log") || e.path === "excluded.txt",
    ),
  );
});
test("status detects additions, edits and deletions without advancing baseline", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "old.txt"), "original");
  await writeFile(path.join(root, "gone.txt"), "gone");
  const before = await capture(root);
  await writeFile(path.join(root, "old.txt"), "edited");
  await rm(path.join(root, "gone.txt"));
  await writeFile(path.join(root, "new.txt"), "new");
  assert.deepEqual(await status(root), {
    head: before.id,
    added: ["new.txt"],
    modified: ["old.txt"],
    deleted: ["gone.txt"],
    context: [],
  });
  assert.equal(
    (await readFile(path.join(root, ".prj", "HEAD"), "utf8")).trim(),
    before.id,
  );
});
test("exports exact bytes into a new directory, refusing existing work", async (t) => {
  const { root, dir } = await fixture(t);
  await mkdir(path.join(root, "src"));
  const content = Buffer.from([0, 1, 255, 128]);
  await writeFile(path.join(root, "src", "binary.bin"), content);
  const snapshot = await capture(root);
  const destination = path.join(dir, "export");
  assert.equal(await exportSnapshot(root, snapshot.id, destination), 1);
  assert.deepEqual(
    await readFile(path.join(destination, "src", "binary.bin")),
    content,
  );
  await writeFile(path.join(destination, "private.txt"), "local");
  await assert.rejects(
    exportSnapshot(root, snapshot.id, destination),
    /new directory/,
  );
  assert.equal(
    await readFile(path.join(destination, "private.txt"), "utf8"),
    "local",
  );
});
test("rejects traversal, Windows streams/reserved names and metadata overwrite", () => {
  for (const name of [
    "../escape",
    "/absolute",
    "a/../../escape",
    "a\\..\\b",
    "C:/escape",
    "x:stream",
    ".prj/HEAD",
    ".git/config",
    "CON",
    "aux.txt",
    "folder/NUL",
    "a//b",
    "a/.",
    "a/..",
    "trailing.",
    "trailing ",
    "a\0b",
  ])
    assert.throws(() => safePath(name), /Unsafe/);
  assert.equal(safePath("src/normal.ts"), "src/normal.ts");
});
test("rejects case collisions, ancestor file collisions and invalid metadata", () => {
  const entry = { path: "file", hash: "a".repeat(64), size: 1, kind: "file" };
  for (const entries of [
    [entry, { ...entry, path: "FILE" }],
    [entry, { ...entry, path: "file/child" }],
    [{ ...entry, size: -1 }],
    [{ ...entry, hash: "bad" }],
    [{ ...entry, kind: "hook" }],
  ])
    assert.throws(() => validateSnapshot({ version: 1, entries }));
});
test("corrupt objects abort before destination creation and leave HEAD unchanged", async (t) => {
  const { root, dir } = await fixture(t);
  await writeFile(path.join(root, "file.txt"), "safe");
  const snapshot = await capture(root);
  await writeFile(
    path.join(root, ".prj", "objects", snapshot.entries[0].hash),
    "corrupt",
  );
  const dest = path.join(dir, "export");
  await assert.rejects(exportSnapshot(root, snapshot.id, dest), /integrity/);
  await assert.rejects(access(dest));
  assert.equal(
    (await readFile(path.join(root, ".prj", "HEAD"), "utf8")).trim(),
    snapshot.id,
  );
});
test("malicious manifest cannot escape the destination even with a matching digest", async (t) => {
  const { root, dir } = await fixture(t);
  const json = JSON.stringify({
    version: 1,
    entries: [{ path: "../escape", hash: hash("bad"), size: 3, kind: "file" }],
  });
  const id = hash(json);
  await writeFile(path.join(root, ".prj", "snapshots", id + ".json"), json);
  await assert.rejects(
    exportSnapshot(root, id, path.join(dir, "out")),
    /Unsafe/,
  );
  await assert.rejects(access(path.join(dir, "escape")));
});
test("capture and export reject directory symlinks or Windows junctions", async (t) => {
  const { root, dir } = await fixture(t);
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret"), "do not read");
  await writeFile(path.join(root, "safe"), "safe");
  const snapshot = await capture(root);
  await symlink(
    outside,
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(capture(root), /symbolic/);
  assert.equal(
    (await readFile(path.join(root, ".prj", "HEAD"), "utf8")).trim(),
    snapshot.id,
  );
  const alias = path.join(dir, "alias");
  await symlink(
    outside,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    exportSnapshot(root, snapshot.id, path.join(alias, "export")),
    /symbolic/,
  );
  await assert.rejects(access(path.join(outside, "export")));
});
test("linked source files are rejected", async (t) => {
  const { root, dir } = await fixture(t);
  const outside = path.join(dir, "outside.txt");
  await writeFile(outside, "private");
  await link(outside, path.join(root, "hardlink.txt"));
  await assert.rejects(capture(root), /linked/);
});
test("concurrent captures serialize through exclusive lock and preserve valid objects", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "file"), "content");
  const result = await Promise.allSettled([capture(root), capture(root)]);
  assert.ok(result.some((r) => r.status === "fulfilled"));
  const latest = await capture(root);
  assert.equal(latest.entries[0].hash, hash("content"));
  assert.deepEqual((await status(root)).modified, []);
});
test("a lock left by a dead process is cleared; a live process keeps it", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "file"), "content");
  const lock = path.join(root, ".prj", "lock");
  // A pid that cannot exist on this machine: the lock is stale.
  await writeFile(lock, "999999999");
  const captured = await capture(root);
  assert.equal(captured.entries[0].hash, hash("content"));
  assert.equal(await stat(lock).catch(() => null), null, "stale lock removed");
  // Our own pid is alive: the lock is honoured and the message points at recover.
  await writeFile(lock, String(process.pid));
  await assert.rejects(
    capture(root),
    /Another operation is active.*prj recover/,
  );
  await rm(lock);
  // Garbage in the lock is never trusted.
  await writeFile(lock, "not-a-pid");
  await assert.rejects(capture(root), /Another operation is active/);
  await rm(lock);
});
test("symlinked metadata directory never writes outside project", async (t) => {
  const { root, dir } = await fixture(t);
  await rm(path.join(root, ".prj", "objects"), { recursive: true });
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(root, ".prj", "objects"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(capture(root), /symbolic/);
});
test("local commands report real results and reject extra arguments", async (t) => {
  const { root } = await fixture(t);
  assert.equal((await local(["init"], root)).code, 1);
  assert.equal((await local(["snapshot"], root)).code, 0);
  assert.equal((await local(["status"], root)).code, 0);
  assert.equal((await local(["status", "secret-value"], root)).code, 1);
  assert.equal(
    JSON.stringify(await local(["export", "secret-value"], root)).includes(
      "secret-value",
    ),
    false,
  );
});
