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

import { pickAccounts, type Need, type PickInput } from "./pick.ts";
// type-only: erased at compile time, so importing this file never loads
// node:sqlite (which the hooks must not do at module scope).
import type { SessionRow } from "./state.ts";

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
