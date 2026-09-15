// src/launch.ts
//
// `ms claude` (spec §7): choose the account, write down what is about to run,
// and hand the running of it to tmux.
//
// Nothing of ours stays resident. The launch is a record in the store plus one
// tmux command whose argv is `ms _exec <launch-id>`; `src/exec.ts` picks that
// record up inside the pane, puts the credential in the child's ENVIRONMENT
// and `execve`s the CLI in place. So no secret is ever an argument to tmux —
// tmux command strings are readable by anything that can talk to the server.
//
// Two shapes, one spine:
//   * inside tmux — the caller's OWN pane is respawned. tmux kills this very
//     process to do it, so everything the human should see is already on
//     stderr before the respawn is issued.
//   * outside tmux — a tool-owned server (`<store>/tmux.sock`), session `ms`,
//     then an interactive attach.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { ensureStore, msBinary, msHome, p } from "./paths.ts";
import { findAccount, loadRegistry } from "./registry.ts";
import { getSnapshot, toPickInputs, type AccountUsage } from "./snapshot.ts";
import { parseNeed, pickAccounts, type Need, type PickInput } from "./pick.ts";
import { openState } from "./state.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { Tmux, currentPane, tmuxFromEnv } from "./tmux.ts";

/** Exit codes, fixed by spec §7 so a caller can branch on them. */
const EXIT_OK = 0;
const EXIT_ACCOUNT = 1; // named account missing, or no launch token
const EXIT_USAGE_ERROR = 2; // the command line itself is wrong
const EXIT_NO_ROOM = 3; // nothing has room
const EXIT_UNREACHABLE = 4; // usage is down and there is no recent pick

/** The tool's own tmux server, for a launch with no tmux of its own. */
const TOOL_SOCKET = () => path.join(msHome(), "tmux.sock");
const TOOL_SESSION = "ms";

/** How long a remembered pick stands in for a reading we cannot take. */
export const LAST_PICK_MAX_AGE_MS = 600_000;

const SNAPSHOT_MAX_AGE_MS = 20_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function say(msg: string, detail: string[] = []): void {
  process.stderr.write(`ms claude: ${msg}\n${detail.map((l) => `  ${l}\n`).join("")}`);
}

// --- The command line --------------------------------------------------

type Parsed = { as: string | null; need: Need | null; args: string[] };

/**
 * `ms claude [--as name] [--need any|fable] [-- <claude args>]`.
 *
 * `--` is the boundary, and it is a hard one: everything after it is the
 * user's own claude command line and passes through untouched, and anything
 * before it that is not one of our two flags is a mistake rather than a guess
 * (a mistyped `--need` must not silently become an argument to claude).
 */
export function parseLaunchArgs(argv: string[]): Parsed | { error: string } {
  let as: string | null = null;
  let need: Need | null = null;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a === "--as" || a.startsWith("--as=")) {
      const v = a.startsWith("--as=") ? a.slice("--as=".length) : argv[++i];
      if (!v) return { error: "--as needs an account name" };
      as = v;
      continue;
    }
    if (a === "--need" || a.startsWith("--need=")) {
      const v = a.startsWith("--need=") ? a.slice("--need=".length) : argv[++i];
      const parsed = v === undefined ? null : parseNeed(v);
      if (!parsed) return { error: `--need must be 'any' or 'fable'` };
      need = parsed;
      continue;
    }
    return { error: `unexpected argument ${JSON.stringify(a)} — put claude's own arguments after --` };
  }
  // `--session-id` is how the launch keeps its grip on the CLI session across
  // a rotation; a user-supplied one would break the only handle we have.
  if (args.some((a) => a === "--session-id" || a.startsWith("--session-id="))) {
    return { error: "--session-id is set by ms; remove it" };
  }
  return { as, need, args };
}

// --- What the run needs ------------------------------------------------

function modelFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") return args[i + 1] ?? null;
    if (a.startsWith("--model=")) return a.slice("--model=".length);
  }
  return null;
}

