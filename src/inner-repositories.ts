// Git repositories inside a git repository. Git never stores one repository
// inside another: an inner repository is either a submodule (the outer one
// records which commit of it belongs here) or it is not part of the outer one
// at all. prj finds them, says so, and can publish each as its own PrjLab
// repository linked here as a submodule, so nothing inner leaks into the outer
// history and a clone still brings everything.
import { execFile } from "node:child_process";
import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { ProjectError } from "./snapshot.js";
import { create, slugFor } from "./create.js";
import { prjlabRemote, selfCommand } from "./git-integration.js";

type Run = { code: number; out: string; err: string };
/** git without the 30 s cap of the small helper: pushes and long listings. */
function run(args: string[], cwd: string, signed = false): Promise<Run> {
  const full = signed
    ? [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=!${selfCommand("git-credential")}`,
        ...args,
      ]
    : args;
  return new Promise((resolve) => {
    execFile(
      "git",
      full,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) =>
        resolve({
          code: error
            ? typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code?: number }).code as number)
              : 1
            : 0,
          out: stdout ?? "",
          err: stderr ?? "",
        }),
    );
  });
}

export type InnerState =
  /** Listed in .gitmodules: the outer repository points to it. */
  | "submodule"
  /** Recorded as a bare pointer without .gitmodules: a clone gets an empty folder. */
  | "embedded"
  /** The outer repository tracks its files as plain files. */
  | "files"
  /** The outer repository does not track it. */
  | "untracked";
export interface InnerRepository {
  /** Relative to the outer root, forward slashes. */
  path: string;
  state: InnerState;
  /** The URL .gitmodules gives it. */
  url: string | null;
  /** Its folder is a git repository on this machine. */
  present: boolean;
}
/** Folders that are never worth walking to find a repository. */
const SKIP = new Set([
  ".git",
  ".prj",
  ".prjcontext",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
]);
const MAX_FOLDERS = 20000;
const MAX_DEPTH = 8;

async function isRepository(dir: string) {
  const dot = path.join(dir, ".git");
  const info = await lstat(dot).catch(() => undefined);
  if (!info) return false;
  if (info.isDirectory())
    return Boolean(await lstat(path.join(dot, "HEAD")).catch(() => undefined));
  if (!info.isFile()) return false;
  return (await readFile(dot, "utf8").catch(() => "")).startsWith("gitdir:");
}
/** Folders below root that are git repositories of their own (not looked into). */
export async function findRepositories(root: string) {
  const found: string[] = [];
  const queue: [string, number][] = [["", 0]];
  let seen = 0,
    complete = true;
  while (queue.length) {
    const [rel, depth] = queue.shift()!;
    const abs = rel ? path.join(root, rel) : root;
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    if (
      rel &&
      entries.some((e) => e.name === ".git") &&
      (await isRepository(abs))
    ) {
      found.push(rel);
      continue;
    }
    if (++seen > MAX_FOLDERS) {
      complete = false;
      break;
    }
    if (depth >= MAX_DEPTH) continue;
    for (const e of entries)
      if (e.isDirectory() && !SKIP.has(e.name))
        queue.push([rel ? `${rel}/${e.name}` : e.name, depth + 1]);
  }
  return { found: found.sort(), complete };
}
/** path → url, as .gitmodules records them. */
async function registered(root: string) {
  const r = await run(
    [
      "config",
      "-z",
      "-f",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.(path|url)$",
    ],
    root,
  );
  const byName = new Map<string, { path?: string; url?: string }>();
  if (r.code === 0)
    for (const record of r.out.split("\0").filter(Boolean)) {
      const nl = record.indexOf("\n");
      if (nl < 0) continue;
      const key = record.slice(0, nl),
        value = record.slice(nl + 1);
      const m = /^submodule\.(.*)\.(path|url)$/.exec(key);
      if (!m) continue;
      const entry = byName.get(m[1]!) ?? {};
      entry[m[2] as "path" | "url"] = value;
      byName.set(m[1]!, entry);
    }
  const byPath = new Map<string, string | null>();
  for (const e of byName.values())
    if (e.path) byPath.set(e.path, e.url ?? null);
  return byPath;
}
/** How the outer index holds a path: a pointer, plain files, or nothing. */
async function held(root: string, rel: string) {
  const r = await run(["ls-files", "-s", "-z", "--", `:(literal)${rel}`], root);
  const first = r.out.split("\0")[0] ?? "";
  if (!first) return "nothing" as const;
  const tab = first.indexOf("\t");
  return first.startsWith("160000 ") && first.slice(tab + 1) === rel
    ? ("pointer" as const)
    : ("files" as const);
}
/**
 * Every inner repository of a git folder and how the outer repository holds
 * it. Ignored folders are left out: what git ignores is not part of the project.
 */
export async function innerRepositories(root: string) {
  const [{ found, complete }, modules] = await Promise.all([
    findRepositories(root),
    registered(root),
  ]);
  const items: InnerRepository[] = [];
  for (const rel of found) {
    if (modules.has(rel)) {
      items.push({
        path: rel,
        state: "submodule",
        url: modules.get(rel) ?? null,
        present: true,
      });
      continue;
    }
    const how = await held(root, rel);
    if (
      how === "nothing" &&
      (await run(["check-ignore", "-q", "--", rel], root)).code === 0
    )
      continue;
    items.push({
      path: rel,
      state:
        how === "pointer"
          ? "embedded"
          : how === "files"
            ? "files"
            : "untracked",
      url: null,
      present: true,
    });
  }
  for (const [rel, url] of modules)
    if (!found.includes(rel))
      items.push({ path: rel, state: "submodule", url, present: false });
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { items, complete };
}
const unpublished = (items: InnerRepository[]) =>
  items.filter((i) => i.state !== "submodule");
function names(paths: string[]) {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}
/** What prj create and prj init say when inner repositories are not linked. */
export async function innerNotice(root: string, inGit: boolean) {
  const open = inGit
    ? unpublished((await innerRepositories(root)).items).map((i) => i.path)
    : (await findRepositories(root)).found;
  if (!open.length) return [];
  const n = open.length;
  return inGit
    ? [
        `${n} folder${n === 1 ? "" : "s"} here ${n === 1 ? "is a git repository" : "are git repositories"} of ${n === 1 ? "its" : "their"} own (${names(open)}). Git keeps ${n === 1 ? "it" : "them"} out of this repository.`,
        ` Give ${n === 1 ? "it its" : "each its"} own PrjLab repository and link it here: prj submodules publish`,
      ]
    : [
        `${n} folder${n === 1 ? "" : "s"} here ${n === 1 ? "is a git repository" : "are git repositories"} (${names(open)}). prj push uploads ${n === 1 ? "its" : "their"} files as plain files, without ${n === 1 ? "its" : "their"} git history.`,
        " To keep the history: git init here, prj create, then prj submodules publish.",
      ];
}
/** Pointers in the index that .gitmodules does not explain. Cheap: for the hook. */
export async function strayPointers(root: string) {
  const r = await run(["ls-files", "-s", "-z"], root);
  if (r.code !== 0) return [];
  const pointers = r.out
    .split("\0")
    .filter((l) => l.startsWith("160000 "))
    .map((l) => l.slice(l.indexOf("\t") + 1));
  if (!pointers.length) return [];
  const modules = await registered(root);
  return pointers.filter((p) => !modules.has(p));
}
/**
 * With submodules, make git move the inner repositories along with the outer
 * one (switch, pull, reset) and refuse to push an outer commit that points to
 * an inner commit no remote has.
 */
export async function configureSubmodules(root: string) {
  if (!(await lstat(path.join(root, ".gitmodules")).catch(() => undefined)))
    return false;
  await run(["config", "submodule.recurse", "true"], root);
  await run(["config", "push.recurseSubmodules", "check"], root);
  return true;
}
/** The paths of every submodule, nested ones included, relative to root. */
export async function submodulePaths(root: string) {
  const r = await run(
    ["submodule", "--quiet", "foreach", "--recursive", 'echo "$displaypath"'],
    root,
  );
  return r.code === 0
    ? r.out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
}

interface Api {
  request(
    method: "GET" | "POST",
    route: string,
    options?: { body?: unknown; signal?: AbortSignal },
  ): Promise<{ status: number; data: unknown }>;
}
export interface Planned {
  path: string;
  state: InnerState;
  /** <handle>/<name> on PrjLab. */
  name: string;
  /** The inner repository already has a remote there. */
  remote: string | null;
  /** Not committed there: stays on this machine. */
  uncommitted: number;
}
export interface Plan {
  /** <handle>/<name> of the outer repository. */
  outer: string;
  ready: Planned[];
  /** Inner repositories that cannot be published, with the reason. */
  skipped: { path: string; reason: string }[];
}
/** Repositories one account may own (the server answers 409 beyond it). */
const ACCOUNT_REPOSITORIES = 200;
async function remotes(dir: string) {
  const r = await run(
    ["config", "-z", "--get-regexp", "^remote\\..*\\.url$"],
    dir,
  );
  const list: { name: string; url: string }[] = [];
  if (r.code === 0)
    for (const record of r.out.split("\0").filter(Boolean)) {
      const nl = record.indexOf("\n");
      const m = /^remote\.(.*)\.url$/.exec(record.slice(0, nl));
      if (nl > 0 && m) list.push({ name: m[1]!, url: record.slice(nl + 1) });
    }
  return list;
}
/** The PrjLab repository a git folder pushes to: origin first, then any remote. */
export async function prjlabName(dir: string, origin: string) {
  const list = await remotes(dir);
  for (const r of [
    ...list.filter((r) => r.name === "origin"),
    ...list.filter((r) => r.name !== "origin"),
  ]) {
    const name = prjlabRemote(r.url, origin);
    if (name) return { remote: r.name, name };
  }
  return null;
}
/** Decide, without changing anything, what publishing would do. */
export async function planPublish(
  root: string,
  origin: string,
  api: Api,
  signal: AbortSignal | undefined,
  only: string[] = [],
): Promise<Plan> {
  const outer = await prjlabName(root, origin);
  if (!outer)
    throw new ProjectError(
      "This repository is not on PrjLab yet. Create it first: prj create, then git push -u origin HEAD.",
    );
  const { items } = await innerRepositories(root);
  const wanted = only.map((p) =>
    p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""),
  );
  for (const w of wanted)
    if (!items.some((i) => i.path === w))
      throw new ProjectError(
        `${w} is not a git repository inside this folder. Run prj submodules to see them.`,
      );
  const open = unpublished(items).filter(
    (i) => !wanted.length || wanted.includes(i.path),
  );
  const plan: Plan = { outer: outer.name, ready: [], skipped: [] };
  if (!open.length) return plan;
  const listed = await api.request("GET", "/api/v1/repositories", { signal });
  const owned = (
    Array.isArray(listed.data)
      ? (listed.data as { slug?: unknown; role?: unknown }[])
      : []
  )
    .filter((r) => r && typeof r === "object" && r.role === "owner")
    .map((r) => String(r.slug));
  const taken = new Set(owned);
  const [handle, outerSlug] = outer.name.split("/") as [string, string];
  let fresh = 0;
  for (const item of open) {
    const dir = path.join(root, item.path);
    if ((await run(["rev-parse", "--verify", "-q", "HEAD"], dir)).code !== 0) {
      plan.skipped.push({ path: item.path, reason: "it has no commits yet" });
      continue;
    }
    const status = await run(["status", "--porcelain", "-z"], dir);
    const uncommitted = status.out.split("\0").filter(Boolean).length;
    const existing = await prjlabName(dir, origin);
    if (existing) {
      plan.ready.push({
        path: item.path,
        state: item.state,
        name: existing.name,
        remote: existing.remote,
        uncommitted,
      });
      continue;
    }
    const base = path.posix.basename(item.path);
    const slug = [
      slugFor(`${outerSlug}-${base}`),
      slugFor(`${outerSlug}-${item.path}`),
      ...[2, 3, 4, 5].map((n) => slugFor(`${outerSlug}-${base}`) + `-${n}`),
    ].find((s) => s && s.length <= 63 && !taken.has(s));
    if (!slug) {
      plan.skipped.push({
        path: item.path,
        reason: "no free repository name was found for it",
      });
      continue;
    }
    taken.add(slug);
    fresh++;
    plan.ready.push({
      path: item.path,
      state: item.state,
      name: `${handle}/${slug}`,
      remote: null,
      uncommitted,
    });
  }
  if (owned.length + fresh > ACCOUNT_REPOSITORIES)
    throw new ProjectError(
      `This needs ${fresh} new repositories and your account owns ${owned.length} of ${ACCOUNT_REPOSITORIES}. Delete some you no longer need at https://prjlab.com, or publish fewer: prj submodules publish <path>.`,
    );
  return plan;
}
export function describePlan(origin: string, plan: Plan) {
  const lines: string[] = [];
  const width = Math.max(0, ...plan.ready.map((p) => p.path.length));
  for (const p of plan.ready)
    lines.push(
      `  ${p.path.padEnd(width)}  → ${p.remote ? `${p.name} (already on PrjLab)` : `new private repository ${p.name}`}`,
    );
  for (const s of plan.skipped)
    lines.push(`  ${s.path.padEnd(width)}  skipped: ${s.reason}`);
  const loose = plan.ready.filter((p) => p.uncommitted);
  for (const p of loose)
    lines.push(
      `  Note: ${p.path} has ${p.uncommitted} uncommitted change${p.uncommitted === 1 ? "" : "s"}. Only commits travel; commit there to include them.`,
    );
  return lines;
}
export interface Published {
  path: string;
  name: string;
  ok: boolean;
  /** Why it was left as it was. */
  problem?: string;
}
/**
 * Publish each planned inner repository (create, push every branch and tag)
 * and link it in the outer one as a submodule. One that fails is left exactly
 * as it was; the others still go through. Working files are never touched.
 */
