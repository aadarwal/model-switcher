// src/rebalance.ts
//
// Rebalance (docs/superpowers/specs/2026-09-19-rebalance-design.md): keep a
// session on the best account between its launch and its wall, at the only
// moment moving it is free — the end of a turn.
//
// The chooser answers "which account is best" at launch and at a wall. In
// between, budgets move: a week resets somewhere (so by the chooser's own
// rule that account is now the worst place to spend), or the account the
// session is on creeps toward a wall that will land mid-turn. The old rule —
// only a wall moves work — bought quiet at the cost of leaving that on the
// table.
//
// THIS FILE IS THE DECISION, AND ONLY THE DECISION. `decide` is pure: it is
// handed the clock, the pane's reading, the two cooldown timestamps and the
// accounts as the chooser sees them, and it returns what it would do. It
// takes no reading of its own, so every condition and every guard can be
// mutation-proved against a fixed clock with no store, no tmux and no network
// anywhere near it. `maybeRebalance` (Task 2) is the impure half that gathers
// those inputs and acts on the answer.
//
// MILLISECONDS. Every time in this module — `now`, `lastMoveAt`,
// `lastWallAt`, `snapshotTakenAt`, every `resetsAt` — is a unix time in
// MILLISECONDS, the unit `Date.now()` and `Date.parse()` speak and the unit
// the usage snapshot's `takenAt` is written in. `src/state.ts` keeps its own
// columns in SECONDS, and so does the event log; the caller converts at the
// boundary rather than leaving two units loose in one comparison.

import { rebalanceEnabled } from "./autorotate.ts";
import { appendEvent, lastEvent } from "./events.ts";
import { msBinary } from "./paths.ts";
import { pickAccounts, type Need, type PickInput } from "./pick.ts";
import { isBusy, safeCapture } from "./recover.ts";
import { getSnapshot, toPickInputs, type Snapshot, type SnapshotOptions } from "./snapshot.ts";
import { Tmux } from "./tmux.ts";
import type { Verb } from "./cli.ts";
// type-only: erased at compile time. `state.ts` pulls in node:sqlite (and its
// ExperimentalWarning), so `maybeRebalance` below imports it dynamically and
// the hooks import THIS file dynamically in turn — nothing on a hook's early
// return path loads any of it.
import type { SessionRow, State } from "./state.ts";

/**
 * Every number the rule is made of, in one place, so the spec's thresholds
 * and the tests that mutation-prove them can never drift apart.
 */
export const REBALANCE_RULES = {
  /** Condition 1. A window the chooser gates on, this full on the CURRENT
   *  account, is a wall about to land mid-turn. */
  NEAR_WALL_PERCENT: 85,
  /** Condition 1. …and the destination must have at least this much room in
   *  EVERY gating window, or the move only buys the same wall an hour later. */
  DESTINATION_ROOM_PERCENT: 30,
  /** Condition 2. The best account's week must reset at least this much
   *  earlier than the current one's. */
  RESET_LEAD_MS: 24 * 3_600_000,
  /** Condition 2. …and the current week must already be at least this spent,
   *  so an untouched budget is never churned for a theoretical one. */
  WEEK_USED_PERCENT: 50,
  /** Hysteresis. No move of this session — by this rule, by a human, by a
   *  recovery — within this long of the last one. */
  MOVE_COOLDOWN_MS: 6 * 3_600_000,
  /** Hysteresis. A wall has just moved this session; let the rotation settle
   *  before second-guessing where it landed. */
  WALL_COOLDOWN_MS: 30 * 60_000,
  /** The snapshot is worth re-reading once it is older than this. */
  SNAPSHOT_MAX_AGE_MS: 15 * 60_000,
} as const;

/** Rows this rule never touches. `parked`, `waiting` and `stopped` are each
 *  somebody else's business — a failed recovery's, a scheduled wake-up's, a
 *  human's — and a session in any of them is not doing work that a better
 *  account would help. (`gone` is not a stored state: it is a live fact about
 *  the pane, and arrives as `pane: "gone"` below.) */
const NEVER_STATES: ReadonlySet<string> = new Set(["parked", "waiting", "stopped"]);

