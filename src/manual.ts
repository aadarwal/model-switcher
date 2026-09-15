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
// Those refusals read the pane through recover.ts's OWN helpers (`safeCapture`,
// `isBusy`, and wall.ts's `wallKindFromText`), because a verb that refused a
// different set of panes than the transaction it is about to start would be
// worse than no refusal at all.
//
// `stop` is the one verb that is not a handoff. Its ordering is the whole
// design (spec §9: "`ms stop` during polling: the intent is recorded first and
// checked before every destructive step"):
//
//   1. the intent — `desired: stopped`, `state: stopping` — written WITHOUT the
//      lock, so a worker already inside its transaction can see it;
//   2. everything destructive under `sessionLockName(<id>)`, the very lock that
//      transaction holds, with the session row RE-READ inside it: a worker that
//      was already past its own `desired` check may have respawned the pane
//      onto a new account and generation, and the CLI we ask to leave has to be
//      the one that is in the pane now.
//
// Exit codes are the caller's contract: 0 done, 1 refused (one line saying
// why), 2 the command line itself is wrong.

import { setTimeout as sleep } from "node:timers/promises";
import type { Verb } from "./cli.ts";
import { Locked, withLock } from "./lock.ts";
import { isBusy, recoverSession, safeCapture, sessionLockName, stopPane } from "./recover.ts";
import { findAccount, loadRegistry } from "./registry.ts";
import { openState, type SessionRow, type State } from "./state.ts";
import { Tmux, currentPane, tmuxFromEnv } from "./tmux.ts";
import { wallKindFromText } from "./wall.ts";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

/** How long `stop` waits for a recovery worker to finish before giving up.
 * A handoff can take longer (exit ~14 s plus readiness up to 60 s); the
 * refusal leaves the stop intent written, so a retry is cheap and correct. */
const STOP_LOCK_WAIT_MS = 30_000;
/** How long `stop` waits for the pane to settle after the exit sequence. */
const SETTLE_MS = 10_000;
/** Every bound here is test-tunable, the way recover.ts's polls are; nothing
 * else in the verb depends on the values. */
const lockWaitMs = (): number => Number(process.env.MS_LOCK_WAIT_MS) || STOP_LOCK_WAIT_MS;
const settleMs = (): number => Number(process.env.MS_SETTLE_MS) || SETTLE_MS;
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
      const joined = a.startsWith("--to=");
      const v = joined ? a.slice("--to=".length) : argv[i + 1];
      // `ms switch s1 --to --force` is a forgotten account name, not an account
      // called "--force": swallowing the next flag would send the session to an
      // account nobody named.
      if (!v || (!joined && v.startsWith("-"))) return { error: "--to needs an account name" };
      if (!joined) i++;
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

// --- Preflight, shared by all three verbs -------------------------------

const STALE_SERVER = "tmux server restarted; the pane id is stale (ms status shows it gone)";

/**
 * Why the session's recorded pane id no longer means anything, or null.
 *
 * tmux restarts its pane numbering from `%0`, so after a server restart the
 * session's `%7` is somebody else's pane — and `paneExists` (all the
 * transaction itself asks) says yes about it. Every verb here is destructive
 * to whatever holds the pane, so every verb asks this first.
 */
function staleServer(tmux: Tmux, session: SessionRow): string | null {
  if (!session.serverStart) return null;
  let identity: string;
  try {
    identity = tmux.serverIdentity();
  } catch {
    // A server we cannot reach is a different failure, and the verb that
    // follows will report it in its own terms rather than as a stale pane.
    return null;
  }
  return identity && identity !== session.serverStart ? STALE_SERVER : null;
}

/** The wall the pane's last turn is showing, if any (wall.ts scopes it). */
const wallOnScreen = (screen: string): string | null => wallKindFromText(screen);

/**
 * Why this pane must not be moved out from under its own work, or null.
 *
 * A wall on screen means the turn ENDED at the wall, so a spinner still drawn
 * above it is not work in progress — exactly the reading `claimManual` applies
 * under the lock. Both come from recover.ts's own helpers so the two can never
 * drift into refusing different panes.
 */
