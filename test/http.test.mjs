import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { ApiTransport, TransportError } from "../dist/http.js";
const require = createRequire(import.meta.url);
const { validate } = require("../contracts/check.cjs");
const { Account } = require("../contracts/fixtures.json");
const token = "synthetic.payload.signature";
async function server(t, handler) {
  const app = createServer(handler);
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve, reject) =>
      app.close((e) => (e ? reject(e) : resolve())),
    );
  });
  return `http://127.0.0.1:${app.address().port}`;
}
function client(origin, options = {}) {
  return new ApiTransport(
    origin,
    { origin, accessToken: token },
    { allowLoopbackHttp: true, ...options },
  );
}
const fails = (code) => (error) => {
  assert.ok(error instanceof TransportError);
  assert.equal(error.code, code);
  assert.ok(!inspect(error).includes(token));
  assert.ok(!inspect(error).includes("PRIVATE_SERVER_DETAIL"));
  return true;
};
test("real HTTP request scopes bearer credentials and returns a valid contract fixture", async (t) => {
  let received;
  const origin = await server(t, (req, res) => {
    received = { url: req.url, headers: req.headers };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Set-Cookie", "session=unwanted");
    res.end(JSON.stringify(Account));
  });
  const api = client(origin);
  const result = await api.request("GET", "/api/v1/account");
  assert.equal(result.status, 200);
  validate("Account", result.data);
  await api.request("GET", "/api/v1/account");
  assert.equal(received.url, "/api/v1/account");
  assert.equal(received.headers.authorization, `Bearer ${token}`);
  assert.equal(received.headers.cookie, undefined);
  assert.ok(!inspect(api).includes(token));
});
test("rejects insecure servers, URL credentials and mismatched credential scopes", () => {
  for (const origin of [
    "http://example.com",
    "http://127.0.0.1",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?token=secret",
    "https://example.com#fragment",
    " https://example.com",
    "file:///tmp/api",
  ]) {
    assert.throws(
      () => new ApiTransport(origin, { origin, accessToken: token }),
      fails("configuration"),
    );
  }
  assert.throws(() => client("http://example.com"), fails("configuration"));
  assert.throws(
    () =>
      new ApiTransport("https://one.example", {
        origin: "https://two.example",
        accessToken: token,
      }),
    fails("configuration"),
  );
  assert.throws(
    () =>
      new ApiTransport("https://one.example", {
        origin: "https://one.example",
        accessToken: "bad\r\nheader",
      }),
    fails("configuration"),
  );
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 30001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1048577 },
  ])
    assert.throws(
      () => client("http://127.0.0.1", options),
      fails("configuration"),
    );
});
test("rejects route escapes and oversized requests before any network access", async (t) => {
  let requests = 0;
  const origin = await server(t, (_req, res) => {
    requests++;
    res.end();
  });
  const api = client(origin);
  for (const route of [
    "https://evil.example/api/v1/account",
    "//evil.example",
    "/api/v1/../account",
    "/api/v1/%2e%2e/account",
    "/api/v1/account?token=secret",
    "/api/v1//account",
    "/health/live",
  ])
    await assert.rejects(api.request("GET", route), fails("request"));
  await assert.rejects(
    api.request("POST", "/api/v1/repositories", {
      body: { description: "x".repeat(65536) },
    }),
    fails("request"),
  );
  await assert.rejects(
    api.request("GET", "/api/v1/account", { body: {} }),
    fails("request"),
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    api.request("POST", "/api/v1/repositories", { body: cyclic }),
    fails("request"),
  );
  assert.equal(requests, 0);
});
test("never follows a cross-origin redirect with a credential", async (t) => {
  let forwarded = 0;
  const other = await server(t, (_req, res) => {
    forwarded++;
    res.end();
  });
  const origin = await server(t, (_req, res) => {
    res.writeHead(307, { Location: other + "/api/v1/account" });
    res.end();
  });
  await assert.rejects(
    client(origin).request("GET", "/api/v1/account"),
    fails("redirect"),
  );
  assert.equal(forwarded, 0);
});
for (const [status, code] of [
  [400, "http"],
  [401, "authentication"],
  [403, "permission"],
  [404, "not_found"],
  [409, "conflict"],
  [413, "http"],
  [429, "rate_limited"],
  [500, "service"],
  [503, "service"],
]) {
  test(`HTTP ${status} has a safe error and no automatic retry`, async (t) => {
    let calls = 0;
    const origin = await server(t, (_req, res) => {
      calls++;
      res.writeHead(status);
      res.end(token + " PRIVATE_SERVER_DETAIL");
    });
    await assert.rejects(
      client(origin).request("GET", "/api/v1/account"),
      (error) => {
        fails(code)(error);
        assert.equal(error.status, status);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}
test("writes JSON once and accepts no-content success", async (t) => {
  let requestBody;
  const origin = await server(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requestBody = {
      method: req.method,
      type: req.headers["content-type"],
      body: JSON.parse(text),
    };
    res.writeHead(204);
    res.end();
  });
  assert.deepEqual(
    await client(origin).request("PUT", "/api/v1/account", {
      body: { handle: "alice" },
    }),
    { status: 204, data: undefined },
  );
  assert.deepEqual(requestBody, {
    method: "PUT",
    type: "application/json",
    body: { handle: "alice" },
  });
});
for (const mode of [
  "declared",
  "chunked",
  "compressed",
  "html",
  "json",
  "utf8",
]) {
  test(`rejects invalid/oversized ${mode} response`, async (t) => {
    const origin = await server(t, (_req, res) => {
      res.setHeader(
        "Content-Type",
        mode === "html" ? "text/html" : "application/json",
      );
      const oversized = JSON.stringify({ value: "x".repeat(1024) });
      if (mode === "declared") {
        res.setHeader("Content-Length", Buffer.byteLength(oversized));
        res.end(oversized);
      } else if (mode === "chunked") {
        res.write(oversized);
        res.end();
      } else if (mode === "compressed") {
        const body = gzipSync(oversized);
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Content-Length", body.length);
        res.end(body);
      } else if (mode === "utf8") res.end(Buffer.from([0x22, 0xff, 0x22]));
      else res.end("PRIVATE_SERVER_DETAIL");
    });
    await assert.rejects(
      client(origin, { maxResponseBytes: 128 }).request(
        "GET",
        "/api/v1/account",
      ),
      fails("response"),
    );
  });
}
for (const mode of ["headers", "body"]) {
  test(`deadline covers stalled ${mode}`, async (t) => {
    const origin = await server(t, (_req, res) => {
      if (mode === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"value":');
      }
    });
    await assert.rejects(
      client(origin, { timeoutMs: 100 }).request("GET", "/api/v1/account"),
      fails("timeout"),
    );
  });
}
test("caller cancellation is safe before and during a request", async (t) => {
  const abort = new AbortController();
  const origin = await server(t, () => abort.abort("PRIVATE_SERVER_DETAIL"));
  const api = client(origin);
  await assert.rejects(
    api.request("GET", "/api/v1/account", { signal: abort.signal }),
    fails("cancelled"),
  );
  await assert.rejects(
    api.request("GET", "/api/v1/account", { signal: abort.signal }),
    fails("cancelled"),
  );
});
test("connection failure is redacted", async (t) => {
  const origin = await server(t, (req) => req.socket.destroy());
  await assert.rejects(
    client(origin).request("GET", "/api/v1/account"),
    fails("network"),
  );
});
