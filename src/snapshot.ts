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
    const data = Buffer.alloc(max + 1);
    let count = 0;
    while (count <= max) {
      const { bytesRead } = await fd.read(data, count, max + 1 - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await fd.stat();
    if (
      count > max ||
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
async function scan(
  base: string,
  onFile?: (entry: Entry, data: Buffer) => Promise<void>,
  meta?: string,
): Promise<Snapshot> {
  const defaults = ignore().add(DEFAULT_IGNORE),
    custom = await rules(base, ".prjignore");
  const entries: Entry[] = [];
  let total = 0;
  type Rule = { prefix: string; matcher: ReturnType<typeof ignore> };
  async function walk(relative: string, inherited: Rule[]) {
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
      if (stat.isSymbolicLink())
        throw new ProjectError(
          "Capture refuses symbolic links. Exclude them explicitly.",
        );
      if (stat.isDirectory()) {
        await walk(name, all);
        continue;
      }
      if (!stat.isFile())
        throw new ProjectError("Capture supports regular files only.");
      const data = await readSafe(path.join(base, name), MAX_FILE);
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
    }
  }
  await walk("", []);
  if (meta) {
    // Tool context captured into .prj/context/agents/… (see context-mirror.ts).
    const mirror = mirrorRoot(meta);
    async function walkMirror(relative: string) {
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
          await walkMirror(rel);
          continue;
        }
        if (!item.isFile() || custom?.ignores(probe) || !isMirrorPath(name))
          continue;
        safePath(name);
        const data = await readSafe(path.join(mirror, rel), MAX_FILE);
        total += data.length;
        if (total > MAX_TOTAL || entries.length >= MAX_ENTRIES)
          throw new ProjectError(
            "Project exceeds development snapshot limits.",
          );
        const entry = {
          path: name,
          hash: digest(data),
          size: data.length,
          kind: kind(name),
        };
        entries.push(entry);
        await onFile?.(entry, data);
      }
    }
    await walkMirror("agents");
  }
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
export interface CaptureOptions {
  /** false: leave AI-tool sessions out of this capture (prj push --no-sessions). */
  sessions?: boolean;
}
export async function capture(root: string, options: CaptureOptions = {}) {
  const { base, meta } = await state(root);
  return locked(meta, async () => {
    const context = await refreshMirror(meta, base, {
      sessions: options.sessions !== false,
    });
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
    1024 * 1024,
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
) {
  const target = await load(meta, id),
    originalHead = await head(meta),
    baselineId =
      baselineOverride === undefined ? originalHead : baselineOverride,
    baseline = baselineId
      ? await load(meta, baselineId)
      : { version: 1 as const, entries: [] };
  const before = new Map(baseline.entries.map((e) => [e.path, e])),
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
        JSON.parse((await readSafe(file, 1024 * 1024)).toString("utf8")),
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
        const manifest = await scan(
          base,
          (entry, data) => store(meta, entry, data),
          meta,
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
      adopt: (id, baseline, checkpoint = async () => {}) =>
        restoreLocked(base, meta, id, checkpoint, baseline),
    }),
  );
}
