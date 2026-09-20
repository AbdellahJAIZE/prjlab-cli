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
export async function syncCommands(args: readonly string[]) {
  const command = args[0];
  if (!["push", "pull", "clone"].includes(command ?? "")) return undefined;
  const controller = new AbortController(),
    cancel = () => controller.abort();
  const timer = setTimeout(cancel, 5 * 60 * 1000);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (
      args.length !== (command === "clone" ? 3 : 2) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args[1] ?? "")
    )
      throw new ProjectError(
        "Usage: prj push <repository-id> | pull <repository-id> | clone <repository-id> <new-directory>.",
      );
    const repository = args[1]!.toLowerCase(),
      config = readLoginConfig(),
      directory = await credentialDirectory(config);
    const api = await withCredentialLock(directory, async () =>
      new LoginSession(config, await secureStore(config, directory)).transport(
        controller.signal,
      ),
    );
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
              args[2]!,
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
