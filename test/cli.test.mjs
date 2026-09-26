import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { run, VERSION } from "../dist/cli.js";
import { readFileSync } from "node:fs";
test("help describes actual capabilities", () => {
  const r = run([]);
  assert.equal(r.code, 0);
  for (const command of [
    "login",
    "whoami",
    "logout",
    "init",
    "status",
    "snapshot",
    "export <snapshot-id> <new-dir>",
    "restore <snapshot-id>",
    "recover",
    "push [origin]",
    "pull [origin]",
    "remote add origin <handle>/<name>",
    "remote -v | set-url | remove",
    "context push|pull",
    "git clone https://prjlab.com/<handle>/<name>.git",
    "clone <handle>/<name> [<dir>]",
  ])
    assert.ok(r.stdout.includes(command), command);
  assert.match(r.stdout, /https:\/\/prjlab\.com\/docs/);
  assert.doesNotMatch(r.stdout, /development/i);
});
test("version matches package metadata", () => {
  assert.equal(
    VERSION,
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
      .version,
  );
});
test("unimplemented commands fail rather than pretending to succeed", () => {
  assert.equal(run(["search"]).code, 1);
  // Account and sync commands are dispatched before this fallback; here they are unknown.
  for (const c of ["login", "logout", "push", "pull", "clone"])
    assert.equal(run([c]).code, 2);
});
test("unknown arguments do not leak user input", () => {
  const r = run(["private-secret-value"]);
  assert.equal(r.code, 2);
  assert.equal(JSON.stringify(r).includes("private-secret-value"), false);
});
test("executable runs and sets exit status", () => {
  const r = spawnSync(process.execPath, ["dist/bin.js", "--version"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), VERSION);
  const bad = spawnSync(process.execPath, ["dist/bin.js", "push"], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
});
