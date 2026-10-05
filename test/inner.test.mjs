import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  findRepositories,
  innerRepositories,
  innerNotice,
  strayPointers,
  configureSubmodules,
  submodulePaths,
  planPublish,
  describePlan,
  publish,
  prjlabName,
} from "../dist/inner-repositories.js";
import { ProjectError } from "../dist/snapshot.js";

const origin = "https://prjlab.test";
const skip = process.platform === "win32";
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const g = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function repository(dir, files = { "readme.md": "hello\n" }) {
  await mkdir(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "first");
  return dir;
}
/**
 * A PrjLab that lives in a folder: https://prjlab.test/<handle>/<name>.git is
 * rewritten by git to a bare repository there, and the API creates them.
 */
async function world(t) {
  const base = await mkdtemp(path.join(tmpdir(), "prj-inner-"));
  const saved = { ...process.env };
  Object.assign(process.env, IDENTITY, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.file://${base}/remote/.insteadOf`,
    GIT_CONFIG_VALUE_0: `${origin}/`,
    GIT_CONFIG_KEY_1: "protocol.file.allow",
    GIT_CONFIG_VALUE_1: "always",
  });
  t.after(async () => {
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await rm(base, { recursive: true, force: true });
  });
  const owned = [];
  const bare = async (slug) => {
    const dir = path.join(base, "remote", "ajaize", `${slug}.git`);
    await mkdir(dir, { recursive: true });
    g(dir, "init", "-q", "--bare", "-b", "main");
    owned.push(slug);
  };
  const api = {
    calls: [],
    broken: new Set(),
    request: async (method, route, options = {}) => {
      api.calls.push({ method, route, body: options.body });
      if (method === "GET")
        return {
          status: 200,
          data: owned.map((slug) => ({ slug, role: "owner" })),
        };
      const slug = options.body.slug;
      // A repository the server made but git cannot reach: the push fails.
      if (api.broken.has(slug)) owned.push(slug);
      else await bare(slug);
      return {
        status: 201,
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          handle: "ajaize",
          slug,
          visibility: "private",
        },
      };
    },
  };
  await bare("outer");
  const outer = await repository(path.join(base, "work", "outer"), {
    "readme.md": "outer\n",
    "kept/plain.txt": "tracked as files\n",
  });
  g(outer, "remote", "add", "origin", `${origin}/ajaize/outer.git`);
  return { base, outer, api, bare, owned };
}