/**
 * The pane, as one word.
 *
 * `busy` and `gone` are kept apart on purpose. Both refuse the move, but they
 * refuse it for opposite reasons — one pane has too much life in it and the
 * other has none — and a reason a human reads in `ms rebalance` must not
 * flatten the two.
 */
export type PaneReading = "idle" | "busy" | "gone";

/** The part of a session row this decision reads. Structural, so a test can
 *  build one in a line and a caller can pass a whole `SessionRow`. */
export type RebalanceSession = Pick<SessionRow, "provider" | "account" | "need" | "state">;

export type DecisionInput = {
  session: RebalanceSession;
  /** The accounts as the CHOOSER sees them (`toPickInputs` of a snapshot) —
   *  both providers' rows; this filters to the session's own. */
  accounts: PickInput[];
  /** The injected clock, in milliseconds. */
  now: number;
  /** When this session last changed account by any hand, or null. */
  lastMoveAt: number | null;
  /** When this session last hit a wall (and so was rotated off it), or null. */
  lastWallAt: number | null;
  /** kv `rebalance` — see `rebalanceEnabled` in src/autorotate.ts. */
  gate: boolean;
  pane: PaneReading;
};

export type MoveReason = "imminent-wall" | "better-budget";

/**
 * What the rule would do. `better` is present on BOTH arms and is computed
 * before any guard runs: `ms status`'s BETTER column is the rule's opinion of
 * where this session belongs, which is worth showing whether or not anything
 * is allowed to act on it right now.
 */
export type Decision =
  | { move: false; better: string | null; reason: string }
  | { move: true; to: string; better: string; reason: MoveReason };

// --- Windows -------------------------------------------------------------

type W = { usedPercent: number; resetsAt: string | null };

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The windows the chooser GATES on for this account and this need — the exact
 * set `pickAccounts` refuses an account for being at 100 in. Null when the
 * reading is not one this rule may judge: a missing window, a percentage that
 * is not a number, or an account the snapshot has marked dead.
 *
 * A Codex Pro plan reports no 5 h window at all (`src/pick.ts`), so its
 * absence is a gating window fewer there and an unreadable account for Claude.
 */
function gatingWindows(a: PickInput, need: Need): W[] | null {
  if (a.error) return null;
  const out: W[] = [];
  if (a.session) out.push(a.session);
  else if (a.provider !== "codex") return null;
  if (!a.weeklyAll) return null;
  out.push(a.weeklyAll);
  if (need === "fable") {
    if (!a.weeklyFable) return null;
    out.push(a.weeklyFable);
  }
  return out.every((x) => Number.isFinite(x.usedPercent)) ? out : null;
}

/**
 * The WEEKLY windows only — what "the week" means in condition 2. The 5 h
 * session window is deliberately left out: it resets four times a day, and a
 * budget argument made from it would move a session every afternoon.
 */
function weeklyWindows(a: PickInput, need: Need): W[] | null {
  if (a.error || !a.weeklyAll) return null;
  const out: W[] = [a.weeklyAll];
  if (need === "fable") {
    if (!a.weeklyFable) return null;
    out.push(a.weeklyFable);
  }
  return out.every((x) => Number.isFinite(x.usedPercent)) ? out : null;
}

const mostUsed = (ws: W[]): number => Math.max(...ws.map((x) => x.usedPercent));
const leastRoom = (ws: W[]): number => Math.min(...ws.map((x) => 100 - x.usedPercent));
/** The soonest of these windows' resets, or NaN when none of them names one.
 *  NaN is the point: "I do not know when this resets" must never compare as
 *  "it resets at the end of time" and win condition 2 by default. */
const soonestReset = (ws: W[]): number => {
  const times = ws.map((x) => ms(x.resetsAt)).filter((t) => Number.isFinite(t));
  return times.length ? Math.min(...times) : Number.NaN;
};

// --- The two conditions --------------------------------------------------

/** A window the chooser gates on is at ≥ 85 % here, and the destination has
 *  ≥ 30 % room in every one of its own. */
function imminentWall(from: PickInput, to: PickInput, need: Need): boolean {
  const here = gatingWindows(from, need);
  const there = gatingWindows(to, need);
  if (!here || !there) return false;
  return mostUsed(here) >= REBALANCE_RULES.NEAR_WALL_PERCENT
    && leastRoom(there) >= REBALANCE_RULES.DESTINATION_ROOM_PERCENT;
}

