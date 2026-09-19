// The rebalance decision (docs/superpowers/specs/2026-09-19-rebalance-design.md).
//
// Everything here is pure: a fixed clock, hand-built snapshot rows, and a
// counting fake for the refresher. Nothing polls, nothing opens a store, and
// nothing looks at a pane — `decide` is handed the pane's reading, never asked
// to take one.
//
// Every condition and every guard is mutation-proved: for each one there is a
// pair of cases that differ ONLY in that condition, one moving and one not.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  refreshIfStale,
  REBALANCE_RULES,
  type DecisionInput,
  type RebalanceSession,
} from "../src/rebalance.ts";
import type { PickInput } from "../src/pick.ts";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const at = (hours: number): string => new Date(NOW + hours * HOUR).toISOString();

const w = (usedPercent: number, resetsAt: string | null) => ({ usedPercent, resetsAt });

/** An account as the chooser sees it. Defaults are deliberately unremarkable:
 *  plenty of room, a week that resets in five days. */
const acct = (name: string, o: Partial<PickInput> = {}): PickInput => ({
  name,
  provider: "claude",
  shared: false,
  session: w(10, at(3)),
  weeklyAll: w(20, at(120)),
  weeklyFable: w(20, at(120)),
  error: null,
  ...o,
});

const sess = (o: Partial<RebalanceSession> = {}): RebalanceSession => ({
  provider: "claude",
  account: "here",
  need: "any",
  state: "running",
  ...o,
});

/** The baseline: two accounts, `here` is where the session is, `there` resets
 *  sooner so the chooser prefers it — but neither condition holds, so nothing
 *  moves until a test makes one true. */
function input(o: Partial<DecisionInput> = {}): DecisionInput {
  return {
    session: sess(),
    accounts: [acct("here", { weeklyAll: w(20, at(120)) }), acct("there", { weeklyAll: w(20, at(48)) })],
    now: NOW,
    lastMoveAt: null,
    lastWallAt: null,
    gate: true,
    pane: "idle",
    ...o,
  };
}

// --- Condition 1: an imminent wall ---------------------------------------

test("condition 1: a gating window at 85 on the current account moves to one with room", () => {
  const d = decide(input({
    accounts: [
      acct("here", { session: w(85, at(3)), weeklyAll: w(20, at(120)) }),
      acct("there", { weeklyAll: w(20, at(48)) }),
    ],
  }));
  assert.deepEqual(d, { move: true, to: "there", better: "there", reason: "imminent-wall" });
});

test("condition 1 is a floor at exactly 85, and 84.9 is not it", () => {
  const near = (used: number) => decide(input({
    accounts: [
      acct("here", { session: w(used, at(3)), weeklyAll: w(20, at(120)) }),
      acct("there", { weeklyAll: w(20, at(48)) }),
    ],
  }));
  assert.equal(near(REBALANCE_RULES.NEAR_WALL_PERCENT).move, true);
  assert.equal(near(84.9).move, false, "84.9 is not 85 — no rounding, exactly as the chooser reads 99.6");
});

test("condition 1 reads the WEEKLY window too, not only the 5 h one", () => {
  const d = decide(input({
    accounts: [
      acct("here", { session: w(2, at(3)), weeklyAll: w(90, at(120)) }),
      acct("there", { weeklyAll: w(20, at(48)) }),
    ],
  }));
  assert.equal(d.move, true, "any window the chooser gates on being near a wall is the condition");
});

test("condition 1 refuses a destination with less than 30 % room in a gating window", () => {
  const dest = (used: number) => decide(input({
    accounts: [
      acct("here", { session: w(90, at(3)), weeklyAll: w(20, at(120)) }),
      acct("there", { weeklyAll: w(used, at(48)) }),
    ],
  }));
  assert.equal(dest(100 - REBALANCE_RULES.DESTINATION_ROOM_PERCENT).move, true, "exactly 30 % room is enough");
  assert.equal(dest(70.1).move, false, "29.9 % room buys a wall in an hour instead of now");
});

test("condition 1's gating windows follow the session's need", () => {
  const accounts = [
    acct("here", { weeklyFable: w(95, at(120)) }),
    acct("there", { weeklyAll: w(20, at(48)) }),
  ];
  assert.equal(decide(input({ accounts, session: sess({ need: "any" }) })).move, false,
    "a full fable window gates nothing for a session that does not need fable");
  assert.equal(decide(input({ accounts, session: sess({ need: "fable" }) })).move, true);
});

// --- Condition 2: a clearly better budget --------------------------------

test("condition 2: a week that resets 24 h earlier, against a current week half spent", () => {
  const d = decide(input({
    accounts: [
      acct("here", { weeklyAll: w(50, at(48)) }),
      acct("there", { weeklyAll: w(10, at(24)) }),
    ],
  }));
  assert.deepEqual(d, { move: true, to: "there", better: "there", reason: "better-budget" });
});

