import { readLoginConfig, LoginError } from "./auth-config.js";
import {
  credentialDirectory,
  secureStore,
  withCredentialLock,
} from "./credential-store.js";
import { LoginSession } from "./login-session.js";
import {
  configureGitCredentials,
  removeGitCredentials,
  parseCredentialRequest,
  credentialMatches,
} from "./git-integration.js";
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
        await removeGitCredentials(config.origin).catch(() => {});
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
      if (command !== "login") return `Signed in as ${account.handle}.`;
      const gitSetup = await configureGitCredentials(config.origin).catch(
        () => "failed",
      );
      return (
        `Signed in as ${account.handle}.` +
        (gitSetup === "configured"
          ? `\ngit will sign in to ${config.origin} with this account (no password needed).`
          : gitSetup === "no-git"
            ? "\ngit was not found; install git to clone and push PrjLab repositories."
            : "")
      );
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

/** `git credential` helper protocol: `prj git-credential get` (called by git). */
export async function gitCredential(action: string | undefined, input: string) {
  if (action !== "get") return { code: 0, stdout: "", stderr: "" };
  const fields = parseCredentialRequest(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const config = readLoginConfig();
    if (!credentialMatches(fields, config.origin))
      return { code: 0, stdout: "", stderr: "" };
    const directory = await credentialDirectory(config);
    const token = await withCredentialLock(directory, async () =>
      new LoginSession(
        config,
        await secureStore(config, directory),
      ).accessToken(controller.signal),
    );
    return { code: 0, stdout: `username=prj\npassword=${token}\n`, stderr: "" };
  } catch {
    return {
      code: 0,
      stdout: "",
      stderr:
        "prj: not signed in to PrjLab. Run prj login, or use a personal access token.\n",
    };
  } finally {
    clearTimeout(timer);
  }
}
