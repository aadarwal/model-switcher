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
import { handBackShell, releasePane } from "./handback.ts";
import { Locked, withLock } from "./lock.ts";
import { HANDOFF_SLOTS, isBusy, recoverSession, safeCapture, sessionLockName, stopPane, takeFailReason } from "./recover.ts";
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

const USAGE: Record<string, string> = {
  rotate: "usage: ms rotate [<session|pane>] [--force]",
  switch: [
    "usage: ms switch [<session|pane>] --to <account> [--continue] [--force]",
    "       ms switch --all --to <account> [--continue] [--force] [--timeout <seconds>]",
  ].join("\n"),
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

type Options = { target: string | null; to: string | null; force: boolean; continueAfter: boolean; all: boolean; timeoutSeconds: number | null };
type Allowed = { to?: boolean; continueAfter?: boolean; force?: boolean; all?: boolean; timeout?: boolean };

/**
 * One positional (a session id or a `%N` pane) plus whichever flags the verb
 * takes. A flag the verb does NOT take is a mistake rather than a guess — `ms
 * rotate --to gmail` means `ms switch`, and silently ignoring the `--to` would
 * move the session to an account nobody chose.
 */
export function parseManualArgs(argv: string[], allowed: Allowed): Options | { error: string } {
  const out: Options = { target: null, to: null, force: false, continueAfter: false, all: false, timeoutSeconds: null };
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
    if (allowed.timeout && (a === "--timeout" || a.startsWith("--timeout="))) {
      const joined = a.startsWith("--timeout=");
      const v = joined ? a.slice("--timeout=".length) : argv[i + 1];
      // Same rule as `--to`, and one more: a budget that is not a number of
      // seconds is not a budget. `0` is legal and means "start nothing".
      if (!v || (!joined && v.startsWith("-"))) return { error: "--timeout needs a number of seconds" };
      if (!joined) i++;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: `--timeout needs a number of seconds, not ${JSON.stringify(v)}` };
      out.timeoutSeconds = n;
      continue;
    }
    if (allowed.all && a === "--all") { out.all = true; continue; }
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

/** What one session's move came to: 0 and how it went, or non-zero and why not. */
export type SwitchResult = { session: string; code: number; message: string };
export type SwitchOneOptions = {
  /** `true` always carries the unfinished work over, `false` never does, and
   * `"auto"` is the switch's own rule: a walled screen means the turn never
   * finished, so the work carries over whether or not the human thought to
   * ask. */
  continueAfter: boolean | "auto";
  force: boolean;
};

/**
 * The fallback message a transaction refusal carries when, somehow,
 * `recover.ts`'s own `takeFailReason` has nothing recorded for this session
 * — every `RecoverCode` a manual (`opts.manual.toAccount`-carrying) call can
 * return other than 0 is produced by `fail()`, which always records one
 * first, so this is defensive rather than a path either verb takes today.
 */
export const HANDOFF_REPORTED = "the handoff did not happen (the reason is above, and in ms status)";

/** How long `--all` keeps starting new moves for, when nobody says. */
const ALL_TIMEOUT_SECONDS = 600;

/** A budget said back to the human in the units they wrote it in. Rounding to
 * seconds would report `--timeout 0.4` as "the 0s budget ran out" — a budget
 * they never set, and one that reads as a bug rather than as a short deadline. */
const budgetSaid = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

/**
 * Move ONE session to `to`: the whole of `ms switch`'s per-session path, minus
 * the printing and the process's exit code.
 *
 * Every refusal is returned rather than printed, because the two callers say
 * them differently — `ms switch` in its own name (`ms switch: <why>`), `ms
 * switch --all` under the session's (`ms: s3 refused: <why>`) — and a body that
 * printed would say it twice or in the wrong voice.
 *
 * A TRANSACTION refusal (recoverSession returned non-zero) sets
 * `fromTransaction: true` and a `message` that is the transaction's OWN
 * reason (`recover.ts`'s `takeFailReason`, fix-C-report.md item 2) — the
 * exact words `recoverSession` already wrote to stderr and to the session's
 * recover log. `switchVerb` uses the flag, not the message text, to print
 * nothing for it (recoverSession said it once already); `switchAllVerb`
 * prints it under the session's own name either way, so the fleet line now
 * carries the real reason instead of a pointer at stderr the dashboard's
 * `captured()` may already have discarded.
 */
export async function switchOne(
  sessionId: string,
  to: string,
  opts: SwitchOneOptions,
): Promise<{ code: number; message: string; fromTransaction?: true }> {
  const found = withSession(sessionId);
  // `resolveSession` speaks the CLI's exit codes, and 2 there means "the
  // command line is wrong" — which is never what a named session is. A library
  // that returned it would have its caller print a usage line for a session id
  // it was handed, so every non-zero answer from here is a refusal.
  if ("error" in found) return { code: EXIT_REFUSED, message: found.error };
  const session = found.session;

  // The typo-catchers first, because they need no tmux at all: a mistyped
  // account name never becomes a question anybody asks the pane, and the
  // transaction never kills a healthy CLI on its way to finding out.
  const { registry, parseError } = loadRegistry();
  if (parseError) return { code: EXIT_REFUSED, message: `cannot read the registry: ${parseError}` };
  if (!findAccount(registry, to, session.provider)) return { code: EXIT_REFUSED, message: `no such ${session.provider} account '${to}'` };
  if (to === session.account) return { code: EXIT_REFUSED, message: `${session.id} is already on ${to}` };

  const tmux = new Tmux(session.socket || null);
  const stale = staleServer(tmux, session);
  if (stale) return { code: EXIT_REFUSED, message: stale };
  const screen = safeCapture(tmux, session.pane);
  const busy = midTurn(session, screen, opts.force);
  if (busy) return { code: EXIT_REFUSED, message: busy };

  // A switch of a conversation that had finished resumes without a
  // continuation (spec §9) — but a walled screen says the turn never finished,
  // so the work carries over whether or not the human thought to ask.
  const continueAfter = opts.continueAfter === "auto" ? wallOnScreen(screen) !== null : opts.continueAfter;
  const code = await recoverSession(session.id, { manual: { toAccount: to, continueAfter }, force: opts.force });
  if (code !== EXIT_OK) {
    return { code: EXIT_REFUSED, message: takeFailReason(session.id) ?? HANDOFF_REPORTED, fromTransaction: true };
  }
  return { code: EXIT_OK, message: `switched → ${to}` };
}

/**
 * Move the whole fleet to `to`: every session of that account's provider that
 * is not already there.
 *
 * Three bounds, and each one is the point:
 *
 *   * **The pool is `HANDOFF_SLOTS` wide.** The slots are a counting bound the
 *     recovery transaction already enforces across processes; a worker that
 *     finds none free stands down and asks tmux to run it again in 30 s. That
 *     is right for an automatic rotation and wrong for a human watching this
 *     command: their fleet move would finish minutes later, as automatic
 *     rotations, choosing accounts nobody named. So we never start a fifth.
 *   * **`timeoutMs` stops STARTING, never stops a move in flight.** A handoff
 *     is `/exit` plus a respawn plus up to a minute of readiness; cancelling
 *     one midway would leave a pane between two CLIs. The ones already going
 *     finish; the ones not yet begun are refused, and say so.
 *   * **A session on its way out is not part of the fleet.** `stopped` is
 *     where a session whose pane is gone ends up (reconciliation writes it),
 *     and `desired: stopped` is one the human has already told to leave —
 *     dragging either into a fleet move would fail it for a reason that has
 *     nothing to do with the accounts.
 *
 * `results` is in candidate order — the store's own order — however the moves
 * finished; `onResult` is the other half of that, called as each one lands, so
 * a caller can print a line per session while the rest are still running.
 */
export async function switchAll(
  to: string,
  opts: { force: boolean; continueAfter: boolean | "auto"; timeoutMs: number; onResult?: (r: SwitchResult) => void },
): Promise<{ results: SwitchResult[]; code: number; message: string | null }> {
  // Which fleet `to` names, and the three ways that question has no answer.
  // They live HERE rather than in the verb because the verb is not the only
  // caller — the dashboard's `POST /api/switch-all` calls this function — and
  // `findAccount` with no provider returns the FIRST name match: a guard the
  // verb kept to itself would let a `home` that two providers both claim move
  // the whole claude fleet on a codex typo, out of the very registry the CLI
  // refuses. `message` is what a caller says in its own voice; nothing was
  // started, so there is nothing to summarise under it.
  const { registry, parseError } = loadRegistry();
  if (parseError) return { results: [], code: EXIT_REFUSED, message: `cannot read the registry: ${parseError}` };
  const named = registry.accounts.filter((a) => a.name === to);
  if (!named.length) return { results: [], code: EXIT_REFUSED, message: `no such account '${to}'` };
  if (named.length > 1) {
    const which = named.map((a) => `a ${a.provider}`).join(" and ");
    return { results: [], code: EXIT_REFUSED, message: `'${to}' names ${which} account; --all cannot tell which fleet you mean` };
  }
  const account = named[0]!;

  const st = openState();
  let candidates: SessionRow[];
  try {
    candidates = st
      .listSessions()
      .filter((s) => s.provider === account.provider && s.account !== to && s.state !== "stopped" && s.desired !== "stopped");
  } finally {
    st.close();
  }

  const results: SwitchResult[] = new Array(candidates.length);
  const deadline = performance.now() + opts.timeoutMs;
  let next = 0;
  /**
   * One candidate's answer, whatever happened — including a throw.
   *
   * `switchOne` returns its refusals, but `openState` is outside every guard
   * the transaction has: a store it cannot open throws past all of them. Left
   * to reject, that throw takes `Promise.all` with it — the summary never
   * prints, every sibling's result is lost with it, and the workers still
   * running keep driving handoffs while the process unwinds. One session's bad
   * luck is that session's refusal, never the fleet's. The message is the
   * error's own; none of the paths that reach here carry a credential in one.
   */
  const attempt = async (session: SessionRow): Promise<SwitchResult> => {
    if (performance.now() >= deadline) {
      return { session: session.id, code: EXIT_REFUSED, message: `not started: the ${budgetSaid(opts.timeoutMs)} budget ran out` };
    }
    try {
      return { session: session.id, ...(await switchOne(session.id, to, { continueAfter: opts.continueAfter, force: opts.force })) };
    } catch (e) {
      return { session: session.id, code: EXIT_REFUSED, message: (e as Error)?.message || String(e) };
    }
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const session = candidates[i];
      if (!session) return;
      const result = await attempt(session);
      results[i] = result;
      opts.onResult?.(result);
    }
  };
  // `next++` needs no lock: one event loop, and nothing awaits between the read
  // and the increment.
  await Promise.all(Array.from({ length: Math.min(HANDOFF_SLOTS, candidates.length) }, worker));
  return { results, code: results.some((r) => r.code !== EXIT_OK) ? EXIT_REFUSED : EXIT_OK, message: null };
}

