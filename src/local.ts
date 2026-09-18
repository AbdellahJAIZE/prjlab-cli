import {
  initialize,
  capture,
  status,
  exportSnapshot,
  ProjectError,
} from "./snapshot.js";
export async function local(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string } | undefined> {
  const command = args[0];
  if (!["init", "status", "snapshot", "export"].includes(command ?? ""))
    return undefined;
  try {
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
