// src/recover.ts
//
// `ms _recover <session>` (spec §9): the recovery transaction.
//
// A short-lived worker — dispatched by tmux from Claude Code's own StopFailure
// hook, so it lives outside the walled CLI's process tree — owns the pending
// recovery for ONE session, rechecks that the failure is still true, picks the
// next account, asks the parked CLI to leave, and respawns the same pane on a
// new launch that runs `claude --resume <id> "<continuation>"`.
//
// Two rules shape everything below:
//
//   * Nothing is ever typed into a shell. The continuation is an ARGUMENT to
//     the resumed invocation, not keystrokes into a prompt, and the only keys
//     we ever send are `Escape` and `/exit` — the CLI's own way out — and never
//     those when a modal choice is on screen, where a keystroke would answer a
//     question the human was asked.
//   * Every step that could be wrong is rechecked under the session lock. A
//     wall the session has already worked past, a generation that moved, a pane
//     that is gone: each ends the transaction as obsolete rather than moving
//     live work.
//
// Exit codes are the caller's contract: 0 handed off, 2 nothing has room (the
// session waits and a wake-up is scheduled), 1 anything else.

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Verb } from "./cli.ts";
import { readEvents } from "./events.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { Locked, acquire, withLock, type Release } from "./lock.ts";
import { ensureSessionDir, msBinary, p } from "./paths.ts";
import { pickAccounts, type PickInput, type Window } from "./pick.ts";
import { ownerDead } from "./reconcile.ts";
import { NAME_PATTERN, findAccount, loadRegistry } from "./registry.ts";
import { getSnapshot, toPickInputs } from "./snapshot.ts";
import { openState, type AttemptOutcome, type RecoveryRow, type SessionRow, type State } from "./state.ts";
import { Tmux } from "./tmux.ts";
import { lastTurn, wallKindFromText } from "./wall.ts";

/**
 * What the resumed CLI is asked to do, verbatim (spec §9). It is a prompt
 * argument, so it reaches Claude as the human's own next turn would — and it
 * says "check before retrying" because a wall can land mid-action: the tool
 * call that hit the limit may or may not have taken effect.
 *
 * The last sentence is the live matrix's: a wall can land on a turn that was
 * trivial or already answered, and "continue the unfinished work" then invites
 * the model to invent some. It did, on a real rotation — explored the repo and
 * proposed deleting untracked directories nobody had mentioned. A continuation
 * that must be able to say "there is nothing to continue" is the only safe
 * version of an instruction we send unattended.
 */
export const CONTINUATION =
  "Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions. If the last user message was already answered, or needs nothing more, say so in one line and wait for the user; do not start new work.";

/** One recovery at a time per session; a second worker is a duplicate. */
const SESSION_LOCK_WAIT_MS = 5_000;
/** A counting bound on simultaneous handoffs across ALL sessions: four slots,
 * taken without waiting. A fleet that walls at once must not respawn at once. */
const HANDOFF_SLOTS = 4;
/** How long a worker that found no free slot waits before trying again. */
const REDISPATCH_SECONDS = 30;
/** How long the CLI is given to leave on its own after `/exit`. */
const GRACE_MS = 10_000;
const TERM_MS = 3_000;
const KILL_MS = 1_000;
/** Escape lands, then the composer takes `/exit` as a command rather than text. */
const ESCAPE_SETTLE_MS = 300;
/** How long the resumed CLI has to report itself through the hook. */
const READY_MS = 60_000;
/** No window told us when it resets: try again in ten minutes. */
const NO_ROOM_SECONDS = 600;
/** Never re-dispatch sooner than this: a resetsAt that has already passed (a
 * stale reading, a clock that stepped) must not become a hot retry loop. */
const MIN_DISPATCH_SECONDS = 30;
const SNAPSHOT_MAX_AGE_MS = 20_000;
/** Spec §9: three failures and the session is parked for a human. */
const MAX_FAILED_ATTEMPTS = 3;

/** Every poll in this module. Tests set it low so the loops run in
 * milliseconds; nothing else in the transaction depends on the value. */
const pollMs = (): number => Number(process.env.MS_POLL_MS) || 500;
const readyMs = (): number => Number(process.env.MS_READY_MS) || READY_MS;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export type ManualRecovery = {
  /** Move to this account rather than whatever the chooser ranks first. */
  toAccount?: string;
  /** Whether the resumed CLI is handed the continuation prompt. */
  continueAfter: boolean;
};
export type RecoverOptions = {
  /** Present when a human asked for this move (Task 16's `rotate`/`switch`). */
  manual?: ManualRecovery;
  /** Skip the manual-mode refusal: move the session whatever the screen says. */
  force?: boolean;
};
export type RecoverCode = 0 | 1 | 2;

// --- The log -----------------------------------------------------------

/** One line per step, with the generation it belongs to (`?` when we failed
 * before reading one). The log is evidence, never a dependency: a line we
 * cannot write must not cost the rotation. */
function logLine(id: string, generation: number, msg: string): void {
  try {
    ensureSessionDir(id);
    const f = p.recoverLog(id);
    if (!existsSync(f)) closeSync(openSync(f, "a", 0o600));
    appendFileSync(f, `${new Date().toISOString()} [gen ${generation || "?"}] ${msg}\n`, { mode: 0o600 });
    if ((statSync(f).mode & 0o777) !== 0o600) chmodSync(f, 0o600);
  } catch {
    /* a full disk is not a reason to leave a session walled */
  }
}