/** The destination's week resets ≥ 24 h earlier, and this one's is ≥ 50 %
 *  spent. Both readings must name a reset; an unknown one decides nothing. */
function betterBudget(from: PickInput, to: PickInput, need: Need): boolean {
  const here = weeklyWindows(from, need);
  const there = weeklyWindows(to, need);
  if (!here || !there) return false;
  const hereReset = soonestReset(here);
  const thereReset = soonestReset(there);
  if (!Number.isFinite(hereReset) || !Number.isFinite(thereReset)) return false;
  return hereReset - thereReset >= REBALANCE_RULES.RESET_LEAD_MS
    && mostUsed(here) >= REBALANCE_RULES.WEEK_USED_PERCENT;
}

// --- The decision --------------------------------------------------------

/**
 * Would this session be better off somewhere else, and may it go?
 *
 * Pure, and clock-injected. The order below is the order of the spec's own
 * sentences: the chooser's answer first (so `better` is always honest), then
 * the gate, then the guards that say "not this session" or "not now", then
 * the two conditions. Nothing after the first refusal is consulted, so the
 * `reason` a human reads is the FIRST thing that stopped the move, not the
 * last.
 *
 * Cross-provider moves do not exist: a Claude session stays Claude, so the
 * pool is filtered to the session's own provider before the chooser sees it.
 */
export function decide(input: DecisionInput): Decision {
  const { session, now } = input;
  const need: Need = session.need;
  const mine = input.accounts.filter((a) => a.provider === session.provider);
  const best = pickAccounts(mine, need).picks[0] ?? null;
  const better = best && best.name !== session.account ? best.name : null;
  const no = (reason: string): Decision => ({ move: false, better, reason });

  if (!input.gate) return no("the gate is off");
  if (NEVER_STATES.has(session.state)) return no(`the session is ${session.state}`);
  if (input.pane === "gone") return no("the pane is gone");
  if (input.pane === "busy") return no("the pane is mid-turn");
  if (input.lastMoveAt !== null && now - input.lastMoveAt < REBALANCE_RULES.MOVE_COOLDOWN_MS) {
    return no("it moved within the last 6h");
  }
  if (input.lastWallAt !== null && now - input.lastWallAt < REBALANCE_RULES.WALL_COOLDOWN_MS) {
    return no("it rotated off a wall within the last 30m");
  }
  if (!best) return no("no account has room");
  if (!better) return no("already on the best account");

  const from = mine.find((a) => a.name === session.account);
  if (!from) return no("the current account is not in the snapshot");
  if (!gatingWindows(from, need)) return no("the current account has no usable reading");
  const to = mine.find((a) => a.name === better)!;

  if (imminentWall(from, to, need)) return { move: true, to: better, better, reason: "imminent-wall" };
  if (betterBudget(from, to, need)) return { move: true, to: better, better, reason: "better-budget" };
  return no("neither condition holds");
}

// --- The refresh rule ----------------------------------------------------

export type RefreshInput = {
  /** The cached snapshot's own `takenAt`, or null when nothing has ever been
   *  written. */
  snapshotTakenAt: number | null;
  /** Every `resetsAt` the snapshot carries, in milliseconds. Values that are
   *  not finite times are ignored rather than guessed at. */
  resetsAt: number[];
  now: number;
  /** ONE usage round for every account, written back for everyone. Called at
   *  most once. */
  refresh: () => Promise<void>;
};

/**
 * Re-read the fleet's usage if, and only if, the cached reading can no longer
 * be trusted to answer "which account is best". Returns whether it did.
 *
 * Two ways a snapshot stops being evidence, and the second is the one a plain
 * age check misses:
 *
 *   * it is simply old — older than fifteen minutes;
 *   * a window it describes has RESET since it was taken. Those percentages
 *     are not stale by a few minutes, they are wrong by a whole week: the
 *     account they describe as nearly spent now has its entire budget back,
 *     and it is exactly the account the chooser should now prefer.
 *
 * A reset that was already in the past when the poll ran is not a reason: that
 * poll saw it, and its numbers already account for it.
 *
 * One call, never one per account or one per window — the refresher polls the
 * whole fleet and writes the file back for every process that reads it next.
 */
