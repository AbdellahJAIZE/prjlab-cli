import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initialize } from "../dist/snapshot.js";
import { addRemote, removeRemote, showRemote } from "../dist/sync.js";
import { linkedRepository } from "../dist/repository-ref.js";
import { linkedArguments, repositoryArgument } from "../dist/sync-commands.js";
const origin = "https://prjlab.com";
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), "prj-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initialize(root);
  return root;
}
test("remote add links like git remote add, and push then needs no name", async (t) => {
  const root = await project(t);
  assert.equal(await showRemote(root), null);
  assert.equal(await addRemote(root, origin, id, "ajaize/kibbit"), "added");
  assert.equal(await linkedRepository(root, origin), id);
  assert.deepEqual(await showRemote(root), {
    origin,
    repository: id,
    name: "ajaize/kibbit",
  });
  assert.equal(await addRemote(root, origin, id, "ajaize/kibbit"), "unchanged");
  await assert.rejects(
    addRemote(root, origin, other, "ajaize/other"),
    /already exists/,
  );
  const link = JSON.parse(
    await readFile(path.join(root, ".prj", "remote.json"), "utf8"),
  );
  assert.deepEqual(link, {
    version: 1,
    origin,
    repository: id,
    baseVersion: null,
    baseSnapshot: null,
  });
});
test("remote remove forgets the link but refuses mid-push", async (t) => {
  const root = await project(t);
  assert.equal(await removeRemote(root), false);
  await addRemote(root, origin, id, null);
  assert.equal((await showRemote(root)).name, null);
  const file = path.join(root, ".prj", "remote.json");
  const link = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...link,
      pendingPush: { snapshot: "a".repeat(64), retryKey: other, parent: null },
    }),
  );
  await assert.rejects(removeRemote(root), /unfinished/);
  await writeFile(file, JSON.stringify(link));
  assert.equal(await removeRemote(root), true);
  assert.equal(await showRemote(root), null);
  await assert.rejects(linkedRepository(root, origin), /no remote yet/);
});
test("an uninitialized folder says to run prj init", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "prj-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(addRemote(root, origin, id, null), /Run prj init first/);
});
test("git habits map to the linked repository", () => {
  for (const args of [
    [],
    ["origin"],
    ["."],
    ["origin", "main"],
    ["-u", "origin", "main"],
    ["--set-upstream", "origin", "master"],
  ])
    assert.deepEqual(linkedArguments(args), [], args.join(" "));
  assert.deepEqual(linkedArguments(["alice/notes"]), ["alice/notes"]);
  assert.throws(() => linkedArguments(["origin", "dev"]), /no branches/);
});
test("repository page links work in place of handle/name", () => {
  assert.equal(repositoryArgument("alice/notes", origin), "alice/notes");
  assert.equal(
    repositoryArgument("https://prjlab.com/alice/notes", origin),
    "alice/notes",
  );
  assert.equal(
    repositoryArgument("https://prjlab.com/alice/notes.git", origin),
    "alice/notes",
  );
  assert.equal(
    repositoryArgument("https://prjlab.com/alice/notes/", origin),
    "alice/notes",
  );
  assert.throws(
    () => repositoryArgument("https://evil.example/alice/notes", origin),
    /not on https:\/\/prjlab\.com/,
  );
  assert.throws(
    () => repositoryArgument("https://prjlab.com/alice/notes/tree/x", origin),
    /repository page link/,
  );
  assert.throws(
    () => repositoryArgument("https://prjlab.com/alice/notes?x=1", origin),
    /repository page link/,
  );
});