function modelFromSettings(): string | null {
  const f = path.join(process.env.HOME || homedir(), ".claude", "settings.json");
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { model?: unknown };
    return typeof j?.model === "string" ? j.model : null;
  } catch {
    return null; // absent, unreadable or not JSON — all mean "it does not say"
  }
}

/** The need nobody stated. The effective model is whichever source speaks
 *  first — the command line, the environment, then the user's settings — and
 *  a model that names fable is a run that needs fable room. */
export function autoNeed(args: string[]): Need {
  const model = modelFromArgs(args) ?? (process.env.ANTHROPIC_MODEL || null) ?? modelFromSettings();
  return model && /fable/i.test(model) ? "fable" : "any";
}

// --- The last successful pick ------------------------------------------

type LastPick = { name: string; at: number };

/** The remembered pick for this need, or null when there is none young
 *  enough to still be evidence. */
export function readLastPick(need: Need): LastPick | null {
  try {
    const j = JSON.parse(readFileSync(p.lastPick, "utf8")) as Record<string, unknown>;
    const e = j?.[need];
    if (!e || typeof e !== "object") return null;
    const { name, at } = e as { name?: unknown; at?: unknown };
    if (typeof name !== "string" || !name) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    const age = Date.now() - at;
    // A negative age is a clock that went backwards; trusting it would let a
    // stale pick stand forever.
    if (age < 0 || age > LAST_PICK_MAX_AGE_MS) return null;
    return { name, at };
  } catch {
    return null;
  }
}

/** Remember a real pick, per need, without disturbing the other need's entry.
 *  This is a hint file, never a source of truth: a write that fails costs the
 *  next launch its fallback and nothing else, so it is never worth an error. */
