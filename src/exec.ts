import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { openState, type Provider } from "./state.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { msBinary, p } from "./paths.ts";

// spec §7 step 4, §11: `ms _exec <launch-id>` is the command tmux runs in
// the pane. It loads the launch record and the account's launch credential
// from the store, builds the environment, and execs the CLI in place with
// `process.execve` — no process of ours stays resident, and no secret ever
// appears in a tmux command string (it only ever lives in the child's
// environment, never on argv).
//
// The two providers hand the CLI its credential in different SHAPES, and the
// session row says which:
//   * claude — a launch token, read from a 0600 file into
//     `CLAUDE_CODE_OAUTH_TOKEN`. A secret in the environment, nowhere else.
//   * codex  — a DIRECTORY. `codex login` writes `auth.json` inside the
//     account's own CODEX_HOME, so this process points the CLI at it and
//     never reads, holds or passes on a credential at all.
//
// Either way the environment is scrubbed of anything that would make the CLI
// answer as somebody other than the account this tool just chose: an API key
// billed elsewhere, another provider's token, an alternative backend.
const STRIP_ENV_KEYS: Record<Provider, readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
  codex: [
    // An API key would bill an OpenAI account instead of the ChatGPT
    // subscription whose windows this tool is choosing between.
    "OPENAI_API_KEY",
    // Not codex's to read, and never right to carry into another CLI.
    "CLAUDE_CODE_OAUTH_TOKEN",
  ],
};

/** `execve` takes a path, not a bare name, so we walk PATH ourselves the
 * way a shell would (first executable regular file named `name` wins).
 * Exported for `src/doctor.ts`'s "ms on PATH" check — the one other module
 * that needs to resolve a name on PATH the same way. */
export function resolveOnPath(name: string): string | null {
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

  // The session is read BEFORE the credential, because the session is what
  // says which credential there is to read: a Codex launch has no token, and
  // looking for one would refuse a launch that is perfectly well set up.
  const session = st.getSession(launch.sessionId);
  if (!session) {
    st.close();
    process.stderr.write(`ms _exec: no session ${launch.sessionId} for launch ${launch.id}\n`);
    return 3;
  }
  const provider: Provider = session.provider;

  // What this account's CLI must be told, as a step applied later — after
  // `launch.env`, so nothing in that record can shadow it. The credential
  // itself is captured here and never named again: it is read once, put in
  // one environment variable, and that is the whole of its life.
  let applyCredential: (env: NodeJS.ProcessEnv) => void;
  if (provider === "claude") {
    const token = readLaunchToken(launch.account);
    if (!token) {
      st.close();
      process.stderr.write(`ms _exec: no launch token for account ${launch.account}\n`);
      return 3;
    }
    applyCredential = (env) => { env.CLAUDE_CODE_OAUTH_TOKEN = token; };
  } else {
    const home = p.codexHome(launch.account);
    applyCredential = (env) => {
      for (const key of STRIP_ENV_KEYS.codex) delete env[key];
      env.CODEX_HOME = home;
    };
  }

  const cli = resolveOnPath(launch.command[0]);
  if (!cli) {
    st.close();
    process.stderr.write(`ms _exec: ${launch.command[0]} not found on PATH\n`);
    return 3;
  }
  st.close();

  // Strip the conflicting provider vars, then layer launch.env (non-secret
  // extras recorded at launch) *before* the token and the identity
  // variables below — never after, so a launch.env entry (whatever wrote
  // it) can never shadow the real credential or MS_* identity.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIP_ENV_KEYS[provider]) delete env[key];
  for (const [k, v] of Object.entries(launch.env)) env[k] = v;
  // The codex arm re-runs its own strip in here, for the same reason the
  // token is set here: a launch.env entry must never be able to put back what
  // was scrubbed, any more than it can shadow the credential itself.
  applyCredential(env);
  env.MS_SESSION = launch.sessionId;
  env.MS_GENERATION = String(launch.generation);
  env.MS_SOCKET = session.socket;
  env.MS_PANE = session.pane;
  env.MS_ACCOUNT = launch.account;
  env.MS_BIN = msBinary();

  execve(cli, [cli, ...launch.command.slice(1)], env);
  return 0; // unreachable: a successful execve replaces this process image
};
