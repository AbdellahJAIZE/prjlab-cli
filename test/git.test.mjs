import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  prjlabRemote,
  parseCredentialRequest,
  credentialMatches,
  installContextHooks,
  hooksInstalled,
  configureGitCredentials,
  removeGitCredentials,
} from "../dist/git-integration.js";

const origin = "https://prjlab.com";
async function repo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "prj-gitint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}
test("PrjLab remotes are recognised like GitHub URLs, only on this server", () => {
  assert.equal(
    prjlabRemote("https://prjlab.com/Ajaize/Kibbit.git", origin),
    "ajaize/kibbit",
  );
  assert.equal(
    prjlabRemote("https://prjlab.com/ajaize/kibbit", origin),
    "ajaize/kibbit",
  );
  assert.equal(
    prjlabRemote("https://prjlab.com/ajaize/kibbit/", origin),
    "ajaize/kibbit",
  );
  assert.equal(
    prjlabRemote("https://github.com/ajaize/kibbit.git", origin),
    null,
  );
  assert.equal(prjlabRemote("git@prjlab.com:ajaize/kibbit.git", origin), null);
  assert.equal(
    prjlabRemote("https://prjlab.com/ajaize/kibbit/tree/main", origin),
    null,
  );
  assert.equal(
    prjlabRemote("https://user:pw@prjlab.com.evil.example/a/b.git", origin),
    null,
  );
});
test("the credential helper answers only for the PrjLab host", () => {
  const f = parseCredentialRequest(
    "protocol=https\nhost=prjlab.com\npath=a/b.git\n\n",
  );
  assert.deepEqual(f, {
    protocol: "https",
    host: "prjlab.com",
    path: "a/b.git",
  });
  assert.equal(credentialMatches(f, origin), true);
  assert.equal(
    credentialMatches({ protocol: "https", host: "github.com" }, origin),
    false,
  );
  assert.equal(
    credentialMatches({ protocol: "http", host: "prjlab.com" }, origin),
    false,
  );
  assert.equal(
    credentialMatches(
      { protocol: "http", host: "127.0.0.1:4021" },
      "http://127.0.0.1:4021",
    ),
    true,
  );
});
test(
  "hooks: installed, idempotent, chain an existing hook with its stdin, and it can still abort",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await repo(t);
    const hooks = path.join(dir, ".git", "hooks");
    const log = path.join(dir, "previous.log");
    await writeFile(
      path.join(hooks, "pre-push"),
      `#!/bin/sh\ncat > "${log}"\necho "args:$1" >> "${log}"\nexit 0\n`,
      { mode: 0o755 },
    );
    assert.deepEqual(await installContextHooks(hooks), [
      "pre-push",
      "post-merge",
      "post-checkout",
    ]);
    await installContextHooks(hooks);
    assert.equal(await hooksInstalled(hooks), true);
    const names = (await readdir(hooks))
      .filter((n) => !n.endsWith(".sample"))
      .sort();
    assert.deepEqual(names, [
      "post-checkout",
      "post-merge",
      "pre-push",
      "pre-push.prjlab-previous",
    ]);
    assert.ok(((await stat(path.join(hooks, "pre-push"))).mode & 0o111) !== 0);
    let r = spawnSync(
      path.join(hooks, "pre-push"),
      ["origin", "https://prjlab.com/a/b.git"],
      {
        input: "refs/heads/main abc refs/heads/main def\n",
        env: { ...process.env, PRJ_NO_CONTEXT_HOOKS: "1" },
      },
    );
    assert.equal(r.status, 0);
    assert.equal(
      await readFile(log, "utf8"),
      "refs/heads/main abc refs/heads/main def\nargs:origin\n",
    );
    await writeFile(
      path.join(hooks, "pre-push.prjlab-previous"),
      "#!/bin/sh\nexit 3\n",
      { mode: 0o755 },
    );
    r = spawnSync(path.join(hooks, "pre-push"), ["origin", "x"], {
      input: "",
      env: { ...process.env, PRJ_NO_CONTEXT_HOOKS: "1" },
    });
    assert.equal(r.status, 3, "the user's own hook can still stop the push");
  },
);
test("prj login configures git only for PrjLab, resetting other helpers; logout removes it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "prj-gitcfg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gitconfig");
  await writeFile(file, "[credential]\n\thelper = store\n");
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
  t.after(() =>
    saved === undefined
      ? delete process.env.GIT_CONFIG_GLOBAL
      : (process.env.GIT_CONFIG_GLOBAL = saved),
  );
  assert.equal(await configureGitCredentials(origin), "configured");
  await configureGitCredentials(origin);
  const values = execFileSync(
    "git",
    ["config", "--global", "--get-all", `credential.${origin}.helper`],
    { encoding: "utf8" },
  ).split("\n");
  assert.equal(values[0], "");
  assert.match(values[1], /^!".*" ".*bin\.js" git-credential$/);
  assert.equal(values.filter(Boolean).length, 1, "configured once");
  assert.match(
    await readFile(file, "utf8"),
    /helper = store/,
    "other hosts keep their helper",
  );
  await removeGitCredentials(origin);
  assert.doesNotMatch(await readFile(file, "utf8"), /git-credential/);
});