/** `ms switch --all --to <account>`: the fleet move, and its summary. */
async function switchAllVerb(parsed: Options): Promise<number> {
  // `ms switch --all s1 --to home` is two commands at once, and the one the
  // human meant cannot be guessed from it.
  if (parsed.target) return usage("switch", `--all moves every session; ${JSON.stringify(parsed.target)} names one`);
  if (!parsed.to) return usage("switch", "--all needs --to <account>");
  const to = parsed.to;

  const { results, code, message } = await switchAll(to, {
    force: parsed.force,
    continueAfter: parsed.continueAfter || "auto",
    timeoutMs: (parsed.timeoutSeconds ?? ALL_TIMEOUT_SECONDS) * 1000,
    onResult: (r) =>
      process.stderr.write(r.code === EXIT_OK ? `ms: ${r.session} moved → ${to}\n` : `ms: ${r.session} refused: ${r.message}\n`),
  });
  // A destination that is no destination: `switchAll` refused before it started
  // anything, and this verb says so in its own name. No summary follows — a
  // move that never began has nothing to count.
  if (message) return refuse("switch", message);
  const moved = results.filter((r) => r.code === EXIT_OK).length;
  process.stderr.write(`ms: moved ${moved}, refused ${results.length - moved}\n`);
  return code;
}

