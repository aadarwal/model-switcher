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
import { pickAccounts, type PickInput } from "./pick.ts";
import { loadRegistry } from "./registry.ts";
import { getSnapshot, toPickInputs } from "./snapshot.ts";
import { openState, type AttemptOutcome, type RecoveryRow, type SessionRow, type State } from "./state.ts";
import { Tmux } from "./tmux.ts";
import { lastTurn, wallKindFromText } from "./wall.ts";

/**
 * What the resumed CLI is asked to do, verbatim (spec §9). It is a prompt
 * argument, so it reaches Claude as the human's own next turn would — and it
 * says "check before retrying" because a wall can land mid-action: the tool
 * call that hit the limit may or may not have taken effect.
 */
export const CONTINUATION =
  "Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions.";

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

function safeCapture(tmux: Tmux, pane: string): string {
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

/** The CLI is mid-turn: its own spinner says how to interrupt it. */
const isBusy = (screen: string): boolean => tail(screen, 6).some((l) => INTERRUPT.test(l));

// --- Locks -------------------------------------------------------------

/** A lock name is a restricted token (src/lock.ts); a session id that is not
 * a UUID must still produce a legal, stable one rather than throwing. */
const lockToken = (id: string): string => id.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48);

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
  // Append order, not timestamps: events are seconds-resolution, so a wall and
  // the activity that followed it can share a second.
  let wallAt = -1;
  let activityAt = -1;
  const events = readEvents(session.id);
  events.forEach((e, i) => {
    if (e.generation !== rec.generation) return;
    if (e.kind === "rate_limited") wallAt = i;
    if (e.kind === "activity") activityAt = i;
  });
  const worked = wallAt >= 0 ? activityAt > wallAt : activityAt >= 0 && events[activityAt]!.t > rec.createdAt;
  if (worked) return "the session went on working after the wall";
  if (!tmux.paneExists(session.pane)) return "the pane is gone";
  return null;
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
 */
