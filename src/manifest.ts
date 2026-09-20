/** Portable snapshot validation shared with the private platform under MIT. */
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
export const MAX_FILE = 5 * 1024 * 1024,
  MAX_TOTAL = 100 * 1024 * 1024,
  MAX_ENTRIES = 1000;
export const HASH = /^[a-f0-9]{64}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
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
      typeof e.kind !== "string" ||
      !["file", "instruction", "memory", "session"].includes(e.kind) ||
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
