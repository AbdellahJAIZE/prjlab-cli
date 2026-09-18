#!/usr/bin/env node
import { local } from "./local.js";
import { run } from "./cli.js";
const result =
  (await local(process.argv.slice(2))) ?? run(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