test("condition 2's lead is exactly 24 h, and 23 h 59 m is not it", () => {
  const lead = (destHours: number) => decide(input({
    accounts: [
      acct("here", { weeklyAll: w(50, at(48)) }),
      acct("there", { weeklyAll: w(10, at(destHours)) }),
    ],
  }));
  assert.equal(lead(24).move, true);
  assert.equal(lead(24.02).move, false, "a lead just under 24 h is not clearly better");
});

test("condition 2 needs the current week at least half spent", () => {
  const spent = (used: number) => decide(input({
    accounts: [
      acct("here", { weeklyAll: w(used, at(48)) }),
      acct("there", { weeklyAll: w(10, at(24)) }),
    ],
  }));
  assert.equal(spent(REBALANCE_RULES.WEEK_USED_PERCENT).move, true);
  assert.equal(spent(49.9).move, false, "a barely used week is not worth churning a session for");
});

test("a week that resets LATER on the best account never moves anything", () => {
  // The chooser can prefer an account for its room alone (same reset instant).
  const d = decide(input({
    accounts: [
      acct("here", { weeklyAll: w(60, at(48)) }),
      acct("there", { weeklyAll: w(10, at(48)) }),
    ],
  }));
  assert.equal(d.move, false);
  assert.equal(d.better, "there", "still the better place to be — just not by enough to move for");
});

// --- `better` is computed whatever the guards say ------------------------

test("`better` is computed even when nothing moves", () => {
  for (const o of [
    { gate: false },
    { pane: "busy" as const },
    { pane: "gone" as const },
    { session: sess({ state: "parked" }) },
    { lastMoveAt: NOW - HOUR },
    { lastWallAt: NOW - MINUTE },
  ]) {
    const d = decide(input(o));
    assert.equal(d.move, false, JSON.stringify(o));
    assert.equal(d.better, "there", `${JSON.stringify(o)} still reports what the rule would choose`);
  }
});

test("`better` is null when the session is already on the best account", () => {
  const d = decide(input({
    accounts: [acct("here", { weeklyAll: w(20, at(24)) }), acct("there", { weeklyAll: w(20, at(120)) })],
  }));
  assert.deepEqual(d, { move: false, better: null, reason: "already on the best account" });
});

test("`better` is null when nothing has room at all", () => {
  const d = decide(input({
    accounts: [acct("here", { weeklyAll: w(100, at(24)) }), acct("there", { weeklyAll: w(100, at(48)) })],
  }));
  assert.equal(d.better, null);
  assert.equal(d.move, false);
});

// --- The guards ----------------------------------------------------------

test("the gate is the first thing asked, and off means nothing moves", () => {
  const moving = { accounts: [acct("here", { session: w(90, at(3)) }), acct("there", { weeklyAll: w(20, at(48)) })] };
  assert.equal(decide(input({ ...moving, gate: true })).move, true);
  const off = decide(input({ ...moving, gate: false }));
  assert.equal(off.move, false);
  assert.equal(off.reason, "the gate is off");
});

test("a parked, waiting or stopped row is never moved; a running one is", () => {
  const moving = { accounts: [acct("here", { session: w(90, at(3)) }), acct("there", { weeklyAll: w(20, at(48)) })] };
  for (const state of ["parked", "waiting", "stopped"] as const) {
    const d = decide(input({ ...moving, session: sess({ state }) }));
    assert.equal(d.move, false, state);
    assert.equal(d.reason, `the session is ${state}`);
  }
  assert.equal(decide(input({ ...moving, session: sess({ state: "running" }) })).move, true);
});

test("a pane that is mid-turn, or gone, is never moved", () => {
  const moving = { accounts: [acct("here", { session: w(90, at(3)) }), acct("there", { weeklyAll: w(20, at(48)) })] };
  assert.equal(decide(input({ ...moving, pane: "busy" })).reason, "the pane is mid-turn");
  assert.equal(decide(input({ ...moving, pane: "gone" })).reason, "the pane is gone");
  assert.equal(decide(input({ ...moving, pane: "idle" })).move, true);
});

test("no second move within six hours of the last one, by any hand", () => {
  const moving = { accounts: [acct("here", { session: w(90, at(3)) }), acct("there", { weeklyAll: w(20, at(48)) })] };
  const ago = (ms: number) => decide(input({ ...moving, lastMoveAt: NOW - ms }));
  assert.equal(ago(REBALANCE_RULES.MOVE_COOLDOWN_MS - 1).move, false);
  assert.equal(ago(REBALANCE_RULES.MOVE_COOLDOWN_MS).move, true, "six hours later it is free to move again");
  assert.equal(ago(MINUTE).reason, "it moved within the last 6h");
});

test("no move within thirty minutes of a wall-driven rotation", () => {
  const moving = { accounts: [acct("here", { session: w(90, at(3)) }), acct("there", { weeklyAll: w(20, at(48)) })] };
  const ago = (ms: number) => decide(input({ ...moving, lastWallAt: NOW - ms }));
  assert.equal(ago(REBALANCE_RULES.WALL_COOLDOWN_MS - 1).move, false);
  assert.equal(ago(REBALANCE_RULES.WALL_COOLDOWN_MS).move, true);
  assert.equal(ago(MINUTE).reason, "it rotated off a wall within the last 30m");
});