function midTurn(session: SessionRow, screen: string, force: boolean): string | null {
  if (force || wallOnScreen(screen) || !isBusy(screen)) return null;
  return `${session.id} is mid-turn; moving it now would kill that turn (use --force)`;
}

// --- ms rotate ----------------------------------------------------------

export const rotateVerb: Verb = async (argv) => {
  const parsed = parseManualArgs(argv, { force: true });
  if ("error" in parsed) return usage("rotate", parsed.error);
  const found = withSession(parsed.target);
  if ("error" in found) return found.code === EXIT_USAGE ? usage("rotate", found.error) : refuse("rotate", found.error);
  const session = found.session;

  const tmux = new Tmux(session.socket || null);
  const stale = staleServer(tmux, session);
  if (stale) return refuse("rotate", stale);
  const busy = midTurn(session, safeCapture(tmux, session.pane), parsed.force);
  if (busy) return refuse("rotate", busy);

  // The work is unfinished by definition — a rotation is what happens to a
  // session that was stopped mid-turn by a wall — so it always continues.
  // `recoverSession` has already said on stderr (and in the session's log) why
  // anything other than 0 happened; 2 there means "nothing has room", which is
  // a refusal here, not this verb's usage error.
  const code = await recoverSession(session.id, { manual: { continueAfter: true }, force: parsed.force });
  if (code !== EXIT_OK) return EXIT_REFUSED;
  process.stderr.write(`ms: ${session.id} rotated → ${accountOf(session.id)}\n`);
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

  // The typo-catchers first, because they need no tmux at all: a mistyped
  // account name never becomes a question anybody asks the pane, and the
  // transaction never kills a healthy CLI on its way to finding out.
  const { registry, parseError } = loadRegistry();
  if (parseError) return refuse("switch", `cannot read the registry: ${parseError}`);
  if (!findAccount(registry, to, session.provider)) return refuse("switch", `no such ${session.provider} account '${to}'`);
  if (to === session.account) return refuse("switch", `${session.id} is already on ${to}`);

  const tmux = new Tmux(session.socket || null);
  const stale = staleServer(tmux, session);
  if (stale) return refuse("switch", stale);
  const screen = safeCapture(tmux, session.pane);
  const busy = midTurn(session, screen, parsed.force);
  if (busy) return refuse("switch", busy);

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
/** Whether the session really ended, and anything unusual about how. */
type Ending = { stopped: boolean; note: string | null };

/**
 * Poll the pane until it has settled into one of four answers, or the budget
 * runs out. The pid matters: a LIVE pane holding a different process is not our
 * CLI refusing to die, it is tmux's own pane-died hook having already put a
 * shell back — and respawning over that would kill the shell we are trying to
 * give the human. A live pane holding the SAME pid is the CLI refusing to die,
 * which is a thing to keep waiting on, never to respawn over.
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
 * The pane is not the tool's any more: a shell the human exits should close it
 * rather than leave a dead pane behind, and with `remain-on-exit` off the
 * pane-died hook still set on it never fires again (which would otherwise
 * respawn a login shell forever — the session's `desired` is `stopped`).
 */
function releasePane(tmux: Tmux, pane: string): void {
  try {
    tmux.remainOnExit(pane, false);
  } catch {
    /* the pane may have gone in the meantime; it is still not ours */
  }
}

/** Ask the CLI to leave and give the pane back to a shell. */
async function endPane(tmux: Tmux, session: SessionRow): Promise<Ending> {
  if (!tmux.paneExists(session.pane)) return { stopped: true, note: "the pane was already gone" };

  const was = tmux.paneInfo(session.pane)?.pid ?? null;
  await stopPane(tmux, session, session.generation);
  switch (await settle(tmux, session.pane, was, settleMs())) {
    case "dead": {
      // The CLI has gone either way, so a tmux that will not respawn is a note
      // for the human, not an exception: throwing here would leave the session
      // recorded as `stopping`, the one state that would be untrue.
      let note: string | null = null;
      try {
        tmux.respawn(session.pane, session.cwd, [loginShell(), "-l"]);
      } catch (e) {
        note = `the pane could not be given back to a shell: ${(e as Error).message}`;
      }
      releasePane(tmux, session.pane);
      return { stopped: true, note };
    }
    case "revived":
      // Something already put a process back. Leave it alone — but the pane is
      // still the tool's until we say otherwise.
      releasePane(tmux, session.pane);
      return { stopped: true, note: null };
    case "gone":
      return { stopped: true, note: "the pane is gone" };
    case "stubborn":
      // Alive, same pid, after `/exit`, SIGTERM and SIGKILL. The session is NOT
      // stopped; the intent stays written and `stopping` is the honest state
      // for reconciliation to find.
      return { stopped: false, note: "the pane's own process did not exit" };
  }
}

/** A recovery for a session that is ending describes a world that is over. */
function obsoleteRecovery(st: State, id: string): void {
  const open = st.pendingRecovery(id);
  if (open) st.finishRecovery(open.id, "obsolete");
}

export const stopVerb: Verb = async (argv) => {
  const parsed = parseManualArgs(argv, {});
  if ("error" in parsed) return usage("stop", parsed.error);
  const st = openState();
  try {
    const found = resolveSession(st, parsed.target);
    if ("error" in found) return found.code === EXIT_USAGE ? usage("stop", found.error) : refuse("stop", found.error);
    const session = found.session;

    // 1. Already over. A second `ms stop` — or one aimed at a pane the first
    //    already handed back — must never type `/exit` into the human's login
    //    shell and then SIGKILL it.
    //
    //    `stopping` is deliberately NOT that case. It is the one state that
    //    means a stop which did not finish (a lock it could not take, a CLI
    //    that would not exit), and it is only ever written while the pane still
    //    holds the CLI — a handed-back pane is `stopped` — so it stays
    //    retryable, which is what the `a recovery is in progress (a handoff can take ~75 s); retry` line
    //    below promises.
    if (session.state === "stopped" || (session.desired === "stopped" && session.state !== "stopping")) {
      process.stderr.write(`ms: ${session.id} already stopped\n`);
      return EXIT_OK;
    }

    // 2. Whose pane is it? (Shared preflight; nothing has been written yet.)
    const stale = staleServer(new Tmux(session.socket || null), session);
    if (stale) return refuse("stop", stale);

    // 3. The intent, UNLOCKED and before anything reaches the pane: a worker
    //    already inside the transaction rechecks `desired` and must be able to
    //    see this while we are still waiting for its lock.
    st.updateSession(session.id, { desired: "stopped", state: "stopping" });
    obsoleteRecovery(st, session.id);
    st.setWakeup(session.id, null);

    // 4. Everything destructive under the session's own mutation lock.
    try {
      return await withLock(
        sessionLockName(session.id),
        async () => {
          // Re-read: a worker that was already past its own `desired` check can
          // have finished a handoff while we waited, so the pane, generation and
          // account may all have moved. The CLI we ask to leave is that one.
          const fresh = st.getSession(session.id) ?? session;
          obsoleteRecovery(st, fresh.id);
          const ended = await endPane(new Tmux(fresh.socket || null), fresh);
          if (!ended.stopped) return refuse("stop", `${fresh.id}: ${ended.note}`);
          st.updateSession(fresh.id, { state: "stopped" });
          process.stderr.write(`ms: ${fresh.id} stopped${ended.note ? ` (${ended.note})` : ""}\n`);
          return EXIT_OK;
        },
        { waitMs: lockWaitMs() },
      );
    } catch (e) {
      if (e instanceof Locked || (e as Error)?.name === "Locked") {
        // The intent stays written: whoever holds the lock reads it, and a
        // second `ms stop` picks up where this one stood down.
        return refuse("stop", `${session.id}: a recovery is in progress (a handoff can take ~75 s); retry`);
      }
      throw e;
    }
  } finally {
    st.close();
  }
};
