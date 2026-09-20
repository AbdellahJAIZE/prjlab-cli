import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Ajv from "ajv/dist/2020.js";
import { validateSnapshot } from "../dist/snapshot.js";
const require = createRequire(import.meta.url);
const { spec, validate, response } = require("../contracts/check.cjs");
const fixtures = require("../contracts/fixtures.json");
const snapshotSchema = require("../contracts/snapshot.schema.json");
for (const [name, fixture] of Object.entries(fixtures)) {
  test(`public API fixture: ${name}`, () => validate(name, fixture));
}
test("every operation has a unique ID and a documented success schema", () => {
  const ids = new Set();
  for (const methods of Object.values(spec.paths)) {
    for (const op of Object.values(methods)) {
      assert.ok(!ids.has(op.operationId));
      ids.add(op.operationId);
      for (const [code, definition] of Object.entries(op.responses)) {
        if (code === "204") assert.equal(definition.content, undefined);
        else if (definition.content["application/octet-stream"]) {
          assert.equal(
            definition.content["application/octet-stream"]["x-max-bytes"],
            5242880,
          );
        } else {
          const name = definition.content["application/json"].schema.$ref
            .split("/")
            .at(-1);
          assert.ok(Object.hasOwn(fixtures, name));
        }
      }
    }
  }
  assert.equal(ids.size, 17);
});
test("response contract rejects leaked fields, malformed identity and invented statuses", () => {
  assert.throws(() =>
    validate("Account", { ...fixtures.Account, token: "secret" }),
  );
  assert.throws(() =>
    validate("Account", { ...fixtures.Account, id: "not-a-uuid" }),
  );
  assert.throws(() =>
    validate("RepositorySummary", {
      ...fixtures.RepositorySummary,
      role: "admin",
    }),
  );
  assert.throws(() => validate("RegisterAccount", { handle: "admin" }));
  assert.throws(() =>
    response("get", "/api/v1/account", 202, fixtures.Account),
  );
  assert.throws(() => response("get", "/api/v1/snapshots", 200, {}));
  assert.throws(() =>
    response("delete", "/api/v1/repositories/id/members/user", 204, {
      secret: true,
    }),
  );
});
test("version-1 snapshot schema and CLI agree on valid and malformed manifests", () => {
  const check = new Ajv({ strict: true }).compile(snapshotSchema);
  const entry = {
    path: ".prjcontext/memory/notes.md",
    hash: "a".repeat(64),
    size: 12,
    kind: "memory",
  };
  const valid = { version: 1, entries: [entry] };
  assert.equal(check(valid), true);
  assert.deepEqual(validateSnapshot(valid), valid);
  for (const value of [
    { ...valid, version: 2 },
    { ...valid, token: "secret" },
    { version: 1, entries: [{ ...entry, hash: "invalid" }] },
    { version: 1, entries: [{ ...entry, size: 5242881 }] },
    { version: 1, entries: [{ ...entry, kind: "executable" }] },
    { version: 1, entries: [{ ...entry, path: "" }] },
    { version: 1, entries: Array(1001).fill(entry) },
  ]) {
    assert.equal(check(value), false);
    assert.throws(() => validateSnapshot(value));
  }
  // JSON Schema checks structure; portable path containment remains a semantic check.
  const traversal = { version: 1, entries: [{ ...entry, path: "../escape" }] };
  assert.equal(check(traversal), true);
  assert.throws(() => validateSnapshot(traversal));
});

test("binary contract checks response types and transfer bounds", () => {
  const path =
    "/api/v1/repositories/00000000-0000-0000-0000-000000000000/objects/" +
    "0".repeat(64);
  response("get", path, 200, Buffer.alloc(0));
  response("put", path, 200, fixtures.ObjectReceipt, Buffer.alloc(0));
  assert.throws(() => response("get", path, 200, "text"));
  assert.throws(() => response("get", path, 200, Buffer.alloc(5242881)));
  assert.throws(() => response("put", path, 200, fixtures.ObjectReceipt, {}));
  assert.throws(() =>
    response("put", path, 200, fixtures.ObjectReceipt, Buffer.alloc(5242881)),
  );
});