/** The one shape of failure: say why on stderr AND in the log, and exit 1. */
function fail(id: string, generation: number, why: string): 1 {
  logLine(id, generation, why);
  process.stderr.write(`ms _recover: ${why}\n`);
  return 1;
}

// --- Reading the screen ------------------------------------------------

/** A choice cursor in an option list — the human was asked something. */
const OPTION = /^\s*[❯›]\s*\d+\./;
const CANCEL = /esc to cancel/i;
const INTERRUPT = /esc to interrupt/i;

/** Exported for Task 16's manual verbs: one reading of a pane, one meaning. */
export function safeCapture(tmux: Tmux, pane: string): string {
  try {
    return tmux.capture(pane, 200);
  } catch {
    return ""; // a dead or vanished pane has no screen; that is not an error here
  }
}

/** Lines with the trailing blank rows dropped. */
function tail(screen: string, n: number): string[] {
  const lines = screen.split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  return lines.slice(Math.max(0, end - n), end);
}

const lastNonBlank = (screen: string, n: number): string[] => screen.split("\n").filter((l) => l.trim()).slice(-n);

/**
 * A modal choice is on screen. Keystrokes are answers here: `Escape` cancels
 * whatever the human was deciding and `/exit` would be typed INTO the dialog,
 * so this pane gets the signal path instead. Scoped to the last turn for the
 * same reason wall.ts scopes its patterns there — an older dialog stays drawn.
 */
function isModal(screen: string): boolean {
  return lastTurn(screen).some((l) => OPTION.test(l) || CANCEL.test(l));
}

/** The CLI is mid-turn: its own spinner says how to interrupt it. Exported so
 * Task 16's manual verbs refuse on exactly the reading this transaction uses. */
export const isBusy = (screen: string): boolean => tail(screen, 6).some((l) => INTERRUPT.test(l));

// --- Locks -------------------------------------------------------------

/** A lock name is a restricted token (src/lock.ts); a session id that is not
 * a UUID must still produce a legal, stable one rather than throwing. */
const lockToken = (id: string): string => id.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48);
/**
 * The lock this worker holds for the whole transaction. Exported because it is
 * a shared name, not an implementation detail: Tasks 16 and 18 serialise
 * against this worker by taking the SAME lock, and they can only do that if
 * they derive the name the same way.
 */
export const sessionLockName = (id: string): string => `session-${lockToken(id)}`;

/**
 * One of four handoff slots, taken without waiting — `acquire` is `withLock`
 * minus the wait, which is exactly what a counting bound wants: a caller that
 * cannot have a slot now must go away and come back, not queue.
 */
function takeHandoffSlot(): Release | null {
  for (let k = 0; k < HANDOFF_SLOTS; k++) {
    const release = acquire(`handoff-${k}`);
    if (release) return release;
  }
  return null;
}

const owner = (): string => `${process.pid}@${hostname()}`;

// --- Endings -----------------------------------------------------------

/**
 * The outcomes that are FAILURES of a try, as opposed to the record of a
 * handoff that happened. `exhausted`, `forced` and `ok` all describe the
 * account this worker LEFT — one of them is written on every successful
 * handoff — so counting them against the budget would let two rows from one
 * transaction spend three tries in a session and a half.
 */
const FAILURE_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set(["auth", "infra", "resume-broken"]);

/**
 * The failures that SPEND a candidate — an account this episode tried and
 * could not use. They are what tells an empty candidate list apart from a full
 * fleet: with one of these on the record, "nobody is left" means "used up",
 * not "everybody is at 100", and waiting for a window would be a lie.
 * (`resume-broken` is not here: it parks and closes on the spot.)
 */
const SPENT_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set(["auth", "infra"]);

/**
 * Park the session for a human and close the recovery.
 *
 * `finishRecovery` takes it out of the open set, which is the point: an open
 * row is what the StopFailure hook's `addRecovery` returns for the NEXT wall,
 * so a recovery left open here would swallow the next real wall on a later
 * generation. The wake-up goes too — a parked session is not waiting for a
 * window to reset, it is waiting for a person.
 *
 * The recovery closes as `failed`, not `done`: a park is never a completed
 * handoff, and a terminal `failed` status lets a reader (`ms status`, a
 * future audit) tell "rotated fine" apart from "gave up and needs a human"
 * without parsing the log. `one_open_recovery`'s partial index already
 * treats anything outside `('pending','owned')` as closed, so `failed`
 * needs no schema change to let a fresh recovery open after it.
 */
function park(st: State, id: string, recoveryId: number, generation: number, why: string): 1 {
  st.updateSession(id, { state: "parked" });
  st.setWakeup(id, null);
  st.finishRecovery(recoveryId, "failed");
  return fail(id, generation, why);
}

/**
 * The human asked for this session to stop while we were mid-handoff. Their
 * intent wins over ours: the recovery is obsolete, the pane is left exactly as
 * it is, and this is not a failure — a stop that arrives during a rotation is
 * a stop that worked, so it exits 0.
 */
function standDown(st: State, tmux: Tmux, session: SessionRow, recoveryId: number, generation: number, when: string): 0 {
  st.finishRecovery(recoveryId, "obsolete");
  try {
    tmux.unsetPaneOption(session.pane, "@ms_handoff");
  } catch {
    /* the mark is cosmetic; the stop is what matters */
  }
  logLine(session.id, generation, `${session.id} was asked to stop ${when}; standing down`);
  return 0;
}