export async function refreshIfStale(input: RefreshInput): Promise<boolean> {
  const { snapshotTakenAt: takenAt, now } = input;
  const old = takenAt === null || now - takenAt > REBALANCE_RULES.SNAPSHOT_MAX_AGE_MS;
  const passed = takenAt !== null
    && input.resetsAt.some((t) => Number.isFinite(t) && t <= now && t > takenAt);
  if (!old && !passed) return false;
  await input.refresh();
  return true;
}

// =========================================================================
// The impure half: gathering the inputs, and acting on the answer.
// =========================================================================
//
// Nothing below is resident. The only triggers are a turn ending — Claude
// Code's `Stop` hook, and the two places the Codex side records a `stop` for
// a turn — and, from Task 3, a human asking. When nothing moves the whole
// cost is one SQLite read of the gate, one read of the cached snapshot file
// and a handful of comparisons; the network is touched at most once every
// fifteen minutes, fleet-wide, by `refreshIfStale` above.

/**
 * What ONE hook run has already done.
 *
 * A "run" is a process: one `ms _hook claude`, one `ms _hook codex`, one `ms
 * _codex_watch` pass. Two things are bounded per run and both live here — the
 * usage refresh (one round for every account, never one per session) and the
 * move (at most one, so a watchdog pass that settles four turns at once can
 * never reshuffle the whole fleet in a second).
 */
export type RebalanceRun = { refreshed: boolean; moved: boolean };
export const newRebalanceRun = (): RebalanceRun => ({ refreshed: false, moved: false });

/** The default run: this process's. Callers that want isolation (tests, and
 *  Task 3's fleet verb, which is one run by the same argument) pass their own. */
const processRun: RebalanceRun = newRebalanceRun();

export type RebalanceDeps = {
  /** The clock, in milliseconds. */
  now?: () => number;
  /** The usage snapshot. Called cache-first; `refreshIfStale` is the only
   *  thing that ever asks it to poll. */
  snapshot?: (opts: SnapshotOptions) => Promise<Snapshot>;
  /** The pane, in one word. */
  pane?: (socket: string, pane: string) => PaneReading;
  /** Hand the move to a process outside this one's tree. */
  dispatch?: (row: SessionRow, to: string) => void;
  run?: RebalanceRun;
};

/** How long to wait for somebody else's poll before serving the file as it
 *  stands. A turn end is not a place to queue: the human is waiting, and a
 *  reading a few seconds old decides this just as well as a fresh one. */
const SNAPSHOT_LOCK_WAIT_MS = 2_000;
/** "Serve the cache file, do not poll." `getSnapshot` still polls an account
 *  the file has never covered, which is right — an account with no reading at
 *  all is not a reading this rule may skip. */
const CACHE_ONLY_MS = Number.POSITIVE_INFINITY;

/** The worker's argv, in one place: the dispatcher builds it and the test
 *  asserts it, so "the switch transaction, by session, to that account" can
 *  never drift into something else. */
export const rebalanceArgv = (sessionId: string, to: string): string[] =>
  [msBinary(), "_rebalance", sessionId, "--to", to];

/**
 * One word for a pane, from a reading somebody else already took.
 *
 * `ms status` captures every session's screen once per render, to decide the
 * STATE column and the WALLED? one; asking tmux a second time per row for
 * this rule's benefit would double a verb's tmux traffic to learn a fact it
 * is already holding. `screen === null` is what that caller passes for a
 * pane it could not capture, which is the same thing as a pane that is gone.
 */
export function paneReading(exists: boolean, screen: string | null): PaneReading {
  if (!exists || screen === null) return "gone";
  return isBusy(screen) ? "busy" : "idle";
}

/** One word for a pane, read the way the recovery transaction reads it —
 *  `src/recover.ts`'s own `safeCapture`/`isBusy`, so this rule refuses
 *  exactly the panes that transaction would refuse. */
