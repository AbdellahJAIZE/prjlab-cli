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
/** What a version's entries actually carry for Claude Code. */
export function travelling(entries: readonly { path: string }[]) {
  const sessions = new Set<string>();
  let memories = 0,
    settings = false;
  for (const { path: name } of entries) {
    if (!name.startsWith(CLAUDE_PREFIX)) continue;
    const rel = name.slice(CLAUDE_PREFIX.length);
    if (rel.startsWith("memory/")) memories++;
    else if (rel.startsWith("sessions/")) sessions.add(rel.split("/")[1]!);
    else if (rel === "project.json") settings = true;
  }
  return { memories, sessions: sessions.size, settings };
}
/**
 * Report what the version carries, not what was found on this machine. Context
 * that was found but left out (by a .prjignore rule) becomes a warning, so a
 * push can never claim sessions it did not upload.
 */
export function reconcile(
  found: ContextSummary[],
  entries: readonly { path: string }[],
): ContextSummary[] {
  const sent = travelling(entries);
  return found.map((s) => {
    const warnings = [...s.warnings];
    const left = (n: number, one: string, many: string) =>
      `${n} ${n === 1 ? one : many} found on this machine ${n === 1 ? "is" : "are"} left out by .prjignore and ${n === 1 ? "was" : "were"} not uploaded.`;
    if (s.sessions > sent.sessions)
      warnings.push(left(s.sessions - sent.sessions, "session", "sessions"));
    if (s.memories > sent.memories)
      warnings.push(
        left(s.memories - sent.memories, "memory file", "memory files"),
      );
    return {
      ...s,
      memories: sent.memories,
      sessions: sent.sessions,
      settings: s.settings && sent.settings,
      warnings,
    };
  });
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
