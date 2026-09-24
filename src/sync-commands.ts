import { readLoginConfig, LoginError } from "./auth-config.js";
import {
  credentialDirectory,
  secureStore,
  withCredentialLock,
} from "./credential-store.js";
import { LoginSession } from "./login-session.js";
import { ProjectError } from "./snapshot.js";
import { TransportError } from "./http.js";
import {
  push,
  pull,
  clone,
  parsePushArguments,
  addRemote,
  removeRemote,
  showRemote,
  rememberRemoteName,
} from "./sync.js";
import {
  parseRepositoryRef,
  resolveRepository,
  defaultCloneDirectory,
  linkedRepository,
  type RepositoryRef,
} from "./repository-ref.js";
const USAGE =
  'Usage: prj push [origin | <handle>/<name>] [-m "what changed"] | pull [origin | <handle>/<name>] | clone <handle>/<name> [<new-directory>] | remote [-v] | remote add origin <handle>/<name> | remote set-url origin <handle>/<name> | remote remove origin. A repository ID or a https://prjlab.com/<handle>/<name> link works in place of <handle>/<name>.';
const REMOTE_USAGE =
  "Usage: prj remote [-v] | prj remote add origin <handle>/<name> | prj remote set-url origin <handle>/<name> | prj remote remove origin";
