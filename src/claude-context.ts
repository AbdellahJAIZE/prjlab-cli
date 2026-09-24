// Claude Code context: what lives outside the project folder, keyed by its
// absolute path. Ported from ClaudeHub (packages/core: slug.ts, discover.ts,
// relocate.ts) and adapted to PrjLab versions (docs/19 in the PrjLab tracker).
//
//   ~/.claude/projects/<slug>/memory/**        project memory
//   ~/.claude/projects/<slug>/<sid>.jsonl       session transcripts
//   ~/.claude/projects/<slug>/<sid>/**          subagents, tool results, titles
//   ~/.claude.json projects["/abs/path"]        trust, allowed tools, MCP
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  readdir,
  readFile,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";

export const ROOT_TOKEN = "{{PRJ_PROJECT_ROOT}}";
export const DIR_TOKEN = "{{PRJ_CLAUDE_PROJECT_DIR}}";
/** Transcripts are cut at the first line end after this many bytes, so an
 * appended session changes only its last segment and earlier ones dedupe. */
export const SEGMENT_BYTES = 1024 * 1024;
const MAX_OBJECT = 5 * 1024 * 1024;
const MAX_TRANSCRIPT = 256 * 1024 * 1024;
/** Per-project keys that describe the project, not this machine (ClaudeHub types.ts). */
export const PORTABLE_CONFIG_KEYS = [
  "allowedTools",
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "mcpContextUris",
  "hasTrustDialogAccepted",
  "hasClaudeMdExternalIncludesApproved",
  "hasClaudeMdExternalIncludesWarningShown",
  "projectOnboardingSeenCount",
  "exampleFiles",
] as const;

export interface ClaudeLayout {
  /** ~/.claude, or CLAUDE_CONFIG_DIR */
  dir: string;
  /** ~/.claude.json, or CLAUDE_CONFIG_DIR/.claude.json */
  config: string;
  /** where PrjLab keeps backups of the config before writing it */
  backups: string;
}
export function claudeLayout(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ClaudeLayout {
  const custom = env.CLAUDE_CONFIG_DIR;
  const dir = custom ? path.resolve(custom) : path.join(home, ".claude");
  return {
    dir,
    config: custom
      ? path.join(dir, ".claude.json")
      : path.join(home, ".claude.json"),
    backups: path.join(home, ".prjlab", "backups"),
  };
}
/** Claude Code's observed rule: every non-alphanumeric character becomes "-". */
export function computeSlug(projectPath: string) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}
async function exists(file: string) {
  return lstat(file).then(
    (s) => s,
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    },
  );
}
/**
 * The history directory for a project. An existing directory wins over the
 * computed rule (ClaudeHub resolveSlug): the rule was verified on real paths,
 * but paths with underscores were never observed, so alternatives are scanned.
 */
