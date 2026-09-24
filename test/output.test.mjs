import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatSync } from "../dist/sync-commands.js";
import { diffSnapshots } from "../dist/sync.js";
import { isNewer, checkForUpdate, updateNotice } from "../dist/update-check.js";
const e = (p, h = "a") => ({
  path: p,
  hash: h.repeat(64),
  size: 1,
  kind: "file",
});
test("push and pull print like git: where, version range, what changed, context", () => {
  const before = {
    version: 1,
    entries: [
      e("README.md"),
      e("old.txt"),
      e(".prjcontext/agents/claude-code/memory/M.md"),
    ],
  };
  const after = {
    version: 1,
    entries: [
      e("README.md", "b"),
      e("new.txt"),
      e(".prjcontext/agents/claude-code/memory/M.md", "c"),
    ],
  };
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes.files, {
    added: ["new.txt"],
    modified: ["README.md"],
    deleted: ["old.txt"],
  });
  assert.deepEqual(changes.context.modified, [
    ".prjcontext/agents/claude-code/memory/M.md",
  ]);
  const ctx = [
    {
      tool: "claude-code",
      label: "Claude Code",
      memories: 1,
      sessions: 2,
      settings: true,
      warnings: [],
    },
  ];
  assert.deepEqual(
    formatSync("push", "https://prjlab.com/ajaize/kibbit", "/x", {
      version: "3fde3e41-aaaa",
      message: "With Claude context",
      parent: "c4f0c873-bbbb",
      changes,
      context: ctx,
    }),
    [
      "To https://prjlab.com/ajaize/kibbit",
      "   c4f0c873..3fde3e41  With Claude context",
      " 3 files changed: 1 added, 1 modified, 1 deleted",
      "   + new.txt",
      "   M README.md",
      "   - old.txt",
      " Context: Claude Code: 1 memory, 2 sessions, project settings (1 file updated)",
    ],
  );
  assert.deepEqual(
    formatSync("push", "W", "/x", {
      version: "v1",
      parent: null,
      changes: diffSnapshots(null, after),
      context: [],
    }).slice(0, 3),
    ["To W", "  * [new version] v1", " 2 files"],
  );
  assert.deepEqual(
    formatSync("push", "W", "/x", { version: "v", upToDate: true }),
    ["Everything up-to-date."],
  );
  assert.deepEqual(
    formatSync("pull", "W", "/x", { version: "v", upToDate: true }),
    ["Already up to date."],
  );
  const many = {
    added: Array.from({ length: 12 }, (_, i) => `f${i}`),
    modified: [],
    deleted: [],
  };
  const lines = formatSync("pull", "W", "/x", {
    version: "b",
    parent: "a",
    changes: {
      files: many,
      context: { added: [], modified: [], deleted: [] },
      total: 12,
    },
  });
  assert.equal(lines.at(-1), "   … and 2 more");
  assert.equal(
    formatSync("clone", "W", "/tmp/kibbit", {
      version: "v",
      parent: null,
      changes: diffSnapshots(null, after),
    })[0],
    "Cloned into 'kibbit'.",
  );
});
test("update notice: newer versions only, cached for a day, off in CI and when piped", async (t) => {
  assert.equal(isNewer("0.6.0", "0.5.0"), true);
  assert.equal(isNewer("0.5.10", "0.5.9"), true);
  assert.equal(isNewer("0.5.0", "0.5.0"), false);
  assert.equal(isNewer("0.4.9", "0.5.0"), false);
  assert.equal(isNewer("1.0.0-beta", "0.5.0"), false);
  const home = await mkdtemp(path.join(tmpdir(), "prj-update-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { ok: true, json: async () => ({ version: "0.6.0" }) };
  };
  const base = { home, tty: true, env: {}, fetcher, now: 1_000_000 };
  assert.equal(await checkForUpdate("0.5.0", base), "0.6.0");
  assert.equal(
    await checkForUpdate("0.5.0", { ...base, now: 1_000_000 + 3600_000 }),
    "0.6.0",
  );
  assert.equal(calls, 1, "cached for a day");
  assert.equal(
    await checkForUpdate("0.5.0", { ...base, now: 1_000_000 + 25 * 3600_000 }),
    "0.6.0",
  );
  assert.equal(calls, 2);
  assert.equal(await checkForUpdate("0.6.0", base), null);
  assert.equal(
    await checkForUpdate("0.5.0", { ...base, env: { CI: "true" } }),
    null,
  );
  assert.equal(
    await checkForUpdate("0.5.0", {
      ...base,
      env: { PRJ_NO_UPDATE_CHECK: "1" },
    }),
    null,
  );
  assert.equal(await checkForUpdate("0.5.0", { ...base, tty: false }), null);
  const offline = {
    ...base,
    now: 9e12,
    fetcher: async () => {
      throw new Error("offline");
    },
  };
  assert.equal(await checkForUpdate("0.5.0", offline), null, "never throws");
  await writeFile(path.join(home, ".prjlab", "update-check.json"), "{bad");
  assert.equal(
    await checkForUpdate("0.5.0", base),
    "0.6.0",
    "corrupt cache is refreshed",
  );
  assert.match(
    JSON.parse(
      await readFile(path.join(home, ".prjlab", "update-check.json"), "utf8"),
    ).latest,
    /0\.6\.0/,
  );
  assert.equal(
    updateNotice("0.5.0", "0.6.0"),
    "\nUpdate available: prj 0.5.0 → 0.6.0\nRun: npm install -g prjlab-cli\n",
  );
});
