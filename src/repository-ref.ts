import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { ProjectError } from "./snapshot.js";
import { TransportError } from "./http.js";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HANDLE = /^[a-z][a-z0-9-]{2,38}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/i;
export type RepositoryRef =
  { kind: "id"; id: string } | { kind: "name"; handle: string; slug: string };
export interface ListApi {
  request(
    method: "GET",
    route: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ status: number; data: unknown }>;
}
export function parseRepositoryRef(input: string | undefined): RepositoryRef {
  if (typeof input === "string" && UUID.test(input))
    return { kind: "id", id: input.toLowerCase() };
  const parts = typeof input === "string" ? input.split("/") : [];
  if (parts.length === 2 && HANDLE.test(parts[0]!) && SLUG.test(parts[1]!))
    return {
      kind: "name",
      handle: parts[0]!.toLowerCase(),
      slug: parts[1]!.toLowerCase(),
    };
  throw new ProjectError(
    "Name a repository as <handle>/<name> (for example alice/fieldnotes) or by its ID.",
  );
}
export async function resolveRepository(
  ref: RepositoryRef,
  api: ListApi,
  signal?: AbortSignal,
): Promise<string> {
  if (ref.kind === "id") return ref.id;
  const listed = await api.request("GET", "/api/v1/repositories", { signal });
  if (listed.status !== 200 || !Array.isArray(listed.data))
    throw new TransportError("response");
  for (const item of listed.data as unknown[]) {
    const v = item as { id?: unknown; handle?: unknown; slug?: unknown };
    if (
      v &&
      typeof v === "object" &&
      typeof v.id === "string" &&
      UUID.test(v.id) &&
      typeof v.handle === "string" &&
      typeof v.slug === "string" &&
      v.handle.toLowerCase() === ref.handle &&
      v.slug.toLowerCase() === ref.slug
    )
      return v.id.toLowerCase();
  }
  // Not one of yours: it may still be a public repository (contract 0.7).
  const found = await api.request(
    "GET",
    `/api/v1/repositories/lookup?handle=${encodeURIComponent(ref.handle)}&slug=${encodeURIComponent(ref.slug)}`,
    { signal },
  );
  if (found.status === 200) {
    const v = found.data as { id?: unknown };
    if (
      v &&
      typeof v === "object" &&
      typeof v.id === "string" &&
      UUID.test(v.id)
    )
      return v.id.toLowerCase();
    throw new TransportError("response");
  }
  if (found.status !== 404) throw new TransportError("response");
  throw new ProjectError(
    `Repository ${ref.handle}/${ref.slug} was not found in your repositories and is not public. Check the name or ask the owner for access.`,
  );
}
export function defaultCloneDirectory(ref: RepositoryRef): string {
  return ref.kind === "name" ? ref.slug : ref.id;
}
// The repository this directory was pushed to or cloned from, so push/pull need no argument.
export async function linkedRepository(
  root: string,
  origin: string,
): Promise<string> {
  const file = path.join(root, ".prj", "remote.json");
  let raw: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4096) throw new Error();
    raw = await readFile(file, "utf8");
  } catch {
    throw new ProjectError(
      "This directory is not linked to a repository yet. Run prj push <handle>/<name> or prj clone <handle>/<name> first.",
    );
  }
  let link: { origin?: unknown; repository?: unknown };
  try {
    link = JSON.parse(raw);
  } catch {
    throw new ProjectError("Invalid or mismatched remote link.");
  }
  if (
    !link ||
    typeof link !== "object" ||
    typeof link.repository !== "string" ||
    !UUID.test(link.repository)
  )
    throw new ProjectError("Invalid or mismatched remote link.");
  if (link.origin !== origin)
    throw new ProjectError(
      "This directory is linked to a different server. Name the repository explicitly.",
    );
  return link.repository.toLowerCase();
}
