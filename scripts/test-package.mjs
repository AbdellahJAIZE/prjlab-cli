import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run test:package");
const temp = mkdtempSync(path.join(tmpdir(), "prjlab-package-"));
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
  console.log(
    "PASS: packed file allowlist, clean install and installed CLI version",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
