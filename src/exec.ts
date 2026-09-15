import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { openState } from "./state.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { msBinary } from "./paths.ts";

// spec §7 step 4, §11: `ms _exec <launch-id>` is the command tmux runs in
// the pane. It loads the launch record and the account's launch credential
// from the store, builds the environment, and execs the CLI in place with
// `process.execve` — no process of ours stays resident, and no secret ever
// appears in a tmux command string (it only ever lives in the child's
// environment, never on argv).
const STRIP_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** `execve` takes a path, not a bare name, so we walk PATH ourselves the
 * way a shell would (first executable regular file named `name` wins). */
function resolveOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue; // not here (missing, not a file, or not executable); keep looking
    }
  }
  return null;
}

export const execLaunch: Verb = async (args) => {
  // Node ≥22.15 is required for `process.execve`; `bin/ms` stays untouched,
  // so this is the one place that checks and reports it.
  const execve = process.execve;
  if (typeof execve !== "function") {
    process.stderr.write("ms _exec: Node 22.15+ with process.execve is required\n");
    return 1;
  }

  const [id] = args;
  const st = openState();
  const launch = id ? st.getLaunch(id) : null;
  if (!launch) {
    st.close();
    process.stderr.write(`ms _exec: no launch record ${id ?? "(missing id)"}\n`);
    return 3;
  }

  const token = readLaunchToken(launch.account);
  if (!token) {
    st.close();
    process.stderr.write(`ms _exec: no launch token for account ${launch.account}\n`);
    return 3;
  }

  const cli = resolveOnPath(launch.command[0]);
  if (!cli) {
    st.close();
    process.stderr.write(`ms _exec: ${launch.command[0]} not found on PATH\n`);
    return 3;
  }

  const session = st.getSession(launch.sessionId);
  if (!session) {
    st.close();
    process.stderr.write(`ms _exec: no session ${launch.sessionId} for launch ${launch.id}\n`);
    return 3;
  }
  st.close();

  // Strip the conflicting provider vars, then layer launch.env (non-secret
  // extras recorded at launch) *before* the token and the identity
  // variables below — never after, so a launch.env entry (whatever wrote
  // it) can never shadow the real credential or MS_* identity.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIP_ENV_KEYS) delete env[key];
  for (const [k, v] of Object.entries(launch.env)) env[k] = v;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.MS_SESSION = launch.sessionId;
  env.MS_GENERATION = String(launch.generation);
  env.MS_SOCKET = session.socket;
  env.MS_PANE = session.pane;
  env.MS_ACCOUNT = launch.account;
  env.MS_BIN = msBinary();

  execve(cli, [cli, ...launch.command.slice(1)], env);
  return 0; // unreachable: a successful execve replaces this process image
};
