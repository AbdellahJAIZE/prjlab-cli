import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  computeSlug,
  resolveProjectDir,
  portable,
  localize,
  segment,
  completeLines,
  captureClaude,
  restoreClaude,
  SEGMENT_BYTES,
  ROOT_TOKEN,
  DIR_TOKEN,
} from "../dist/claude-context.js";

async function machine(t) {
  const home = await mkdtemp(path.join(tmpdir(), "prj-claude-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const layout = {
    dir: path.join(home, ".claude"),
    config: path.join(home, ".claude.json"),
    backups: path.join(home, ".prjlab", "backups"),
  };
  return { home, layout };
}
const line = (o) => JSON.stringify(o) + "\n";

test("slug rule, existing directory wins, underscore alternative found, computed fallback", async (t) => {
  const { layout } = await machine(t);
  assert.equal(computeSlug("/home/a/my project.v2"), "-home-a-my-project-v2");
  assert.equal(computeSlug("C:\\Users\\a\\proj"), "C--Users-a-proj");
  const projects = path.join(layout.dir, "projects");
  await mkdir(path.join(projects, "-home-a-under_score"), { recursive: true });
  assert.deepEqual(await resolveProjectDir(layout, "/home/a/under_score"), {
    dir: path.join(projects, "-home-a-under_score"),
    found: true,
  });
  await mkdir(path.join(projects, "-home-a-plain"), { recursive: true });
  assert.equal((await resolveProjectDir(layout, "/home/a/plain")).found, true);
  const missing = await resolveProjectDir(layout, "/home/a/new");
  assert.deepEqual(missing, {
    dir: path.join(projects, "-home-a-new"),
    found: false,
  });
});

test("paths become placeholders at boundaries only and come back per machine", () => {
  const text = `{"cwd":"/home/a/proj","f":"/home/a/proj/src/x.ts","other":"/home/a/proj2","dir":"/h/.claude/projects/-home-a-proj/t.txt"}`;
  const out = portable(
    text,
    "/home/a/proj",
    "/h/.claude/projects/-home-a-proj",
  );
  assert.equal(
    out,
    `{"cwd":"${ROOT_TOKEN}","f":"${ROOT_TOKEN}/src/x.ts","other":"/home/a/proj2","dir":"${DIR_TOKEN}/t.txt"}`,
  );
  assert.equal(
    localize(out, "/srv/b/proj", "/b/.claude/projects/-srv-b-proj", true),
    `{"cwd":"/srv/b/proj","f":"/srv/b/proj/src/x.ts","other":"/home/a/proj2","dir":"/b/.claude/projects/-srv-b-proj/t.txt"}`,
  );
  // Windows: JSON doubles backslashes, both spellings are recognised.
  const win = portable(
    `{"cwd":"C:\\\\Users\\\\a\\\\p"} C:\\Users\\a\\p`,
    "C:\\Users\\a\\p",
    "X",
  );
  assert.equal(win, `{"cwd":"${ROOT_TOKEN}"} ${ROOT_TOKEN}`);
  assert.equal(
    localize(`{"cwd":"${ROOT_TOKEN}"}`, "D:\\w", "X", true),
    `{"cwd":"D:\\\\w"}`,
  );
});

test("segments are deterministic and an append changes only the last one", () => {
  const big = Buffer.from(
    Array.from({ length: 3000 }, (_, i) =>
      line({ i, pad: "x".repeat(900) }),
    ).join(""),
  );
  const first = segment(big);
  assert.ok(first.length >= 2);
  assert.ok(first.every((p) => p[p.length - 1] === 0x0a));
  assert.ok(first.slice(0, -1).every((p) => p.length >= SEGMENT_BYTES));
  assert.deepEqual(Buffer.concat(first), big);
  const grown = segment(Buffer.concat([big, Buffer.from(line({ more: 1 }))]));
  for (let i = 0; i < first.length - 1; i++)
    assert.ok(grown[i].equals(first[i]));
  assert.equal(
    completeLines(Buffer.from('{"a":1}\n{"b":')).toString(),
    '{"a":1}\n',
  );
});

async function seed(layout, root) {
  const dir = path.join(layout.dir, "projects", computeSlug(root));
  await mkdir(path.join(dir, "memory"), { recursive: true });
  await writeFile(path.join(dir, "memory", "MEMORY.md"), "- [Plan](plan.md)\n");
  await writeFile(path.join(dir, "memory", "plan.md"), "Ship it.\n");
  await writeFile(
    path.join(dir, "s1.jsonl"),
    line({ type: "user", cwd: root, text: `open ${root}/a.ts` }) +
      line({ type: "assistant", cwd: root }) +
      '{"type":"partial', // still being written
  );
  await mkdir(path.join(dir, "s1", "subagents"), { recursive: true });
  await writeFile(
    path.join(dir, "s1", "subagents", "agent-x.jsonl"),
    line({ cwd: root }),
  );
  await writeFile(
    path.join(dir, "s1", "custom-title.json"),
    '{"title":"Plan"}',
  );
  await writeFile(
    layout.config,
    JSON.stringify({
      userID: "secret-machine-id",
      projects: {
        [root]: {
          allowedTools: ["Bash(npm test)"],
          hasTrustDialogAccepted: true,
          mcpServers: { local: { command: `${root}/bin/mcp` } },
          lastCost: 12.5,
          lastSessionId: "s1",
        },
        "/elsewhere": { allowedTools: ["X"] },
      },
    }),
  );
  return dir;
}

test("capture: memory, segmented sessions with side files, portable settings only", async (t) => {
  const { layout } = await machine(t);
  const root = "/home/a/kibbit";
  await seed(layout, root);
  const captured = await captureClaude(root, { sessions: true }, layout);
  assert.deepEqual([...captured.files.keys()].sort(), [
    "memory/MEMORY.md",
    "memory/plan.md",
    "project.json",
    "sessions/s1/files/custom-title.json.gz",
    "sessions/s1/files/subagents/agent-x.jsonl.gz",
    "sessions/s1/transcript.0000.jsonl.gz",
  ]);
  assert.equal(captured.memories, 2);
  assert.equal(captured.sessions, 1);
  assert.equal(captured.config, true);
  const transcript = gunzipSync(
    captured.files.get("sessions/s1/transcript.0000.jsonl.gz"),
  ).toString();
  assert.ok(!transcript.includes(root), "no machine path uploaded");
  assert.ok(!transcript.includes("partial"), "incomplete last line dropped");
  assert.equal(transcript.split("\n").filter(Boolean).length, 2);
  const settings = JSON.parse(captured.files.get("project.json").toString());
  assert.deepEqual(Object.keys(settings.config).sort(), [
    "allowedTools",
    "hasTrustDialogAccepted",
    "mcpServers",
  ]);
  assert.equal(
    settings.config.mcpServers.local.command,
    `${ROOT_TOKEN}/bin/mcp`,
  );
  assert.ok(
    !captured.files
      .get("project.json")
      .toString()
      .includes("secret-machine-id"),
  );
  const noSessions = await captureClaude(root, { sessions: false }, layout);
  assert.deepEqual([...noSessions.files.keys()].sort(), [
    "memory/MEMORY.md",
    "memory/plan.md",
    "project.json",
  ]);
  assert.equal(
    await captureClaude("/home/a/unknown", { sessions: true }, layout),
    null,
  );
});

test("a corrupt ~/.claude.json is reported, never guessed", async (t) => {
  const { layout } = await machine(t);
  const root = "/home/a/p";
  await seed(layout, root);
  await writeFile(layout.config, "{not json");
  const captured = await captureClaude(root, { sessions: false }, layout);
  assert.equal(captured.config, false);
  assert.match(captured.warnings[0], /not valid JSON/);
});

test("restore on another machine and path: re-keyed history, localized paths, merged settings with backup", async (t) => {
  const a = await machine(t),
    b = await machine(t);
  const rootA = "/home/a/kibbit",
    rootB = "/srv/b/work/kibbit";
  await seed(a.layout, rootA);
  const captured = await captureClaude(rootA, { sessions: true }, a.layout);
  await writeFile(
    b.layout.config,
    JSON.stringify({
      projects: { [rootB]: { allowedTools: ["Local"], lastCost: 1 } },
    }),
  );
  const report = await restoreClaude(
    rootB,
    captured.files,
    new Map(),
    b.layout,
  );
  assert.equal(report.memoryWritten, 2);
  assert.equal(report.sessionsWritten, 1);
  assert.equal(report.config, "merged");
  const dirB = path.join(b.layout.dir, "projects", computeSlug(rootB));
  assert.equal(
    await readFile(path.join(dirB, "memory", "plan.md"), "utf8"),
    "Ship it.\n",
  );
  const transcript = await readFile(path.join(dirB, "s1.jsonl"), "utf8");
  assert.equal(JSON.parse(transcript.split("\n")[0]).cwd, rootB);
  assert.equal(
    JSON.parse(transcript.split("\n")[0]).text,
    `open ${rootB}/a.ts`,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(dirB, "s1", "subagents", "agent-x.jsonl"),
        "utf8",
      ),
    ).cwd,
    rootB,
  );
  const config = JSON.parse(await readFile(b.layout.config, "utf8"));
  assert.deepEqual(
    config.projects[rootB].allowedTools,
    ["Local"],
    "local values win",
  );
  assert.equal(config.projects[rootB].hasTrustDialogAccepted, true);
  assert.equal(
    config.projects[rootB].mcpServers.local.command,
    `${rootB}/bin/mcp`,
  );
  assert.equal(config.projects[rootB].lastCost, 1);
  assert.equal(config.userID, undefined);
  assert.equal(
    (await readdir(b.layout.backups)).length,
    1,
    "backup before write",
  );
  // Idempotent: a second restore changes nothing.
  const again = await restoreClaude(
    rootB,
    captured.files,
    captured.files,
    b.layout,
  );
  assert.equal(again.memoryWritten + again.sessionsWritten, 0);
  assert.equal(again.config, "unchanged");
  // No Claude on the machine: history is written, no config is created.
  const c = await machine(t);
  const bare = await restoreClaude("/x/y", captured.files, new Map(), c.layout);
  assert.equal(bare.config, "no-claude");
  await assert.rejects(readFile(c.layout.config));
});

