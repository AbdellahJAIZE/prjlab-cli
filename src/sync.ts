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
  ): Promise<Buffer | { hash: string; bytes: number }>;
}
interface Link {
  version: 1;
  origin: string;
  repository: string;
  baseVersion: string | null;
  baseSnapshot: string | null;
  pendingPush?: { snapshot: string; retryKey: string; parent: string | null };
  pendingPull?: { snapshot: string; version: string };
}
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
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
      v.pendingPush.parent !== v.baseVersion)
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
export async function push(
  root: string,
  origin: string,
  repository: string,
  api: SyncApi,
  signal: AbortSignal,
) {
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
      };
      await project.writeLink(state);
    }
    const pending = state.pendingPush,
      manifest = await project.manifest(pending.snapshot);
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
    let response;
    try {
      response = await api.request(
        "POST",
        `/api/v1/repositories/${repository}/versions`,
        {
          body: {
            expectedParent: pending.parent,
            retryKey: pending.retryKey,
            manifest,
          },
          signal,
        },
      );
    } catch (error) {
      if (error instanceof TransportError && error.code === "conflict") {
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