export function writeLastPick(need: Need, name: string): void {
  ensureStore();
  let j: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(p.lastPick, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
  } catch {
    /* absent or torn: start a fresh one */
  }
  j[need] = { name, at: Date.now() };
  const tmp = `${p.lastPick}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(j) + "\n", { mode: 0o600 });
    renameSync(tmp, p.lastPick);
  } catch {
    rmSync(tmp, { force: true });
  }
}

/**
 * "We could not read usage", as distinct from "nothing has room".
 *
 * Every account the chooser could have used was passed over for a TRANSIENT
 * failure — the network, a 429, a timeout. An account that is genuinely full,
 * or whose grant is dead, is an answer; this is the absence of one, and it is
 * the only case where a remembered pick may stand in for a reading.
 */
export function usageUnreachable(rows: AccountUsage[], inputs: PickInput[]): boolean {
  if (!rows.length) return false;
  const errorOf = new Map(inputs.map((i) => [i.name, i.error]));
  return rows.every((a) => a.errorKind === "transient" && errorOf.get(a.name) != null);
}

// --- The verb ----------------------------------------------------------

export const launchClaude: Verb = async (argv) => {
  const parsed = parseLaunchArgs(argv);
  if ("error" in parsed) { say(parsed.error); return EXIT_USAGE_ERROR; }
  const need = parsed.need ?? autoNeed(parsed.args);

  const { registry } = loadRegistry();
  let account: string;

  if (parsed.as) {
    const named = findAccount(registry, parsed.as, "claude");
    if (!named) { say(`no such account '${parsed.as}'`); return EXIT_ACCOUNT; }
    account = named.name;
  } else {
    const mine = new Set(registry.accounts.filter((a) => a.provider === "claude").map((a) => a.name));
    if (!mine.size) { say("no account has room", ["no claude accounts are registered"]); return EXIT_NO_ROOM; }
    const snapshot = await getSnapshot({ maxAgeMs: SNAPSHOT_MAX_AGE_MS });
    // Only this provider's accounts: a codex row has no poller yet, and
    // letting it into the set would make "every account transient" unsayable.
    const rows = snapshot.accounts.filter((a) => mine.has(a.name));
    const inputs = toPickInputs({ takenAt: snapshot.takenAt, accounts: rows });
    const { picks, out } = pickAccounts(inputs, need);
    const reasons = out.map((o) => `${o.name}: ${o.why}`);
    const first = picks[0];
    if (first) {
      account = first.name;
      writeLastPick(need, account);
    } else if (usageUnreachable(rows, inputs)) {
      const last = readLastPick(need);
      if (!last) { say("usage unreachable", reasons); return EXIT_UNREACHABLE; }
      if (!findAccount(registry, last.name, "claude")) {
        say(`usage unreachable, and the last pick '${last.name}' is no longer registered`, reasons);
        return EXIT_UNREACHABLE;
      }
      account = last.name;
    } else {
      say("no account has room", reasons);
      return EXIT_NO_ROOM;
    }
  }

  // Existence only: the value belongs in the pane's environment (src/exec.ts),
  // never here, and never in a message.
  if (!readLaunchToken(account)) {
    say(`no launch token for account '${account}' (run: ms accounts add ${account})`);
    return EXIT_ACCOUNT;
  }

  const msBin = msBinary();
  const cwd = process.cwd();
  const sessionId = randomUUID();
  const cliSessionId = randomUUID();
  const launchId = randomUUID();
  const command = ["claude", "--session-id", cliSessionId, ...parsed.args];
  const inside = !!process.env.TMUX && !!process.env.TMUX_PANE;
  const tmux = inside ? tmuxFromEnv() : new Tmux(TOOL_SOCKET());
  const socket = tmux.socket ?? "";

  const st = openState();
  try {
    if (inside) {
      const pane = currentPane()!;
      const serverStart = tmux.serverIdentity();
      st.createSession({
        id: sessionId, provider: "claude", cliSessionId, cwd, socket, pane, serverStart,
        need, account, generation: 1, state: "launching", desired: "running",
        // The pass-through arguments verbatim: a rotation re-applies exactly
        // what this launch was asked for.
        flags: parsed.args,
      });
      st.createLaunch({ id: launchId, sessionId, generation: 1, account, command, env: {}, createdAt: nowSeconds() });

      tmux.remainOnExit(pane, true);
      tmux.setPaneOption(pane, "@ms_session", sessionId);
      tmux.setPaneDiedHook(pane, [msBin, "_pane_died", sessionId]);
      // The respawn below replaces the shell this process is running in, so
      // tmux kills us the moment it is issued: say it first or never.
      process.stderr.write(`ms: ${account} (${need}) → pane ${pane}\n`);
      tmux.respawn(pane, cwd, [msBin, "_exec", launchId]);
      return EXIT_OK;
    }

    // Outside tmux the pane does not exist yet, so the row is written without
    // one and completed the moment tmux names it. The new pane is already
    // running `ms _exec` by then; it reads the launch row (complete) and the
    // session's socket (correct from the start), and only `MS_PANE` could
    // briefly be empty — a few milliseconds against node's own startup.
    st.createSession({
      id: sessionId, provider: "claude", cliSessionId, cwd, socket, pane: "", serverStart: "",
      need, account, generation: 1, state: "launching", desired: "running", flags: parsed.args,
    });
    st.createLaunch({ id: launchId, sessionId, generation: 1, account, command, env: {}, createdAt: nowSeconds() });

    const exec = [msBin, "_exec", launchId];
    const pane = tmux.hasSession(TOOL_SESSION)
      ? tmux.newWindow(TOOL_SESSION, cwd, exec)
      : tmux.newSession(TOOL_SESSION, cwd, exec);
    st.updateSession(sessionId, { pane, serverStart: tmux.serverIdentity() });

    tmux.remainOnExit(pane, true);
    tmux.setPaneOption(pane, "@ms_session", sessionId);
    tmux.setPaneDiedHook(pane, [msBin, "_pane_died", sessionId]);
    process.stderr.write(`ms: ${account} (${need}) → pane ${pane}\n`);
    st.close(); // the attach below lasts as long as the session does
    // The launch has already happened; this exit code is the attach's own
    // (a terminal-less caller cannot attach, and the pane runs regardless).
    return tmux.attach(TOOL_SESSION);
  } finally {
    st.close(); // idempotent
  }
};