// Accepts a repository page link the way git accepts a clone URL.
export function repositoryArgument(input: string, origin: string): string {
  if (!/^https?:\/\//i.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ProjectError("That repository link is not a valid URL.");
  }
  if (url.origin !== origin)
    throw new ProjectError(
      `That link is not on ${origin}. Use <handle>/<name> or a link from ${origin}.`,
    );
  const parts = url.pathname
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2 || url.search || url.hash)
    throw new ProjectError(
      "Use the repository page link, for example https://prjlab.com/alice/fieldnotes.",
    );
  return parts.join("/");
}
function refName(ref: RepositoryRef) {
  return ref.kind === "name" ? `${ref.handle}/${ref.slug}` : null;
}
// git habits: "origin", "." and "origin main" all mean the linked repository;
// -u / --set-upstream is accepted and has nothing more to do (the first push links).
export function linkedArguments(rest: readonly string[]): string[] {
  const words = rest.filter((a) => a !== "-u" && a !== "--set-upstream");
  if (
    (words.length === 1 && (words[0] === "origin" || words[0] === ".")) ||
    (words.length === 2 &&
      words[0] === "origin" &&
      ["main", "master"].includes(words[1]!))
  )
    return [];
  if (words.length === 2 && words[0] === "origin")
    throw new ProjectError(
      "PrjLab has no branches: every push is a new version of the repository. Run prj push.",
    );
  return words;
}
async function signedIn(signal: AbortSignal) {
  const config = readLoginConfig();
  const directory = await credentialDirectory(config);
  const api = await withCredentialLock(directory, async () =>
    new LoginSession(config, await secureStore(config, directory)).transport(
      signal,
    ),
  );
  return { config, api };
}
async function remoteCommand(args: readonly string[], signal: AbortSignal) {
  const [sub, name, target] = args;
  const root = process.cwd();
  if (
    sub === undefined ||
    ((sub === "-v" || sub === "--verbose") && args.length === 1)
  ) {
    const current = await showRemote(root);
    if (!current)
      return "No remote yet. Run prj remote add origin <handle>/<name>.\n";
    const shown = current.name
      ? `${current.origin}/${current.name}`
      : `${current.origin} (repository ${current.repository})`;
    return sub === undefined
      ? "origin\n"
      : `origin\t${shown} (push)\norigin\t${shown} (pull)\n`;
  }
  if ((sub === "remove" || sub === "rm") && args.length === 2) {
    if (name !== "origin")
      throw new ProjectError("PrjLab uses one remote, named origin.");
    if (!(await removeRemote(root)))
      throw new ProjectError("No remote named origin.");
    return "Removed remote origin. Your files and local snapshots were kept.\n";
  }
  if ((sub === "add" || sub === "set-url") && args.length === 3) {
    if (name !== "origin")
      throw new ProjectError("PrjLab uses one remote, named origin.");
    const { config, api } = await signedIn(signal);
    const ref = parseRepositoryRef(repositoryArgument(target!, config.origin));
    const repository = await resolveRepository(ref, api, signal);
    const checked = await api.request(
      "GET",
      `/api/v1/repositories/${repository}/tip`,
      { signal },
    );
    if (checked.status === 404 || checked.status === 403)
      throw new ProjectError(
        "That repository was not found or you do not have access. Create it at https://prjlab.com/new first.",
      );
    if (checked.status !== 200) throw new TransportError("response");
    const outcome = await addRemote(
      root,
      config.origin,
      repository,
      refName(ref),
      sub === "set-url",
    );
    const label = refName(ref) ?? repository;
    return outcome === "unchanged"
      ? `origin already points to ${label}.\n`
      : `origin is now ${label}. Run prj push -m "First version" to upload.\n`;
  }
  throw new ProjectError(REMOTE_USAGE);
}
export async function syncCommands(args: readonly string[]) {
  const command = args[0];
  if (!["push", "pull", "clone", "remote"].includes(command ?? ""))
    return undefined;
  const controller = new AbortController(),
    cancel = () => controller.abort();
  const timer = setTimeout(cancel, 5 * 60 * 1000);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (command === "remote")
      return {
        code: 0,
        stdout: await remoteCommand(args.slice(1), controller.signal),
        stderr: "",
      };
    const parsed =
      command === "push"
        ? parsePushArguments(args.slice(1))
        : { rest: args.slice(1), options: {} };
    const { options } = parsed;
    const rest =
      command === "clone" ? parsed.rest : linkedArguments(parsed.rest);
    if (
      (command === "clone" && (rest.length < 1 || rest.length > 2)) ||
      (command !== "clone" && rest.length > 1) ||
      rest.some((a) => a.startsWith("-"))
    )
      throw new ProjectError(USAGE);
    const config = readLoginConfig(),
      ref =
        rest[0] === undefined
          ? undefined
          : parseRepositoryRef(repositoryArgument(rest[0], config.origin));
    const linked =
      ref === undefined
        ? await linkedRepository(process.cwd(), config.origin)
        : undefined;
    const directory = await credentialDirectory(config);
    const api = await withCredentialLock(directory, async () =>
      new LoginSession(config, await secureStore(config, directory)).transport(
        controller.signal,
      ),
    );
    const repository =
      linked ?? (await resolveRepository(ref!, api, controller.signal));
    const result =
      command === "push"
        ? await push(
            process.cwd(),
            config.origin,
            repository,
            api,
            controller.signal,
            options,
          )
        : command === "pull"
          ? await pull(
              process.cwd(),
              config.origin,
              repository,
              api,
              controller.signal,
            )
          : await clone(
              rest[1] ?? defaultCloneDirectory(ref!),
              config.origin,
              repository,
              api,
              controller.signal,
            );
    const name = ref ? refName(ref) : null;
    if (name && command !== "pull")
      await rememberRemoteName(
        command === "clone"
          ? (rest[1] ?? defaultCloneDirectory(ref!))
          : process.cwd(),
        name,
      ).catch(() => {});
    return {
      code: 0,
      stdout: `${command === "push" ? "Pushed" : "Pulled"} version ${result.version ?? "empty"}.\n`,
      stderr: "",
    };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: controller.signal.aborted
        ? "Sync cancelled or timed out. Saved state is kept for retry.\n"
        : error instanceof LoginError ||
            error instanceof ProjectError ||
            error instanceof TransportError
          ? error.message + "\n"
          : "Sync failed. Saved state is kept; retry the same command.\n",
    };
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
