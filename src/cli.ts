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
      stdout: `PrjLab CLI (development)\n\nUsage: prj [login | logout | whoami | push <repository-id> | pull <repository-id> | clone <repository-id> <new-directory> | init | status | snapshot | export <id> <new-directory> | restore <id> | recover | --help | --version]\n\nRemote sync requires login, configured application settings and an existing repository UUID.\nLocal commands never upload. Push uploads selected project files to the configured server.\n`,
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