/**
 * The wall this transaction is acting on is no longer true: the human worked
 * past it while we were polling. Close the recovery, take back the mark, and
 * put the session's state back the way we found it — by now `stopping` is
 * written, and a row claiming a handoff nobody is doing is what reconciliation
 * would park (or stop) two minutes later, over a session that is alive.
 */
function standDownObsolete(st: State, tmux: Tmux, session: SessionRow, rec: RecoveryRow, generation: number, why: string, when: string): 1 {
  st.finishRecovery(rec.id, "obsolete");
  st.updateSession(session.id, { state: session.state });
  try {
    tmux.unsetPaneOption(session.pane, "@ms_handoff");
  } catch {
    /* the mark is cosmetic; standing down is what matters */
  }
  return fail(session.id, generation, `obsolete: ${why} (noticed ${when})`);
}

/** Ask tmux to run this worker again. Once — the budget is what bounds it. */
function redispatch(tmux: Tmux, id: string, generation: number, delaySeconds?: number): void {
  try {
    tmux.runShell([msBinary(), "_recover", id], delaySeconds ? { delaySeconds } : {});
  } catch (e) {
    logLine(id, generation, `could not re-dispatch: ${(e as Error).message}`);
  }
}

/**
 * Has the human asked for this session to stop since we last looked? Read
 * fresh from the store, never from the row this transaction started with:
 * `ms stop` can land at any moment, and §9 checks it before every destructive
 * step for exactly that reason.
 */
const stopRequested = (st: State, id: string): boolean => st.getSession(id)?.desired === "stopped";

/**
 * Why `--as <name>` cannot be honoured, or null. Checked before the name is
 * used for anything: unvalidated it reaches `readLaunchToken`, where a name
 * like `../../x` is a path traversal under MS_HOME/launch, and a codex account
 * that happens to share a name would be launched as claude.
 */
function badDestination(name: string, session: SessionRow): string | null {
  if (!NAME_PATTERN.test(name)) return `'${name}' is not a valid account name`;
  const { registry, parseError } = loadRegistry();
  // An unreadable registry is not evidence that the account is absent, and
  // telling a human their account "is not registered" when the file is corrupt
  // sends them to fix the wrong thing.
  if (parseError) return `cannot read the registry: ${parseError}`;
  const found = findAccount(registry, name, session.provider);
  if (!found) return `no ${session.provider} account named '${name}' is registered`;
  if (name === session.account) return `${session.id} is already on '${name}'`;
  return null;
}

// --- Is the failure still true? ----------------------------------------

/**
 * Why this recovery no longer describes the world, or null if it still does.
 * The hook fired some seconds ago; in between, the human may have answered the
 * wall themselves, the session may have been rotated by another path, or the
 * pane may have gone away.
 */
function obsoleteReason(session: SessionRow, rec: RecoveryRow, tmux: Tmux): string | null {
  if (rec.generation !== session.generation) {
    return `the recovery is for generation ${rec.generation} and the session is at ${session.generation}`;
  }
  const worked = workedPastWall(session, rec);
  if (worked) return worked;
  if (!tmux.paneExists(session.pane)) return "the pane is gone";
  return null;
}

/**
 * Has the conversation the session is in NOW ever been given a turn?
 *
 * Claude Code writes a transcript only once a prompt has been submitted, so a
 * CLI session id with no `activity` event behind it — a launch nobody has typed
 * into yet, or the conversation a `/clear` has just started — has no file on
 * disk to resume. And `--resume` on such an id does NOT quietly start a fresh
 * conversation: verified live against 2.1.273, it prints "No conversation found
 * with session ID: <id>" and exits 1, which is how a rotation of an untouched
 * pane came back a corpse within a second.
 *
 * `--session-id <id>` is the relaunch that works there: a new conversation
 * carrying the id the store already records, so the row, the hook's reports and
 * the readiness check all still agree about which conversation this is.
 *
 * The id is compared, not merely the kind: after a `/clear` the row moves onto
 * a new id (src/hooks/claude-hook.ts), and the turns of the conversation the
 * human LEFT say nothing about whether the one they are in has a transcript.
 */
function hasTranscript(id: string, cliSessionId: string): boolean {
  return readEvents(id).some((e) => e.kind === "activity" && e.cliSessionId === cliSessionId);
}

/**
 * The session went on working after the wall, or null — re-read from the event
 * log every time it is asked (spec §9: "User starts a new turn during polling:
 * the failure is obsolete, nothing is killed").
 *
 * Asked once at claim time this misses the race it exists for: the pick polls
 * usage, which can take tens of seconds on a cold cache, and a human whose
 * window has just reset submits a new prompt in that gap. So the destructive
 * steps ask it again — before `/exit` and again before the respawn — and a
 * `activity` event for this generation newer than the wall stands the whole
 * transaction down.
 *
 * Append order, not timestamps: events are seconds-resolution, so a wall and
 * the activity that followed it can share a second.
 */
function workedPastWall(session: SessionRow, rec: RecoveryRow): string | null {
  let wallAt = -1;
  let activityAt = -1;
  const events = readEvents(session.id);
  events.forEach((e, i) => {
    if (e.generation !== rec.generation) return;
    if (e.kind === "rate_limited") wallAt = i;
    if (e.kind === "activity") activityAt = i;
  });
  const worked = wallAt >= 0 ? activityAt > wallAt : activityAt >= 0 && events[activityAt]!.t > rec.createdAt;
  return worked ? "the session went on working after the wall" : null;
}

