import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  initialize,
  capture,
  status,
  restoreSnapshot,
  recover,
} from "../dist/snapshot.js";
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "prj-restore-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  return root;
}
async function snapshots(root) {
  await writeFile(path.join(root, "file.txt"), "old");
  await writeFile(path.join(root, "keep.txt"), "unchanged");
  const first = await capture(root);
  await writeFile(path.join(root, "file.txt"), "new");
  await writeFile(path.join(root, "added.txt"), "newly tracked");
  const second = await capture(root);
  return { first, second };
}
const head = async (root) =>
  (await readFile(path.join(root, ".prj", "HEAD"), "utf8")).trim();
test("three-way restore applies tracked edits and deletions while preserving unrelated work", async (t) => {
  const root = await fixture(t),
    { first } = await snapshots(root);
  await writeFile(path.join(root, "keep.txt"), "local edit");
  await writeFile(path.join(root, "untracked.txt"), "keep me");
  const result = await restoreSnapshot(root, first.id);
  assert.equal(result.changed, 2);
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "old");
  await assert.rejects(access(path.join(root, "added.txt")));
  assert.equal(
    await readFile(path.join(root, "untracked.txt"), "utf8"),
    "keep me",
  );
  assert.equal(
    await readFile(path.join(root, "keep.txt"), "utf8"),
    "local edit",
  );
  assert.equal(await head(root), first.id);
  assert.deepEqual((await status(root)).modified, ["keep.txt"]);
});
test("conflicting local edit rejects entire restore before any deletion", async (t) => {
  const root = await fixture(t),
    { first, second } = await snapshots(root);
  await writeFile(path.join(root, "file.txt"), "local conflict");
  await assert.rejects(restoreSnapshot(root, first.id), /conflicts/);
  assert.equal(
    await readFile(path.join(root, "added.txt"), "utf8"),
    "newly tracked",
  );
  assert.equal(
    await readFile(path.join(root, "file.txt"), "utf8"),
    "local conflict",
  );
  assert.equal(await head(root), second.id);
});
test("edited tracked deletion remains untouched", async (t) => {
  const root = await fixture(t),
    { first, second } = await snapshots(root);
  await writeFile(path.join(root, "added.txt"), "edited");
  await assert.rejects(restoreSnapshot(root, first.id), /conflicts/);
  assert.equal(await readFile(path.join(root, "added.txt"), "utf8"), "edited");
  assert.equal(await head(root), second.id);
});
test("untracked collision blocks incoming addition", async (t) => {
  const root = await fixture(t),
    { first, second } = await snapshots(root);
  await restoreSnapshot(root, first.id);
  await writeFile(path.join(root, "added.txt"), "untracked collision");
  await assert.rejects(restoreSnapshot(root, second.id), /conflicts/);
  assert.equal(
    await readFile(path.join(root, "added.txt"), "utf8"),
    "untracked collision",
  );
  assert.equal(await head(root), first.id);
});
test("injected write failure rolls back earlier writes and does not advance baseline", async (t) => {
  const root = await fixture(t),
    { first, second } = await snapshots(root);
  await assert.rejects(
    restoreSnapshot(root, first.id, async () => {
      throw Error("simulated disk failure");
    }),
    /rolled back/,
  );
  assert.equal(
    await readFile(path.join(root, "added.txt"), "utf8"),
    "newly tracked",
  );
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "new");
  assert.equal(await head(root), second.id);
  assert.equal((await recover(root)).recovered, false);
});
function crash(root, id) {
  const script = `import {restoreSnapshot} from ${JSON.stringify(new URL("../dist/snapshot.js", import.meta.url).href)};await restoreSnapshot(process.argv[1],process.argv[2],async()=>{process.exit(77)});`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, root, id],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 77, result.stderr);
}
test("process crash leaves recoverable journal and prevents false sync", async (t) => {
  const root = await fixture(t),
    { first, second } = await snapshots(root);
  crash(root, first.id);
  assert.equal(await head(root), second.id);
  await assert.rejects(capture(root), /operation|lock/);
  assert.deepEqual(await recover(root), { recovered: true });
  assert.equal(
    await readFile(path.join(root, "added.txt"), "utf8"),
    "newly tracked",
  );
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "new");
  assert.equal(await head(root), second.id);
  assert.deepEqual((await status(root)).modified, []);
});
test("recovery refuses to overwrite edits made after interruption", async (t) => {
  const root = await fixture(t),
    { first, second } = await snapshots(root);
  crash(root, first.id);
  await writeFile(path.join(root, "added.txt"), "new outside edit");
  await assert.rejects(recover(root), /edits made after/);
  assert.equal(
    await readFile(path.join(root, "added.txt"), "utf8"),
    "new outside edit",
  );
  assert.equal(await head(root), second.id);
  await assert.rejects(capture(root), /recovery/);
  await rm(path.join(root, "added.txt"));
  assert.deepEqual(await recover(root), { recovered: true });
  assert.equal(
    await readFile(path.join(root, "added.txt"), "utf8"),
    "newly tracked",
  );
});
test("same already-present incoming bytes do not conflict", async (t) => {
  const root = await fixture(t),
    { first } = await snapshots(root);
  await writeFile(path.join(root, "file.txt"), "old");
  await restoreSnapshot(root, first.id);
  assert.equal(await head(root), first.id);
  assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "old");
});
test("ignored case-variant files cannot be overwritten by restore", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, ".gitignore"), "TARGET.txt\n");
  const first = await capture(root);
  await writeFile(path.join(root, "target.txt"), "incoming");
  const second = await capture(root);
  await restoreSnapshot(root, first.id);
  await writeFile(path.join(root, "TARGET.txt"), "ignored local");
  await assert.rejects(restoreSnapshot(root, second.id), /case-variant/);
  assert.equal(
    await readFile(path.join(root, "TARGET.txt"), "utf8"),
    "ignored local",
  );
  assert.equal(await head(root), first.id);
});
