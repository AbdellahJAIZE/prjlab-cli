import { constants } from "node:fs";
import {
  open,
  mkdir,
  lstat,
  realpath,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import ignore from "ignore";
import {
  AGENTS_PREFIX,
  isMirrorPath,
  mirrorRoot,
  refreshMirror,
  applyContext,
  type ContextSummary,
  type ContextRestore,
} from "./context-mirror.js";
import {
  ProjectError,
  safePath,
  validateSnapshot,
  MAX_FILE,
  MAX_TOTAL,
  MAX_ENTRIES,
  HASH,
  type Entry,
  type Snapshot,
} from "./manifest.js";
export {
  ProjectError,
  safePath,
  validateSnapshot,
  type Entry,
  type Snapshot,
} from "./manifest.js";
// A snapshot of MAX_ENTRIES entries with 240-character paths is about 1.8 MiB;
// a restore journal lists up to twice as many paths.
const SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024,
  JOURNAL_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_IGNORE = [
  ".git",
  ".git/",
  ".prj",
  ".prj/",
  "node_modules/",
  ".next/",
  "dist/",
  "coverage/",
  ".env",
  ".env.*",
  "!.env.example",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  ".ssh/",
  ".aws/",
  ".azure/",
  ".config/",
  "credentials.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
];
const digest = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
async function statOrMissing(file: string) {
  try {
    return await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
async function directory(file: string) {
  const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ProjectError("Project directories must not be symbolic links.");
}
async function readSafe(file: string, max: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink > 1 ||
    stat.size > max
  )
    throw new ProjectError("Unsupported, linked or oversized file.");
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat();
    if (
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      !opened.isFile() ||
      opened.size > max
    )
      throw new ProjectError("File changed while being read.");
    // One spare byte reveals a file that grew while it was being read.
    const capacity = Math.min(max, opened.size) + 1;
    const data = Buffer.alloc(capacity);
    let count = 0;
    while (count < capacity) {
      const { bytesRead } = await fd.read(data, count, capacity - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await fd.stat();
    if (
      count > max ||
      count !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new ProjectError("File changed while being read.");
    return data.subarray(0, count);
  } finally {
    await fd.close();
  }
}
async function atomic(file: string, data: string | Buffer) {
  const temp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  const fd = await open(temp, "wx", 0o600);
  try {
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    const existing = await statOrMissing(file);
    if (
      existing &&
      (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)
    )
      throw new ProjectError("Unsafe metadata destination.");
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
async function state(root: string) {
  const base = await realpath(root),
    meta = path.join(base, ".prj");
  if (!(await statOrMissing(meta)))
    throw new ProjectError(
      "This folder is not set up for PrjLab yet. Run prj init first.",
    );
  await directory(meta);
  await directory(path.join(meta, "objects"));
  await directory(path.join(meta, "snapshots"));
  return { base, meta };
}
/**
 * A lock left behind by a process that no longer exists (killed push, power
 * loss) is stale: it is removed and the operation proceeds. A lock held by a
 * live process, or one whose contents cannot be read, stays untouched.
 */
async function clearStaleLock(lock: string): Promise<boolean> {
  const pid = Number((await readSafe(lock, 20)).toString("utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  try {
    await unlink(lock);
    return true;
  } catch {
    return false;
  }
}
async function locked<T>(
  meta: string,
  work: () => Promise<T>,
  allowPending = false,
): Promise<T> {
  const lock = path.join(meta, "lock");
  let fd;
  for (let attempt = 0; ; attempt++) {
    try {
      fd = await open(lock, "wx", 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (attempt === 0 && (await clearStaleLock(lock))) continue;
      throw new ProjectError(
        "Another operation is active. If nothing is running, prj recover removes the stale lock.",
      );
    }
  }
  try {
    await fd.writeFile(String(process.pid));
    if (!allowPending && (await statOrMissing(path.join(meta, "restore.json"))))
      throw new ProjectError(
        "An interrupted restore needs recovery. Run prj recover.",
      );
    return await work();
  } finally {
    await fd.close();
    await unlink(path.join(meta, "lock"));
  }
}
export async function initialize(root: string) {
  const base = await realpath(root),
    meta = path.join(base, ".prj");
  if (await statOrMissing(meta))
    throw new ProjectError(
      "Project is already initialized or .prj is occupied.",
    );
  await mkdir(meta, { mode: 0o700 });
  await mkdir(path.join(meta, "objects"), { mode: 0o700 });
  await mkdir(path.join(meta, "snapshots"), { mode: 0o700 });
  await atomic(
    path.join(meta, "config.json"),
    JSON.stringify({ version: 1 }) + "\n",
  );
}
function kind(name: string): Entry["kind"] {
  if (name.startsWith(".prjcontext/memory/")) return "memory";
  if (name.startsWith(".prjcontext/sessions/")) return "session";
  const agent = /^\.prjcontext\/agents\/[a-z0-9-]+\/(memory|sessions)\//.exec(
    name,
  );
  if (agent) return agent[1] === "memory" ? "memory" : "session";
  if (name.startsWith(AGENTS_PREFIX)) return "instruction";
  if (
    name.startsWith(".prjcontext/instructions/") ||
    ["CLAUDE.md", "AGENTS.md"].includes(path.posix.basename(name))
  )
    return "instruction";
  return "file";
}
async function rules(directoryPath: string, name: string) {
  const file = path.join(directoryPath, name);
  if (!(await statOrMissing(file))) return undefined;
  return ignore().add((await readSafe(file, 65536)).toString("utf8"));
}
/**
 * The root .prjignore, as two matchers. Folder files obey every rule. Tool
 * context (memory, sessions) obeys only the rules that name .prjcontext: a
 * broad rule such as `*` or `/*` is about the folder, and must not silently
 * drop the context the user expects to travel.
 */
async function customRules(base: string) {
  const file = path.join(base, ".prjignore");
  if (!(await statOrMissing(file))) return {};
  const text = (await readSafe(file, 65536)).toString("utf8");
  const named = text
    .split(/\r?\n/)
    .filter((l) => !l.trimStart().startsWith("#") && l.includes(".prjcontext"));
  return {
    files: ignore().add(text),
    context: named.length ? ignore().add(named.join("\n")) : undefined,
  };
}
type Matcher = ReturnType<typeof ignore>;
type Rule = { prefix: string; matcher: Matcher };
/** Folder paths that pass the default, .prjignore and .gitignore rules. */
async function* included(
  base: string,
  custom: Matcher | undefined,
): AsyncGenerator<{
  name: string;
  size: number;
  link: boolean;
  regular: boolean;
}> {
  const defaults = ignore().add(DEFAULT_IGNORE);
  async function* walk(
    relative: string,
    inherited: Rule[],
  ): AsyncGenerator<{
    name: string;
    size: number;
    link: boolean;
    regular: boolean;
  }> {
    const full = path.join(base, relative);
    await directory(full);
    const own = await rules(full, ".gitignore"),
      all = own
        ? [...inherited, { prefix: relative, matcher: own }]
        : inherited;
    for (const item of (await readdir(full, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const name = relative ? `${relative}/${item.name}` : item.name,
        probe = name + (item.isDirectory() ? "/" : "");
      // .prjcontext/agents/ is reserved for tool context from the mirror.
      if (
        (probe + "/").startsWith(AGENTS_PREFIX) ||
        probe.startsWith(AGENTS_PREFIX)
      )
        continue;
      if (
        defaults.ignores(probe) ||
        custom?.ignores(probe) ||
        all.reduce((excluded, r) => {
          const result = r.matcher.test(
            probe.slice(r.prefix ? r.prefix.length + 1 : 0),
          );
          return result.ignored ? true : result.unignored ? false : excluded;
        }, false)
      )
        continue;
      safePath(name);
      const stat = await lstat(path.join(base, name));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        yield* walk(name, all);
        continue;
      }
      yield {
        name,
        size: stat.size,
        link: stat.isSymbolicLink(),
        regular: stat.isFile(),
      };
    }
  }
  yield* walk("", []);
}
/** Tool context in .prj/context that passes the .prjcontext rules of .prjignore. */
async function* mirrored(
  meta: string,
  custom: Matcher | undefined,
): AsyncGenerator<{ name: string; file: string; size: number }> {
  // Tool context captured into .prj/context/agents/… (see context-mirror.ts).
  const mirror = mirrorRoot(meta);
  async function* walk(
    relative: string,
  ): AsyncGenerator<{ name: string; file: string; size: number }> {
    const full = path.join(mirror, relative);
    if (!(await statOrMissing(full))) return;
    await directory(full);
    for (const item of (await readdir(full, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const rel = relative ? `${relative}/${item.name}` : item.name;
      const name = `.prjcontext/${rel}`;
      const probe = name + (item.isDirectory() ? "/" : "");
      if (item.isDirectory()) {
        if (custom?.ignores(probe)) continue;
        yield* walk(rel);
        continue;
      }
      if (!item.isFile() || custom?.ignores(probe) || !isMirrorPath(name))
        continue;
      safePath(name);
      const file = path.join(mirror, rel);
      yield { name, file, size: (await lstat(file)).size };
    }
  }
  yield* walk("agents");
}
/** What a capture of this folder would carry, measured without reading files. */
export interface Usage {
  /** Folder files that pass the ignore rules, and their bytes. */
  files: number;
  bytes: number;
  /** Tool context (memory, sessions, settings) entries and bytes. */
  contextEntries: number;
  contextBytes: number;
  sessions: number;
  /** Folder files above the per-file limit, largest first. */
  oversize: { path: string; size: number }[];
  /** Symbolic links, which a capture refuses. */
  links: string[];
  /** Top-level entries and the directories one level below them, largest first. */
  groups: { path: string; directory: boolean; files: number; bytes: number }[];
}
export function overLimits(usage: Usage) {
  return (
    usage.files + usage.contextEntries > MAX_ENTRIES ||
    usage.bytes + usage.contextBytes > MAX_TOTAL ||
    usage.oversize.length > 0 ||
    usage.links.length > 0
  );
}
const mib = (bytes: number) =>
  bytes >= 10 * 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024)).toLocaleString("en-US")} MiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const count = (n: number) => n.toLocaleString("en-US");
/** Plain-language account of which limit a folder exceeds, and by how much. */
export function describeUsage(usage: Usage): string[] {
  const entries = usage.files + usage.contextEntries,
    total = usage.bytes + usage.contextBytes;
  const lines = [
    "This folder is over PrjLab's limits, so nothing was uploaded:",
    `  entries    ${count(entries)} of ${count(MAX_ENTRIES)}${entries > MAX_ENTRIES ? "  (over)" : ""}  — ${count(usage.files)} files + ${count(usage.contextEntries)} context`,
    `  size       ${mib(total)} of ${mib(MAX_TOTAL)}${total > MAX_TOTAL ? "  (over)" : ""}  — ${mib(usage.bytes)} files + ${mib(usage.contextBytes)} context`,
  ];
  if (usage.oversize.length)
    lines.push(
      `  too large  ${count(usage.oversize.length)} file${usage.oversize.length === 1 ? "" : "s"} over ${mib(MAX_FILE)} each, largest ${usage.oversize[0]!.path} (${mib(usage.oversize[0]!.size)})`,
    );
  if (usage.links.length)
    lines.push(
      `  links      ${count(usage.links.length)} symbolic link${usage.links.length === 1 ? "" : "s"} (not supported), first ${usage.links[0]}`,
    );
  if (usage.groups.length) {
    lines.push("Largest parts of the folder:");
    for (const g of usage.groups.slice(0, 8))
      lines.push(
        `  ${count(g.files).padStart(7)} file${g.files === 1 ? " " : "s"}  ${mib(g.bytes).padStart(10)}  ${g.path}${g.directory ? "/" : ""}`,
      );
  }
  if (
    usage.contextEntries > MAX_ENTRIES ||
    usage.contextBytes > MAX_TOTAL ||
    (!usage.files && !usage.oversize.length && !usage.links.length)
  )
    lines.push(
      `The AI context alone is over the limits (${count(usage.sessions)} session${usage.sessions === 1 ? "" : "s"}). prj push --no-sessions uploads memory and settings without sessions.`,
    );
  lines.push(
    "Leave parts out with a .prjignore file (same syntax as .gitignore), or run prj push in a terminal to choose what stays out.",
  );
  return lines;
}
/** A capture that cannot fit the limits; carries the measurements for the caller. */
export class LimitError extends ProjectError {
  constructor(readonly usage: Usage) {
    super(describeUsage(usage).join("\n"));
  }
}
async function survey(
  base: string,
  meta: string,
  contextOnly = false,
): Promise<Usage> {
  const custom = await customRules(base);
  const usage: Usage = {
    files: 0,
    bytes: 0,
    contextEntries: 0,
    contextBytes: 0,
    sessions: 0,
    oversize: [],
    links: [],
    groups: [],
  };
  const groups = new Map<string, Usage["groups"][number]>();
  // In a git folder git carries the files: only the context is measured.
  for await (const item of contextOnly ? [] : included(base, custom.files)) {
    if (item.link) {
      usage.links.push(item.name);
      continue;
    }
    if (!item.regular) continue;
    usage.files++;
    usage.bytes += item.size;
    if (item.size > MAX_FILE)
      usage.oversize.push({ path: item.name, size: item.size });
    // Each file counts towards its top-level entry and, when it sits deeper,
    // towards the directory one level down, so both "JOBS/" and "JOBS/_scan/"
    // can be named.
    const segments = item.name.split("/");
    const keys = [segments[0]!];
    if (segments.length > 2) keys.push(segments.slice(0, 2).join("/"));
    for (const [depth, key] of keys.entries()) {
      const group = groups.get(key) ?? {
        path: key,
        directory: depth === 1 || segments.length > 1,
        files: 0,
        bytes: 0,
      };
      group.files++;
      group.bytes += item.size;
      groups.set(key, group);
    }
  }
  const sessions = new Set<string>();
  for await (const item of mirrored(meta, custom.context)) {
    usage.contextEntries++;
    usage.contextBytes += item.size;
    const session =
      /^\.prjcontext\/agents\/[a-z0-9-]+\/sessions\/([^/]+)\//.exec(item.name);
    if (session) sessions.add(session[1]!);
  }
  usage.sessions = sessions.size;
  usage.oversize.sort((a, b) => b.size - a.size);
  usage.groups = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  return usage;
}
async function scan(
  base: string,
  onFile?: (entry: Entry, data: Buffer) => Promise<void>,
  meta?: string,
  contextOnly = false,
): Promise<Snapshot> {
  const custom = await customRules(base);
  const entries: Entry[] = [];
  let total = 0;
  const add = async (name: string, file: string) => {
    const data = await readSafe(file, MAX_FILE);
    total += data.length;
    if (total > MAX_TOTAL || entries.length >= MAX_ENTRIES)
      throw new ProjectError("Project exceeds development snapshot limits.");
    const entry = {
      path: name,
      hash: digest(data),
      size: data.length,
      kind: kind(name),
    };
    entries.push(entry);
    await onFile?.(entry, data);
  };
  for await (const item of contextOnly ? [] : included(base, custom.files)) {
    if (item.link)
      throw new ProjectError(
        "Capture refuses symbolic links. Exclude them explicitly.",
      );
    if (!item.regular)
      throw new ProjectError("Capture supports regular files only.");
    await add(item.name, path.join(base, item.name));
  }
  if (meta)
    for await (const item of mirrored(meta, custom.context))
      await add(item.name, item.file);
  return validateSnapshot({
    version: 1,
    entries: entries.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  });
}
async function store(meta: string, entry: Entry, data: Buffer) {
  const file = path.join(meta, "objects", entry.hash);
  if (await statOrMissing(file)) {
    if (digest(await readSafe(file, MAX_FILE)) !== entry.hash)
      throw new ProjectError("Stored object is corrupt.");
    return;
  }
  await atomic(file, data);
}
/** Refuse an over-limit folder up front, saying which limit and what is largest. */
async function withinLimits(base: string, meta: string, contextOnly = false) {
  const usage = await survey(base, meta, contextOnly);
  if (overLimits(usage)) throw new LimitError(usage);
}
/** Read-only measurement of what a push of this folder would carry. */
export async function measure(root: string, options: CaptureOptions = {}) {
  const { base, meta } = await state(root);
  return locked(meta, async () => {
    await refreshMirror(meta, base, { sessions: options.sessions !== false });
    return survey(base, meta);
  });
}
export interface CaptureOptions {
  /** false: leave AI-tool sessions out of this capture (prj push --no-sessions). */
  sessions?: boolean;
  /** Git folders: capture only the AI-tool context, git carries the files. */
  contextOnly?: boolean;
}
export async function capture(root: string, options: CaptureOptions = {}) {
  const { base, meta } = await state(root);
  return locked(meta, async () => {
    const context = await refreshMirror(meta, base, {
      sessions: options.sessions !== false,
    });
    await withinLimits(base, meta);
    const snapshot = await scan(
      base,
      (entry, data) => store(meta, entry, data),
      meta,
    );
    const json = JSON.stringify(snapshot),
      id = digest(Buffer.from(json));
    await atomic(path.join(meta, "snapshots", id + ".json"), json);
    await atomic(path.join(meta, "HEAD"), id + "\n");
    return { id, ...snapshot, context };
  });
}
async function load(meta: string, id: string) {
  if (!HASH.test(id)) throw new ProjectError("Invalid snapshot ID.");
  const bytes = await readSafe(
    path.join(meta, "snapshots", id + ".json"),
    SNAPSHOT_FILE_BYTES,
  );
  if (digest(bytes) !== id)
    throw new ProjectError("Snapshot integrity check failed.");
  return validateSnapshot(JSON.parse(bytes.toString("utf8")));
}
export async function status(root: string) {
  const { base, meta } = await state(root);
  return locked(meta, async () => {
    const head = (await statOrMissing(path.join(meta, "HEAD")))
      ? (await readSafe(path.join(meta, "HEAD"), 65)).toString("utf8").trim()
      : undefined;
    const previous = head
      ? await load(meta, head)
      : { version: 1 as const, entries: [] };
    const context = await refreshMirror(meta, base, { sessions: true });
    await withinLimits(base, meta);
    const current = await scan(base, undefined, meta);
    const before = new Map(previous.entries.map((e) => [e.path, e.hash])),
      after = new Map(current.entries.map((e) => [e.path, e.hash]));
    return {
      head: head ?? null,
      added: current.entries
        .filter((e) => !before.has(e.path))
        .map((e) => e.path),
      modified: current.entries
        .filter((e) => before.has(e.path) && before.get(e.path) !== e.hash)
        .map((e) => e.path),
      deleted: previous.entries
        .filter((e) => !after.has(e.path))
        .map((e) => e.path),
      context,
    };
  });
}
export async function exportSnapshot(
  root: string,
  id: string,
  destination: string,
) {
  const { meta } = await state(root);
  return locked(meta, async () => {
    const snapshot = await load(meta, id),
      target = path.resolve(destination),
      parent = path.dirname(target);
    // Reject existing targets and any symlink in the destination's ancestor chain.
    let ancestor = parent;
    while (true) {
      await directory(ancestor);
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    if (await statOrMissing(target))
      throw new ProjectError(
        "Export requires a new directory. Existing work is never overwritten.",
      );
    for (const entry of snapshot.entries) {
      const data = await readSafe(
        path.join(meta, "objects", entry.hash),
        MAX_FILE,
      );
      if (data.length !== entry.size || digest(data) !== entry.hash)
        throw new ProjectError("Stored object integrity check failed.");
    }
    await mkdir(target, { mode: 0o700 });
    try {
      for (const entry of snapshot.entries) {
        const output = path.join(target, ...entry.path.split("/"));
        await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        let cursor = path.dirname(output);
        while (cursor !== parent) {
          await directory(cursor);
          cursor = path.dirname(cursor);
        }
        const data = await readSafe(
          path.join(meta, "objects", entry.hash),
          MAX_FILE,
        );
        if (data.length !== entry.size || digest(data) !== entry.hash)
          throw new ProjectError("Stored object changed during export.");
        const file = await open(
          output,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await file.writeFile(data);
          await file.sync();
        } finally {
          await file.close();
        }
      }
    } catch {
      throw new ProjectError(
        "Export interrupted. Partial files remain in the new directory; the source snapshot is unchanged.",
      );
    }
    return snapshot.entries.length;
  });
}
interface Content {
  hash: string;
  size: number;
}
interface Change {
  path: string;
  before: Content | null;
  after: Content | null;
}
interface Journal {
  version: 1;
  base: string | null;
  target: string;
  changes: Change[];
}
async function head(meta: string): Promise<string | null> {
  const file = path.join(meta, "HEAD");
  return (await statOrMissing(file))
    ? (await readSafe(file, 65)).toString("utf8").trim()
    : null;
}
/** Tool context lives in .prj/context/, everything else in the folder. */
function locate(base: string, name: string): [string, string] {
  return isMirrorPath(name)
    ? [path.join(base, ".prj", "context"), name.slice(".prjcontext/".length)]
    : [base, name];
}
function diskPath(base: string, name: string) {
  const [root, rel] = locate(base, name);
  return path.join(root, ...rel.split("/"));
}
async function current(base: string, name: string): Promise<Content | null> {
  safePath(name);
  [base, name] = locate(base, name);
  if (!(await statOrMissing(base))) return null;
  const parts = name.split("/");
  let cursor = base;
  for (const part of parts.slice(0, -1)) {
    if (
      (await readdir(cursor)).some(
        (name) => name !== part && name.toLowerCase() === part.toLowerCase(),
      )
    )
      throw new ProjectError(
        "Restore conflicts with an existing case-variant path.",
      );
    cursor = path.join(cursor, part);
    const stat = await statOrMissing(cursor);
    if (!stat) return null;
    await directory(cursor);
  }
  const leaf = parts[parts.length - 1]!;
  if (
    (await readdir(cursor)).some(
      (name) => name !== leaf && name.toLowerCase() === leaf.toLowerCase(),
    )
  )
    throw new ProjectError(
      "Restore conflicts with an existing case-variant path.",
    );
  const file = path.join(base, ...parts);
  if (!(await statOrMissing(file))) return null;
  const data = await readSafe(file, MAX_FILE);
  return { hash: digest(data), size: data.length };
}
async function object(meta: string, content: Content) {
  const data = await readSafe(
    path.join(meta, "objects", content.hash),
    MAX_FILE,
  );
  if (data.length !== content.size || digest(data) !== content.hash)
    throw new ProjectError("Stored object integrity check failed.");
  return data;
}
async function writeChange(
  base: string,
  meta: string,
  name: string,
  content: Content | null,
) {
  safePath(name);
  const mirror = isMirrorPath(name);
  [base, name] = locate(base, name);
  if (mirror && content) await mkdir(base, { recursive: true, mode: 0o700 });
  if (mirror && !content && !(await statOrMissing(base))) return;
  const parts = name.split("/");
  let cursor = base;
  if (content) {
    const data = await object(meta, content);
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      await directory(cursor);
    }
    await atomic(path.join(base, ...parts), data);
  } else {
    for (const part of parts.slice(0, -1)) {
      cursor = path.join(cursor, part);
      await directory(cursor);
    }
    await unlink(path.join(base, ...parts));
  }
}
const same = (a: Content | null, b: Content | null) =>
  a?.hash === b?.hash && a?.size === b?.size;
async function rollback(base: string, meta: string, journal: Journal) {
  for (const change of [...journal.changes].reverse()) {
    const local = await current(base, change.path);
    if (same(local, change.before)) continue;
    if (!same(local, change.after))
      throw new ProjectError(
        "Recovery found edits made after the interrupted restore. Keep them safe before retrying recovery.",
      );
    await writeChange(base, meta, change.path, change.before);
  }
  await unlink(path.join(meta, "restore.json"));
}
/** Three-way restore. The checkpoint callback is for fault-injection tests. */
export async function restoreSnapshot(
  root: string,
  id: string,
  checkpoint: () => Promise<void> = async () => {},
) {
  const { base, meta } = await state(root);
  return locked(meta, () => restoreLocked(base, meta, id, checkpoint));
}
async function restoreLocked(
  base: string,
  meta: string,
  id: string,
  checkpoint: () => Promise<void>,
  baselineOverride?: string | null,
  mirrorOnly = false,
) {
  const loaded = await load(meta, id);
  // Context-only sync (git folders): never touch the folder's own files.
  const target = mirrorOnly
    ? { ...loaded, entries: loaded.entries.filter((e) => isMirrorPath(e.path)) }
    : loaded;
  const originalHead = await head(meta),
    baselineId =
      baselineOverride === undefined ? originalHead : baselineOverride,
    baseline = baselineId
      ? await load(meta, baselineId)
      : { version: 1 as const, entries: [] };
  const before = new Map(
      baseline.entries
        .filter((e) => !mirrorOnly || isMirrorPath(e.path))
        .map((e) => [e.path, e]),
    ),
    after = new Map(target.entries.map((e) => [e.path, e]));
  // Catch portable collisions between untouched local and incoming names as well.
  const localSnapshot = await scan(base);
  const localFolded = new Map(
    localSnapshot.entries.map((e) => [e.path.toLowerCase(), e.path]),
  );
  for (const entry of target.entries) {
    const collision = localFolded.get(entry.path.toLowerCase());
    if (collision && collision !== entry.path)
      throw new ProjectError(
        "Restore conflicts with an existing case-variant path.",
      );
    await object(meta, entry);
  }
  const changes: Change[] = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(name) ?? null,
      incoming = after.get(name) ?? null;
    if (same(previous, incoming)) continue;
    const local = await current(base, name);
    if (same(local, incoming)) continue;
    // Tool context in .prj/context is a cache of what the tools hold; the real
    // three-way merge happens when it is applied to the tool (applyContext).
    if (!same(local, previous) && !isMirrorPath(name))
      throw new ProjectError(
        "Restore conflicts with local edits or untracked files. Nothing was changed.",
      );
    if (local) {
      const data = await readSafe(diskPath(base, name), MAX_FILE);
      await store(meta, { path: name, ...local, kind: "file" }, data);
    }
    changes.push({
      path: name,
      before: local,
      after: incoming ? { hash: incoming.hash, size: incoming.size } : null,
    });
  }
  if (!changes.length) {
    await atomic(path.join(meta, "HEAD"), id + "\n");
    return { changed: 0 };
  }
  const journal: Journal = {
    version: 1,
    base: originalHead,
    target: id,
    changes,
  };
  await atomic(path.join(meta, "restore.json"), JSON.stringify(journal));
  try {
    for (const change of changes) {
      if (!same(await current(base, change.path), change.before))
        throw new ProjectError("Working files changed during restore.");
      await writeChange(base, meta, change.path, change.after);
      await checkpoint();
    }
    // Commit only after every planned write/deletion succeeds.
    await atomic(path.join(meta, "HEAD"), id + "\n");
  } catch (error) {
    try {
      await rollback(base, meta, journal);
    } catch {
      throw new ProjectError(
        "Restore interrupted and needs recovery. The baseline was not advanced. Run prj recover.",
      );
    }
    throw new ProjectError(
      "Restore failed and was rolled back. The baseline was not advanced.",
    );
  }
  await unlink(path.join(meta, "restore.json"));
  return { changed: changes.length };
}

function validateJournal(value: unknown): Journal {
  if (!value || typeof value !== "object")
    throw new ProjectError("Invalid recovery journal.");
  const j = value as Journal;
  if (
    j.version !== 1 ||
    !(j.base === null || (typeof j.base === "string" && HASH.test(j.base))) ||
    typeof j.target !== "string" ||
    !HASH.test(j.target) ||
    !Array.isArray(j.changes) ||
    j.changes.length > MAX_ENTRIES * 2
  )
    throw new ProjectError("Invalid recovery journal.");
  const seen = new Set<string>();
  for (const c of j.changes) {
    if (!c || typeof c !== "object")
      throw new ProjectError("Invalid recovery journal.");
    safePath(c.path);
    if (seen.has(c.path.toLowerCase()))
      throw new ProjectError("Duplicate recovery path.");
    seen.add(c.path.toLowerCase());
    for (const content of [c.before, c.after])
      if (content !== null)
        validateSnapshot({
          version: 1,
          entries: [{ path: c.path, ...content, kind: "file" }],
        });
  }
  return j;
}
export async function recover(root: string) {
  const { base, meta } = await state(root);
  const lock = path.join(meta, "lock");
  if (await statOrMissing(lock)) {
    const pid = Number((await readSafe(lock, 20)).toString("utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new ProjectError("Invalid lock; inspect it manually.");
    try {
      process.kill(pid, 0);
      throw new ProjectError("An operation is still running.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await unlink(lock);
  }
  return locked(
    meta,
    async () => {
      const file = path.join(meta, "restore.json");
      if (!(await statOrMissing(file))) return { recovered: false };
      const journal = validateJournal(
        JSON.parse((await readSafe(file, JOURNAL_FILE_BYTES)).toString("utf8")),
      );
      const active = await head(meta);
      if (active === journal.target) {
        await unlink(file);
        return { recovered: true };
      }
      if (active !== journal.base)
        throw new ProjectError(
          "Recovery baseline does not match the interrupted operation.",
        );
      await rollback(base, meta, journal);
      return { recovered: true };
    },
    true,
  );
}

/** One project lock covers remote staging, workspace adoption and link updates. */
export async function withSync<T>(
  root: string,
  work: (project: {
    readLink: () => Promise<unknown>;
    writeLink: (value: unknown) => Promise<void>;
    removeLink: () => Promise<void>;
    readName: () => Promise<string | null>;
    writeName: (name: string | null) => Promise<void>;
    capture: (
      options?: CaptureOptions,
    ) => Promise<{ id: string; manifest: Snapshot; context: ContextSummary[] }>;
    applyContext: (
      target: string,
      baseline: string | null,
    ) => Promise<ContextRestore[]>;
    manifest: (id: string) => Promise<Snapshot>;
    bytes: (entry: Entry) => Promise<Buffer>;
    stage: (
      input: unknown,
      fetchObject: (entry: Entry) => Promise<Buffer>,
    ) => Promise<string>;
    adopt: (
      id: string,
      baseline: string | null,
      checkpoint?: () => Promise<void>,
      mirrorOnly?: boolean,
    ) => Promise<{ changed: number }>;
  }) => Promise<T>,
): Promise<T> {
  const { base, meta } = await state(root);
  return locked(meta, () =>
    work({
      readLink: async () =>
        (await statOrMissing(path.join(meta, "remote.json")))
          ? JSON.parse(
              (await readSafe(path.join(meta, "remote.json"), 4096)).toString(
                "utf8",
              ),
            )
          : null,
      writeLink: async (value) => {
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json) > 4096)
          throw new ProjectError("Remote state exceeds limit.");
        await atomic(path.join(meta, "remote.json"), json);
      },
      removeLink: async () => {
        for (const file of ["remote.json", "remote-name"])
          await unlink(path.join(meta, file)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          );
      },
      // Display name only (<handle>/<name>); the link itself is the repository ID.
      readName: async () => {
        const file = path.join(meta, "remote-name");
        if (!(await statOrMissing(file))) return null;
        const name = (await readSafe(file, 200)).toString("utf8").trim();
        return /^[a-z0-9-]{1,39}\/[a-z0-9-]{1,63}$/.test(name) ? name : null;
      },
      writeName: async (name) => {
        const file = path.join(meta, "remote-name");
        if (name === null)
          await unlink(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        else await atomic(file, name + "\n");
      },
      capture: async (options = {}) => {
        const context = await refreshMirror(meta, base, {
          sessions: options.sessions !== false,
        });
        await withinLimits(base, meta, options.contextOnly === true);
        const manifest = await scan(
          base,
          (entry, data) => store(meta, entry, data),
          meta,
          options.contextOnly === true,
        );
        const json = JSON.stringify(manifest),
          id = digest(Buffer.from(json));
        await atomic(path.join(meta, "snapshots", id + ".json"), json);
        return { id, manifest, context };
      },
      applyContext: async (target, baseline) => {
        const read = async (id: string | null) => {
          const out = new Map<string, Buffer>();
          if (!id) return out;
          for (const entry of (await load(meta, id)).entries)
            if (isMirrorPath(entry.path))
              out.set(entry.path, await object(meta, entry));
          return out;
        };
        return applyContext(base, await read(target), await read(baseline));
      },
      manifest: (id) => load(meta, id),
      bytes: (entry) => object(meta, entry),
      stage: async (input, fetchObject) => {
        const manifest = validateSnapshot(input);
        for (const entry of manifest.entries) {
          const bytes = await fetchObject(entry);
          if (bytes.length !== entry.size || digest(bytes) !== entry.hash)
            throw new ProjectError("Remote object integrity failed.");
          await store(meta, entry, bytes);
        }
        const json = JSON.stringify(manifest),
          id = digest(Buffer.from(json));
        await atomic(path.join(meta, "snapshots", id + ".json"), json);
        return id;
      },
      adopt: (id, baseline, checkpoint = async () => {}, mirrorOnly = false) =>
        restoreLocked(base, meta, id, checkpoint, baseline, mirrorOnly),
    }),
  );
}
