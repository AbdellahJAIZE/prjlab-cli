export const VERSION = "0.0.0-development";
export function run(args: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const command = args[0];
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h", "help"].includes(command!))
  ) {
    return {
      code: 0,
      stdout: `PrjLab CLI (development)\n\nUsage: prj [--help | --version]\n\nLogin, push, pull and clone are not implemented yet.\nThis build does not read project files or send network requests.\n`,
      stderr: "",
    };
  }
  if (args.length === 1 && ["--version", "-v"].includes(command!))
    return { code: 0, stdout: VERSION + "\n", stderr: "" };
  if (
    command &&
    ["login", "logout", "push", "pull", "clone", "search"].includes(command)
  )
    return {
      code: 1,
      stdout: "",
      stderr: "This command is not available in the development build.\n",
    };
  // Do not echo unknown arguments: they could contain tokens or private paths.
  return {
    code: 2,
    stdout: "",
    stderr: "Unknown command or arguments. Run prj --help.\n",
  };
}
