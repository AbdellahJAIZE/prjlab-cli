import {
  restoreSnapshot,
  recover,
  initialize,
  capture,
  status,
  exportSnapshot,
  ProjectError,
} from "./snapshot.js";
import { detectContext, describeSummary } from "./context-mirror.js";
export async function local(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string } | undefined> {
  const command = args[0];
  if (
    ![
      "init",
      "status",
      "snapshot",
      "export",
      "restore",
      "recover",
      "context",
    ].includes(command ?? "")
  )
    return undefined;
  try {
    if (command === "restore") {
      if (args.length !== 2)
        throw new ProjectError("Usage: prj restore <snapshot-id>");
      const result = await restoreSnapshot(cwd, args[1]!);
      return {
        code: 0,
        stdout: `Restored snapshot; ${result.changed} tracked paths changed. Local edits were preserved.\n`,
        stderr: "",
      };
    }
    if (command === "recover") {
      if (args.length !== 1) throw new ProjectError("Usage: prj recover");
      const result = await recover(cwd);
      return {
        code: 0,
        stdout: result.recovered
          ? "Interrupted restore recovered.\n"
          : "No interrupted restore found.\n",
        stderr: "",
      };
    }
    if (command === "export") {
      if (args.length !== 3)
        throw new ProjectError(
          "Usage: prj export <snapshot-id> <new-directory>",
        );
      const count = await exportSnapshot(cwd, args[1]!, args[2]!);
      return {
        code: 0,
        stdout: `Exported ${count} files to a new directory.\n`,
        stderr: "",
      };
    }
    if (args.length !== 1)
      throw new ProjectError(
        "This command does not accept additional arguments.",
      );
    if (command === "context") {
      const summary = await detectContext(cwd);
      return {
        code: 0,
        stdout: summary.length
          ? [
              "Context that travels with prj push (use --no-sessions to leave sessions out):",
              ...describeSummary(summary).map((l) => `  ${l}`),
              ...summary.flatMap((s) => s.warnings.map((w) => `  ${w}`)),
            ].join("\n") + "\n"
          : "No AI-tool context found for this folder yet. Supported: Claude Code.\n",
        stderr: "",
      };
    }
    if (command === "init") {
      await initialize(cwd);
      return {
        code: 0,
        stdout:
          "Initialized local PrjLab metadata. Add .prj/ to your .gitignore.\n",
        stderr: "",
      };
    }
    if (command === "snapshot") {
      const result = await capture(cwd);
      return {
        code: 0,
        stdout: `Snapshot ${result.id}\n${result.entries.length} files captured locally. Nothing uploaded.\n`,
        stderr: "",
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify(await status(cwd), null, 2) + "\n",
      stderr: "",
    };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr:
        error instanceof ProjectError
          ? error.message + "\n"
          : "Local operation failed. Check initialization and file permissions.\n",
    };
  }
}
