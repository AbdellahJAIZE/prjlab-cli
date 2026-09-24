export const VERSION = "0.5.0";
const HELP = `prj ${VERSION} — push, pull and clone your projects with their context.

Usage: prj <command> [arguments]

Account
  login                              Sign in through your browser (https://prjlab.com)
  whoami                             Show the signed-in handle
  logout                             Remove the saved credentials on this machine

Sync (needs login; create repositories at https://prjlab.com/new)
  remote add origin <handle>/<name>  Link this directory to a repository
  remote -v                          Show the linked repository
  remote set-url origin <handle>/<name>
  remote remove origin               Forget the link (files stay)
  push [origin] [-m "…"] [--no-sessions]
                                     Upload this directory and its AI context
                                     (Claude Code memory, sessions, settings)
  pull [origin]                      Bring this directory up to the latest version
  clone <handle>/<name> [<dir>]      Copy a repository into a new directory
  Like git: push and pull use origin; "prj push origin main" and
  "prj push -u origin main" work too (PrjLab has no branches). A repository
  ID or its https://prjlab.com/<handle>/<name> link works in place of
  <handle>/<name>, and prj push <handle>/<name> links on the first push.
  -m / --message describes the version (up to 200 characters).

Local (offline)
  init                               Prepare this directory (creates .prj/)
  status                             Show what changed since the last snapshot
  context                            Show the AI-tool context found for this folder
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
