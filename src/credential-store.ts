import { homedir } from "node:os";
import path from "node:path";
import {
  mkdir,
  lstat,
  open,
  unlink,
  realpath,
  readFile,
  rename,
} from "node:fs/promises";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
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
// Envelope storage: a random AES-256-GCM key lives in the OS credential store
// (Windows Credential Manager, macOS Keychain, Linux Secret Service); the
// encrypted session lives in a private file next to the lock. The file alone
// reveals nothing, the key entry stays tiny (Windows caps credential blobs at
// 2,560 bytes), and there is no plaintext fallback.
const SERVICE = "PrjLab CLI";
const FILE = "session.enc";
const FORMAT = 1;
const LEGACY_FILES = ["cache.bin", "test.cache", "cache.bin.lockfile"];
async function privateFile(file: string) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
    throw new Error("unsafe credential file");
  return stat;
}
export interface KeyEntry {
  getPassword(): Promise<string | undefined | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export type KeyEntryFactory = (account: string) => Promise<KeyEntry>;
const nativeEntry: KeyEntryFactory = async (account) => {
  // Lazy import keeps help and local commands independent of native keychain availability.
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const entry = new AsyncEntry(SERVICE, account, {
    linux: { store: "secret-service" },
  });
  return {
    getPassword: () => entry.getPassword(),
    setPassword: (value) => entry.setPassword(value),
    deletePassword: () => entry.deletePassword(),
  };
};
export async function secureStore(
  config: LoginConfig,
  directory: string,
  entries: KeyEntryFactory = nativeEntry,
): Promise<CredentialStore> {
  const scope = credentialScope(config);
  const file = path.join(directory, FILE);
  const aad = Buffer.from(`prjlab-session:${FORMAT}:${scope}`);
  let key: KeyEntry, legacy: KeyEntry;
  try {
    await privateFile(file);
    key = await entries(`${scope}:session-key`);
    // 0.3.x stored the whole session under the bare scope (keytar); on macOS the
    // same entry is reachable here and is removed on the next save or logout.
    legacy = await entries(scope);
  } catch {
    throw new LoginError(
      "Secure OS credential storage is unavailable. Enable your keychain/Secret Service. Tokens were not saved as plain text.",
    );
  }
  const readKey = async () => {
    const raw = await key.getPassword();
    if (!raw) return null;
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length !== 32) throw new Error("invalid session key");
    return bytes;
  };
  const cleanLegacy = async () => {
    await legacy.deletePassword().catch(() => false);
    for (const name of LEGACY_FILES)
      await unlink(path.join(directory, name)).catch(() => {});
  };
  return {
    load: async () => {
      const stat = await privateFile(file);
      if (!stat) return null;
      if (stat.size > 8 * 1024 * 1024) throw new Error("credential too large");
      const secret = await readKey();
      if (!secret) return null;
      const blob = await readFile(file);
      if (blob.length < 1 + 12 + 16 || blob[0] !== FORMAT)
        throw new Error("invalid credential file");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        secret,
        blob.subarray(1, 13),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(blob.subarray(blob.length - 16));
      return Buffer.concat([
        decipher.update(blob.subarray(13, blob.length - 16)),
        decipher.final(),
      ]).toString("utf8");
    },
    save: async (value) => {
      let secret = await readKey();
      if (!secret) {
        secret = randomBytes(32);
        await key.setPassword(secret.toString("base64"));
        if (!(await readKey())?.equals(secret))
          throw new Error("session key was not stored");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([
        cipher.update(Buffer.from(value, "utf8")),
        cipher.final(),
      ]);
      const blob = Buffer.concat([
        Buffer.from([FORMAT]),
        iv,
        body,
        cipher.getAuthTag(),
      ]);
      const temporary = path.join(directory, `${FILE}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(blob);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      await cleanLegacy();
    },
    delete: async () => {
      const existed = (await privateFile(file)) !== undefined;
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const removed = await key.deletePassword();
      await cleanLegacy();
      return existed || removed;
    },
  };
}
