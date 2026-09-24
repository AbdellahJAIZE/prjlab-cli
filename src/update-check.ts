// "Update available" notice, like npm and gh. Asks the npm registry at most
// once a day (cached in ~/.prjlab/update-check.json), never for more than
// 1.5 s, never in CI or when stderr is not a terminal. PRJ_NO_UPDATE_CHECK=1
// turns it off. Nothing about the user or project is sent.
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const REGISTRY_URL = "https://registry.npmjs.org/prjlab-cli/latest";
const DAY = 24 * 60 * 60 * 1000;
function parse(version: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/** True when `latest` is a strictly newer plain x.y.z than `current`. */
export function isNewer(latest: string, current: string) {
  const a = parse(latest),
    b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
export interface UpdateCheckOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: number;
  tty?: boolean;
  fetcher?: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}
/** Resolves to the newer version to announce, or null. Never throws. */
export async function checkForUpdate(
  current: string,
  options: UpdateCheckOptions = {},
): Promise<string | null> {
  try {
    const env = options.env ?? process.env;
    if (env.PRJ_NO_UPDATE_CHECK || env.CI) return null;
    if (!(options.tty ?? process.stderr.isTTY)) return null;
    const now = options.now ?? Date.now();
    const file = path.join(
      options.home ?? homedir(),
      ".prjlab",
      "update-check.json",
    );
    let cached: { checkedAt?: number; latest?: string } = {};
    try {
      cached = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    let latest = typeof cached.latest === "string" ? cached.latest : null;
    if (
      typeof cached.checkedAt !== "number" ||
      now - cached.checkedAt > DAY ||
      now < cached.checkedAt
    ) {
      const fetcher =
        options.fetcher ??
        ((url, init) =>
          fetch(url, { ...init, headers: { accept: "application/json" } }));
      const response = await fetcher(REGISTRY_URL, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { version?: unknown };
      if (typeof body.version !== "string" || !parse(body.version)) return null;
      latest = body.version;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ checkedAt: now, latest }), {
        mode: 0o600,
      });
      await rename(temporary, file);
    }
    return latest && isNewer(latest, current) ? latest : null;
  } catch {
    return null;
  }
}
export function updateNotice(current: string, latest: string) {
  return `\nUpdate available: prj ${current} → ${latest}\nRun: npm install -g prjlab-cli\n`;
}
