#!/usr/bin/env node
import { local } from "./local.js";
import { run, VERSION } from "./cli.js";
import { checkForUpdate, updateNotice } from "./update-check.js";
const args = process.argv.slice(2);
// Started first so the (at most daily, 1.5 s) registry check overlaps the command.
const update = checkForUpdate(VERSION);
const auth = ["login", "logout", "whoami"].includes(args[0] ?? "")
  ? await (await import("./auth-commands.js")).authCommands(args)
  : undefined;
const sync = ["push", "pull", "clone", "remote"].includes(args[0] ?? "")
  ? await (await import("./sync-commands.js")).syncCommands(args)
  : undefined;
const result = auth ?? sync ?? (await local(args)) ?? run(args);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const newer = await update;
if (newer) process.stderr.write(updateNotice(VERSION, newer));
process.exitCode = result.code;