async function stopPane(tmux: Tmux, session: SessionRow, generation: number): Promise<boolean> {
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

type Ready = "ok" | "resume-broken" | "timeout";

/**
 * The resumed CLI reports itself through Claude Code's own SessionStart hook —
 * we never scrape the screen for readiness. The same CLI session id means the
 * conversation survived; a different one means `--resume` silently started a
 * new conversation, which is a broken handoff, not a successful one.
 */
async function waitForReady(id: string, generation: number, cliSessionId: string): Promise<Ready> {
  const deadline = performance.now() + readyMs();
  for (;;) {
    for (const e of readEvents(id)) {
      if (e.generation !== generation) continue;
      if (e.kind !== "resumed" && e.kind !== "started") continue;
      if (e.cliSessionId === cliSessionId) return "ok";
      if (e.cliSessionId) return "resume-broken";
    }
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
function nextAttemptAt(inputs: PickInput[], out: { name: string; why: string }[]): number {
  const by = new Map(inputs.map((i) => [i.name, i]));
  const times: number[] = [];
  for (const o of out) {
    if (!/ at 100$/.test(o.why)) continue;
    const input = by.get(o.name);
    if (!input) continue;
    const window = o.why.startsWith("session") ? input.session : o.why.startsWith("fable") ? input.weeklyFable : input.weeklyAll;
    const at = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(at)) times.push(Math.floor(at / 1000));
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
    return await withLock(`session-${lockToken(id)}`, () => transaction(id, opts), { waitMs: SESSION_LOCK_WAIT_MS });
  } catch (e) {
    if (e instanceof Locked || (e as Error)?.name === "Locked") return fail(id, 0, `another recovery holds ${id}`);
    // Anything else — a tmux call that failed, a store that would not write —
    // is still a failed recovery, and the contract says the reason goes to
    // stderr AND the log. Throwing past here would put it only on stderr, in a
    // process nobody is watching, and leave the log silent about the attempt.
    // The store is left exactly as it was: reconciliation (§12) repairs it.
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

    // 2. Own the recovery and recheck that it is still true.
    const claimed = opts.manual ? claimManual(st, session, tmux, opts) : claimAutomatic(st, session, tmux);
    if ("why" in claimed) return fail(id, g, claimed.why);
    const rec = claimed.rec;

    // 9. The budget, before anything is disturbed.
    const failedSoFar = st.attempts(rec.id).filter((a) => a.outcome !== "ok").length;
    if (failedSoFar >= MAX_FAILED_ATTEMPTS) {
      st.updateSession(id, { state: "parked" });
      st.finishRecovery(rec.id, "done");
      return fail(id, g, `gave up after ${MAX_FAILED_ATTEMPTS} attempts`);
    }

    // Without a CLI session id there is nothing to resume, and a respawn would
    // start a new conversation — the exact failure §9 calls resume-broken. Park
    // now, while the walled CLI is still alive and its transcript still on screen.
    if (!session.cliSessionId) {
      st.updateSession(id, { state: "parked" });
      st.finishRecovery(rec.id, "done");
      return fail(id, g, "the session never reported a CLI session id; nothing to resume");
    }

    const slot = takeHandoffSlot();
    if (!slot) {
      st.releaseRecovery(rec.id);
      logLine(id, g, `too many handoffs in flight; retrying in ${REDISPATCH_SECONDS}s`);
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

  const open = st.pendingRecovery(session.id);
  const recId = open ? open.id : st.addRecovery({ sessionId: session.id, generation: session.generation, turnId: null, kind: wall ?? "unknown" });
  if (!st.ownRecovery(recId, owner())) return { why: `recovery ${recId} is already owned by ${open?.owner ?? "another worker"}` };
  const rec = st.pendingRecovery(session.id);
  return rec ? { rec } : { why: `recovery ${recId} vanished` };
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
      st.releaseRecovery(rec.id);
      return fail(id, g, `cannot read the registry: ${found.registryError}`);
    }
    names = found.names;
    inputs = found.inputs;
    out = found.out;
  }

  if (!names.length) {
    const at = nextAttemptAt(inputs, out);
    const delaySeconds = Math.max(MIN_DISPATCH_SECONDS, at - nowSeconds());
    st.setWakeup(id, at);
    st.updateSession(id, { state: "waiting" });
    try {
      tmux.runShell([msBinary(), "_recover", id], { delaySeconds });
    } catch (e) {
      logLine(id, g, `could not schedule the next try: ${(e as Error).message}`);
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
    st.releaseRecovery(rec.id);
    return fail(id, g, `no candidate account has a launch token (run: ms accounts add <name>)`);
  }

  // 5. Say what is happening, and keep the pane alive across the exit.
  st.updateSession(id, { state: "stopping" });
  try {
    tmux.setPaneOption(session.pane, "@ms_handoff", `${from}→${to}`);
    tmux.remainOnExit(session.pane, true);
  } catch (e) {
    logLine(id, g, `could not mark the pane: ${(e as Error).message}`);
  }
  logLine(id, g, `${id}: handing ${from} → ${to} (${rec.kind} wall)`);

  // 6. Ask the CLI to leave; make it leave if it will not.
  const forced = await stopPane(tmux, session, g);

  // 7. The new generation, written down before it is started.
  const next = g + 1;
  const continuing = !manual || manual.continueAfter;
  const command = ["claude", "--resume", session.cliSessionId!, ...(continuing ? [CONTINUATION] : []), ...session.flags];
  const launchId = randomUUID();
  st.createLaunch({ id: launchId, sessionId: id, generation: next, account: to, command, env: {}, createdAt: nowSeconds() });
  st.updateSession(id, { account: to, generation: next, state: "resuming" });
  // The attempt records the account we LEFT — that is what was consumed, and
  // what the next try through this recovery must not go back to.
  const outcome: AttemptOutcome = forced ? "forced" : manual ? "ok" : "exhausted";
  st.addAttempt({ recoveryId: rec.id, account: from, outcome, note: `left for ${to}${forced ? " (forced exit)" : ""}` });
  tmux.respawn(session.pane, session.cwd, [msBinary(), "_exec", launchId]);
  logLine(id, next, `respawned pane ${session.pane} on ${to} (launch ${launchId}${forced ? ", forced exit" : ""})`);

  // 8. Readiness, from the hook's own report.
  const ready = await waitForReady(id, next, session.cliSessionId!);
  if (ready !== "ok") {
    for (const line of lastNonBlank(safeCapture(tmux, session.pane), 8)) logLine(id, next, `screen| ${line}`);
    st.addAttempt({ recoveryId: rec.id, account: to, outcome: "resume-broken", note: ready });
    st.updateSession(id, { state: "parked" });
    // Not done: the recovery goes back to pending so a later try (Task 18's
    // reconciliation, or `ms rotate --force`) can pick up where this left off.
    st.releaseRecovery(rec.id);
    return fail(
      id,
      next,
      ready === "timeout"
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
  logLine(id, next, `${id}: ${from} → ${to} (${rec.kind} wall, generation ${next})`);
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
