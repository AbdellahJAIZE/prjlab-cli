import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLoginConfig } from "../dist/auth-config.js";
import { credentialDirectory, secureStore } from "../dist/credential-store.js";
const env = {
  PRJ_SERVER: "https://prjlab.example",
  PRJ_AUTHORITY:
    "https://example.ciamlogin.com/11111111-1111-4111-8111-111111111111",
  PRJ_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  PRJ_API_SCOPE: "api://33333333-3333-4333-8333-333333333333/access_as_user",
};
const config = readLoginConfig(env);
// In-memory stand-in for the OS credential store.
function keyring() {
  const entries = new Map();
  const factory = async (account) => ({
    getPassword: async () => entries.get(account) ?? null,
    setPassword: async (value) => void entries.set(account, value),
    deletePassword: async () => entries.delete(account),
  });
  return { entries, factory };
}
async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), "prj-store-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = await credentialDirectory(config, home);
  return { directory, ...keyring() };
}
const secret = JSON.stringify({
  refresh: "synthetic-refresh-token-" + "x".repeat(6000),
});
test("sessions round-trip encrypted; only a small key reaches the OS store", async (t) => {
  const { directory, entries, factory } = await setup(t);
  const store = await secureStore(config, directory, factory);
  assert.equal(await store.load(), null);
  await store.save(secret);
  assert.equal(await store.load(), secret);
  assert.equal(entries.size, 1);
  for (const value of entries.values()) assert.ok(value.length <= 64);
  for (const file of await readdir(directory)) {
    const bytes = await readFile(path.join(directory, file));
    assert.equal(bytes.includes(Buffer.from("synthetic-refresh")), false);
  }
  if (process.platform !== "win32")
    assert.equal(
      (await stat(path.join(directory, "session.enc"))).mode & 0o777,
      0o600,
    );
  await store.save("second");
  assert.equal(await store.load(), "second");
  assert.deepEqual(await readdir(directory), ["session.enc"]);
});
test("a missing key, a tampered file or another scope never yields a session", async (t) => {
  const { directory, entries, factory } = await setup(t);
  const store = await secureStore(config, directory, factory);
  await store.save(secret);
  const file = path.join(directory, "session.enc");
  const good = await readFile(file);
  const tampered = Buffer.from(good);
  tampered[20] ^= 1;
  await writeFile(file, tampered);
  await assert.rejects(store.load());
  await writeFile(file, good);
  const other = readLoginConfig({
    ...env,
    PRJ_CLIENT_ID: "55555555-5555-4555-8555-555555555555",
  });
  const [account, key] = [...entries][0];
  const otherStore = await secureStore(other, directory, async (name) => ({
    getPassword: async () => (name.endsWith(":session-key") ? key : null),
    setPassword: async () => {},
    deletePassword: async () => false,
  }));
  await assert.rejects(otherStore.load());
  entries.delete(account);
  assert.equal(await store.load(), null);
});
test("logout removes the key, the file and 0.3.x leftovers", async (t) => {
  const { directory, entries, factory } = await setup(t);
  const scopeEntry = [
    ...(await (async () => {
      const probe = keyring();
      await (await secureStore(config, directory, probe.factory)).save("x");
      return probe.entries.keys();
    })()),
  ][0].replace(/:session-key$/, "");
  entries.set(scopeEntry, "legacy keytar session");
  await writeFile(path.join(directory, "cache.bin"), "legacy");
  const store = await secureStore(config, directory, factory);
  await store.save(secret);
  assert.equal(entries.has(scopeEntry), false, "legacy entry removed on save");
  assert.deepEqual(await readdir(directory), ["session.enc"]);
  assert.equal(await store.delete(), true);
  assert.equal(entries.size, 0);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(await store.delete(), false);
  assert.equal(await store.load(), null);
});
test(
  "a symlinked session file is refused",
  { skip: process.platform === "win32" },
  async (t) => {
    const { directory, factory } = await setup(t);
    const outside = path.join(
      await mkdtemp(path.join(tmpdir(), "prj-out-")),
      "x",
    );
    t.after(() => rm(path.dirname(outside), { recursive: true, force: true }));
    await writeFile(outside, "x");
    await symlink(outside, path.join(directory, "session.enc"));
    await assert.rejects(
      secureStore(config, directory, factory),
      /unavailable/,
    );
  },
);
test("an unavailable OS store fails without plaintext fallback", async (t) => {
  const { directory } = await setup(t);
  await assert.rejects(
    secureStore(config, directory, async () => {
      throw new Error("no secret service");
    }),
    /Secure OS credential storage is unavailable/,
  );
  assert.deepEqual(await readdir(directory), []);
});
