import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { initialize } from "./snapshot.js";
import { randomUUID } from "node:crypto";
import { withSync, ProjectError } from "./snapshot.js";
import { TransportError } from "./http.js";
import type { Snapshot } from "./manifest.js";
export interface SyncApi {
  request(
    method: "GET" | "POST",
    route: string,
    options?: { body?: unknown; signal?: AbortSignal },
  ): Promise<{ status: number; data: unknown }>;
  object(
    method: "GET" | "PUT",
    repo: string,
    hash: string,
    bytes?: Buffer,
    signal?: AbortSignal,
    upload?: string,
  ): Promise<Buffer | { hash: string; bytes: number }>;
}
interface Link {
  version: 1;
  origin: string;
  repository: string;
  baseVersion: string | null;
  baseSnapshot: string | null;
  pendingPush?: {
    snapshot: string;
    retryKey: string;
    parent: string | null;
    protocol?: "sessions";
    session?: string;
    message?: string;
  };
  pendingPull?: { snapshot: string; version: string };
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const MESSAGE_LIMIT = 200;
const validMessage = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= MESSAGE_LIMIT &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
// A push message: trailing line breaks are dropped; the server stores at most 200
// characters and rejects control characters other than tab and line breaks.
export function pushMessage(input: string): string {
  const message = input.replace(/[\r\n]+$/, "");
  if (message.length === 0)
    throw new ProjectError("The push message is empty.");
  if (!validMessage(message))
    throw new ProjectError(
      `The push message must be at most ${MESSAGE_LIMIT} characters and contain no control characters.`,
    );
  return message;
}
export interface PushOptions {
  message?: string;
}
// Splits `-m <text>` / `--message <text>` / `--message=<text>` out of push arguments.
export function parsePushArguments(args: readonly string[]): {
  rest: string[];
  options: PushOptions;
} {
  const rest: string[] = [],
    options: PushOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "-m" || arg === "--message") {
      if (i + 1 >= args.length)
        throw new ProjectError("Give the push message after -m.");
      value = args[++i]!;
    } else if (arg.startsWith("--message=")) value = arg.slice(10);
    else {
      rest.push(arg);
      continue;
    }
    if (options.message !== undefined)
      throw new ProjectError("Give the push message only once.");
    options.message = pushMessage(value);
  }
  return { rest, options };
}
function link(input: unknown, origin: string, repository: string): Link {
  if (!uuid(repository)) throw new ProjectError("Invalid repository ID.");
  if (input === null)
    return {
      version: 1,
      origin,
      repository,
      baseVersion: null,
      baseSnapshot: null,
    };
  const v = input as Link;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    v.version !== 1 ||
    v.origin !== origin ||
    v.repository !== repository ||
    !(v.baseVersion === null || uuid(v.baseVersion)) ||
    !(v.baseSnapshot === null || hash(v.baseSnapshot)) ||
    (v.baseVersion === null) !== (v.baseSnapshot === null) ||
    Object.keys(v).some(
      (k) =>
        ![
          "version",
          "origin",
          "repository",
          "baseVersion",
          "baseSnapshot",
          "pendingPush",
          "pendingPull",
        ].includes(k),
    )
  )
    throw new ProjectError(
      "Invalid or mismatched remote link. Existing state was kept.",
    );
  if (
    v.pendingPush &&
    (!hash(v.pendingPush.snapshot) ||
      !uuid(v.pendingPush.retryKey) ||
      v.pendingPush.parent !== v.baseVersion ||
      (v.pendingPush.protocol !== undefined &&
        v.pendingPush.protocol !== "sessions") ||
      (v.pendingPush.session !== undefined &&
        (!uuid(v.pendingPush.session) ||
          v.pendingPush.protocol !== "sessions")) ||
      (v.pendingPush.message !== undefined &&
        !validMessage(v.pendingPush.message)))
  )
    throw new ProjectError("Invalid pending push.");
  if (
    v.pendingPull &&
    (!hash(v.pendingPull.snapshot) || !uuid(v.pendingPull.version))
  )
    throw new ProjectError("Invalid pending pull.");
  if (v.pendingPush && v.pendingPull)
    throw new ProjectError("Conflicting pending remote operations.");
  return v;
}
function receipt(
  input: unknown,
  allowEmpty = false,
): { id: string | null; parent: string | null } {
  const v = input as { id: unknown; parent: unknown };
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    !(uuid(v.id) || (allowEmpty && v.id === null)) ||
    !(v.parent === null || uuid(v.parent)) ||
    Object.keys(v).some((k) => !["id", "parent"].includes(k)) ||
    (v.id === null && v.parent !== null)
  )
    throw new TransportError("response");
  return v as { id: string | null; parent: string | null };
}
function uploadReceipt(input: unknown) {
  const v = input as {
    id: string;
    status: string;
    expiresAt: string;
    version: string | null;
  };
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(",") !== "expiresAt,id,status,version" ||
    !uuid(v.id) ||
    !["active", "committed", "expired", "aborted"].includes(v.status) ||
    typeof v.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    !(v.version === null || uuid(v.version)) ||
    (v.status === "committed") !== (v.version !== null)
  )
    throw new TransportError("response");
  return v;
}
export async function push(
  root: string,
  origin: string,
  repository: string,
  api: SyncApi,
  signal: AbortSignal,
  options: PushOptions = {},
) {
  const message =
    options.message === undefined ? undefined : pushMessage(options.message);
  return withSync(root, async (project) => {
    const state = link(await project.readLink(), origin, repository);
    if (state.pendingPull)
      throw new ProjectError("Finish the pending pull before pushing.");
    if (!state.pendingPush) {
      const captured = await project.capture();
      if (Buffer.byteLength(JSON.stringify(captured.manifest)) > 60 * 1024)
        throw new ProjectError(
          "Manifest exceeds the server development limit.",
        );
      state.pendingPush = {
        snapshot: captured.id,
        retryKey: randomUUID(),
        parent: state.baseVersion,
        protocol: "sessions",
        ...(message === undefined ? {} : { message }),
      };
      await project.writeLink(state);
    }
    // A retried push resends exactly what was reserved; a new message waits for the next push.
    const pending = state.pendingPush,
      manifest = await project.manifest(pending.snapshot),
      described =
        pending.message === undefined ? {} : { message: pending.message };
    let response;
    let canClearConflict = false;
    try {
      if (pending.protocol === "sessions") {
        const base = `/api/v1/repositories/${repository}/uploads`;
        canClearConflict = !pending.session;
        const current = pending.session
          ? await api.request("GET", `${base}/${pending.session}`, { signal })
          : await api.request("POST", base, {
              body: {
                expectedParent: pending.parent,
                retryKey: pending.retryKey,
                manifest,
                ...described,
              },
              signal,
            });
        canClearConflict = false;
        const session = uploadReceipt(current.data);
        if (
          current.status !== 200 ||
          (pending.session && pending.session !== session.id)
        )
          throw new TransportError("response");
        pending.session = session.id;
        await project.writeLink(state);
        if (session.status === "committed") {
          response = {
            status: 200,
            data: { id: session.version, parent: pending.parent },
          };
        } else if (
          session.status === "expired" ||
          session.status === "aborted"
        ) {
          // A checked terminal state rules out a successful publication. Persist a
          // fresh key before the next invocation without changing snapshot/base.
          pending.retryKey = randomUUID();
          delete pending.session;
          await project.writeLink(state);
          throw new ProjectError(
            "Upload session closed. Retry push to resume the saved snapshot with a fresh reservation.",
          );
        } else {
          for (const entry of manifest.entries) {
            signal.throwIfAborted();
            await api.object(
              "PUT",
              repository,
              entry.hash,
              await project.bytes(entry),
              signal,
              session.id,
            );
          }
          canClearConflict = true;
          response = await api.request("POST", `${base}/${session.id}/commit`, {
            signal,
          });
        }
      } else {
        // Old on-disk pushes may already have committed through the legacy API.
        // Preserve their original retry namespace until that outcome is resolved.
        for (const entry of manifest.entries) {
          signal.throwIfAborted();
          await api.object(
            "PUT",
            repository,
            entry.hash,
            await project.bytes(entry),
            signal,
          );
        }
        canClearConflict = true;
        response = await api.request(
          "POST",
          `/api/v1/repositories/${repository}/versions`,
          {
            body: {
              expectedParent: pending.parent,
              retryKey: pending.retryKey,
              manifest,
              ...described,
            },
            signal,
          },
        );
      }
    } catch (error) {
      if (
        error instanceof TransportError &&
        error.code === "conflict" &&
        canClearConflict
      ) {
        delete state.pendingPush;
        await project.writeLink(state);
      }
      throw error;
    }
    const result = receipt(response.data);
    if (response.status !== 200 || result.parent !== pending.parent)
      throw new TransportError("response");
    state.baseVersion = result.id;
    state.baseSnapshot = pending.snapshot;
    delete state.pendingPush;
    await project.writeLink(state);
    return { version: result.id, files: manifest.entries.length };
  });
}
export async function pull(
  root: string,
  origin: string,
  repository: string,
  api: SyncApi,
  signal: AbortSignal,
) {
  return withSync(root, async (project) => {
    const state = link(await project.readLink(), origin, repository);
    if (state.pendingPush)
      throw new ProjectError(
        "Retry the pending push before pulling; its server outcome is unknown.",
      );
    // Revalidate remote access even when resuming a staged adoption.
    const tipResponse = await api.request(
      "GET",
      `/api/v1/repositories/${repository}/tip`,
      { signal },
    );
    const tip = receipt(tipResponse.data, true);
    if (tipResponse.status !== 200) throw new TransportError("response");
    if (!state.pendingPull) {
      if (tip.id === state.baseVersion) {
        await project.writeLink(state);
        return { version: tip.id, changed: 0 };
      }
      if (tip.id === null) throw new TransportError("response");
      const response = await api.request(
        "GET",
        `/api/v1/repositories/${repository}/versions/${tip.id}`,
        { signal },
      );
      const detail = response.data as {
        id: string;
        parent: string | null;
        manifest: Snapshot;
      };
      if (
        !detail ||
        typeof detail !== "object" ||
        Array.isArray(detail) ||
        response.status !== 200 ||
        detail.id !== tip.id ||
        detail.parent !== tip.parent ||
        Object.keys(detail).sort().join(",") !== "id,manifest,parent"
      )
        throw new TransportError("response");
      const snapshot = await project.stage(detail.manifest, async (entry) => {
        const bytes = await api.object(
          "GET",
          repository,
          entry.hash,
          undefined,
          signal,
        );
        if (!Buffer.isBuffer(bytes)) throw new TransportError("response");
        return bytes;
      });
      state.pendingPull = { snapshot, version: tip.id };
      await project.writeLink(state);
    }
    signal.throwIfAborted();
    const adopted = await project.adopt(
      state.pendingPull.snapshot,
      state.baseSnapshot,
    );
    state.baseVersion = state.pendingPull.version;
    state.baseSnapshot = state.pendingPull.snapshot;
    delete state.pendingPull;
    await project.writeLink(state);
    return { version: state.baseVersion, changed: adopted.changed };
  });
}

export async function clone(
  destination: string,
  origin: string,
  repository: string,
  api: SyncApi,
  signal: AbortSignal,
) {
  if (!uuid(repository)) throw new ProjectError("Invalid repository ID.");
  const target = path.resolve(destination);
  let ancestor = path.dirname(target);
  while (true) {
    const info = await lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ProjectError("Clone requires safe directory ancestors.");
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  // Check authorization before creating a destination; never replace an existing path.
  const checked = await api.request(
    "GET",
    `/api/v1/repositories/${repository}/tip`,
    { signal },
  );
  receipt(checked.data, true);
  if (checked.status !== 200) throw new TransportError("response");
  await mkdir(target, { mode: 0o700 });
  await initialize(target);
  return pull(target, origin, repository, api, signal);
}