// --- Waiting -----------------------------------------------------------

/** True when the pane's process is gone (a zombie still counts as present;
 * EPERM means it exists and is someone else's). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

/** Poll the pane until it is dead (or its pid is), up to `budgetMs`. */
async function waitForExit(tmux: Tmux, pane: string, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const info = tmux.paneInfo(pane);
    if (!info || info.dead || !info.pid || !alive(info.pid)) return true;
    const left = deadline - performance.now();
    if (left <= 0) return false;
    await sleep(Math.min(pollMs(), left));
  }
}

/**
 * Ask the CLI to leave, and make it leave if it will not. Returns whether the
 * exit had to be forced.
 *
 * Exported for Task 16's `ms stop`, which ends a session with the same
 * sequence: a handoff and a stop differ in what happens to the pane
 * afterwards, never in how the CLI is asked to go.
 */
export async function stopPane(tmux: Tmux, session: SessionRow, generation: number): Promise<boolean> {
  const modal = isModal(safeCapture(tmux, session.pane));
  if (modal) {
    logLine(session.id, generation, "a modal choice is on screen; signalling rather than typing into it");
  } else {
    try {
      tmux.sendKeys(session.pane, ["Escape"]);
      await sleep(ESCAPE_SETTLE_MS);
      tmux.sendKeys(session.pane, ["/exit", "Enter"]);
    } catch (e) {
      logLine(session.id, generation, `send-keys failed (${(e as Error).message}); signalling instead`);
    }
    if (await waitForExit(tmux, session.pane, GRACE_MS)) return false;
    logLine(session.id, generation, "the CLI did not leave on /exit; signalling");
  }

  const info = tmux.paneInfo(session.pane);
  if (!info || info.dead || !info.pid || !alive(info.pid)) return false;
  signal(info.pid, "SIGTERM");
  logLine(session.id, generation, `sent SIGTERM to pid ${info.pid}`);
  if (await waitForExit(tmux, session.pane, TERM_MS)) return true;
  signal(info.pid, "SIGKILL");
  logLine(session.id, generation, `sent SIGKILL to pid ${info.pid}`);
  await waitForExit(tmux, session.pane, KILL_MS);
  return true;
}

type Ready = "ok" | "resume-broken" | "timeout" | "dead";

/**
 * The resumed CLI reports itself through Claude Code's own SessionStart hook —
 * we never scrape the screen for readiness. The same CLI session id means the
 * conversation survived; a different one means `--resume` silently started a
 * new conversation, which is a broken handoff, not a successful one.
 *
 * The pane is watched alongside the log, every tick. A launch that dies on
 * arrival will never write a report, and waiting out the full minute for a
 * silence tmux could have explained in one call is a minute of a human's
 * session sitting dead for no reason — live, the worker waited 60 s after its
 * CLI had exited at +1 s. `paneDead` is null when tmux could not be asked,
 * which is not a death and never ends the wait (src/tmux.ts).
 */
async function waitForReady(id: string, generation: number, cliSessionId: string, tmux: Tmux, pane: string): Promise<Ready> {
  const deadline = performance.now() + readyMs();
  for (;;) {
    for (const e of readEvents(id)) {
      if (e.generation !== generation) continue;
      if (e.kind !== "resumed" && e.kind !== "started") continue;
      if (e.cliSessionId === cliSessionId) return "ok";
      if (e.cliSessionId) return "resume-broken";
    }
    // After the log, not before it: a CLI that reported itself and then exited
    // has still resumed, and the report is the thing this step is waiting for.
    if (tmux.paneDead(pane) === true) return "dead";
    const left = deadline - performance.now();
    if (left <= 0) return "timeout";
    await sleep(Math.min(pollMs(), left));
  }
}

// --- Candidates --------------------------------------------------------

/**
 * When to look again, given that every account was passed over. A window that
 * is at 100 says when it resets; the earliest of those is the first moment the
 * fleet can have room. Nothing else is a schedule — an account with a dead
 * grant will still be dead in ten minutes, but ten minutes is the honest
 * "check again" rather than a guess at a fix.
 */
function nextAttemptAt(inputs: PickInput[], out: { name: string; why: string }[], from: string, need: SessionRow["need"]): number {
  const by = new Map(inputs.map((i) => [i.name, i]));
  const times: number[] = [];
  const consider = (w: Window | null | undefined): void => {
    const at = w?.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (Number.isFinite(at)) times.push(Math.floor(at / 1000));
  };
  for (const o of out) {
    if (!/ at 100$/.test(o.why)) continue;
    const input = by.get(o.name);
    if (!input) continue;
    consider(o.why.startsWith("session") ? input.session : o.why.startsWith("fable") ? input.weeklyFable : input.weeklyAll);
  }
  // The account this session is LEAVING counts here too. It is excluded from
  // the PICK — we will not hand a walled session back to the account that
  // walled it in this transaction — but that is not a reason to ignore when it
  // comes back. Without it, a one-account fleet re-dispatched every ten
  // minutes for ever, and a two-account one waited days for the other's weekly
  // reset while its own five-hour window was minutes away.
  const leaving = by.get(from);
  if (leaving) {
    for (const w of [leaving.session, leaving.weeklyAll, ...(need === "fable" ? [leaving.weeklyFable] : [])]) {
      // Only a window that is actually FULL says anything about when there
      // will be room; one with room left is not what we are waiting on.
      if (w && Number.isFinite(w.usedPercent) && w.usedPercent >= 100) consider(w);
    }
  }
  const soonest = times.length ? Math.min(...times) : 0;
  return Math.max(soonest || nowSeconds() + NO_ROOM_SECONDS, nowSeconds() + MIN_DISPATCH_SECONDS);
}

