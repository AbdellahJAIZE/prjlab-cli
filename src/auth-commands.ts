import { readLoginConfig, LoginError } from "./auth-config.js";
import {
  credentialDirectory,
  secureStore,
  withCredentialLock,
} from "./credential-store.js";
import { LoginSession } from "./login-session.js";
export async function authCommands(args: readonly string[]) {
  const command = args[0];
  if (!["login", "logout", "whoami"].includes(command ?? "")) return undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, command === "login" ? 300000 : 30000);
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (args.length !== 1)
      throw new LoginError(
        "Usage: prj login | logout | whoami. Tokens and secrets are never command arguments.",
      );
    const config = readLoginConfig();
    const directory = await credentialDirectory(config);
    const message = await withCredentialLock(directory, async () => {
      const store = await secureStore(config, directory);
      const session = new LoginSession(config, store);
      if (command === "logout") {
        await session.logout();
        return "Local PrjLab credentials removed. Existing provider sessions and issued tokens are not revoked.";
      }
      if (command === "login")
        process.stderr.write(
          "Opening your browser to sign in. Press Ctrl+C to cancel.\n",
        );
      const account =
        command === "login"
          ? await session.login(controller.signal)
          : await session.whoami(controller.signal);
      return `Signed in as ${account.handle}.`;
    });
    return { code: 0, stdout: message + "\n", stderr: "" };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr:
        error instanceof LoginError
          ? error.message + "\n"
          : "Credential operation failed. Check secure storage and retry.\n",
    };
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