export async function resolveProjectDir(layout: ClaudeLayout, root: string) {
  const projects = path.join(layout.dir, "projects");
  const computed = computeSlug(root);
  if ((await exists(path.join(projects, computed)))?.isDirectory())
    return { dir: path.join(projects, computed), found: true };
  const alternatives = new Set([
    root.replace(/[/\\.\s]/g, "-"),
    root.replace(/[/\\.\s_]/g, "-"),
  ]);
  const names = await readdir(projects).catch(() => [] as string[]);
  for (const name of names)
    if (
      alternatives.has(name) ||
      (process.platform === "win32" &&
        name.toLowerCase() === computed.toLowerCase())
    )
      if ((await exists(path.join(projects, name)))?.isDirectory())
        return { dir: path.join(projects, name), found: true };
  return { dir: path.join(projects, computed), found: false };
}
function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Plain and JSON-escaped spellings of a path (Windows backslashes double in JSON). */
function spellings(value: string) {
  const json = JSON.stringify(value).slice(1, -1);
  return json === value ? [value] : [json, value];
}
/** Replace this machine's paths with placeholders; a path must end at a boundary. */
export function portable(text: string, root: string, projectDir: string) {
  let out = text;
  for (const [value, token] of [
    [projectDir, DIR_TOKEN],
    [root, ROOT_TOKEN],
  ] as const)
    for (const spelling of spellings(value))
      out = out.replace(
        new RegExp(escapeRegExp(spelling) + "(?![A-Za-z0-9_.-])", "g"),
        token,
      );
  return out;
}
/** Put this machine's paths back. JSON files get JSON-escaped paths. */
export function localize(
  text: string,
  root: string,
  projectDir: string,
  json: boolean,
) {
  const spell = (v: string) => (json ? JSON.stringify(v).slice(1, -1) : v);
  return text
    .split(DIR_TOKEN)
    .join(spell(projectDir))
    .split(ROOT_TOKEN)
    .join(spell(root));
}
const isJson = (name: string) => /\.(jsonl|json)$/i.test(name);
function isText(data: Buffer) {
  if (data.subarray(0, 8000).includes(0)) return false;
  return Buffer.from(data.toString("utf8"), "utf8").equals(data);
}
/** Cut at line ends once a segment reaches SEGMENT_BYTES. Deterministic. */
export function segment(transcript: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  while (start < transcript.length) {
    let end = Math.min(start + SEGMENT_BYTES, transcript.length);
    if (end < transcript.length) {
      const newline = transcript.indexOf(0x0a, end - 1);
      end = newline === -1 ? transcript.length : newline + 1;
    }
    parts.push(transcript.subarray(start, end));
    start = end;
  }
  return parts;
}
/** A transcript being written may end mid-line; keep only complete lines. */
export function completeLines(data: Buffer) {
  const last = data.lastIndexOf(0x0a);
  return last === -1 ? Buffer.alloc(0) : data.subarray(0, last + 1);
}
const gzip = (data: Buffer) => gzipSync(data, { level: 9 });
async function walk(dir: string, relative = ""): Promise<string[]> {
  const out: string[] = [];
  const items = await readdir(path.join(dir, relative), {
    withFileTypes: true,
  }).catch(() => []);
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) out.push(...(await walk(dir, rel)));
    else if (item.isFile()) out.push(rel);
  }
  return out;
}
export interface ClaudeCapture {
  /** paths relative to agents/claude-code/ in the version */
  files: Map<string, Buffer>;
  memories: number;
  sessions: number;
  config: boolean;
  warnings: string[];
}
async function readConfig(layout: ClaudeLayout) {
  const info = await exists(layout.config);
  if (!info?.isFile()) return undefined;
  const raw = await readFile(layout.config, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return { raw, parsed: parsed as Record<string, unknown>, mode: info.mode };
  } catch {
    // ClaudeHub: never guess on a corrupt config.
    throw new Error("unreadable");
  }
}
function projectEntry(config: Record<string, unknown>, root: string) {
  const projects = config.projects as Record<string, unknown> | undefined;
  if (!projects || typeof projects !== "object") return undefined;
  const keys = [root, root.replace(/\\/g, "/")];
  for (const key of Object.keys(projects))
    if (
      keys.includes(key) ||
      (process.platform === "win32" &&
        keys.some((k) => k.toLowerCase() === key.toLowerCase()))
    )
      return { key, value: projects[key] as Record<string, unknown> };
  return undefined;
}
/** Everything Claude Code keeps for this project, ready to travel. */
export async function captureClaude(
  root: string,
  options: { sessions: boolean },
  layout = claudeLayout(),
): Promise<ClaudeCapture | null> {
  const { dir, found } = await resolveProjectDir(layout, root);
  const result: ClaudeCapture = {
    files: new Map(),
    memories: 0,
    sessions: 0,
    config: false,
    warnings: [],
  };
  if (found) {
    for (const rel of await walk(path.join(dir, "memory"))) {
      const data = await readFile(path.join(dir, "memory", rel));
      if (data.length > MAX_OBJECT) {
        result.warnings.push(`Claude memory file too large, skipped: ${rel}`);
        continue;
      }
      result.files.set(`memory/${rel}`, data);
      result.memories++;
    }
    if (options.sessions) {
      const top = await readdir(dir, { withFileTypes: true });
      const ids = new Set<string>();
      for (const item of top) {
        if (item.isFile() && item.name.endsWith(".jsonl"))
          ids.add(item.name.slice(0, -6));
        else if (item.isDirectory() && item.name !== "memory")
          ids.add(item.name);
      }
      for (const sid of [...ids].sort()) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(sid)) continue;
        const pieces = new Map<string, Buffer>();
        let fits = true;
        const transcriptFile = path.join(dir, `${sid}.jsonl`);
        if ((await exists(transcriptFile))?.isFile()) {
          const info = await lstat(transcriptFile);
          if (info.size > MAX_TRANSCRIPT) fits = false;
          else {
            const text = Buffer.from(
              portable(
                completeLines(await readFile(transcriptFile)).toString("utf8"),
                root,
                dir,
              ),
              "utf8",
            );
            segment(text).forEach((part, i) =>
              pieces.set(
                `sessions/${sid}/transcript.${String(i).padStart(4, "0")}.jsonl.gz`,
                gzip(part),
              ),
            );
          }
        }
        for (const rel of await walk(path.join(dir, sid))) {
          let data: Buffer = await readFile(path.join(dir, sid, rel));
          if (rel.endsWith(".jsonl")) data = completeLines(data);
          if (isText(data))
            data = Buffer.from(portable(data.toString("utf8"), root, dir));
          pieces.set(`sessions/${sid}/files/${rel}.gz`, gzip(data));
        }
        if (!pieces.size) continue;
        if (!fits || [...pieces.values()].some((p) => p.length > MAX_OBJECT)) {
          result.warnings.push(
            `Claude session ${sid.slice(0, 8)} is too large to upload and was skipped.`,
          );
          continue;
        }
        for (const [k, v] of pieces) result.files.set(k, v);
        result.sessions++;
      }
    }
  }
  let config;
  try {
    config = await readConfig(layout);
  } catch {
    result.warnings.push(
      `${layout.config} is not valid JSON; Claude project settings were not captured.`,
    );
  }
  const entry = config && projectEntry(config.parsed, root);
  if (entry && entry.value && typeof entry.value === "object") {
    const picked: Record<string, unknown> = {};
    for (const key of PORTABLE_CONFIG_KEYS)
      if (key in entry.value) picked[key] = entry.value[key];
    if (Object.keys(picked).length) {
      result.files.set(
        "project.json",
        Buffer.from(
          portable(
            JSON.stringify({ version: 1, config: picked }, null, 2) + "\n",
            root,
            dir,
          ),
        ),
      );
      result.config = true;
    }
  }
  return result.files.size ? result : found || entry ? result : null;
}