type Candidates = { names: string[]; inputs: PickInput[]; out: { name: string; why: string }[]; registryError: string | null };

/** The accounts worth trying, best first, and why each of the others is out. */
async function candidatesFor(session: SessionRow, exclude: string[]): Promise<Candidates> {
  const { registry } = loadRegistry();
  const mine = new Set(registry.accounts.filter((a) => a.provider === session.provider).map((a) => a.name));
  const snapshot = await getSnapshot({ maxAgeMs: SNAPSHOT_MAX_AGE_MS });
  // The registry can break between our read and the snapshot's own, and an
  // unreadable one yields NO inputs at all — which must never be mistaken for
  // "nothing has room", because the fleet was never looked at.
  if (snapshot.registryError) return { names: [], inputs: [], out: [], registryError: snapshot.registryError };
  // Identity is (provider, name): a codex account sharing a name is a
  // different account, not this session's.
  const rows = snapshot.accounts.filter((a) => a.provider === session.provider && mine.has(a.name));
  // The whole snapshot travels, only its rows narrowed. `toPickInputs` reads
  // more than `accounts` — a hand-built partial silently drops whatever it
  // learns next, and an absent field is not the same as a null one.
  const inputs = toPickInputs({ ...snapshot, accounts: rows });
  const { picks, out } = pickAccounts(inputs, session.need, exclude);
  return { names: picks.map((x) => x.name), inputs, out, registryError: null };
}

// --- The transaction ---------------------------------------------------

/**
 * Recover `id`: exactly one handoff, or a reason why not.
 *
 * Exported for Task 16's manual verbs, which pass `manual` (and `force`); the
 * `_recover` worker calls it with no options at all.
 */
