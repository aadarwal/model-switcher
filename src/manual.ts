// src/manual.ts
//
// The human's hands on the recovery transaction (spec §4, §9):
//
//   ms rotate <session|pane> [--force]                   move a walled session NOW
//   ms switch <session|pane> --to <account> [--continue] [--force]
//   ms stop   <session|pane>                             end it; give the pane back
//
// `rotate` and `switch` are the SAME transaction the automatic worker runs —
// `recoverSession` with `manual` set — so a human and a hook can never disagree
// about what a handoff is: one lock, one recheck, one respawn. All these verbs
// add is the human's intent (which account, whether to carry the work over) and
// the refusals that only make sense when a person is asking:
//
//   * a pane that is mid-turn is not switched out from under its own work
//     (`--force` is the deliberate override);
//   * an account nobody registered, or the one the session is already on, is a
//     typo, not an instruction — and is refused before the pane is touched.
//
// `stop` is the one verb that is not a handoff: it records the intent FIRST
// (spec §9: "`ms stop` during polling: the intent is recorded first and checked
// before every destructive step" — which is why it takes no lock; `desired =
// stopped` is what a racing recovery rechecks), then asks the CLI to leave and
// puts the human's login shell back in the pane, so a pane that ran `ms claude`
// ends up at a prompt exactly as a pane that ran `claude` would.
//
// Exit codes are the caller's contract: 0 done, 1 refused (one line saying
// why), 2 the command line itself is wrong.

import { setTimeout as sleep } from "node:timers/promises";
import type { Verb } from "./cli.ts";
import { recoverSession, stopPane } from "./recover.ts";
import { findAccount, loadRegistry } from "./registry.ts";
import { openState, type SessionRow, type State } from "./state.ts";
import { Tmux, currentPane, tmuxFromEnv } from "./tmux.ts";
import { lastTurn, wallKindFromText } from "./wall.ts";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

/** How long `stop` waits for the pane to settle after the exit sequence. */
const SETTLE_MS = 10_000;
/** Tests set this low so the loop runs in milliseconds. */
const pollMs = (): number => Number(process.env.MS_POLL_MS) || 500;
/** The shell a stopped pane is handed back to. */
const loginShell = (): string => process.env.SHELL || "/bin/zsh";

const USAGE: Record<string, string> = {
  rotate: "usage: ms rotate [<session|pane>] [--force]",
  switch: "usage: ms switch [<session|pane>] --to <account> [--continue] [--force]",
  stop: "usage: ms stop [<session|pane>]",
};

/** A refusal: one line saying why, and exit 1. */
function refuse(verb: string, why: string): 1 {
  process.stderr.write(`ms ${verb}: ${why}\n`);
  return EXIT_REFUSED;
}
/** A command line that did not parse: the reason AND the shape, and exit 2. */
function usage(verb: string, why: string): 2 {
  process.stderr.write(`ms ${verb}: ${why}\n${USAGE[verb]}\n`);
  return EXIT_USAGE;
}

// --- The command line --------------------------------------------------

type Options = { target: string | null; to: string | null; force: boolean; continueAfter: boolean };
type Allowed = { to?: boolean; continueAfter?: boolean; force?: boolean };

/**
 * One positional (a session id or a `%N` pane) plus whichever flags the verb
 * takes. A flag the verb does NOT take is a mistake rather than a guess — `ms
 * rotate --to gmail` means `ms switch`, and silently ignoring the `--to` would
 * move the session to an account nobody chose.
 */
export function parseManualArgs(argv: string[], allowed: Allowed): Options | { error: string } {
  const out: Options = { target: null, to: null, force: false, continueAfter: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (allowed.to && (a === "--to" || a.startsWith("--to="))) {
      const v = a.startsWith("--to=") ? a.slice("--to=".length) : argv[++i];
      if (!v) return { error: "--to needs an account name" };
      out.to = v;
      continue;
    }
    if (allowed.force && a === "--force") { out.force = true; continue; }
    if (allowed.continueAfter && a === "--continue") { out.continueAfter = true; continue; }
    if (a.startsWith("-")) return { error: `unexpected option ${JSON.stringify(a)}` };
    if (out.target) return { error: `unexpected argument ${JSON.stringify(a)} — one session at a time` };
    out.target = a;
  }
  return out;
}

// --- Which session ------------------------------------------------------

type Resolved = { session: SessionRow } | { error: string; code: 1 | 2 };

