// Real git + prj for context (PrjLab docs/20). git carries the code; prj
// signs git in to PrjLab and moves the AI context around git's own commands.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  readFile,
  writeFile,
  rename,
  lstat,
  mkdir,
  chmod,
} from "node:fs/promises";

export function git(
  args: string[],
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", timeout: 30000, windowsHide: true },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          out: stdout ?? "",
          err: stderr ?? "",
        }),
    );
  });
}
/** How git should start this CLI: absolute node + script, forward slashes for sh. */
export function selfCommand(sub: string) {
  const bin = fileURLToPath(new URL("./bin.js", import.meta.url));
  const quote = (p: string) => `"${p.replace(/\\/g, "/")}"`;
  return `${quote(process.execPath)} ${quote(bin)} ${sub}`;
}
/**
 * `prj login` makes git sign in to PrjLab with the prj session. Scoped to the
 * PrjLab origin; the empty entry first resets other helpers for this host so a
 * caching helper (store, manager) never keeps the short-lived token.
 */
export async function configureGitCredentials(origin: string) {
  if (process.env.PRJ_NO_GIT_CONFIG) return "skipped";
  const key = `credential.${origin}.helper`;
  if ((await git(["--version"])).code !== 0) return "no-git";
  await git(["config", "--global", "--unset-all", key]);
  await git(["config", "--global", "--add", key, ""]);
  const r = await git([
    "config",
    "--global",
    "--add",
    key,
    `!${selfCommand("git-credential")}`,
  ]);
  return r.code === 0 ? "configured" : "failed";
}
export async function removeGitCredentials(origin: string) {
  if (process.env.PRJ_NO_GIT_CONFIG) return;
  await git([
    "config",
    "--global",
    "--unset-all",
    `credential.${origin}.helper`,
  ]);
}
/** git's credential protocol (key=value lines) → the fields we need. */
export function parseCredentialRequest(input: string) {
  const fields: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  return fields;
}
export function credentialMatches(
  fields: Record<string, string>,
  origin: string,
) {
  const url = new URL(origin);
  return (
    fields.protocol === url.protocol.slice(0, -1) &&
    (fields.host ?? "").toLowerCase() === url.host.toLowerCase()
  );
}
/** The PrjLab repository a git remote URL points to, if it is on this server. */
export function prjlabRemote(remoteUrl: string, origin: string) {
  let url: URL;
  try {
    url = new URL(remoteUrl.trim());
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const m =
    /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9][A-Za-z0-9-]{0,62}?)(?:\.git)?\/?$/.exec(
      url.pathname,
    );
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null;
}
export interface GitFolder {
  top: string;
  hooks: string;
  origin: string | null;
}
/** The git worktree this folder is the root of, or null. */
export async function gitFolder(cwd: string): Promise<GitFolder | null> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0) return null;
  const hooks = await git(["rev-parse", "--git-path", "hooks"], cwd);
  const remote = await git(["remote", "get-url", "origin"], cwd);
  return {
    top: top.out.trim(),
    hooks: path.resolve(cwd, hooks.out.trim()),
    origin: remote.code === 0 ? remote.out.trim() : null,
  };
}
const MARK = "# prjlab-context-hook";
const HOOKS: Record<string, { run: string; stdin: boolean; gate?: string }> = {
  // Before code leaves, the AI context goes up (never blocks the push).
  "pre-push": { run: "context push --quiet", stdin: true },
  // After code arrives, the AI context comes down.
  "post-merge": { run: "context pull --quiet", stdin: false },
  "post-checkout": {
    run: "context pull --quiet",
    stdin: false,
    gate: '[ "$3" = "1" ] || exit 0',
  },
};
function hookScript(name: string) {
  const h = HOOKS[name]!;
  const previous = `"$(dirname "$0")/${name}.prjlab-previous"`;
  return (
    [
      "#!/bin/sh",
      `${MARK} (installed by prj init; PRJ_NO_CONTEXT_HOOKS=1 skips it)`,
      h.stdin ? "input=$(cat)" : "",
      `if [ -x ${previous} ]; then`,
      h.stdin
        ? `  printf '%s\\n' "$input" | ${previous} "$@" || exit $?`
        : `  ${previous} "$@" || exit $?`,
      "fi",
      '[ -n "$PRJ_NO_CONTEXT_HOOKS" ] && exit 0',
      h.gate ?? "",
      `${selfCommand(h.run)} || true`,
      "exit 0",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n") + "\n"
  );
}
/** Install (or refresh) the three hooks; an existing foreign hook is kept and chained. */
export async function installContextHooks(hooksDir: string) {
  await mkdir(hooksDir, { recursive: true });
  const installed: string[] = [];
  for (const name of Object.keys(HOOKS)) {
    const file = path.join(hooksDir, name);
    const info = await lstat(file).catch(() => undefined);
    if (info) {
      const current = await readFile(file, "utf8").catch(() => "");
      if (!current.includes(MARK)) {
        const previous = path.join(hooksDir, `${name}.prjlab-previous`);
        if (!(await lstat(previous).catch(() => undefined)))
          await rename(file, previous);
      }
    }
    await writeFile(file, hookScript(name), { mode: 0o755 });
    await chmod(file, 0o755);
    installed.push(name);
  }
  return installed;
}
export async function hooksInstalled(hooksDir: string) {
  for (const name of Object.keys(HOOKS)) {
    const text = await readFile(path.join(hooksDir, name), "utf8").catch(
      () => "",
    );
    if (!text.includes(MARK)) return false;
  }
  return true;
}
