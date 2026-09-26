export const VERSION = "1.0.0";
const HELP = `prj ${VERSION} — push, pull and clone your projects with their context.

Usage: prj <command> [arguments]

Account
  login                              Sign in through your browser; git then signs
                                     in to PrjLab by itself (no password)
  whoami                             Show the signed-in handle
  logout                             Remove the saved credentials on this machine

Git repositories (code travels with git, AI context with prj)
  clone <handle>/<name> [<dir>]      git clone + prj init
  init                               In a git repository: link it, keep .prj out
                                     of git, install hooks so Claude Code memory
                                     and sessions travel with git push/pull/switch
  context                            Show the AI-tool context found for this folder
  context push|pull [--quiet]        Move the context by hand (the hooks do this)
  Like GitHub: git clone https://prjlab.com/<handle>/<name>.git, then prj init.

Folders without git (versions)
  remote add origin <handle>/<name>  Link this directory to a repository
  remote -v | set-url | remove       Show or change the link
  push [origin] [-m "…"] [--no-sessions]
                                     Upload this directory and its AI context
  pull [origin]                      Bring this directory up to the latest version
  A repository ID or its https://prjlab.com/<handle>/<name> link works in
  place of <handle>/<name>.

Local (offline)
  init                               Prepare this directory (creates .prj/)
  status                             Show what changed since the last snapshot
  snapshot                           Record a local snapshot
  export <snapshot-id> <new-dir>     Write a snapshot into a new directory
  restore <snapshot-id>              Return tracked files to a snapshot
  recover                            Finish an interrupted restore

  --help, --version

prj tells you when a newer version is on npm (checked at most once a day;
PRJ_NO_UPDATE_CHECK=1 turns it off). Update with: npm install -g prjlab-cli

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
