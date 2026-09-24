export const VERSION = "0.3.4";
const HELP = `prj ${VERSION} — push, pull and clone your projects with their context.

Usage: prj <command> [arguments]

Account
  login                              Sign in through your browser (https://prjlab.com)
  whoami                             Show the signed-in handle
  logout                             Remove the saved credentials on this machine

Sync (needs login; create repositories at https://prjlab.com/new)
  push [<handle>/<name>] [-m "…"]    Upload this directory as a new version
  pull [<handle>/<name>]             Bring this directory up to the latest version
  clone <handle>/<name> [<dir>]      Copy a repository into a new directory
  A repository ID works in place of <handle>/<name>. After the first push or
  clone, push and pull remember the repository. -m / --message describes
  the version (up to 200 characters).

Local (offline)
  init                               Prepare this directory (creates .prj/)
  status                             Show what changed since the last snapshot
  snapshot                           Record a local snapshot
  export <snapshot-id> <new-dir>     Write a snapshot into a new directory
  restore <snapshot-id>              Return tracked files to a snapshot
  recover                            Finish an interrupted restore

  --help, --version

Guide: https://prjlab.com/docs
`;
export function run(args: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const command = args[0];
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h", "help"].includes(command!))
  )
    return { code: 0, stdout: HELP, stderr: "" };
  if (args.length === 1 && ["--version", "-v"].includes(command!))
    return { code: 0, stdout: VERSION + "\n", stderr: "" };
  if (command === "search")
    return {
      code: 1,
      stdout: "",
      stderr: "Public search is not available yet. Run prj --help.\n",
    };
  // Do not echo unknown arguments: they could contain tokens or private paths.
  return {
    code: 2,
    stdout: "",
    stderr: "Unknown command or arguments. Run prj --help.\n",
  };
}