export async function recoverSession(id: string, opts: RecoverOptions = {}): Promise<RecoverCode> {
  try {
    return await withLock(sessionLockName(id), () => transaction(id, opts), { waitMs: SESSION_LOCK_WAIT_MS });
  } catch (e) {
    if (e instanceof Locked || (e as Error)?.name === "Locked") return fail(id, 0, `another recovery holds ${id}`);
    // Anything else — a store that would not write, a tmux call with no
    // handler of its own — is still a failed recovery, and the contract says
    // the reason goes to stderr AND the log. Throwing past here would put it
    // only on stderr, in a process nobody is watching, and leave the log
    // silent about the attempt.
    //
    // What is left behind is whatever the transaction had already written when
    // it threw, which is why the steps are ordered so that no half-state lies:
    // the session's generation is bumped only AFTER the respawn succeeds, so a
    // throw before that leaves the session and its open recovery on the same
    // generation, and the next worker (or §12's reconciliation) can simply try
    // again. The respawn itself is handled where it happens, not here.
    return fail(id, 0, `recovery failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

async function transaction(id: string, opts: RecoverOptions): Promise<RecoverCode> {
  const st = openState();
  try {
    const session = st.getSession(id);
    if (!session) return fail(id, 0, `no such session ${id}`);
    const g = session.generation;
    const tmux = new Tmux(session.socket || null);

    // 1. The session is on its way out; a rotation would fight the human.
    if (session.desired === "stopped") {
      const open = st.pendingRecovery(id);
      if (open) st.finishRecovery(open.id, "obsolete");
      return fail(id, g, `${id} is stopping; the recovery is obsolete`);
    }

    // A named destination is checked before it can become anything — a path, a
    // launch account, a provider mismatch — and a bad one changes nothing at
    // all: no recovery is opened, no pane is touched.
    const named = opts.manual?.toAccount;
    if (named !== undefined) {
      const why = badDestination(named, session);
      if (why) return fail(id, g, why);
    }

    // 2. Own the recovery and recheck that it is still true.
    const claimed = opts.manual ? claimManual(st, session, tmux, opts) : claimAutomatic(st, session, tmux);
    if ("why" in claimed) return fail(id, g, claimed.why);
    const rec = claimed.rec;

    // 9. The budget, before anything is disturbed. Only FAILURES count: the row
    // written for the account we left (`exhausted`/`forced`/`ok`) is the record
    // of a handoff that happened, not of one that went wrong — counting it made
    // "three failed transactions" arrive after one and a half.
    const failedSoFar = st.attempts(rec.id).filter((a) => FAILURE_OUTCOMES.has(a.outcome)).length;
    if (failedSoFar >= MAX_FAILED_ATTEMPTS) return park(st, id, rec.id, g, `gave up after ${MAX_FAILED_ATTEMPTS} attempts`);

    // Without a CLI session id there is nothing to resume, and a respawn would
    // start a new conversation — the exact failure §9 calls resume-broken. Park
    // now, while the walled CLI is still alive and its transcript still on screen.
    if (!session.cliSessionId) return park(st, id, rec.id, g, "the session never reported a CLI session id; nothing to resume");

    const slot = takeHandoffSlot();
    if (!slot) {
      st.releaseRecovery(rec.id);
      logLine(id, g, `too many handoffs in flight; retrying in ${REDISPATCH_SECONDS}s`);
      // Record the wake-up before arming the delayed re-dispatch: without
      // this, `ms status` shows nothing waiting and reconciliation's orphan
      // rule (45 s grace) has no way to see that a worker is already timed
      // to come back, so it can double-dispatch on top of this one.
      st.setWakeup(id, nowSeconds() + REDISPATCH_SECONDS);
      try {
        tmux.runShell([msBinary(), "_recover", id], { delaySeconds: REDISPATCH_SECONDS });
      } catch (e) {
        logLine(id, g, `could not re-dispatch: ${(e as Error).message}`);
      }
      process.stderr.write("ms _recover: too many handoffs in flight\n");
      return 1;
    }
    try {
      return await handoff(st, session, rec, tmux, opts);
    } finally {
      slot();
    }
  } finally {
    st.close();
  }
}

type Claim = { rec: RecoveryRow } | { why: string };

/** Automatic mode: the hook left a pending recovery and we must own it. */
function claimAutomatic(st: State, session: SessionRow, tmux: Tmux): Claim {
  const rec = st.pendingRecovery(session.id);
  if (!rec) return { why: "no pending recovery" };
  if (!st.ownRecovery(rec.id, owner())) return { why: `recovery ${rec.id} is already owned by ${rec.owner ?? "another worker"}` };
  const why = obsoleteReason(session, rec, tmux);
  if (why) {
    st.finishRecovery(rec.id, "obsolete");
    return { why: `obsolete: ${why}` };
  }
  return { rec };
}

/**
 * Manual mode: a human asked. There need not be a pending recovery — but there
 * must be a reason to believe the pane is not mid-turn, because a manual move
 * kills a running CLI just as dead as an automatic one does.
 */
function claimManual(st: State, session: SessionRow, tmux: Tmux, opts: RecoverOptions): Claim {
  if (!tmux.paneExists(session.pane)) {
    const open = st.pendingRecovery(session.id);
    if (open) st.finishRecovery(open.id, "obsolete");
    return { why: "obsolete: the pane is gone" };
  }
  const screen = safeCapture(tmux, session.pane);
  const wall = wallKindFromText(screen);
  if (!wall && isBusy(screen) && !opts.force) return { why: "the pane is busy and shows no wall (use --force)" };

  let open = st.pendingRecovery(session.id);
  // A row still `owned` by a worker that no longer exists is not somebody
  // else's work in progress: the pid is gone, we hold the session lock it
  // died holding, and refusing the human for ten minutes over it ("already
  // owned by <pid>@host") is how a `kill -9` used to take `ms rotate` and
  // `ms switch` out of service. Released on exactly the row that was judged,
  // so a live worker that claimed it in the meantime is never overwritten.
  if (open && open.status === "owned" && ownerDead(open.owner)) {
    if (st.releaseRecoveryIf(open.id, { owner: open.owner, updatedAt: open.updatedAt })) {
      logLine(session.id, session.generation, `recovery ${open.id} was owned by a dead worker (${open.owner}); taking it over`);
      open = st.pendingRecovery(session.id);
    }
  }
  const recId = open ? open.id : st.addRecovery({ sessionId: session.id, generation: session.generation, turnId: null, kind: wall ?? "unknown" });
  if (!st.ownRecovery(recId, owner())) return { why: `recovery ${recId} is already owned by ${open?.owner ?? "another worker"}` };
  const rec = st.pendingRecovery(session.id);
  return rec ? { rec } : { why: `recovery ${recId} vanished` };
}

/**
 * The launch's pass-through arguments, minus anything the CLI would read as a
 * prompt (spec §9 step 6: the resumed command line is
 * `claude --resume <id> "<continuation>"` plus what the launch was given).
 *
 * `ms claude -- "fix the tests"` records that prompt in `session.flags`, and a
 * resume re-applies the flags verbatim — so the command line carried TWO
 * positionals, the continuation and the original prompt, and the CLI rejects
 * that outright. Even with no continuation (a manual switch of a finished
 * conversation) the old prompt has no business being submitted again.
 *
 * What counts as a positional is decided the way any argv reader without the
 * CLI's own flag table must decide it: a word that neither starts with `-` nor
 * follows a bare `-x`/`--x` that may be taking it as a value (`--model
 * sonnet`), and everything after a `--`. The remaining ambiguity —
 * `--boolean-flag word` — keeps the word, which is exactly the old behaviour
 * and never drops something the human asked for.
 */
export function flagsForResume(flags: string[]): string[] {
  const out: string[] = [];
  let mayBeAValue = false;
  for (const a of flags) {
    if (a === "--") break; // everything past it is positional by definition
    if (a.length > 1 && a.startsWith("-")) {
      out.push(a);
      mayBeAValue = !a.includes("=");
      continue;
    }
    if (mayBeAValue) {
      out.push(a);
      mayBeAValue = false;
      continue;
    }
    // A prompt. The continuation is the only one this command line may carry.
  }
  return out;
}

/** Steps 3–8: pick, leave, respawn, and wait to be told it worked. */
async function handoff(st: State, session: SessionRow, rec: RecoveryRow, tmux: Tmux, opts: RecoverOptions): Promise<RecoverCode> {
  const id = session.id;
  const g = session.generation;
  const from = session.account;
  const manual = opts.manual;

  // 3. Candidates: never the account we are leaving, never one this recovery
  // has already tried.
  const tried = st.attempts(rec.id).map((a) => a.account);
  const exclude = [from, ...tried];
  let names: string[];
  let inputs: PickInput[] = [];
  let out: { name: string; why: string }[] = [];
  if (manual?.toAccount) {
    names = [manual.toAccount];
  } else {
    const found = await candidatesFor(session, exclude);
    // A registry we could not read is a failed attempt, not an empty fleet:
    // scheduling a wake-up here would pick a time out of nothing, and exit 2
    // would tell the caller the accounts are full when they were never read.
    // It counts against the budget, so a registry that stays broken parks the
    // session for a human instead of retrying forever.
    if (found.registryError) {
      st.addAttempt({ recoveryId: rec.id, account: from, outcome: "infra", note: `registry unreadable: ${found.registryError}` });
      // Nothing was touched, so the recovery stays open on this generation and
      // one more worker is dispatched to try again; the budget bounds it. Never
      // for a manual move: the human is right there, and a worker dispatched on
      // their behalf would run as an AUTOMATIC rotation — a different account
      // from the one they named, and a continuation they may have declined.
      st.releaseRecovery(rec.id);
      if (!manual) redispatch(tmux, id, g);
      return fail(id, g, `cannot read the registry: ${found.registryError}`);
    }
    names = found.names;
    inputs = found.inputs;
    out = found.out;
  }

  if (!names.length) {
    // WHY there is nobody left decides whether waiting is honest. If earlier
    // passes of this episode burned candidates on failures of their own — no
    // token, a registry we could not read — then the fleet is not full, it is
    // used up, and a wake-up would tell the human to wait for a window that
    // was never the problem. Park instead, and say what actually failed.
    // Only attempts against CANDIDATES count as spent. The registry-read
    // failure above is recorded against the account we are LEAVING, which is
    // never a candidate (it heads the exclude list) — and a transient one of
    // those on an earlier pass must not, a pass later, turn a fleet that is
    // genuinely at 100 into a park with no wake-up.
    const failures = st.attempts(rec.id).filter((a) => SPENT_OUTCOMES.has(a.outcome) && a.account !== from);
    if (failures.length) {
      const said = failures.map((a) => `${a.account}: ${a.note || a.outcome}`).join("; ");
      return park(st, id, rec.id, g, `all candidates failed: ${said}`);
    }
    const at = nextAttemptAt(inputs, out, from, session.need);
    const delaySeconds = Math.max(MIN_DISPATCH_SECONDS, at - nowSeconds());
    // Is a timer for THIS deadline already out there? The recorded wake-up is
    // what says so — it is written beside every timer this line arms, and
    // reconciliation's due-wake-up rule is the other half of the same promise.
    // A session that comes back round to the same deadline (a re-dispatch, a
    // wake-up reconciliation fired) would otherwise collect one more `run-shell
    // -d` every time, all of them due at the same instant.
    const armed = st.getSession(id)?.wakeupAt ?? null;
    st.setWakeup(id, at);
    st.updateSession(id, { state: "waiting" });
    if (armed !== at) {
      try {
        tmux.runShell([msBinary(), "_recover", id], { delaySeconds });
      } catch (e) {
        logLine(id, g, `could not schedule the next try: ${(e as Error).message}`);
      }
    } else {
      logLine(id, g, `a timer is already armed for ${new Date(at * 1000).toISOString()}; not arming a second`);
    }
    st.releaseRecovery(rec.id);
    const reasons = out.map((o) => `${o.name}: ${o.why}`).join("; ");
    const msg = `nothing has room; ${id} waits until ${new Date(at * 1000).toISOString()}${reasons ? ` (${reasons})` : ""}`;
    logLine(id, g, msg);
    process.stderr.write(`ms _recover: ${msg}\n`);
    return 2;
  }

  // 4. A candidate we cannot launch as is not a candidate.
  let to: string | null = null;
  for (const name of names) {
    if (readLaunchToken(name)) {
      to = name;
      break;
    }
    st.addAttempt({ recoveryId: rec.id, account: name, outcome: "auth", note: "no launch token" });
    logLine(id, g, `${name}: no launch token; trying the next account`);
  }
  if (!to) {
    // Nothing has been touched yet: keep the recovery open on this generation
    // and send one more worker, in case a token lands in the meantime — but
    // only for an automatic rotation (see the registry path above).
    st.releaseRecovery(rec.id);
    if (!manual) redispatch(tmux, id, g);
    return fail(id, g, `no candidate account has a launch token (run: ms accounts add <name>)`);
  }

  // 5. Say what is happening, and keep the pane alive across the exit. The
  // session reads `stopping` BEFORE anything is sent to the pane, so a reader
  // that catches this transaction mid-flight never sees a killed CLI under a
  // session that still claims to be running.
  st.updateSession(id, { state: "stopping" });
  try {
    tmux.setPaneOption(session.pane, "@ms_handoff", `${from}→${to}`);
    tmux.remainOnExit(session.pane, true);
  } catch (e) {
    logLine(id, g, `could not mark the pane: ${(e as Error).message}`);
  }
  // Why this move is happening, for the log. A manual one says so: the wall
  // kind on a `ms switch` of an idle session is whatever `claimManual` had to
  // put in the row it opened — `unknown` — and printing "(unknown wall)" over a
  // move a human asked for describes a failure that never happened.
  const why = manual ? (manual.toAccount ? `manual, --to ${manual.toAccount}` : "manual") : `${rec.kind} wall`;
  logLine(id, g, `${id}: handing ${from} → ${to} (${why})`);

  // §9 checks the human's intent before EVERY destructive step, and `ms stop`
  // can land at any moment: re-read it, never trust the row we started with.
  // The same is true of the failure itself — the poll above took as long as it
  // took, and a turn the human started in the meantime makes it obsolete.
  if (stopRequested(st, id)) return standDown(st, tmux, session, rec.id, g, "before the exit");
  // A manual move is the human's own intent: only the automatic worker
  // asks whether the session went on working after the wall.
  const workedBeforeExit = manual ? null : workedPastWall(session, rec);
  if (workedBeforeExit) return standDownObsolete(st, tmux, session, rec, g, workedBeforeExit, "before the exit");

  // 6. Ask the CLI to leave; make it leave if it will not.
  const forced = await stopPane(tmux, session, g);

  if (stopRequested(st, id)) return standDown(st, tmux, session, rec.id, g, "before the respawn");
  const workedBeforeRespawn = manual ? null : workedPastWall(session, rec);
  if (workedBeforeRespawn) return standDownObsolete(st, tmux, session, rec, g, workedBeforeRespawn, "before the respawn");

  // 7. The new generation, written down before it is started.
  const next = g + 1;
  // A conversation with no transcript cannot be resumed, and has no unfinished
  // work to continue: it is relaunched under its own id instead.
  const resumable = hasTranscript(id, session.cliSessionId!);
  const continuing = resumable && (!manual || manual.continueAfter);
  const command = resumable
    ? ["claude", "--resume", session.cliSessionId!, ...(continuing ? [CONTINUATION] : []), ...flagsForResume(session.flags)]
    : ["claude", "--session-id", session.cliSessionId!, ...flagsForResume(session.flags)];
  if (!resumable) {
    logLine(id, next, `${session.cliSessionId} has no transcript yet (no turn was ever submitted); starting it under the same id rather than resuming`);
  }
  const launchId = randomUUID();
  st.createLaunch({ id: launchId, sessionId: id, generation: next, account: to, command, env: {}, createdAt: nowSeconds() });
  // The attempt records the account we LEFT — that is what was consumed, and
  // what the next try through this recovery must not go back to. A forced exit
  // is worth recording, but when a human asked for the move it is still their
  // `ok`, not a failure of the account.
  const outcome: AttemptOutcome = manual ? "ok" : forced ? "forced" : "exhausted";
  st.addAttempt({ recoveryId: rec.id, account: from, outcome, note: `left for ${to}${forced ? " (forced exit)" : ""}` });

  try {
    tmux.respawn(session.pane, session.cwd, [msBinary(), "_exec", launchId]);
  } catch (e) {
    // The CLI is already stopped and the pane did not come back, so this
    // episode is over: trying the next account would only respawn a dead pane
    // with a fresh credential, and the retry chain that did that ended up
    // telling the human the fleet was full when tmux was what broke. Park it —
    // §12's reconciliation gives a dead pane a shell, and the human runs
    // `ms rotate`. The generation is deliberately still `g`: nothing ran.
    const why = (e as Error).message;
    st.addAttempt({ recoveryId: rec.id, account: to, outcome: "infra", note: `respawn failed: ${why}` });
    return park(st, id, rec.id, g, `could not respawn the pane: ${why}; ${id} is parked with its CLI stopped`);
  }

  // The generation moves only now, once the pane is really running the new
  // launch. Bumping it earlier is what left a released recovery describing a
  // generation the session had already left — a stale row that the hook's own
  // `addRecovery` then handed to the NEXT wall, swallowing it.
  st.updateSession(id, { account: to, generation: next, state: "resuming" });
  logLine(id, next, `respawned pane ${session.pane} on ${to} (launch ${launchId}${forced ? ", forced exit" : ""})`);

  // 8. Readiness, from the hook's own report — or from the pane, when the
  //    launch died before it could make one.
  const ready = await waitForReady(id, next, session.cliSessionId!, tmux, session.pane);
  if (ready !== "ok") {
    // The exit status first: it is the one fact that says WHY, and it is gone
    // the moment anything respawns over the corpse.
    const status = ready === "dead" ? tmux.paneDeadStatus(session.pane) : null;
    for (const line of lastNonBlank(safeCapture(tmux, session.pane), 8)) logLine(id, next, `screen| ${line}`);
    st.addAttempt({ recoveryId: rec.id, account: to, outcome: "resume-broken", note: ready });
    // Terminal. The conversation did not come back, and that is not something
    // another account would fix — so the recovery is CLOSED rather than
    // released: leaving it open would hand this stale row to the next wall.
    // The human runs `ms rotate`, or the next real wall opens a fresh one.
    return park(
      st,
      id,
      rec.id,
      next,
      ready === "dead"
        ? `the resumed CLI exited (pane_dead_status ${status ?? "unknown"}) before reporting; ${id} is parked`
        : ready === "timeout"
          ? `no resume report within ${Math.round(readyMs() / 1000)}s; ${id} is parked`
          : `the resume started a new conversation; ${id} is parked`,
    );
  }

  st.updateSession(id, { state: continuing ? "continuing" : "running" });
  st.setWakeup(id, null);
  st.finishRecovery(rec.id, "done");
  try {
    tmux.unsetPaneOption(session.pane, "@ms_handoff");
  } catch {
    /* the pane may already be gone; the handoff still happened */
  }
  logLine(id, next, `${id}: ${from} → ${to} (${why}, generation ${next})`);
  return 0;
}

/** `ms _recover <session>` — the tmux-dispatched worker. */
export const recoverVerb: Verb = async (args) => {
  const [id] = args;
  if (!id) {
    process.stderr.write("ms _recover: needs a session id\n");
    return 1;
  }
  return recoverSession(id);
};
