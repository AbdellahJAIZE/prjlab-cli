// prj create: make a repository from the terminal and link this folder to it,
// so nobody has to create repositories one by one in the browser.
import path from "node:path";
import { lstat } from "node:fs/promises";
import { TransportError } from "./http.js";
import { initialize, ProjectError } from "./snapshot.js";
import { addRemote, showRemote } from "./sync.js";

/** Names the web application keeps for its own routes (contract: CreateRepository.slug). */
const RESERVED = new Set([
  "api",
  "new",
  "settings",
  "login",
  "logout",
  "sign-in",
  "sign-up",
  "explore",
  "docs",
  "blog",
  "admin",
  "support",
  "security",
  "www",
  "prjlab",
  "account",
  "repositories",
  "invitations",
]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HANDLE = /^[a-z][a-z0-9-]{2,38}$/i;
const NAME_RULE =
  "A repository name is 1 to 63 characters: lower-case letters, digits and dashes, starting with a letter or digit.";

/** A folder name as a repository name: "My Project_v2" becomes "my-project-v2". */
export function slugFor(folder: string): string {
  return folder
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}
export interface CreateOptions {
  /** Repository name; defaults to the folder's name. */
  name?: string;
  description?: string;
  /** false: only create the repository, leave this folder alone (--no-link). */
  link?: boolean;
}
export function parseCreateArguments(args: readonly string[]): CreateOptions {
  const options: CreateOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-link") options.link = false;
    else if (arg === "-d" || arg === "--description") {
      const value = args[++i];
      if (value === undefined || options.description !== undefined)
        throw new ProjectError(USAGE);
      options.description = value;
    } else if (arg.startsWith("-") || options.name !== undefined)
      throw new ProjectError(USAGE);
    else options.name = arg;
  }
  return options;
}
export const USAGE =
  'Usage: prj create [<name>] [-d "description"] [--no-link]. Without a name the folder\'s name is used.';
interface Api {
  request(
    method: "GET" | "POST",
    route: string,
    options?: { body?: unknown; signal?: AbortSignal },
  ): Promise<{ status: number; data: unknown }>;
}
/** Repositories one account may own (the server answers 409 beyond it). */
const ACCOUNT_REPOSITORIES = 200;
/**
 * The server answers 409 both for a name that is taken and for an account that
 * owns the maximum number of repositories. Look at what the account owns to
 * say which one it was, instead of blaming the name.
 */
async function refused(api: Api, slug: string, signal?: AbortSignal) {
  const taken = `You already have a repository named ${slug}. Link this folder to it with prj remote add origin <handle>/${slug}, or choose another name.`;
  let owned: { slug?: unknown }[];
  try {
    const listed = await api.request("GET", "/api/v1/repositories", { signal });
    if (listed.status !== 200 || !Array.isArray(listed.data)) return taken;
    owned = (listed.data as { slug?: unknown; role?: unknown }[]).filter(
      (r) => r && typeof r === "object" && r.role === "owner",
    );
  } catch {
    return taken;
  }
  if (owned.some((r) => r.slug === slug)) return taken;
  if (owned.length >= ACCOUNT_REPOSITORIES)
    return `Your account already owns ${owned.length} repositories, which is the limit. Delete one you no longer need at https://prjlab.com, then run prj create again.`;
  return taken;
}
export interface Created {
  id: string;
  /** <handle>/<name> */
  name: string;
  visibility: string;
  /** This folder now pushes to the new repository. */
  linked: boolean;
  /** .prj/ was created for it. */
  initialized: boolean;
}
/** Create a repository and, unless told otherwise, link the folder to it. */
export async function create(
  root: string,
  origin: string,
  api: Api,
  signal: AbortSignal | undefined,
  options: CreateOptions = {},
): Promise<Created> {
  const link = options.link !== false;
  const slug = options.name ?? slugFor(path.basename(path.resolve(root)));
  if (!SLUG.test(slug))
    throw new ProjectError(
      options.name === undefined
        ? `This folder's name cannot be used as a repository name. Give one: prj create <name>. ${NAME_RULE}`
        : NAME_RULE,
    );
  if (RESERVED.has(slug))
    throw new ProjectError(
      `"${slug}" is reserved by PrjLab. Choose another name: prj create <name>.`,
    );
  const description = options.description;
  if (
    description !== undefined &&
    (description.length > 500 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(description))
  )
    throw new ProjectError(
      "A description is at most 500 characters, without control characters.",
    );
  // Refuse before anything exists remotely: a repository nobody links is clutter.
  const initialized = Boolean(
    await lstat(path.join(root, ".prj")).catch(() => undefined),
  );
  if (link && initialized) {
    const current = await showRemote(root);
    if (current)
      throw new ProjectError(
        `This folder is already linked to ${current.name ?? current.repository}. Use prj create ${slug} --no-link to only create the repository.`,
      );
  }
  let response;
  try {
    response = await api.request("POST", "/api/v1/repositories", {
      body: { slug, ...(description ? { description } : {}) },
      signal,
    });
  } catch (error) {
    if (error instanceof TransportError && error.code === "conflict")
      throw new ProjectError(await refused(api, slug, signal));
    if (error instanceof TransportError && error.status === 400)
      throw new ProjectError(`PrjLab refused that name. ${NAME_RULE}`);
    throw error;
  }
  const made = response.data as Record<string, unknown> | null;
  if (
    response.status !== 201 ||
    !made ||
    typeof made !== "object" ||
    typeof made.id !== "string" ||
    !UUID.test(made.id) ||
    typeof made.handle !== "string" ||
    !HANDLE.test(made.handle) ||
    made.slug !== slug
  )
    throw new TransportError("response", response.status);
  const name = `${made.handle.toLowerCase()}/${slug}`;
  const visibility =
    typeof made.visibility === "string" ? made.visibility : "private";
  if (!link)
    return { id: made.id, name, visibility, linked: false, initialized: false };
  if (!initialized) await initialize(root);
  await addRemote(root, origin, made.id.toLowerCase(), name);
  return {
    id: made.id,
    name,
    visibility,
    linked: true,
    initialized: !initialized,
  };
}
/** What prj create prints. */
export function describeCreated(origin: string, made: Created): string[] {
  const lines = [`Created ${origin}/${made.name} (${made.visibility}).`];
  if (made.initialized)
    lines.push(
      "Initialized local PrjLab metadata. Add .prj/ to your .gitignore.",
    );
  lines.push(
    made.linked
      ? `origin is now ${made.name}. Run prj push -m "First version" to upload.`
      : `Link a folder to it with prj remote add origin ${made.name}.`,
  );
  return lines;
}
