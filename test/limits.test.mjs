import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initialize,
  capture,
  measure,
  overLimits,
  LimitError,
} from "../dist/snapshot.js";
import { MAX_ENTRIES, MAX_FILE } from "../dist/manifest.js";
import { computeSlug } from "../dist/claude-context.js";
import { reconcile, travelling } from "../dist/context-mirror.js";
import {
  choices,
  selected,
  leaveOut,
  pattern,
  SESSIONS_RULE,
} from "../dist/review.js";
import { formatSync } from "../dist/sync-commands.js";

/** A project folder plus a private Claude home holding one memory file and one session for it. */
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "prj-limits-")));
  const saved = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  });
  const home = path.join(dir, "home"),
    root = path.join(dir, "project");
  await mkdir(root, { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  const claude = path.join(home, ".claude", "projects", computeSlug(root));
  await mkdir(path.join(claude, "memory"), { recursive: true });
  await writeFile(path.join(claude, "memory", "MEMORY.md"), "- plan\n");
  await writeFile(
    path.join(claude, "s1.jsonl"),
    JSON.stringify({ cwd: root, n: 1 }) + "\n",
  );
  await initialize(root);
  return { root };
}
const MEMORY = ".prjcontext/agents/claude-code/memory/MEMORY.md";
const isSession = (e) =>
  e.path.startsWith(".prjcontext/agents/claude-code/sessions/");

test("a broad .prjignore rule leaves tool context in; only a .prjcontext rule takes it out", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "notes.txt"), "kept on this machine only");
  await writeFile(path.join(root, ".prjignore"), "/*\n");
  const broad = await capture(root);
  assert.ok(!broad.entries.some((e) => e.path === "notes.txt"));
  assert.ok(broad.entries.some((e) => e.path === MEMORY));
  assert.ok(broad.entries.some(isSession));
  assert.deepEqual(travelling(broad.entries), {
    memories: 1,
    sessions: 1,
    settings: false,
  });

  await writeFile(path.join(root, ".prjignore"), `/*\n${SESSIONS_RULE}\n`);
  const named = await capture(root);
  assert.ok(named.entries.some((e) => e.path === MEMORY));
  assert.ok(!named.entries.some(isSession));
  // The summary reports what the version carries and says what was left out.
  const [summary] = reconcile(named.context, named.entries);
  assert.equal(summary.sessions, 0);
  assert.equal(summary.memories, 1);
  assert.match(
    summary.warnings.join("\n"),
    /1 session found on this machine is left out by \.prjignore and was not uploaded/,
  );
});

test("push output carries context warnings instead of implying everything travelled", () => {
  const lines = formatSync("push", "https://prjlab.com/a/b", "/x", {
    version: "11111111-1111-4111-8111-111111111111",
    parent: null,
    changes: {
      total: 0,
      files: { added: [], modified: [], deleted: [] },
      context: { added: [], modified: [], deleted: [] },
    },
    context: [
      {
        tool: "claude-code",
        label: "Claude Code",
        memories: 1,
        sessions: 0,
        settings: false,
        warnings: [
          "Claude session abcd1234 is too large to upload and was skipped.",
        ],
      },
    ],
  });
  assert.ok(
    lines.some((l) => /Context: Claude Code: 1 memory, 0 sessions/.test(l)),
  );
  assert.ok(
    lines.some((l) => /warning: Claude session abcd1234 is too large/.test(l)),
  );
});

test("an over-limit folder is refused with the limit and its largest parts named, then fits once parts are left out", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, "many", "deep"), { recursive: true });
  for (let i = 0; i <= MAX_ENTRIES; i++)
    await writeFile(path.join(root, "many", "deep", `f${i}.txt`), "x");
  await mkdir(path.join(root, "media"));
  await writeFile(
    path.join(root, "media", "clip [1].bin"),
    Buffer.alloc(MAX_FILE + 1),
  );
  await writeFile(path.join(root, "keep.txt"), "small");

  const usage = await measure(root);
  assert.equal(usage.files, MAX_ENTRIES + 3);
  assert.equal(usage.sessions, 1);
  assert.equal(usage.oversize.length, 1);
  assert.ok(overLimits(usage));

  await assert.rejects(capture(root), (error) => {
    assert.ok(error instanceof LimitError);
    assert.match(error.message, /entries\s+5,00\d of 5,000\s+\(over\)/);
    assert.match(
      error.message,
      /too large\s+1 file over 25 MiB each, largest media\/clip \[1\]\.bin/,
    );
    assert.match(error.message, /many\/deep\//);
    assert.match(error.message, /\.prjignore/);
    return true;
  });

  const offered = choices(usage);
  assert.ok(offered.some((c) => c.patterns.includes("/many/deep/")));
  const oversize = offered.find((c) => c.key === "o");
  assert.deepEqual(oversize.patterns, ["/media/clip \\[1\\].bin"]);
  // Sessions are offered last: context is the last thing to give up.
  assert.equal(offered.at(-1).key, "s");
  assert.deepEqual(offered.at(-1).patterns, [SESSIONS_RULE]);

  const deep = offered.find((c) => c.patterns.includes("/many/deep/"));
  const picked = selected(`${deep.key}, o nonsense`, offered);
  assert.equal(picked.length, 2);
  assert.equal(await leaveOut(root, picked), 2);
  assert.equal(await leaveOut(root, picked), 0); // already there: nothing duplicated
  const written = await readFile(path.join(root, ".prjignore"), "utf8");
  assert.match(written, /# Left out of PrjLab by choice/);

  const after = await capture(root);
  assert.ok(after.entries.some((e) => e.path === "keep.txt"));
  assert.ok(!after.entries.some((e) => e.path.startsWith("many/")));
  assert.ok(!after.entries.some((e) => e.path.startsWith("media/")));
  assert.ok(after.entries.some(isSession)); // context still travels
});

test("ignore patterns are anchored and escape gitignore metacharacters", () => {
  assert.equal(pattern("JOBS/_scan", true), "/JOBS/_scan/");
  assert.equal(pattern("a*b?[c].txt", false), "/a\\*b\\?\\[c\\].txt");
});
