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
export class ProjectError extends Error {}
export interface Entry {
  path: string;
  hash: string;
  size: number;
  kind: "file" | "instruction" | "memory" | "session";
}
export interface Snapshot {
  version: 1;
  entries: Entry[];
}
const MAX_FILE = 5 * 1024 * 1024,
  MAX_TOTAL = 100 * 1024 * 1024,
  MAX_ENTRIES = 1000;
const HASH = /^[a-f0-9]{64}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
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
export function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 240 ||
    value !== value.normalize("NFC") ||
    Buffer.from(value).toString("utf8") !== value ||
    /[\\\x00-\x1f\x7f:*?"<>|]/.test(value)
  )
    throw new ProjectError("Unsafe snapshot path.");
  for (const segment of value.split("/"))
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/.test(segment) ||
      RESERVED.test(segment) ||
      segment.toLowerCase() === ".prj" ||
      segment.toLowerCase() === ".git"
    )
      throw new ProjectError("Unsafe snapshot path.");
  return value;
}
export function validateSnapshot(input: unknown): Snapshot {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProjectError("Invalid snapshot.");
  const value = input as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES ||
    Object.keys(value).some((k) => !["version", "entries"].includes(k))
  )
    throw new ProjectError("Invalid snapshot.");
  const seen = new Set<string>();
  let total = 0;
  const entries = value.entries.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ProjectError("Invalid snapshot entry.");
    const e = raw as Record<string, unknown>,
      name = safePath(e.path),
      folded = name.toLowerCase();
    if (
      seen.has(folded) ||
      typeof e.hash !== "string" ||
      !HASH.test(e.hash) ||
      !Number.isSafeInteger(e.size) ||
      (e.size as number) < 0 ||
      (e.size as number) > MAX_FILE ||
      !["file", "instruction", "memory", "session"].includes(String(e.kind)) ||
      Object.keys(e).some((k) => !["path", "hash", "size", "kind"].includes(k))
    )
      throw new ProjectError("Invalid or duplicate snapshot entry.");
    seen.add(folded);
    total += e.size as number;
    return {
      path: name,
      hash: e.hash,
      size: e.size as number,
      kind: e.kind as Entry["kind"],
    };
  });
  if (total > MAX_TOTAL) throw new ProjectError("Snapshot exceeds size limit.");
  for (const e of entries) {
    const parts = e.path.toLowerCase().split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/")))
        throw new ProjectError("Snapshot contains conflicting paths.");
      parts.pop();
    }
  }
  return { version: 1, entries };
}
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
  await directory(meta);
  await directory(path.join(meta, "objects"));
  await directory(path.join(meta, "snapshots"));
  return { base, meta };
}
async function locked<T>(
  meta: string,
  work: () => Promise<T>,
  allowPending = false,
): Promise<T> {
  let fd;
  try {
    fd = await open(path.join(meta, "lock"), "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new ProjectError(
        "Another operation is active. Inspect .prj/lock before removing a stale lock.",
      );
    throw e;
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
export async function capture(root: string) {
  const { base, meta } = await state(root);
  return locked(meta, async () => {
    const snapshot = await scan(base, (entry, data) =>
      store(meta, entry, data),
    );
    const json = JSON.stringify(snapshot),
      id = digest(Buffer.from(json));
    await atomic(path.join(meta, "snapshots", id + ".json"), json);
    await atomic(path.join(meta, "HEAD"), id + "\n");
    return { id, ...snapshot };
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
    const current = await scan(base);
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
async function current(base: string, name: string): Promise<Content | null> {
  safePath(name);
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
  const parts = safePath(name).split("/");
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
  return locked(meta, async () => {
    const target = await load(meta, id),
      baselineId = await head(meta),
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
    for (const name of [
      ...new Set([...before.keys(), ...after.keys()]),
    ].sort()) {
      const previous = before.get(name) ?? null,
        incoming = after.get(name) ?? null;
      if (same(previous, incoming)) continue;
      const local = await current(base, name);
      if (same(local, incoming)) continue;
      if (!same(local, previous))
        throw new ProjectError(
          "Restore conflicts with local edits or untracked files. Nothing was changed.",
        );
      if (local) {
        const data = await readSafe(path.join(base, name), MAX_FILE);
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
      base: baselineId,
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
  });
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
