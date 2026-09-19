import { homedir } from "node:os";
import path from "node:path";
import { mkdir, lstat, open, unlink, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  credentialScope,
  LoginError,
  type LoginConfig,
} from "./auth-config.js";
export interface CredentialStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  delete(): Promise<boolean>;
}
async function safeDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()))
  )
    throw new LoginError(
      "Credential directory must be private, owned by you and not a symlink.",
    );
}
export async function credentialDirectory(
  config: LoginConfig,
  home = homedir(),
) {
  let directory = await realpath(home);
  for (const component of [".prjlab", "auth", credentialScope(config)]) {
    directory = path.join(directory, component);
    await safeDirectory(directory);
  }
  return directory;
}
export async function withCredentialLock<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = path.join(directory, "operation.lock");
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch {
    throw new LoginError(
      "Another credential operation is active, or an interrupted operation left a lock. See the login recovery instructions.",
    );
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, operation: randomUUID() }),
    );
    return await work();
  } finally {
    await handle.close();
    await unlink(lock);
  }
}
export async function secureStore(
  config: LoginConfig,
  directory: string,
): Promise<CredentialStore> {
  try {
    const cachePath = path.join(directory, "cache.bin");
    const existing = await lstat(cachePath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (
      existing &&
      (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
    )
      throw new Error();
    const probePath = path.join(directory, "test.cache");
    const probe = await lstat(probePath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (
      probe &&
      (!probe.isFile() || probe.isSymbolicLink() || probe.nlink !== 1)
    )
      throw new Error();
    // Lazy import keeps help and local commands independent of native keychain availability.
    const { PersistenceCreator, DataProtectionScope } =
      await import("@azure/msal-node-extensions");
    const persistence = await PersistenceCreator.createPersistence({
      cachePath,
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: "PrjLab CLI",
      accountName: credentialScope(config),
      usePlaintextFileOnLinux: false,
      loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
    });
    return {
      load: async () => {
        if (process.platform === "win32") {
          const stat = await lstat(cachePath).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (!stat || stat.size === 0) return null;
        }
        return persistence.load();
      },
      save: (value) => persistence.save(value),
      delete: () => persistence.delete(),
    };
  } catch {
    throw new LoginError(
      "Secure OS credential storage is unavailable. Enable your keychain/Secret Service and install the native credential dependency. Tokens were not saved as plain text.",
    );
  }
}