test(
  "inner repositories are found and not looked into",
  { skip },
  async (t) => {
    const { outer } = await world(t);
    await repository(path.join(outer, "a"));
    await repository(path.join(outer, "deep/er/b"));
    await repository(path.join(outer, "a/inside-a"));
    await repository(path.join(outer, "node_modules/dep"));
    const { found, complete } = await findRepositories(outer);
    assert.deepEqual(found, ["a", "deep/er/b"]);
    assert.equal(complete, true);
  },
);
test(
  "each inner repository is classified by how the outer one holds it",
  { skip },
  async (t) => {
    const { outer } = await world(t);
    await repository(path.join(outer, "loose"));
    // Tracked as plain files first, a repository of its own later.
    await repository(path.join(outer, "kept"), { "inner.txt": "x\n" });
    // git add of a repository: a pointer nobody can follow.
    await repository(path.join(outer, "pointer"));
    g(outer, "add", "pointer");
    await writeFile(path.join(outer, ".gitignore"), "/scratch/\n");
    await repository(path.join(outer, "scratch/ignored"));
    const { items } = await innerRepositories(outer);
    assert.deepEqual(
      items.map((i) => [i.path, i.state]),
      [
        ["kept", "files"],
        ["loose", "untracked"],
        ["pointer", "embedded"],
      ],
    );
    assert.deepEqual(await strayPointers(outer), ["pointer"]);
    const notice = await innerNotice(outer, true);
    assert.match(
      notice[0],
      /^3 folders here are git repositories of their own \(kept, loose, pointer\)/,
    );
    assert.match(notice[1], /prj submodules publish/);
    const plain = await innerNotice(outer, false);
    assert.match(plain[0], /without their git history/);
  },
);
test(
  "publish: each inner repository gets its own repository and the outer one points to it; a fresh clone has everything",
  { skip },
  async (t) => {
    const { base, outer, api, bare } = await world(t);
    await repository(path.join(outer, "loose"), { "l.txt": "loose\n" });
    g(path.join(outer, "loose"), "tag", "v1");
    g(path.join(outer, "loose"), "switch", "-q", "-c", "feature");
    await writeFile(path.join(outer, "loose", "f.txt"), "feature\n");
    g(path.join(outer, "loose"), "add", "-A");
    g(path.join(outer, "loose"), "commit", "-q", "-m", "feature work");
    await repository(path.join(outer, "kept"), { "inner.txt": "kept\n" });
    await repository(path.join(outer, "pointer"), { "p.txt": "pointer\n" });
    g(outer, "add", "pointer");
    g(outer, "commit", "-q", "-m", "a pointer nobody can follow");
    // Lives somewhere else too: its origin is left alone.
    const elsewhere = await repository(path.join(outer, "tools/elsewhere"));
    g(elsewhere, "remote", "add", "origin", "https://example.com/x/y.git");
    // Already on PrjLab under another name: reused, not created again.
    await bare("existing");
    const known = await repository(path.join(outer, "known"));
    g(known, "remote", "add", "origin", `${origin}/ajaize/existing.git`);
    // On no branch: its commit still has to travel.
    const detached = await repository(path.join(outer, "detached"));
    await writeFile(path.join(detached, "d.txt"), "detached\n");
    g(detached, "add", "-A");
    g(detached, "commit", "-q", "-m", "second");
    g(detached, "checkout", "-q", "--detach");
    g(detached, "branch", "-f", "main", "HEAD~1");
    // Nothing committed yet, and uncommitted work.
    await mkdir(path.join(outer, "unborn"));
    g(path.join(outer, "unborn"), "init", "-q");
    await writeFile(path.join(outer, "loose", "draft.txt"), "not committed\n");

    const plan = await planPublish(outer, origin, api, undefined);
    assert.equal(plan.outer, "ajaize/outer");
    assert.deepEqual(
      plan.ready.map((p) => [p.path, p.name, p.remote]),
      [
        ["detached", "ajaize/outer-detached", null],
        ["kept", "ajaize/outer-kept", null],
        ["known", "ajaize/existing", "origin"],
        ["loose", "ajaize/outer-loose", null],
        ["pointer", "ajaize/outer-pointer", null],
        ["tools/elsewhere", "ajaize/outer-elsewhere", null],
      ],
    );
    assert.deepEqual(plan.skipped, [
      { path: "unborn", reason: "it has no commits yet" },
    ]);
    const text = describePlan(origin, plan).join("\n");
    assert.match(text, /known +→ ajaize\/existing \(already on PrjLab\)/);
    assert.match(text, /loose has 1 uncommitted change\b/);
    assert.equal(
      api.calls.filter((c) => c.method === "POST").length,
      0,
      "planning creates nothing",
    );

    const before = await readFile(
      path.join(outer, "kept", "inner.txt"),
      "utf8",
    );
    const { results, committed } = await publish(
      outer,
      origin,
      api,
      undefined,
      plan,
    );
    assert.deepEqual(
      results.map((r) => [r.path, r.ok]),
      plan.ready.map((p) => [p.path, true]),
    );
    assert.equal(committed, true);
    assert.equal(
      g(outer, "status", "--porcelain", "--ignore-submodules=all"),
      "?? unborn/",
    );
    assert.equal(
      await readFile(path.join(outer, "kept", "inner.txt"), "utf8"),
      before,
    );
    assert.equal(
      g(elsewhere, "config", "remote.origin.url"),
      "https://example.com/x/y.git",
    );
    assert.equal(
      g(elsewhere, "config", "remote.prjlab.url"),
      `${origin}/ajaize/outer-elsewhere.git`,
    );
    assert.equal(g(outer, "config", "submodule.recurse"), "true");
    assert.equal(g(outer, "config", "push.recurseSubmodules"), "check");
    assert.deepEqual(await strayPointers(outer), []);
    assert.deepEqual(
      (await innerRepositories(outer)).items
        .filter((i) => i.state === "submodule")
        .map((i) => i.path),
      ["detached", "kept", "known", "loose", "pointer", "tools/elsewhere"],
    );
    // Nothing left to do the second time.
    assert.deepEqual((await planPublish(outer, origin, api)).ready, []);

    g(outer, "push", "-q", "origin", "HEAD:main");
    const copy = path.join(base, "copy");
    g(
      base,
      "clone",
      "-q",
      "--recurse-submodules",
      `${origin}/ajaize/outer.git`,
      copy,
    );
    for (const [file, content] of [
      ["loose/f.txt", "feature\n"],
      ["kept/inner.txt", "kept\n"],
      ["pointer/p.txt", "pointer\n"],
      ["detached/d.txt", "detached\n"],
      ["tools/elsewhere/readme.md", "hello\n"],
      ["known/readme.md", "hello\n"],
      ["kept/../readme.md", "outer\n"],
    ])
      assert.equal(
        await readFile(path.join(copy, file), "utf8"),
        content,
        file,
      );
    // The outer history holds a pointer, not the inner files.
    assert.match(g(copy, "ls-tree", "HEAD", "kept"), /^160000 commit /);
    assert.deepEqual(await submodulePaths(copy), [
      "detached",
      "kept",
      "known",
      "loose",
      "pointer",
      "tools/elsewhere",
    ]);
    // Every branch and tag went along.
    const refs = g(copy, "-C", "loose", "ls-remote", "origin");
    assert.match(refs, /refs\/heads\/main/);
    assert.match(refs, /refs\/heads\/feature/);
    assert.match(refs, /refs\/tags\/v1/);
    assert.equal(await configureSubmodules(copy), true);
  },
);
test(
  "publish: one that cannot be pushed is left exactly as it was; the others go through",
  { skip },
  async (t) => {
    const { outer, api } = await world(t);
    await repository(path.join(outer, "good"));
    await repository(path.join(outer, "kept"), { "inner.txt": "kept\n" });
    api.broken.add("outer-kept");
    // Something of the person's own is staged: prj must not commit it.
    await writeFile(path.join(outer, "mine.txt"), "mine\n");
    g(outer, "add", "mine.txt");
    const index = g(outer, "ls-files", "-s", "kept");
    const plan = await planPublish(outer, origin, api);
    const lines = [];
    const { results, committed } = await publish(
      outer,
      origin,
      api,
      undefined,
      plan,
      (l) => lines.push(l),
    );
    assert.deepEqual(
      results.map((r) => [r.path, r.ok]),
      [
        ["good", true],
        ["kept", false],
      ],
    );
    assert.match(results[1].problem, /^git push failed: /);
    assert.equal(committed, false);
    assert.equal(g(outer, "ls-files", "-s", "kept"), index);
    assert.match(lines.join("\n"), /kept: not published/);
    // Its repository exists now, so the next run reuses it instead of creating another.
    const again = await planPublish(outer, origin, api);
    assert.deepEqual(
      again.ready.map((p) => [p.path, p.name, p.remote]),
      [["kept", "ajaize/outer-kept", "origin"]],
    );
  },
);
test(
  "publish needs the outer repository on PrjLab, real paths and room in the account",
  { skip },
  async (t) => {
    const { outer, api, owned } = await world(t);
    await repository(path.join(outer, "a"));
    await assert.rejects(
      planPublish(outer, origin, api, undefined, ["nope"]),
      (e) =>
        e instanceof ProjectError &&
        /nope is not a git repository/.test(e.message),
    );
    // A name that is taken by something else: another one is chosen.
    owned.push("outer-a");
    assert.equal(
      (await planPublish(outer, origin, api)).ready[0].name,
      "ajaize/outer-a-2",
    );
    for (let i = owned.length; i < 200; i++) owned.push(`filler-${i}`);
    await assert.rejects(
      planPublish(outer, origin, api),
      (e) =>
        e instanceof ProjectError && /needs 1 new repositor/.test(e.message),
    );
    assert.deepEqual(await prjlabName(outer, origin), {
      remote: "origin",
      name: "ajaize/outer",
    });
    g(outer, "remote", "set-url", "origin", "https://github.com/a/b.git");
    await assert.rejects(
      planPublish(outer, origin, api),
      (e) => e instanceof ProjectError && /not on PrjLab yet/.test(e.message),
    );
  },
);