// --- What the rule refuses to guess at -----------------------------------

test("a Claude session never moves to a Codex account, however good it looks", () => {
  const d = decide(input({
    accounts: [
      acct("here", { session: w(90, at(3)), weeklyAll: w(20, at(120)) }),
      acct("codexy", { provider: "codex", weeklyAll: w(1, at(1)) }),
    ],
  }));
  assert.deepEqual(d, { move: false, better: null, reason: "already on the best account" });
});

test("a current account with no usable reading is never judged", () => {
  const d = decide(input({
    accounts: [acct("here", { error: "token dead" }), acct("there", { weeklyAll: w(20, at(48)) })],
  }));
  assert.equal(d.move, false);
  assert.equal(d.reason, "the current account has no usable reading");
  assert.equal(d.better, "there", "the chooser still says where it would go");
});

test("a current account the snapshot does not carry at all is never judged", () => {
  const d = decide(input({ accounts: [acct("there", { weeklyAll: w(20, at(48)) })] }));
  assert.equal(d.move, false);
  assert.equal(d.reason, "the current account is not in the snapshot");
});

test("neither condition holding is said in those words", () => {
  assert.equal(decide(input()).reason, "neither condition holds");
});

// --- The refresh rule ----------------------------------------------------

/** A refresher that counts, and nothing else — the whole point of the rule is
 *  how many times the network is touched. */
function counter(): { calls: number; refresh: () => Promise<void> } {
  const c = { calls: 0, refresh: async () => { c.calls++; } };
  return c;
}

const stale = (o: Partial<Parameters<typeof refreshIfStale>[0]> = {}) => ({
  snapshotTakenAt: NOW - MINUTE,
  resetsAt: [] as number[],
  now: NOW,
  ...o,
});

test("a snapshot nothing has ever taken is refreshed", async () => {
  const c = counter();
  assert.equal(await refreshIfStale({ ...stale({ snapshotTakenAt: null }), refresh: c.refresh }), true);
  assert.equal(c.calls, 1);
});

test("a snapshot older than fifteen minutes is refreshed; one exactly that old is not", async () => {
  const age = async (ms: number) => {
    const c = counter();
    const did = await refreshIfStale({ ...stale({ snapshotTakenAt: NOW - ms }), refresh: c.refresh });
    return { did, calls: c.calls };
  };
  assert.deepEqual(await age(REBALANCE_RULES.SNAPSHOT_MAX_AGE_MS + 1), { did: true, calls: 1 });
  assert.deepEqual(await age(REBALANCE_RULES.SNAPSHOT_MAX_AGE_MS), { did: false, calls: 0 });
  assert.deepEqual(await age(MINUTE), { did: false, calls: 0 });
});

test("a resetsAt that has PASSED since the snapshot was taken refreshes it", async () => {
  const c = counter();
  // Taken ten minutes ago; a window reset five minutes ago. Every percentage
  // in that file is now a lie about an account with a whole fresh week.
  const did = await refreshIfStale({
    ...stale({ snapshotTakenAt: NOW - 10 * MINUTE, resetsAt: [NOW - 5 * MINUTE] }),
    refresh: c.refresh,
  });
  assert.equal(did, true);
  assert.equal(c.calls, 1);
});

test("a reset that was already past when the snapshot was taken is not a reason", async () => {
  const c = counter();
  // The poll that wrote the file saw this reset happen; the numbers in it
  // already account for it.
  const did = await refreshIfStale({
    ...stale({ snapshotTakenAt: NOW - MINUTE, resetsAt: [NOW - 10 * MINUTE] }),
    refresh: c.refresh,
  });
  assert.equal(did, false);
  assert.equal(c.calls, 0);
});

test("a reset still in the future is not a reason", async () => {
  const c = counter();
  const did = await refreshIfStale({ ...stale({ resetsAt: [NOW + HOUR] }), refresh: c.refresh });
  assert.equal(did, false);
  assert.equal(c.calls, 0);
});

test("one refresh covers every account, however many resets have passed", async () => {
  const c = counter();
  await refreshIfStale({
    ...stale({ snapshotTakenAt: NOW - 10 * MINUTE, resetsAt: [NOW - MINUTE, NOW - 2 * MINUTE, NOW - 3 * MINUTE] }),
    refresh: c.refresh,
  });
  assert.equal(c.calls, 1, "one usage round for the whole fleet, never one per window");
});

test("an unparseable reset time is not evidence of anything", async () => {
  const c = counter();
  const did = await refreshIfStale({ ...stale({ resetsAt: [Number.NaN, Number.POSITIVE_INFINITY] }), refresh: c.refresh });
  assert.equal(did, false);
  assert.equal(c.calls, 0);
});