async function atomicWrite(file: string, data: Buffer | string, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.prjlab-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
function safeRelative(rel: string) {
  const parts = rel.split("/");
  if (
    !rel ||
    rel.startsWith("/") ||
    parts.some(
      (p) =>
        !p || p === "." || p === ".." || p.includes("\\") || p.includes(":"),
    )
  )
    throw new Error("unsafe context path");
  return parts;
}
/** Refuse to write outside the project's history directory (ClaudeHub CH-010). */
async function contained(base: string, rel: string) {
  const parts = safeRelative(rel);
  const top = await exists(base);
  if (top && (top.isSymbolicLink() || !top.isDirectory()))
    throw new Error("unsafe context path");
  let cursor = base;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const info = await exists(cursor);
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new Error("unsafe context path");
  }
  const target = path.join(base, ...parts);
  const info = await exists(target);
  if (info && (info.isSymbolicLink() || !info.isFile()))
    throw new Error("unsafe context path");
  return target;
}
async function readIfFile(file: string) {
  const info = await exists(file);
  return info?.isFile() ? readFile(file) : undefined;
}
/** Linux: is a `claude` process running with this folder as its directory? */
async function liveSession(root: string) {
  if (process.platform !== "linux") return false;
  const pids = await readdir("/proc").catch(() => [] as string[]);
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const cmd = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (!cmd.some((a) => /(^|\/)claude(\.js|\.exe)?$/.test(a))) continue;
      const cwd = await import("node:fs/promises").then((fs) =>
        fs.readlink(`/proc/${pid}/cwd`),
      );
      if (cwd === root || cwd.startsWith(root + path.sep)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
export interface ClaudeRestore {
  memoryWritten: number;
  memoryKept: string[];
  sessionsWritten: number;
  sessionsKept: string[];
  config: "merged" | "unchanged" | "none" | "live-session" | "no-claude";
  warnings: string[];
}
/**
 * Put a version's Claude context where Claude Code looks for THIS folder.
 * Local work always wins: a file is replaced only when it is missing, when
 * the incoming copy extends it (append-only transcripts), or when it is still
 * exactly what the last sync delivered. Everything kept is reported.
 */
export async function restoreClaude(
  root: string,
  incoming: Map<string, Buffer>,
  baseline: Map<string, Buffer>,
  layout = claudeLayout(),
): Promise<ClaudeRestore> {
  const report: ClaudeRestore = {
    memoryWritten: 0,
    memoryKept: [],
    sessionsWritten: 0,
    sessionsKept: [],
    config: "none",
    warnings: [],
  };
  const { dir } = await resolveProjectDir(layout, root);
  const text = (b: Buffer, name: string) =>
    isText(b)
      ? Buffer.from(localize(b.toString("utf8"), root, dir, isJson(name)))
      : b;
  // Memory: plain files, three-way against the last delivered copy.
  for (const [key, data] of incoming) {
    if (!key.startsWith("memory/")) continue;
    const rel = key.slice(7);
    const target = await contained(dir, `memory/${rel}`);
    const local = await readIfFile(target);
    if (local?.equals(data)) continue;
    if (!local || baseline.get(key)?.equals(local)) {
      await atomicWrite(target, data);
      report.memoryWritten++;
    } else report.memoryKept.push(rel);
  }
  for (const [key, data] of baseline) {
    if (!key.startsWith("memory/") || incoming.has(key)) continue;
    const target = await contained(dir, `memory/${key.slice(7)}`);
    const local = await readIfFile(target);
    if (local?.equals(data)) await unlink(target);
  }
  // Sessions: reassemble transcripts; never delete, never rewind.
  const sessions = new Map<
    string,
    { segments: [string, Buffer][]; files: [string, Buffer][] }
  >();
  for (const [key, data] of incoming) {
    const m =
      /^sessions\/([A-Za-z0-9_-]{1,100})\/(transcript\.\d{4}\.jsonl\.gz|files\/(.+)\.gz)$/.exec(
        key,
      );
    if (!m) continue;
    const s = sessions.get(m[1]!) ?? { segments: [], files: [] };
    if (m[3]) s.files.push([m[3], data]);
    else s.segments.push([m[2]!, data]);
    sessions.set(m[1]!, s);
  }
  for (const [sid, s] of sessions) {
    let changed = false,
      kept = false;
    const merge = async (
      target: string,
      next: Buffer,
      appendOnly: boolean,
      baseKey?: string,
    ) => {
      const local = await readIfFile(target);
      if (local?.equals(next)) return;
      if (
        !local ||
        (appendOnly && next.subarray(0, local.length).equals(local)) ||
        (baseKey !== undefined &&
          baseline.has(baseKey) &&
          text(gunzipSync(baseline.get(baseKey)!), target).equals(local))
      ) {
        await atomicWrite(target, next);
        changed = true;
      } else if (!(appendOnly && local.subarray(0, next.length).equals(next)))
        kept = true;
    };
    if (s.segments.length) {
      const joined = Buffer.concat(
        s.segments
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, d]) => gunzipSync(d)),
      );
      await merge(
        await contained(dir, `${sid}.jsonl`),
        text(joined, "x.jsonl"),
        true,
      );
    }
    for (const [rel, data] of s.files) {
      const target = await contained(dir, `${sid}/${rel}`);
      await merge(
        target,
        text(gunzipSync(data), rel),
        rel.endsWith(".jsonl"),
        `sessions/${sid}/files/${rel}.gz`,
      );
    }
    if (changed) report.sessionsWritten++;
    if (kept) report.sessionsKept.push(sid);
  }
  // Per-project settings: merged into ~/.claude.json, local values win.
  const incomingConfig = incoming.get("project.json");
  if (incomingConfig) {
    let config;
    try {
      config = await readConfig(layout);
    } catch {
      report.warnings.push(
        `${layout.config} is not valid JSON; Claude project settings were not restored.`,
      );
    }
    if (!config) {
      if (!report.warnings.length) report.config = "no-claude";
    } else if (await liveSession(root)) {
      report.config = "live-session";
    } else {
      const parsed = JSON.parse(
        localize(incomingConfig.toString("utf8"), root, dir, true),
      ) as { version?: number; config?: Record<string, unknown> };
      const picked: Record<string, unknown> = {};
      for (const key of PORTABLE_CONFIG_KEYS)
        if (parsed.config && key in parsed.config)
          picked[key] = parsed.config[key];
      const projects = (config.parsed.projects ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const current = projectEntry(config.parsed, root);
      const existing = (current?.value ?? {}) as Record<string, unknown>;
      const merged = { ...picked, ...existing };
      if (JSON.stringify(merged) === JSON.stringify(existing))
        report.config = "unchanged";
      else {
        await mkdir(layout.backups, { recursive: true, mode: 0o700 });
        await atomicWrite(
          path.join(
            layout.backups,
            `claude.json.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
          ),
          config.raw,
        );
        projects[current?.key ?? root] = merged;
        config.parsed.projects = projects;
        await atomicWrite(
          layout.config,
          JSON.stringify(config.parsed, null, 2),
          config.mode & 0o777,
        );
        await chmod(layout.config, config.mode & 0o777).catch(() => {});
        report.config = "merged";
      }
    }
  }
  return report;
}