export const switchVerb: Verb = async (argv) => {
  const parsed = parseManualArgs(argv, { to: true, force: true, continueAfter: true, all: true, timeout: true });
  if ("error" in parsed) return usage("switch", parsed.error);
  if (parsed.all) return switchAllVerb(parsed);
  // One session waits exactly as long as its own handoff takes; there is
  // nothing for a budget to stop starting.
  if (parsed.timeoutSeconds !== null) return usage("switch", "--timeout bounds --all");
  if (!parsed.to) return usage("switch", "--to <account> is required");
  const found = withSession(parsed.target);
  if ("error" in found) return found.code === EXIT_USAGE ? usage("switch", found.error) : refuse("switch", found.error);

  const r = await switchOne(found.session.id, parsed.to, {
    continueAfter: parsed.continueAfter || "auto",
    force: parsed.force,
  });
  if (r.code !== EXIT_OK) return r.fromTransaction ? EXIT_REFUSED : refuse("switch", r.message);
  process.stderr.write(`ms: ${found.session.id} ${r.message}\n`);
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
      //
      // `handBackShell` is the shared release-then-respawn (src/handback.ts):
      // `remain-on-exit` goes OFF first, so the shell the human eventually
      // exits closes the pane instead of leaving a corpse behind.
      let note: string | null = null;
      try {
        handBackShell(tmux, session.pane, session.cwd);
      } catch (e) {
        note = `the pane could not be given back to a shell: ${(e as Error).message}`;
      }
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
    //    `stopped` is the ONLY state that means that. A recorded INTENT does
    //    not: `ms stop` writes `desired: stopped` before it takes the lock, so
    //    a first attempt that lost the lock to a live worker leaves exactly
    //    that — and the worker then finishes its handoff and overwrites
    //    `stopping` with `continuing` or `parked`. Short-circuiting on the
    //    intent told the human "already stopped" while the replacement CLI ran
    //    on in the pane, with nothing left that would ever stop it: the hook
    //    ignores walls once `desired` is not `running`, and reconciliation only
    //    acts on dead panes. Every other state is a retry over a live or stale
    //    row, and proceeds.
    if (session.state === "stopped") {
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