test("local work wins: edited memory kept, untouched memory updated, deletions only when unchanged; sessions never rewind", async (t) => {
  const { layout } = await machine(t);
  const root = "/home/a/p";
  const dir = await seed(layout, root);
  const base = (await captureClaude(root, { sessions: true }, layout)).files;
  // Remote changed plan.md and MEMORY.md, and deleted nothing.
  const incoming = new Map(base);
  incoming.set("memory/plan.md", Buffer.from("Ship it on Friday.\n"));
  incoming.set(
    "memory/MEMORY.md",
    Buffer.from("- [Plan](plan.md) — updated\n"),
  );
  // Locally, MEMORY.md was edited too.
  await writeFile(path.join(dir, "memory", "MEMORY.md"), "- local edit\n");
  let report = await restoreClaude(root, incoming, base, layout);
  assert.equal(
    await readFile(path.join(dir, "memory", "plan.md"), "utf8"),
    "Ship it on Friday.\n",
  );
  assert.equal(
    await readFile(path.join(dir, "memory", "MEMORY.md"), "utf8"),
    "- local edit\n",
  );
  assert.deepEqual(report.memoryKept, ["MEMORY.md"]);
  // Remote deletion of an unchanged file is applied; of an edited file it is not.
  const deleted = new Map(incoming);
  deleted.delete("memory/plan.md");
  deleted.delete("memory/MEMORY.md");
  await restoreClaude(root, deleted, incoming, layout);
  await assert.rejects(readFile(path.join(dir, "memory", "plan.md")));
  assert.equal(
    await readFile(path.join(dir, "memory", "MEMORY.md"), "utf8"),
    "- local edit\n",
  );
  // Sessions: the longer transcript wins when one extends the other.
  const transcript = path.join(dir, "s1.jsonl");
  const original = await readFile(transcript, "utf8");
  const complete = completeLines(Buffer.from(original)).toString();
  await writeFile(transcript, complete + line({ local: "ahead" }));
  report = await restoreClaude(root, base, base, layout);
  assert.ok(
    (await readFile(transcript, "utf8")).includes("ahead"),
    "local ahead is kept",
  );
  assert.deepEqual(report.sessionsKept, []);
  await writeFile(transcript, line({ diverged: true }));
  report = await restoreClaude(root, base, base, layout);
  assert.equal(await readFile(transcript, "utf8"), line({ diverged: true }));
  assert.deepEqual(report.sessionsKept, ["s1"]);
});

test(
  "restore never leaves the history directory (ClaudeHub CH-010)",
  { skip: process.platform === "win32" },
  async (t) => {
    const { home, layout } = await machine(t);
    const root = "/home/a/p";
    await assert.rejects(
      restoreClaude(
        root,
        new Map([["memory/../../escape.md", Buffer.from("x")]]),
        new Map(),
        layout,
      ),
      /unsafe context path/,
    );
    const dir = path.join(layout.dir, "projects", computeSlug(root));
    await mkdir(dir, { recursive: true });
    const outside = path.join(home, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(dir, "memory"));
    await assert.rejects(
      restoreClaude(
        root,
        new Map([["memory/x.md", Buffer.from("x")]]),
        new Map(),
        layout,
      ),
      /unsafe context path/,
    );
    assert.deepEqual(await readdir(outside), []);
  },
);
