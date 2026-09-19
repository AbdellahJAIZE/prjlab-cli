import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLoginConfig } from "../dist/auth-config.js";
import { credentialDirectory, secureStore } from "../dist/credential-store.js";
const home = await mkdtemp(path.join(tmpdir(), "prj-native-store-"));
const config = readLoginConfig({
  PRJ_SERVER: `https://${randomUUID()}.example`,
  PRJ_AUTHORITY: `https://example.ciamlogin.com/${randomUUID()}`,
  PRJ_CLIENT_ID: randomUUID(),
  PRJ_API_SCOPE: `api://${randomUUID()}/access_as_user`,
});
const secret = `synthetic-credential-${randomUUID()}`;
let store;
try {
  const directory = await credentialDirectory(config, home);
  store = await secureStore(config, directory);
  assert.equal(await store.load(), null);
  await store.save(secret);
  assert.equal(await store.load(), secret);
  for (const file of await readdir(directory))
    assert.equal(
      (await readFile(path.join(directory, file))).includes(
        Buffer.from(secret),
      ),
      false,
      "Plaintext credential leaked to a file",
    );
  assert.equal(await store.delete(), true);
  assert.equal(await store.load(), null);
  console.log(
    `PASS: native ${process.platform} credential save/load/delete; no plaintext file`,
  );
} finally {
  await store?.delete().catch(() => {});
  await rm(home, { recursive: true, force: true });
}
