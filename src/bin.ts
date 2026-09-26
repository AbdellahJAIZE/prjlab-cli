#!/usr/bin/env node
import { local } from "./local.js";
import { run, VERSION } from "./cli.js";
import { checkForUpdate, updateNotice } from "./update-check.js";
const args = process.argv.slice(2);
// git's credential helper: fast path, no update check, stdin in, stdout out.
if (args[0] === "git-credential") {
  const input = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data));
  });
  const r = await (
    await import("./auth-commands.js")
  ).gitCredential(args[1], input);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
// Started first so the (at most daily, 1.5 s) registry check overlaps the command.
const update = checkForUpdate(VERSION);
const auth = ["login", "logout", "whoami"].includes(args[0] ?? "")
  ? await (await import("./auth-commands.js")).authCommands(args)
  : undefined;
const withGit = ["init", "clone", "context", "push", "pull"].includes(
  args[0] ?? "",
)
  ? await (await import("./git-commands.js")).gitCommands(args)
  : undefined;
const sync =
  !auth &&
  !withGit &&
  ["push", "pull", "clone", "remote"].includes(args[0] ?? "")
    ? await (await import("./sync-commands.js")).syncCommands(args)
    : undefined;
const result = auth ?? withGit ?? sync ?? (await local(args)) ?? run(args);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const newer = await update;
if (newer) process.stderr.write(updateNotice(VERSION, newer));
process.exitCode = result.code;
