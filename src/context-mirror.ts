// AI-tool context that lives outside the folder travels through a mirror in
// .prj/context/. A version lists it under .prjcontext/agents/<tool>/…; the
// user's folder never gets these files. Refreshed before every capture and
// status; applied to the tool's own storage after every pull and clone.
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readdir,
  readFile,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  rmdir,
  realpath,
} from "node:fs/promises";
import {
  captureClaude,
  restoreClaude,
  claudeLayout,
  type ClaudeRestore,
} from "./claude-context.js";

/** Version paths under this prefix are context from AI tools (reserved). */
export const AGENTS_PREFIX = ".prjcontext/agents/";
export const CLAUDE_PREFIX = AGENTS_PREFIX + "claude-code/";
export function isMirrorPath(name: string) {
  return name.startsWith(AGENTS_PREFIX);
}
/** .prj/context holds agents/<tool>/… exactly as the version names it after .prjcontext/. */
export function mirrorRoot(meta: string) {
  return path.join(meta, "context");
}
export interface ContextSummary {
  tool: "claude-code";
  label: string;
  memories: number;
  sessions: number;
  settings: boolean;
  warnings: string[];
}
async function files(dir: string, relative = ""): Promise<string[]> {
  const out: string[] = [];
  const items = await readdir(path.join(dir, relative), {
    withFileTypes: true,
  }).catch(() => []);
  for (const item of items) {
    const rel = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...(await files(dir, rel)));
    else if (item.isFile()) out.push(rel);
  }
  return out;
}
async function write(file: string, data: Buffer) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
async function prune(dir: string, stop: string) {
  let cursor = dir;
  while (cursor.startsWith(stop) && cursor !== stop) {
    if ((await readdir(cursor).catch(() => ["x"])).length) return;
    await rmdir(cursor).catch(() => {});
    cursor = path.dirname(cursor);
  }
}
/** Capture every detected tool into the mirror; returns what was found. */
export async function refreshMirror(
  meta: string,
  base: string,
  options: { sessions: boolean },
): Promise<ContextSummary[]> {
  const root = mirrorRoot(meta);
  const target = path.join(root, "agents", "claude-code");
  const captured = await captureClaude(base, options, claudeLayout());
  const desired = captured?.files ?? new Map<string, Buffer>();
  const present = await files(target);
  for (const rel of present)
    if (!desired.has(rel)) {
      await unlink(path.join(target, rel));
      await prune(path.dirname(path.join(target, rel)), root);
    }
  for (const [rel, data] of desired) {
    const file = path.join(target, ...rel.split("/"));
    const info = await lstat(file).catch(() => undefined);
    if (
      info?.isFile() &&
      info.size === data.length &&
      (await readFile(file)).equals(data)
    )
      continue;
    await write(file, data);
  }
  return captured
    ? [
        {
          tool: "claude-code",
          label: "Claude Code",
          memories: captured.memories,
          sessions: captured.sessions,
          settings: captured.config,
          warnings: captured.warnings,
        },
      ]
    : [];
}
export type ContextRestore = {
  tool: "claude-code";
  label: string;
} & ClaudeRestore;
/**
 * After a pull: hand the version's context to each tool, three-way against the
 * context this folder last received (so local work is never overwritten).
 */
export async function applyContext(
  base: string,
  incoming: Map<string, Buffer>,
  baseline: Map<string, Buffer>,
): Promise<ContextRestore[]> {
  const pick = (m: Map<string, Buffer>) =>
    new Map(
      [...m]
        .filter(([k]) => k.startsWith(CLAUDE_PREFIX))
        .map(([k, v]) => [k.slice(CLAUDE_PREFIX.length), v]),
    );
  const claude = pick(incoming);
  if (!claude.size) return [];
  const report = await restoreClaude(
    base,
    claude,
    pick(baseline),
    claudeLayout(),
  );
  return [{ tool: "claude-code", label: "Claude Code", ...report }];
}
/** One line per tool, for push/pull/status output. */
export function describeSummary(summary: ContextSummary[]) {
  return summary.map(
    (s) =>
      `${s.label}: ${s.memories} memor${s.memories === 1 ? "y" : "ies"}, ${s.sessions} session${s.sessions === 1 ? "" : "s"}${s.settings ? ", project settings" : ""}`,
  );
}
export function describeRestore(restored: ContextRestore[]) {
  const lines: string[] = [];
  for (const r of restored) {
    const parts = [
      `${r.memoryWritten} memor${r.memoryWritten === 1 ? "y" : "ies"}`,
      `${r.sessionsWritten} session${r.sessionsWritten === 1 ? "" : "s"}`,
    ];
    if (r.config === "merged") parts.push("project settings");
    lines.push(`${r.label}: restored ${parts.join(", ")}.`);
    if (r.memoryKept.length)
      lines.push(
        `  Kept your local version of ${r.memoryKept.length} memory file${r.memoryKept.length === 1 ? "" : "s"}: ${r.memoryKept.join(", ")}`,
      );
    if (r.sessionsKept.length)
      lines.push(
        `  Kept your local version of ${r.sessionsKept.length} session${r.sessionsKept.length === 1 ? "" : "s"} that changed on both machines.`,
      );
    if (r.config === "live-session")
      lines.push(
        "  Claude Code is running in this folder: project settings were not merged. Close it and run prj pull again.",
      );
    for (const w of r.warnings) lines.push(`  ${w}`);
  }
  return lines;
}
/** Read-only: what would travel for this folder (prj context). */
export async function detectContext(folder: string): Promise<ContextSummary[]> {
  const base = await realpath(folder);
  const captured = await captureClaude(
    base,
    { sessions: true },
    claudeLayout(),
  );
  return captured
    ? [
        {
          tool: "claude-code",
          label: "Claude Code",
          memories: captured.memories,
          sessions: captured.sessions,
          settings: captured.config,
          warnings: captured.warnings,
        },
      ]
    : [];
}
