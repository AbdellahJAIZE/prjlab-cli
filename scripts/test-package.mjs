import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run test:package");
const temp = realpathSync(mkdtempSync(path.join(tmpdir(), "prjlab-package-")));
try {
  const output = execFileSync(
    process.execPath,
    [npmCli, "pack", "--json", "--pack-destination", temp],
    { encoding: "utf8" },
  );
  const [pack] = JSON.parse(output);
  for (const f of pack.files)
    assert.match(
      f.path,
      /^(dist\/[^/]+\.js|package\.json|README\.md|SECURITY\.md|LICENSE)$/,
    );
  const tarball = path.join(temp, pack.filename);
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      temp,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { stdio: "pipe" },
  );
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const installed = path.join(temp, "node_modules", manifest.name);
  assert.equal(
    JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")).bin
      .prj,
    "dist/bin.js",
  );
  const version = execFileSync(
    process.execPath,
    [path.join(installed, "dist/bin.js"), "--version"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(version, manifest.version);
  const project = path.join(temp, "project");
  mkdirSync(project);
  writeFileSync(path.join(project, "README.md"), "round trip");
  const execute = (...args) =>
    execFileSync(
      process.execPath,
      [path.join(installed, "dist/bin.js"), ...args],
      { cwd: project, encoding: "utf8" },
    );
  execute("init");
  const snapshot = execute("snapshot").match(/Snapshot ([a-f0-9]{64})/)[1];
  writeFileSync(path.join(project, "README.md"), "second version");
  execute("snapshot");
  execute("restore", snapshot);
  assert.equal(
    readFileSync(path.join(project, "README.md"), "utf8"),
    "round trip",
  );
  const destination = path.join(project, "exported");
  execute("export", snapshot, destination);
  assert.equal(
    readFileSync(path.join(destination, "README.md"), "utf8"),
    "round trip",
  );
  console.log(
    "PASS: packed file allowlist, clean install and installed CLI version and local snapshot/export",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
