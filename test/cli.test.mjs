import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { run, VERSION } from "../dist/cli.js";
import { readFileSync } from "node:fs";
test("help describes actual capabilities", () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /push <repository-id>/);
  assert.match(r.stdout, /Remote sync requires login/);
});
test("version matches package metadata", () => {
  assert.equal(
    VERSION,
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
      .version,
  );
});
test("unimplemented commands fail rather than pretending to succeed", () => {
  for (const c of ["login", "logout", "push", "pull", "clone", "search"])
    assert.equal(run([c]).code, 1);
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
