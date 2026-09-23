import { readLoginConfig, LoginError } from "./auth-config.js";
import {
  credentialDirectory,
  secureStore,
  withCredentialLock,
} from "./credential-store.js";
import { LoginSession } from "./login-session.js";
import { ProjectError } from "./snapshot.js";
import { TransportError } from "./http.js";
import { push, pull, clone } from "./sync.js";
import {
  parseRepositoryRef,
  resolveRepository,
  defaultCloneDirectory,
  linkedRepository,
} from "./repository-ref.js";
const USAGE =
  "Usage: prj push [<handle>/<name>] | pull [<handle>/<name>] | clone <handle>/<name> [<new-directory>]. A repository ID works in place of <handle>/<name>.";
export async function syncCommands(args: readonly string[]) {
  const command = args[0];
  if (!["push", "pull", "clone"].includes(command ?? "")) return undefined;
  const controller = new AbortController(),
    cancel = () => controller.abort();
  const timer = setTimeout(cancel, 5 * 60 * 1000);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const rest = args.slice(1);
    if (
      (command === "clone" && (rest.length < 1 || rest.length > 2)) ||
      (command !== "clone" && rest.length > 1) ||
      rest.some((a) => a.startsWith("-"))
    )
      throw new ProjectError(USAGE);
    const config = readLoginConfig(),
      ref = rest[0] === undefined ? undefined : parseRepositoryRef(rest[0]);
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
