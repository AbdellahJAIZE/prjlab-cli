// When a folder is over the limits, let the person choose what stays out
// instead of refusing with nothing to act on. The choice is written to
// .prjignore, so it is visible, editable and applies to every later push.
import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { MAX_ENTRIES, MAX_FILE, MAX_TOTAL } from "./manifest.js";
import { describeUsage, type Usage } from "./snapshot.js";

/** Rule that leaves every AI-tool session out (memory and settings still travel). */
export const SESSIONS_RULE = ".prjcontext/agents/*/sessions/**";
export interface Choice {
  /** What the person types to pick it. */
  key: string;
  label: string;
  /** .prjignore lines that leave it out. */
  patterns: string[];
}
/** A path as a root-anchored .gitignore pattern, with its special characters escaped. */
export function pattern(name: string, directory: boolean) {
  const escaped = name
    .replace(/[\\*?[\]]/g, "\\$&")
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
  return `/${escaped}${directory ? "/" : ""}`;
}
const mib = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MiB`;
/** What can be left out, most useful first: folder parts, oversized files, sessions last. */
export function choices(usage: Usage): Choice[] {
  const out: Choice[] = [];
  // Rank parts by how much of each exceeded limit they account for.
  const overEntries = usage.files + usage.contextEntries > MAX_ENTRIES,
    overBytes = usage.bytes + usage.contextBytes > MAX_TOTAL;
  const weight = (g: Usage["groups"][number]) =>
    (overBytes || !overEntries ? g.bytes / MAX_TOTAL : 0) +
    (overEntries ? g.files / MAX_ENTRIES : 0);
  const parts = [...usage.groups]
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, 9);
  parts.forEach((g, i) =>
    out.push({
      key: String(i + 1),
      label: `${g.path}${g.directory ? "/" : ""}  (${g.files.toLocaleString("en-US")} file${g.files === 1 ? "" : "s"}, ${mib(g.bytes)})`,
      patterns: [pattern(g.path, g.directory)],
    }),
  );
  if (usage.oversize.length)
    out.push({
      key: "o",
      label: `every file over ${mib(MAX_FILE)}  (${usage.oversize.length.toLocaleString("en-US")} file${usage.oversize.length === 1 ? "" : "s"}, ${mib(usage.oversize.reduce((n, f) => n + f.size, 0))})`,
      patterns: usage.oversize.map((f) => pattern(f.path, false)),
    });
  if (usage.links.length)
    out.push({
      key: "l",
      label: `symbolic links  (${usage.links.length.toLocaleString("en-US")}, not supported)`,
      patterns: usage.links.map((l) => pattern(l, false)),
    });
  if (usage.sessions)
    out.push({
      key: "s",
      label: `AI sessions  (${usage.sessions.toLocaleString("en-US")} session${usage.sessions === 1 ? "" : "s"}; memory and settings still travel)`,
      patterns: [SESSIONS_RULE],
    });
  return out;
}
/** The choices named in an answer such as "1 3 o"; unknown words are ignored. */
export function selected(answer: string, offered: Choice[]): Choice[] {
  const keys = new Set(
    answer
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  );
  return offered.filter((c) => keys.has(c.key));
}
/** Append the chosen rules to .prjignore, skipping ones already there. */
export async function leaveOut(root: string, picked: Choice[]) {
  const file = path.join(root, ".prjignore");
  const present = new Set(
    (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/),
  );
  const lines = picked
    .flatMap((c) => c.patterns)
    .filter((l) => !present.has(l));
  if (!lines.length) return 0;
  const current = await readFile(file, "utf8").catch(() => "");
  await appendFile(
    file,
    (current && !current.endsWith("\n") ? "\n" : "") +
      "# Left out of PrjLab by choice (prj push)\n" +
      lines.join("\n") +
      "\n",
  );
  return lines.length;
}
export function prompt(usage: Usage, offered: Choice[]): string[] {
  return [
    ...describeUsage(usage).slice(0, -1),
    "",
    "What should stay out of PrjLab? The files stay on this computer.",
    ...offered.map((c) => `  ${c.key.padStart(2)})  ${c.label}`),
    "",
  ];
}
/** Ask on the terminal; an empty answer cancels. */
export async function ask(usage: Usage): Promise<Choice[]> {
  const offered = choices(usage);
  process.stderr.write(prompt(usage, offered).join("\n"));
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await terminal.question(
      'Type what to leave out (for example "1 3 o"), or press Enter to cancel: ',
    );
    return selected(answer, offered);
  } finally {
    terminal.close();
  }
}