export function readPane(socket: string, pane: string): PaneReading {
  if (!pane) return "gone";
  const tmux = new Tmux(socket || null);
  if (!tmux.paneExists(pane)) return "gone";
  return paneReading(true, safeCapture(tmux, pane));
}

/**
 * Hand the move to tmux, exactly as a wall's recovery is handed over:
 * `run-shell -b` runs it inside the tmux SERVER, outside this process's tree,
 * so the CLI whose turn just ended cannot take the worker down with it when
 * the transaction asks it to leave.
 *
 * A tmux that will not take the request costs this turn its move and nothing
 * else — the `lastMoveAt` stamp is already written, so the next turn end
 * simply waits out the cooldown rather than retrying in a loop.
 */
function dispatchSwitch(row: SessionRow, to: string): void {
  new Tmux(row.socket || null).runShell(rebalanceArgv(row.id, to));
}

/** Every reset time the snapshot names, in milliseconds. Unparseable and
 *  absent ones are dropped rather than guessed at — `refreshIfStale` ignores
 *  non-finite values, and this is where they stop being strings. */
function resetTimes(s: Snapshot): number[] {
  const out: number[] = [];
  for (const a of s.accounts) {
    for (const w of [a.usage?.session, a.usage?.weeklyAll, a.usage?.weeklyFable]) {
      const t = w?.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
      if (Number.isFinite(t)) out.push(t);
    }
  }
  return out;
}

/**
 * When this session last changed account, by ANY hand, in milliseconds.
 *
 * Two records, because neither alone is the whole truth: `lastMoveAt` is what
 * this rule writes about itself (including for a move whose transaction then
 * refused, which still costs the cooldown), and `lastAccountChangeAt` is the
 * launch row every completed handoff writes — a human's `ms switch`, a wall's
 * rotation, and this rule's own successful move alike. The later of the two
 * is the answer.
 */
export function lastMoveAtMs(st: State, row: SessionRow): number | null {
  const seconds = [row.lastMoveAt, st.lastAccountChangeAt(row.id)].filter((t): t is number => typeof t === "number");
  return seconds.length ? Math.max(...seconds) * 1000 : null;
}

/**
 * When this session last hit a wall, in milliseconds.
 *
 * The wall's own `rate_limited` event, not a second clock: the rotation that
 * follows it is dispatched within seconds, so the wall's timestamp IS the
 * rotation's for a thirty-minute guard — and it is the record that exists
 * whether or not the rotation then succeeded, which is exactly the case where
 * second-guessing the account would be worst.
 */
export function lastWallAtMs(sessionId: string): number | null {
  const e = lastEvent(sessionId, "rate_limited");
  return e ? e.t * 1000 : null;
}

/**
 * The turn-end entry point: decide, and if the answer is to move, move.
 *
 * Returns the decision, or null when there is no such session. The order is
 * the spec's:
 *
 *   1. the gate. It is read FIRST and it is one SQLite read, because with it
 *      off — the 0.3.1 default — a turn end must cost nothing else. That is
 *      also why the refusal it returns carries no `better`: computing one
 *      would mean reading the snapshot, which is precisely the cost the gate
 *      is there to avoid. (`decide` itself always computes `better`; Task 3's
 *      status column calls it directly, with a snapshot it already has.)
 *   2. the cached snapshot, refreshed once per run if the rule above says it
 *      is no longer evidence;
 *   3. the pane, re-read HERE and not taken from the hook's word for it — the
 *      turn-end hook is the trigger, but a human can type again while this
 *      runs, and moving a pane that is mid-turn is the one thing this must
 *      never do;
 *   4. `decide`;
 *   5. the record, then the move. The event and the `lastMoveAt` stamp are
 *      both written BEFORE the dispatch, the same order the wall's recovery
 *      uses: a crash between them leaves evidence and a cooldown, never a
 *      silent retry loop.
 */
