// prj alongside real git (PrjLab docs/20 §6): init links a git clone and
// installs context hooks; context push/pull move the AI context; clone uses
// git for git repositories. Folders without git keep the version commands.
import { realpath, readFile, appendFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { readLoginConfig, LoginError } from "./auth-config.js";
import {
  credentialDirectory,
  secureStore,
  withCredentialLock,
} from "./credential-store.js";
import { LoginSession } from "./login-session.js";
import { ProjectError, initialize } from "./snapshot.js";
import { TransportError } from "./http.js";
import { push, pull, addRemote, showRemote } from "./sync.js";
import {
  parseRepositoryRef,
  resolveRepository,
  defaultCloneDirectory,
  linkedRepository,
} from "./repository-ref.js";
import {
  gitFolder,
  git,
  installContextHooks,
  prjlabRemote,
  selfCommand,
} from "./git-integration.js";
import {
  describeSummary,
  describeRestore,
  type ContextSummary,
  type ContextRestore,
} from "./context-mirror.js";
import { repositoryArgument } from "./sync-commands.js";

type Result = { code: number; stdout: string; stderr: string };
const ok = (lines: string[]): Result => ({
  code: 0,
  stdout: lines.filter((l) => l !== "").join("\n") + (lines.length ? "\n" : ""),
  stderr: "",
});
async function api(signal: AbortSignal) {
  const config = readLoginConfig();
  const directory = await credentialDirectory(config);
  const transport = await withCredentialLock(directory, async () =>
    new LoginSession(config, await secureStore(config, directory)).transport(
      signal,
    ),
  );
  return { config, api: transport };
}
/** The git worktree root this folder is, or null (subfolders don't count). */
async function gitRoot(cwd: string) {
  const g = await gitFolder(cwd);
  if (!g) return null;
  const [top, here] = await Promise.all([realpath(g.top), realpath(cwd)]);
  return top === here ? g : null;
}
/** Keep .prj out of git without touching the user's .gitignore. */
async function excludePrj(cwd: string) {
  const r = await git(["rev-parse", "--git-path", "info/exclude"], cwd);
  if (r.code !== 0) return;
  const file = path.resolve(cwd, r.out.trim());
  const text = await readFile(file, "utf8").catch(() => "");
  if (
    text
      .split(/\r?\n/)
      .some((l) => l.trim() === ".prj/" || l.trim() === "/.prj/")
  )
    return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(
    file,
    `${text && !text.endsWith("\n") ? "\n" : ""}# PrjLab local state\n/.prj/\n`,
  );
}
async function contextPull(cwd: string, signal: AbortSignal) {
  const { config, api: transport } = await api(signal);
  const repository = await linkedRepository(cwd, config.origin);
  return pull(cwd, config.origin, repository, transport, signal, {
    contextOnly: true,
  });
}
async function contextPush(
  cwd: string,
  signal: AbortSignal,
  sessions: boolean,
) {
  const { config, api: transport } = await api(signal);
  const repository = await linkedRepository(cwd, config.origin);
  try {
    return await push(cwd, config.origin, repository, transport, signal, {
      contextOnly: true,
      sessions,
      message: "Context",
    });
  } catch (error) {
    // Another machine pushed context first: take theirs (local work wins), retry once.
    if (error instanceof TransportError && error.code === "conflict") {
      await pull(cwd, config.origin, repository, transport, signal, {
        contextOnly: true,
      });
      return push(cwd, config.origin, repository, transport, signal, {
        contextOnly: true,
        sessions,
        message: "Context",
      });
    }
    throw error;
  }
}
/** `prj init` in a git clone: link, exclude .prj, hooks, first context pull. */
async function initGit(
  cwd: string,
  signal: AbortSignal,
): Promise<Result | undefined> {
  const g = await gitRoot(cwd);
  if (!g) return undefined;
  const lines: string[] = [];
  const fresh = !(await realpath(path.join(cwd, ".prj")).catch(() => null));
  if (fresh) await initialize(cwd);
  await excludePrj(cwd);
  const hooks = await installContextHooks(g.hooks);
  lines.push(
    fresh
      ? "Initialized PrjLab in this git repository."
      : "PrjLab is set up in this git repository.",
    ` git hooks installed: ${hooks.join(", ")}. Claude Code context now travels with git push, git pull and git switch.`,
  );
  const config = readLoginConfig();
  const name = g.origin ? prjlabRemote(g.origin, config.origin) : null;
  if (!name) {
    lines.push(
      g.origin
        ? ` origin is not on ${config.origin}; context will travel once origin points to a PrjLab repository (then run prj init again).`
        : ` Add the PrjLab remote, then run prj init again: git remote add origin ${config.origin}/<handle>/<name>.git`,
    );
    return ok(lines);
  }
  try {
    const { api: transport } = await api(signal);
    const repository = await resolveRepository(
      parseRepositoryRef(name),
      transport,
      signal,
    );
    await addRemote(cwd, config.origin, repository, name);
    lines.push(` Linked to ${config.origin}/${name}`);
    const pulled = await pull(
      cwd,
      config.origin,
      repository,
      transport,
      signal,
      { contextOnly: true },
    );
    if ("context" in pulled && pulled.context?.length)
      lines.push(
        ...describeRestore(pulled.context as ContextRestore[]).map(
          (l) => ` ${l}`,
        ),
      );
  } catch (error) {
    if (error instanceof LoginError)
      lines.push(
        " Not signed in: run prj login, then prj init again to link the context.",
      );
    else throw error;
  }
  return ok(lines);
}
function runGitVisible(args: string[], cwd: string) {
  return new Promise<number>((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}
async function cloneGit(
  args: string[],
  signal: AbortSignal,
): Promise<Result | undefined> {
  if (args.length < 1 || args.length > 2 || args.some((a) => a.startsWith("-")))
    return undefined;
  const config = readLoginConfig();
  const ref = parseRepositoryRef(repositoryArgument(args[0]!, config.origin));
  const { api: transport } = await api(signal);
  const repository = await resolveRepository(ref, transport, signal);
  const detail = await transport.request(
    "GET",
    `/api/v1/repositories/${repository}`,
    { signal },
  );
  let summary: { status: number; data: unknown };
  try {
    summary = await transport.request(
      "GET",
      `/api/v1/repositories/${repository}/git/summary`,
      { signal },
    );
  } catch (error) {
    if (error instanceof TransportError && error.code !== "cancelled")
      return undefined; // this server has no git yet: version clone
    throw error;
  }
  const repo = detail.data as {
    handle?: string;
    slug?: string;
    latest?: unknown;
  };
  const git = summary.data as { empty?: boolean };
  if (
    detail.status !== 200 ||
    summary.status !== 200 ||
    typeof repo.handle !== "string" ||
    typeof repo.slug !== "string" ||
    (git.empty && repo.latest)
  )
    return undefined; // not (yet) a git repository: version clone
  const dir = args[1] ?? defaultCloneDirectory(ref);
  const url = `${config.origin}/${repo.handle}/${repo.slug}.git`;
  // Sign git in for this clone even if prj login predates the helper.
  const code = await runGitVisible(
    [
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=!${selfCommand("git-credential")}`,
      "clone",
      url,
      dir,
    ],
    process.cwd(),
  );
  if (code !== 0) return { code: 1, stdout: "", stderr: "git clone failed.\n" };
  const init = await initGit(path.resolve(dir), signal);
  return init ?? ok([]);
}
/** Dispatch: returns undefined to fall back to the version commands. */
export async function gitCommands(
  args: readonly string[],
): Promise<Result | undefined> {
  const [command, sub, ...rest] = args;
  const cwd = process.cwd();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    if (command === "init" && args.length === 1)
      return await initGit(cwd, controller.signal);
    if (command === "clone")
      return await cloneGit(args.slice(1) as string[], controller.signal);
    if (command === "context" && (sub === "push" || sub === "pull")) {
      const flags = new Set(rest);
      if ([...flags].some((f) => !["--quiet", "--no-sessions"].includes(f)))
        throw new ProjectError(
          "Usage: prj context push|pull [--quiet] [--no-sessions]",
        );
      const quiet = flags.has("--quiet");
      if (sub === "push") {
        const r = await contextPush(
          cwd,
          controller.signal,
          !flags.has("--no-sessions"),
        );
        const summary = describeSummary((r.context ?? []) as ContextSummary[]);
        if (r.upToDate)
          return ok(
            quiet
              ? []
              : ["Context up to date.", ...summary.map((l) => ` ${l}`)],
          );
        const n = r.changes
          ? r.changes.context.added.length +
            r.changes.context.modified.length +
            r.changes.context.deleted.length
          : 0;
        return ok(
          quiet
            ? [
                `prj: Claude context pushed (${n} file${n === 1 ? "" : "s"} updated).`,
              ]
            : ["Context pushed.", ...summary.map((l) => ` ${l}`)],
        );
      }
      const r = await contextPull(cwd, controller.signal);
      if (r.upToDate) return ok(quiet ? [] : ["Context already up to date."]);
      const restored = describeRestore(
        ((r as { context?: unknown[] }).context ?? []) as ContextRestore[],
      );
      return ok(
        quiet
          ? restored.slice(0, 1).map((l) => `prj: ${l}`)
          : ["Context pulled.", ...restored.map((l) => ` ${l}`)],
      );
    }
    // prj push / prj pull in a git repository linked to PrjLab: git owns the code.
    if ((command === "push" || command === "pull") && (await gitRoot(cwd))) {
      const g = (await gitRoot(cwd))!;
      const config = readLoginConfig();
      if (!g.origin || !prjlabRemote(g.origin, config.origin)) return undefined;
      const known = await showRemote(cwd).catch(() => null);
      if (!known) return undefined;
      const r =
        command === "push"
          ? await contextPush(
              cwd,
              controller.signal,
              !args.includes("--no-sessions"),
            )
          : await contextPull(cwd, controller.signal);
      return ok([
        `This folder uses git: code travels with git ${command}. Claude context ${command === "push" ? "pushed" : "pulled"}${r.upToDate ? " (already up to date)" : ""}.`,
      ]);
    }
    return undefined;
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr:
        error instanceof LoginError ||
        error instanceof ProjectError ||
        error instanceof TransportError
          ? error.message + "\n"
          : "Context sync failed. Your files are untouched; retry the same command.\n",
    };
  } finally {
    clearTimeout(timer);
  }
}