/**
 * `<session|pane>`, or the caller's own pane when nothing is named.
 *
 * A `%N` is only a name on the server that minted it: tmux reuses pane ids
 * across server restarts, so a pane id is matched against BOTH the recorded
 * pane and the recorded server identity. Get that wrong and `ms stop %7` types
 * `/exit` into whatever now happens to hold `%7` — someone else's editor.
 */
function resolveSession(st: State, target: string | null): Resolved {
  const arg = target ?? currentPane();
  if (!arg) return { error: "name a session or a pane (inside its pane, no argument means that pane)", code: EXIT_USAGE };
  if (!arg.startsWith("%")) {
    const s = st.getSession(arg);
    return s ? { session: s } : { error: `no such session ${arg}`, code: EXIT_REFUSED };
  }
  let identity: string;
  try {
    identity = tmuxFromEnv().serverIdentity();
  } catch (e) {
    return { error: `cannot ask tmux which server this is (${(e as Error).message}); name the session by its id`, code: EXIT_REFUSED };
  }
  const here = st.listSessions().filter((s) => s.pane === arg && s.serverStart === identity);
  // A pane outlives the session that ran in it: prefer one that is still
  // managed, and the most recent of those.
  const live = here.filter((s) => s.state !== "stopped");
  const s = (live.length ? live : here).at(-1);
  return s ? { session: s } : { error: `${arg} is not a managed pane on this tmux server`, code: EXIT_REFUSED };
}

/** Resolve under a store this function opens and closes itself. */
function withSession(target: string | null): Resolved {
  const st = openState();
  try {
    return resolveSession(st, target);
  } finally {
    st.close();
  }
}

/** The account a session is on now — read after a handoff, to say where it went. */
function accountOf(id: string): string {
  const st = openState();
  try {
    return st.getSession(id)?.account ?? "?";
  } finally {
    st.close();
  }
}

// --- Reading the pane ---------------------------------------------------

function safeCapture(tmux: Tmux, pane: string): string {
  try {
    return tmux.capture(pane, 200);
  } catch {
    return ""; // a dead or vanished pane has no screen; that is not an error here
  }
}

/** The CLI is mid-turn: its own spinner says how to interrupt it. */
function isBusy(screen: string): boolean {
  const lines = screen.split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  return lines.slice(Math.max(0, end - 6), end).some((l) => /esc to interrupt/i.test(l));
}

/** The wall the pane's LAST turn is showing, if any — an older turn's wall is
 * still drawn long after it stopped being true (see src/wall.ts). */
const wallOnScreen = (screen: string): string | null => wallKindFromText(lastTurn(screen).join("\n"));

// --- ms rotate ----------------------------------------------------------

export const rotateVerb: Verb = async (argv) => {
  const parsed = parseManualArgs(argv, { force: true });
  if ("error" in parsed) return usage("rotate", parsed.error);
  const found = withSession(parsed.target);
  if ("error" in found) return found.code === EXIT_USAGE ? usage("rotate", found.error) : refuse("rotate", found.error);
  const { id } = found.session;

  // The work is unfinished by definition — a rotation is what happens to a
  // session that was stopped mid-turn by a wall — so it always continues.
  // `recoverSession` has already said on stderr (and in the session's log) why
  // anything other than 0 happened; 2 there means "nothing has room", which is
  // a refusal here, not this verb's usage error.
  const code = await recoverSession(id, { manual: { continueAfter: true }, force: parsed.force });
  if (code !== EXIT_OK) return EXIT_REFUSED;
  process.stderr.write(`ms: ${id} rotated → ${accountOf(id)}\n`);
  return EXIT_OK;
};

// --- ms switch ----------------------------------------------------------

export const switchVerb: Verb = async (argv) => {
  const parsed = parseManualArgs(argv, { to: true, force: true, continueAfter: true });
  if ("error" in parsed) return usage("switch", parsed.error);
  if (!parsed.to) return usage("switch", "--to <account> is required");
  const found = withSession(parsed.target);
  if ("error" in found) return found.code === EXIT_USAGE ? usage("switch", found.error) : refuse("switch", found.error);
  const session = found.session;
  const to = parsed.to;

  // Both checks are typo-catchers, and both run before the pane is touched:
  // the transaction would otherwise kill a healthy CLI on its way to finding
  // out that the account it was sent to does not exist.
  const { registry, parseError } = loadRegistry();
  if (parseError) return refuse("switch", `cannot read the registry: ${parseError}`);
  if (!findAccount(registry, to, session.provider)) return refuse("switch", `no such ${session.provider} account '${to}'`);
  if (to === session.account) return refuse("switch", `${session.id} is already on ${to}`);

  const tmux = new Tmux(session.socket || null);
  const screen = safeCapture(tmux, session.pane);
  if (isBusy(screen) && !parsed.force) return refuse("switch", `${session.id} is mid-turn; moving it now would kill that turn (use --force)`);

  // A switch of a conversation that had finished resumes without a
  // continuation (spec §9) — but a walled screen says the turn never finished,
  // so the work carries over whether or not the human thought to ask.
  const continueAfter = parsed.continueAfter || wallOnScreen(screen) !== null;
  const code = await recoverSession(session.id, { manual: { toAccount: to, continueAfter }, force: parsed.force });
  if (code !== EXIT_OK) return EXIT_REFUSED;
  process.stderr.write(`ms: ${session.id} switched → ${to}\n`);
  return EXIT_OK;
};