export async function publish(
  root: string,
  origin: string,
  api: Api,
  signal: AbortSignal | undefined,
  plan: Plan,
  progress: (line: string) => void = () => {},
) {
  // Only commit for the person when nothing of theirs is staged.
  const clean = (await run(["diff", "--cached", "--quiet"], root)).code === 0;
  const results: Published[] = [];
  for (const p of plan.ready) {
    const dir = path.join(root, p.path);
    const fail = (problem: string) => {
      results.push({ path: p.path, name: p.name, ok: false, problem });
      progress(`  ${p.path}: not published. ${problem}`);
    };
    const url = `${origin}/${p.name}.git`;
    let remote = p.remote;
    if (!remote) {
      const existing = await remotes(dir);
      remote = !existing.some((r) => r.name === "origin")
        ? "origin"
        : !existing.some((r) => r.name === "prjlab")
          ? "prjlab"
          : null;
      if (!remote) {
        fail(
          "It already has remotes named origin and prjlab that point elsewhere.",
        );
        continue;
      }
      try {
        await create(root, origin, api, signal, {
          name: p.name.split("/")[1]!,
          description: `Part of ${plan.outer} (${p.path})`.slice(0, 500),
          link: false,
        });
      } catch (error) {
        if (!(error instanceof ProjectError)) throw error;
        fail(error.message);
        continue;
      }
      await run(["remote", "add", remote, url], dir);
    }
    // A commit on no branch would not travel: give it one.
    const branches = (
      await run(["for-each-ref", "--format=%(refname)", "refs/heads"], dir)
    ).out
      .split("\n")
      .filter(Boolean);
    const onBranch =
      (
        await run(
          ["for-each-ref", "--count=1", "--contains", "HEAD", "refs/heads"],
          dir,
        )
      ).out.trim() !== "";
    const head = (await run(["rev-parse", "HEAD"], dir)).out.trim();
    const pushes: string[][] = [];
    if (branches.length) pushes.push(["push", "-q", remote, "--all"]);
    if (!onBranch)
      pushes.push([
        "push",
        "-q",
        remote,
        `${head}:refs/heads/prjlab/detached-${head.slice(0, 7)}`,
      ]);
    pushes.push(["push", "-q", remote, "--tags"]);
    let pushed = true;
    for (const args of pushes) {
      const r = await run(args, dir, true);
      if (r.code !== 0) {
        const reason = r.err
          .split("\n")
          .map((l) => l.replace(/^(remote|error|fatal):\s*/, "").trim())
          .filter(Boolean)
          .slice(-2)
          .join(" ");
        fail(`git push failed: ${reason || "no reason given"}`);
        pushed = false;
        break;
      }
    }
    if (!pushed) continue;
    if (p.state !== "untracked") {
      const r = await run(
        ["rm", "-r", "-q", "--cached", "--", `:(literal)${p.path}`],
        root,
      );
      if (r.code !== 0) {
        fail(`git could not stop tracking its files here: ${r.err.trim()}`);
        continue;
      }
    }
    const added = await run(
      ["submodule", "add", "--", url, p.path],
      root,
      true,
    );
    if (added.code !== 0) {
      // Put the index back the way it was for this path.
      if (p.state !== "untracked")
        await run(["reset", "-q", "--", `:(literal)${p.path}`], root);
      fail(`git submodule add failed: ${added.err.trim().split("\n").pop()}`);
      continue;
    }
    results.push({ path: p.path, name: p.name, ok: true });
    progress(`  ${p.path} → ${origin}/${p.name}`);
  }
  const done = results.filter((r) => r.ok).map((r) => r.path);
  let committed = false;
  if (done.length) {
    await configureSubmodules(root);
    if (clean)
      committed =
        (
          await run(
            [
              "commit",
              "-q",
              "-m",
              `Inner repositories are submodules: ${names(done)}`,
            ],
            root,
          )
        ).code === 0;
  }
  return { results, committed };
}