export async function maybeRebalance(sessionId: string, deps: RebalanceDeps = {}): Promise<Decision | null> {
  const run = deps.run ?? processRun;
  const now = (deps.now ?? Date.now)();
  const snapshot = deps.snapshot ?? getSnapshot;
  const { openState } = await import("./state.ts");
  const st = openState();
  try {
    const row = st.getSession(sessionId);
    if (!row) return null;
    if (!rebalanceEnabled(st)) return { move: false, better: null, reason: "the gate is off" };

    let snap = await snapshot({ maxAgeMs: CACHE_ONLY_MS, lockWaitMs: SNAPSHOT_LOCK_WAIT_MS });
    if (!run.refreshed) {
      const did = await refreshIfStale({
        snapshotTakenAt: snap.takenAt,
        resetsAt: resetTimes(snap),
        now,
        refresh: async () => { snap = await snapshot({ maxAgeMs: 0, lockWaitMs: SNAPSHOT_LOCK_WAIT_MS }); },
      });
      if (did) run.refreshed = true;
    }

    const decision = decide({
      session: row,
      accounts: toPickInputs(snap),
      now,
      lastMoveAt: lastMoveAtMs(st, row),
      lastWallAt: lastWallAtMs(row.id),
      gate: true,
      pane: (deps.pane ?? readPane)(row.socket, row.pane),
    });
    if (!decision.move) return decision;
    // One move per run. A watchdog pass that settles four turns at once would
    // otherwise reshuffle four panes in the same second, on one reading.
    if (run.moved) return { move: false, better: decision.better, reason: "another session already moved this run" };
    run.moved = true;

    try {
      appendEvent({
        t: Math.floor(now / 1000), kind: "rebalance", session: row.id, generation: row.generation,
        cliSessionId: row.cliSessionId, kindDetail: decision.reason, from: row.account, to: decision.to,
      });
    } catch { /* the stamp below is the load-bearing record; a lost line is not worth the move */ }
    st.updateSession(row.id, { lastMoveAt: Math.floor(now / 1000) });
    (deps.dispatch ?? dispatchSwitch)(row, decision.to);
    return decision;
  } finally {
    st.close();
  }
}

/** Reset this process's run. Only a test wants this: a real run is a process,
 *  and a process ends. */
export function resetRebalanceRun(): void {
  processRun.refreshed = false;
  processRun.moved = false;
}

// --- `ms _rebalance <session> --to <account>` ----------------------------

/** The switch transaction, injectable so a test can prove WHAT it is asked
 *  for without running a handoff. */
export type Switcher = (
  sessionId: string,
  to: string,
  opts: { continueAfter: boolean; force: boolean },
) => Promise<{ code: number; message: string }>;

/**
 * The dispatched worker.
 *
 * It is the human's own `ms switch` transaction — one lock, one recheck, one
 * respawn, and the same destination preflight a rotation runs — with two
 * things fixed:
 *
 *   * **no continuation.** `ms switch` defaults to "auto", which carries the
 *     unfinished work over when the screen shows a wall. There is no
 *     unfinished work here: the trigger is a turn that ENDED, and the pane was
 *     re-read as idle a moment ago. Sending a continuation would make the
 *     model start talking on its own in a pane its human had left quiet.
 *   * **never forced.** A pane that has become busy since the decision is a
 *     pane this rule does not touch; `--force` is a word only a human gets to
 *     say.
 *
 * A refusal is written to the session's event log rather than stderr: this
 * runs under `tmux run-shell`, where stderr goes nowhere a human will look.
 */
export async function rebalanceWorker(argv: string[], switcher?: Switcher): Promise<number> {
  const sessionId = argv[0];
  const i = argv.indexOf("--to");
  const to = i >= 0 ? argv[i + 1] : undefined;
  if (!sessionId || sessionId.startsWith("--") || !to) {
    process.stderr.write("usage: ms _rebalance <session> --to <account>\n");
    return 2;
  }
  const run: Switcher = switcher ?? (async (id, dest, opts) => {
    const { switchOne } = await import("./manual.ts");
    return switchOne(id, dest, opts);
  });
  const r = await run(sessionId, to, { continueAfter: false, force: false });
  if (r.code === 0) return 0;
  try {
    appendEvent({
      t: Math.floor(Date.now() / 1000), kind: "note", session: sessionId, generation: 0,
      kindDetail: "rebalance", text: `rebalance to ${to} refused: ${r.message}`,
    });
  } catch { /* nothing left to say it with */ }
  return 1;
}

export const rebalanceWorkerVerb: Verb = (argv) => rebalanceWorker(argv);
