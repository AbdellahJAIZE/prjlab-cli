import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initialize } from "../dist/snapshot.js";
import { addRemote, showRemote } from "../dist/sync.js";
import { TransportError } from "../dist/http.js";
import {
  create,
  describeCreated,
  parseCreateArguments,
  slugFor,
} from "../dist/create.js";

const origin = "https://prjlab.com";
const id = "11111111-1111-4111-8111-111111111111";
async function folder(t, name = "My Project_v2") {
  const dir = await mkdtemp(path.join(tmpdir(), "prj-create-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, name);
  await mkdir(root);
  return root;
}
/** A server that creates whatever it is asked for, or answers with `fail`. */
function server(fail) {
  const calls = [];
  return {
    calls,
    request: async (method, route, options) => {
      calls.push({ method, route, body: options.body });
      if (fail) throw fail;
      return {
        status: 201,
        data: {
          id,
          handle: "ajaize",
          slug: options.body.slug,
          description: options.body.description ?? "",
          visibility: "private",
        },
      };
    },
  };
}
const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

test("folder names become repository names", () => {
  assert.equal(slugFor("My Project_v2"), "my-project-v2");
  assert.equal(
    slugFor("IND-abdellah-selfEmployed"),
    "ind-abdellah-selfemployed",
  );
  assert.equal(slugFor("  --Café déjà vu!!  "), "cafe-deja-vu");
  assert.equal(slugFor("x".repeat(80)).length, 63);
  assert.equal(slugFor("___"), "");
});

test("create names the repository after the folder, prepares .prj and links origin", async (t) => {
  const root = await folder(t);
  const api = server();
  const made = await create(root, origin, api, undefined, {
    description: "notes",
  });
  assert.deepEqual(api.calls, [
    {
      method: "POST",
      route: "/api/v1/repositories",
      body: { slug: "my-project-v2", description: "notes" },
    },
  ]);
  assert.deepEqual(made, {
    id,
    name: "ajaize/my-project-v2",
    visibility: "private",
    linked: true,
    initialized: true,
  });
  assert.deepEqual(await showRemote(root), {
    origin,
    repository: id,
    name: "ajaize/my-project-v2",
  });
  assert.deepEqual(describeCreated(origin, made), [
    "Created https://prjlab.com/ajaize/my-project-v2 (private).",
    "Initialized local PrjLab metadata. Add .prj/ to your .gitignore.",
    'origin is now ajaize/my-project-v2. Run prj push -m "First version" to upload.',
  ]);
});

test("--no-link only creates the repository and leaves the folder alone", async (t) => {
  const root = await folder(t);
  const made = await create(root, origin, server(), undefined, {
    name: "elsewhere",
    link: false,
  });
  assert.equal(made.linked, false);
  assert.equal(await exists(path.join(root, ".prj")), false);
  assert.match(
    describeCreated(origin, made).at(-1),
    /prj remote add origin ajaize\/elsewhere/,
  );
});

test("an already linked folder is refused before anything is created", async (t) => {
  const root = await folder(t);
  await initialize(root);
  await addRemote(root, origin, id, "ajaize/first");
  const api = server();
  await assert.rejects(
    create(root, origin, api, undefined, { name: "second" }),
    /already linked to ajaize\/first.*--no-link/,
  );
  assert.equal(api.calls.length, 0);
});

test("taken, invalid and reserved names are explained without touching the folder", async (t) => {
  const root = await folder(t);
  await assert.rejects(
    create(
      root,
      origin,
      server(new TransportError("conflict", 409)),
      undefined,
      {
        name: "taken",
      },
    ),
    /already have a repository named taken/,
  );
  const api = server();
  await assert.rejects(
    create(root, origin, api, undefined, { name: "Not Valid" }),
    /lower-case letters, digits and dashes/,
  );
  await assert.rejects(
    create(root, origin, api, undefined, { name: "prjlab" }),
    /reserved by PrjLab/,
  );
  await assert.rejects(
    create(root, origin, api, undefined, {
      name: "ok",
      description: "x".repeat(501),
    }),
    /at most 500 characters/,
  );
  assert.equal(api.calls.length, 0);
  assert.equal(await exists(path.join(root, ".prj")), false);
  // A folder whose name has no usable characters needs an explicit name.
  const odd = await folder(t, "___");
  await assert.rejects(
    create(odd, origin, api, undefined),
    /Give one: prj create <name>/,
  );
});

test("at the repository limit the refusal names the limit, not the name", async (t) => {
  const root = await folder(t);
  const owned = Array.from({ length: 200 }, (_, i) => ({
    slug: `r${i}`,
    role: "owner",
  }));
  const api = (list) => ({
    request: async (method) => {
      if (method === "GET") return { status: 200, data: list };
      throw new TransportError("conflict", 409);
    },
  });
  await assert.rejects(
    create(root, origin, api(owned), undefined, { name: "one-more" }),
    /already owns 200 repositories, which is the limit/,
  );
  // The name really is taken: say so, even at the limit.
  await assert.rejects(
    create(root, origin, api(owned), undefined, { name: "r7" }),
    /already have a repository named r7/,
  );
  // Shared repositories do not count towards what the account owns.
  const shared = owned.map((r) => ({ ...r, role: "reader" }));
  await assert.rejects(
    create(root, origin, api(shared), undefined, { name: "one-more" }),
    /already have a repository named one-more/,
  );
  assert.equal(await exists(path.join(root, ".prj")), false);
});

test("an unexpected reply is not trusted", async (t) => {
  const root = await folder(t);
  const api = {
    request: async () => ({
      status: 201,
      data: { id: "nope", handle: "ajaize", slug: "x" },
    }),
  };
  await assert.rejects(
    create(root, origin, api, undefined, { name: "x" }),
    TransportError,
  );
  assert.equal(await exists(path.join(root, ".prj")), false);
});

test("create arguments", () => {
  assert.deepEqual(parseCreateArguments([]), {});
  assert.deepEqual(
    parseCreateArguments(["name", "-d", "what it is", "--no-link"]),
    {
      name: "name",
      description: "what it is",
      link: false,
    },
  );
  assert.throws(() => parseCreateArguments(["a", "b"]), /Usage: prj create/);
  assert.throws(() => parseCreateArguments(["-d"]), /Usage: prj create/);
  assert.throws(() => parseCreateArguments(["--public"]), /Usage: prj create/);
});
