import { test } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  symlink,
  readdir,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LoginSession, loginDependencies } from "../dist/login-session.js";
import { loginCallback } from "../dist/login-callback.js";
import { readLoginConfig, credentialScope } from "../dist/auth-config.js";
import {
  credentialDirectory,
  withCredentialLock,
  secureStore,
} from "../dist/credential-store.js";
const env = {
  PRJ_SERVER: "https://prjlab.example",
  PRJ_AUTHORITY:
    "https://example.ciamlogin.com/11111111-1111-4111-8111-111111111111",
  PRJ_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  PRJ_API_SCOPE: "api://33333333-3333-4333-8333-333333333333/access_as_user",
};
const config = readLoginConfig(env);
const identity = {
  homeAccountId: "synthetic-account",
  tenantId: config.tenantId,
  environment: "example.ciamlogin.com",
  localAccountId: "local",
  username: "synthetic@example.com",
};
const account = { id: "44444444-4444-4444-8444-444444444444", handle: "alice" };
function fixture(overrides = {}) {
  let stored = null;
  let request;
  let deserialized;
  const store = {
    load: async () => stored,
    save: async (value) => {
      stored = value;
    },
    delete: async () => {
      stored = null;
      return true;
    },
  };
  const result = () => ({
    account: identity,
    accessToken: "synthetic.payload.signature",
    expiresOn: new Date(Date.now() + 600000),
    ...overrides.result,
  });
  const client = {
    getAuthCodeUrl: async (input) => {
      request = input;
      return `https://example.ciamlogin.com/authorize?${new URLSearchParams({ state: input.state, nonce: input.nonce, redirect_uri: input.redirectUri })}`;
    },
    acquireTokenByCode: async (input) => {
      assert.equal(input.code, "synthetic-code");
      assert.equal(
        createHash("sha256").update(input.codeVerifier).digest("base64url"),
        request.codeChallenge,
      );
      assert.equal(input.nonce, request.nonce);
      assert.equal(input.state, request.state);
      assert.equal(input.redirectUri, request.redirectUri);
      assert.equal(input.scopes[0], config.scope);
      return result();
    },
    acquireTokenSilent: async (input) => {
      assert.equal(input.account.homeAccountId, identity.homeAccountId);
      return result();
    },
    getTokenCache: () => ({
      serialize: () => "encrypted-by-store-not-here",
      deserialize: (value) => {
        deserialized = value;
      },
      getAllAccounts: async () => [identity],
    }),
    ...overrides.client,
  };
  const dependencies = {
    client: () => client,
    openBrowser: async (value) => {
      const auth = new URL(value),
        callback = new URL(auth.searchParams.get("redirect_uri"));
      callback.search = new URLSearchParams({
        state: auth.searchParams.get("state"),
        code: "synthetic-code",
      });
      const response = await fetch(callback);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Return to the terminal/);
    },
    verify: async (_config, token) => {
      assert.equal(token, "synthetic.payload.signature");
      return account;
    },
    ...overrides.dependencies,
  };
  return {
    store,
    client,
    dependencies,
    session: new LoginSession(config, store, dependencies),
    read: () => stored,
    request: () => request,
    deserialized: () => deserialized,
  };
}
test("login uses state/nonce/PKCE, verifies API account and saves only after success", async () => {
  const f = fixture();
  assert.deepEqual(
    await f.session.login(new AbortController().signal),
    account,
  );
  const saved = JSON.parse(f.read());
  assert.equal(saved.scope, credentialScope(config));
  assert.equal(saved.accountId, identity.homeAccountId);
  assert.equal(saved.cache, "encrypted-by-store-not-here");
  assert.equal(f.request().codeChallengeMethod, "S256");
  assert.deepEqual(
    await f.session.whoami(new AbortController().signal),
    account,
  );
  assert.equal(f.deserialized(), saved.cache);
  await f.session.logout();
  assert.equal(f.read(), null);
});
test("missing account setup does not save an unverified login", async () => {
  const f = fixture({
    dependencies: {
      verify: async () => {
        throw new Error("account setup required");
      },
    },
  });
  await f.store.save("old");
  await assert.rejects(f.session.login(new AbortController().signal));
  assert.equal(f.read(), "old");
});
for (const mode of [
  "provider",
  "api",
  "browser",
  "tenant",
  "expired",
  "origin",
]) {
  test(`failed ${mode} login preserves old credentials and redacts errors`, async () => {
    const fail = async () => {
      throw new Error("SECRET_PROVIDER_DETAIL");
    };
    const f = fixture({
      client:
        mode === "provider"
          ? { acquireTokenByCode: fail }
          : mode === "origin"
            ? { getAuthCodeUrl: async () => "https://evil.example/authorize" }
            : {},
      dependencies:
        mode === "api"
          ? { verify: fail }
          : mode === "browser"
            ? { openBrowser: fail }
            : {},
      result:
        mode === "tenant"
          ? { account: { ...identity, tenantId: "wrong" } }
          : mode === "expired"
            ? { expiresOn: new Date(0) }
            : {},
    });
    await f.store.save("old credentials");
    await assert.rejects(f.session.login(new AbortController().signal), (e) => {
      assert.ok(!String(e).includes("SECRET_PROVIDER_DETAIL"));
      return true;
    });
    assert.equal(f.read(), "old credentials");
  });
}
test("credential save failure rolls back partial replacement", async () => {
  const f = fixture();
  await f.store.save("old");
  const save = f.store.save;
  let first = true;
  f.store.save = async (value) => {
    await save(value);
    if (first) {
      first = false;
      throw new Error("storage failed");
    }
  };
  await assert.rejects(
    f.session.login(new AbortController().signal),
    /Previous credentials were restored/,
  );
  assert.equal(f.read(), "old");
});
test("saved session from a different server scope is never refreshed", async () => {
  const f = fixture();
  await f.store.save(
    JSON.stringify({
      version: 1,
      scope: "wrong",
      accountId: identity.homeAccountId,
      cache: "private",
    }),
  );
  await assert.rejects(
    f.session.whoami(new AbortController().signal),
    /unavailable/,
  );
  assert.equal(f.deserialized(), undefined);
});
test("pre-cancelled login leaves no credential changes", async () => {
  const f = fixture();
  await f.store.save("old");
  const controller = new AbortController();
  controller.abort("SECRET_ABORT_REASON");
  await assert.rejects(f.session.login(controller.signal), /cancelled/);
  assert.equal(f.read(), "old");
});
test("callback rejects wrong state, duplicate code, host/path tricks then accepts only once", async () => {
  const controller = new AbortController();
  const callback = await loginCallback("expected-state", controller.signal);
  try {
    for (const suffix of [
      "/?state=wrong&code=x",
      "/?state=expected-state&code=x&code=y",
      "/else?state=expected-state&code=x",
      "/?state=expected-state&state=wrong&code=x",
    ]) {
      const response = await fetch(callback.redirectUri + suffix);
      assert.equal(response.status, 400);
      await response.text();
    }
    const wrongHost = await new Promise((resolve, reject) => {
      const req = httpRequest(
        callback.redirectUri + "/?state=expected-state&code=x",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(wrongHost, 400);
    const response = await fetch(
      callback.redirectUri + "/?state=expected-state&code=valid",
    );
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(await callback.code, "valid");
    const replay = await fetch(
      callback.redirectUri + "/?state=expected-state&code=valid",
    );
    assert.equal(replay.status, 400);
    await replay.text();
  } finally {
    callback.close();
  }
});
test("callback cancellation closes listener and rejects pending code", async () => {
  const controller = new AbortController(),
    callback = await loginCallback("state", controller.signal);
  controller.abort("SECRET");
  await assert.rejects(callback.code, /cancelled/);
  await assert.rejects(fetch(callback.redirectUri));
  callback.close();
});
test("valid-state provider denial is redacted", async () => {
  const callback = await loginCallback("state", new AbortController().signal);
  try {
    const response = await fetch(
      callback.redirectUri +
        "/?state=state&error=denied&error_description=SECRET",
    );
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("SECRET"));
    await assert.rejects(callback.code, /declined/);
  } finally {
    callback.close();
  }
});
test("config rejects unsafe origins, provider hosts, secrets and unscoped auth", () => {
  for (const patch of [
    { PRJ_SERVER: "http://example.com" },
    { PRJ_SERVER: "https://user:pass@example.com" },
    { PRJ_SERVER: "https://example.com/path" },
    { PRJ_AUTHORITY: "https://evil.example/" + config.tenantId },
    { PRJ_AUTHORITY: "https://example.ciamlogin.com/common" },
    { PRJ_API_SCOPE: "https://graph.microsoft.com/.default" },
    { PRJ_CLIENT_ID: "client-secret" },
  ]) {
    assert.throws(() => readLoginConfig({ ...env, ...patch }), /Configure/);
  }
  assert.notEqual(
    credentialScope(config),
    credentialScope(
      readLoginConfig({ ...env, PRJ_SERVER: "https://second.example" }),
    ),
  );
  // Invalid overrides never fall back to the hosted defaults.
  assert.throws(
    () => readLoginConfig({ PRJ_SERVER: "http://prjlab.com" }),
    /Configure/,
  );
});
test("without settings the CLI targets the hosted PrjLab service", () => {
  const hosted = readLoginConfig({});
  assert.equal(hosted.origin, "https://prjlab.com");
  assert.equal(hosted.tenantId, "b7c0ef89-ea39-404f-ac7c-3737960bcb9e");
  assert.equal(
    hosted.authority,
    "https://b7c0ef89-ea39-404f-ac7c-3737960bcb9e.ciamlogin.com/b7c0ef89-ea39-404f-ac7c-3737960bcb9e",
  );
  assert.equal(hosted.clientId, "5e51d5dc-695d-4ca1-a93a-044daf8a39d9");
  assert.equal(
    hosted.scope,
    "api://56ec374f-1c3c-4e3e-a4c7-e5e7fae75c9d/access_as_user",
  );
  assert.equal(hosted.allowLoopbackHttp, false);
  // Empty values count as unset; a partial override keeps the other defaults.
  assert.deepEqual(readLoginConfig({ PRJ_SERVER: "" }), hosted);
  assert.equal(
    readLoginConfig({ PRJ_SERVER: "https://second.example" }).authority,
    hosted.authority,
  );
  assert.notEqual(credentialScope(hosted), credentialScope(config));
});
test("credential directories reject symlinks and lock concurrent operations", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "prj-login-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = await credentialDirectory(config, home);
  await withCredentialLock(directory, async () => {
    await assert.rejects(
      withCredentialLock(directory, async () => {}),
      /operation/,
    );
  });
  assert.deepEqual(await readdir(directory), []);
  const other = await mkdtemp(path.join(tmpdir(), "prj-outside-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await rm(path.join(home, ".prjlab"), { recursive: true });
  await symlink(
    other,
    path.join(home, ".prjlab"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(credentialDirectory(config, home), /private|symlink/);
  assert.deepEqual(await readdir(other), []);
});
test("invalid CLI login settings fail clearly without echoing arguments", () => {
  const clean = { ...process.env };
  for (const name of Object.keys(clean))
    if (name.startsWith("PRJ_")) delete clean[name];
  // An unsafe override must fail before any browser, network or keychain use.
  clean.PRJ_SERVER = "http://prjlab.example";
  for (const args of [
    ["login"],
    ["whoami"],
    ["logout"],
    ["login", "private-token"],
  ]) {
    const result = spawnSync(process.execPath, ["dist/bin.js", ...args], {
      env: clean,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("private-token"));
    assert.match(result.stderr, /Configure|Usage/);
  }
});
