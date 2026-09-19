#!/usr/bin/env node
import { local } from "./local.js";
import { run } from "./cli.js";
const args = process.argv.slice(2);
const auth = ["login", "logout", "whoami"].includes(args[0] ?? "")
  ? await (await import("./auth-commands.js")).authCommands(args)
  : undefined;
const result = auth ?? (await local(args)) ?? run(args);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