// --- ms stop ------------------------------------------------------------

type Settled = "dead" | "gone" | "revived" | "stubborn";

/**
 * Poll the pane until it has settled into one of four answers, or the budget
 * runs out. The pid matters: a LIVE pane holding a different process is not our
 * CLI refusing to die, it is tmux's own pane-died hook having already put a
 * shell back — and respawning over that would kill the shell we are trying to
 * give the human.
 */
async function settle(tmux: Tmux, pane: string, was: number | null, budgetMs: number): Promise<Settled> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const info = tmux.paneInfo(pane);
    if (!info) return "gone";
    if (info.dead || !info.pid) return "dead";
    if (was !== null && info.pid !== was) return "revived";
    const left = deadline - performance.now();
    if (left <= 0) return "stubborn";
    await sleep(Math.min(pollMs(), left));
  }
}

/**
 * Ask the CLI to leave and give the pane back to a shell. Returns a note for
 * the human when the ending was not the ordinary one, or null.
 */
async function endPane(tmux: Tmux, session: SessionRow): Promise<string | null> {
  if (!tmux.paneExists(session.pane)) return "the pane was already gone";
  // The recorded pane id means nothing on a server that has restarted since;
  // whatever holds it now is not ours to type into.
  let identity: string | null = null;
  try {
    identity = tmux.serverIdentity();
  } catch {
    /* an unreachable server is not a reason to refuse to mark the session stopped */
  }
  if (identity && session.serverStart && identity !== session.serverStart) {
    return "the tmux server has restarted; the pane was left alone";
  }

  const was = tmux.paneInfo(session.pane)?.pid ?? null;
  await stopPane(tmux, session, session.generation);
  switch (await settle(tmux, session.pane, was, SETTLE_MS)) {
    case "dead":
      // The CLI has gone either way, so a tmux that will not respawn is a note
      // for the human, not an exception: throwing here would leave the session
      // recorded as `stopping` forever, which is the one state that is untrue.
      try {
        tmux.respawn(session.pane, session.cwd, [loginShell(), "-l"]);
      } catch (e) {
        return `the pane could not be given back to a shell: ${(e as Error).message}`;
      }
      // The pane was the tool's only while the tool had something to respawn
      // into it. Handed back, it is an ordinary pane again: a shell the human
      // exits should close it, not leave a dead pane behind (and with
      // remain-on-exit off, the pane-died hook on it never fires again).
      try {
        tmux.remainOnExit(session.pane, false);
      } catch {
        /* the pane may have gone in the meantime; it is still a shell */
      }
      return null;
    case "revived":
      return null; // something already put a process back; leave it alone
    case "gone":
      return "the pane is gone";
    case "stubborn":
      return "the pane's own process is still running";
  }
}

export const stopVerb: Verb = async (argv) => {
  const parsed = parseManualArgs(argv, {});
  if ("error" in parsed) return usage("stop", parsed.error);
  const st = openState();
  try {
    const found = resolveSession(st, parsed.target);
    if ("error" in found) return found.code === EXIT_USAGE ? usage("stop", found.error) : refuse("stop", found.error);
    const session = found.session;

    // 1. The intent, before anything reaches the pane. `stopping` is what a
    //    racing recovery — and the pane-died hook — read to know that the pane
    //    is on its way out on purpose, so neither treats the death as a fault.
    st.updateSession(session.id, { desired: "stopped", state: "stopping" });
    const open = st.pendingRecovery(session.id);
    if (open) st.finishRecovery(open.id, "obsolete");
    st.setWakeup(session.id, null);

    // 2. Ask the CLI to leave, then hand the pane back.
    const note = await endPane(new Tmux(session.socket || null), session);

    st.updateSession(session.id, { state: "stopped" });
    process.stderr.write(`ms: ${session.id} stopped${note ? ` (${note})` : ""}\n`);
    return EXIT_OK;
  } finally {
    st.close();
  }
};
