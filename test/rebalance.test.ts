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
 *  moves until a test makes one true. The reset gap between them is
 *  deliberately UNDER condition 2's 24 h floor (12 h here), so this baseline
 *  does not itself satisfy "clearly better budget" now that condition 2 no
 *  longer also requires the current week to be any particular amount spent. */
function input(o: Partial<DecisionInput> = {}): DecisionInput {
  return {
    session: sess(),
    accounts: [acct("here", { weeklyAll: w(20, at(60)) }), acct("there", { weeklyAll: w(20, at(48)) })],
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
  // The weekly reset gap is kept under condition 2's 24 h floor throughout,
  // so a session below the wall threshold genuinely moves nothing — not
  // "moves for the other reason instead".
  const near = (used: number) => decide(input({
    accounts: [
      acct("here", { session: w(used, at(3)), weeklyAll: w(20, at(60)) }),
      acct("there", { weeklyAll: w(20, at(48)) }),
    ],
  }));
  // Literals on BOTH sides, so the number itself is pinned and not merely the
  // comparison: an assertion written as `near(REBALANCE_RULES.NEAR_WALL_PERCENT)`
  // moves wherever the constant moves and proves only that `>=` is `>=`.
  assert.equal(near(85).move, true, "85 is the spec's floor");
  assert.equal(near(84).move, false, "84 is not near a wall");
  assert.equal(near(84.9).move, false, "and 84.9 is not 85 — no rounding, exactly as the chooser reads 99.6");
  // The comparison, with the constant: the floor is inclusive.
  assert.equal(near(REBALANCE_RULES.NEAR_WALL_PERCENT).move, true);
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
  // Same reset-gap discipline as above: under 24 h, so a destination this
  // test wants refused on ROOM alone is not rescued by condition 2 instead.
  const dest = (used: number) => decide(input({
    accounts: [
      acct("here", { session: w(90, at(3)), weeklyAll: w(20, at(60)) }),
      acct("there", { weeklyAll: w(used, at(48)) }),
    ],
  }));
  // `dest` takes the destination's USED percent, so 30 % room is 70 % used —
  // both literals, because `100 - REBALANCE_RULES.DESTINATION_ROOM_PERCENT`
  // would follow the constant anywhere it went.
  assert.equal(dest(70).move, true, "30 % room is enough");
  assert.equal(dest(71).move, false, "29 % room is not");
  assert.equal(dest(70.1).move, false, "and 29.9 % room buys a wall in an hour instead of now");
  assert.equal(dest(100 - REBALANCE_RULES.DESTINATION_ROOM_PERCENT).move, true, "the floor is inclusive");
});

test("condition 1's gating windows follow the session's need", () => {
  // `here`'s weeklyAll reset is pinned within 24 h of `there`'s so the "any"
  // case below is refused for the reason under test, not rescued by
  // condition 2's reset-lead test instead.
  const accounts = [
    acct("here", { weeklyAll: w(20, at(60)), weeklyFable: w(95, at(120)) }),
    acct("there", { weeklyAll: w(20, at(48)) }),
  ];
  assert.equal(decide(input({ accounts, session: sess({ need: "any" }) })).move, false,
    "a full fable window gates nothing for a session that does not need fable");
  assert.equal(decide(input({ accounts, session: sess({ need: "fable" }) })).move, true);
});

// --- Condition 2: a clearly better budget --------------------------------

test("condition 2: a week that resets 24 h earlier moves, whatever the current week has used", () => {
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

test("condition 2 does not require the current account to be half used: current at 5 % still moves when the reset is 24 h earlier", () => {
  const spent = (used: number) => decide(input({
    accounts: [
      acct("here", { weeklyAll: w(used, at(48)) }),
      acct("there", { weeklyAll: w(10, at(24)) }),
    ],
  }));
  assert.equal(spent(5).move, true, "a sooner reset is reason enough, however little the current week has used");
  assert.equal(spent(0).move, true, "even an untouched budget loses to a reset 24 h sooner");
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
  assert.equal(ago(5 * HOUR + 59 * MINUTE).move, false, "five fifty-nine is still inside the six hours");
  assert.equal(ago(6 * HOUR).move, true, "six hours later it is free to move again");
  assert.equal(ago(REBALANCE_RULES.MOVE_COOLDOWN_MS - 1).move, false, "and the boundary itself is exclusive-then-inclusive");
  assert.equal(ago(REBALANCE_RULES.MOVE_COOLDOWN_MS).move, true);
  assert.equal(ago(MINUTE).reason, "it moved within the last 6h");
});

test("no move within thirty minutes of a wall-driven rotation", () => {
  const moving = { accounts: [acct("here", { session: w(90, at(3)) }), acct("there", { weeklyAll: w(20, at(48)) })] };
  const ago = (ms: number) => decide(input({ ...moving, lastWallAt: NOW - ms }));
  assert.equal(ago(29 * MINUTE).move, false, "twenty-nine minutes is still inside the thirty");
  assert.equal(ago(30 * MINUTE).move, true);
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
  // Literals first: fifteen minutes is the spec's number, and an assertion
  // phrased only in terms of the constant would hold just as green at five.
  assert.deepEqual(await age(16 * MINUTE), { did: true, calls: 1 }, "sixteen minutes is older than fifteen");
  assert.deepEqual(await age(14 * MINUTE), { did: false, calls: 0 }, "fourteen is not");
  assert.deepEqual(await age(MINUTE), { did: false, calls: 0 });
  // Then the comparison: "older than", so the boundary itself is not old.
  assert.deepEqual(await age(REBALANCE_RULES.SNAPSHOT_MAX_AGE_MS + 1), { did: true, calls: 1 });
  assert.deepEqual(await age(REBALANCE_RULES.SNAPSHOT_MAX_AGE_MS), { did: false, calls: 0 });
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

// =========================================================================
// maybeRebalance: the turn-end entry point.
// =========================================================================
//
// Hermetic: a temp MS_HOME, hand-built snapshots, a counting fake for the
// snapshot reader, a stub for the pane and a recorder for the dispatch. No
// tmux runs, no network is touched and no handoff happens.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import {
  maybeRebalance,
  newRebalanceRun,
  rebalanceArgv,
  rebalanceWorker,
  type Decision,
  type RebalanceDeps,
} from "../src/rebalance.ts";
import { REBALANCE_KEY } from "../src/autorotate.ts";
import { openState, type SessionRow, type State } from "../src/state.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { msBinary } from "../src/paths.ts";

type World = { msHome: string; st: State };

function world(): World {
  const { home, msHome } = tempHome();
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  delete process.env.MS_REBALANCE;
  return { msHome, st: openState() };
}

function session(st: State, id: string, o: Partial<SessionRow> = {}): void {
  st.createSession({
    id, provider: "claude", cliSessionId: `c-${id}`, cwd: "/tmp/work", socket: "/tmp/ms.sock", pane: "%7",
    serverStart: "1", need: "any", account: "here", generation: 1, state: "running", desired: "running", flags: [],
    ...o,
  } as Parameters<State["createSession"]>[0]);
}

const gateOn = (st: State) => st.setKv(REBALANCE_KEY, "1");
const gateOff = (st: State) => st.setKv(REBALANCE_KEY, "0");

/** `maybeRebalance` answers null only for a session the store does not have.
 *  Every call below names one it does, so the null is an assertion, not a
 *  case — and asserting it here keeps `?.` out of the tests that matter. */
async function rebalanced(id: string, d: RebalanceDeps): Promise<Decision> {
  const r = await maybeRebalance(id, d);
  assert.ok(r, `${id} is a session the store has`);
  return r;
}

/** A snapshot whose rows are all fresh readings — `toPickInputs`'s ten-minute
 *  age rule reads the REAL clock, so `observedAt` is the real now even though
 *  the decision itself runs on the fixed one. */
function snapshot(takenAt: number, rows: { name: string; session: number; weekly: number; resets: string }[]): Snapshot {
  return {
    takenAt,
    registryError: null,
    accounts: rows.map((r) => ({
      name: r.name, provider: "claude" as const, shared: false,
      usage: {
        session: { usedPercent: r.session, resetsAt: at(3) },
        weeklyAll: { usedPercent: r.weekly, resetsAt: r.resets },
        weeklyFable: null,
      },
      error: null, errorKind: null, observedAt: Date.now(), stale: false,
    })),
  };
}

/** `here` is about to wall; `there` has room and resets sooner. */
const MOVING = [
  { name: "here", session: 92, weekly: 20, resets: at(120) },
  { name: "there", session: 5, weekly: 10, resets: at(48) },
];
/** Both comfortable, same reset: nothing to move for. */
const SETTLED = [
  { name: "here", session: 5, weekly: 20, resets: at(48) },
  { name: "there", session: 5, weekly: 10, resets: at(48) },
];

function deps(rows = MOVING, o: Partial<RebalanceDeps> = {}) {
  const calls = { snapshot: 0, refresh: 0, dispatch: [] as { id: string; to: string }[] };
  const d: RebalanceDeps = {
    now: () => NOW,
    snapshot: async (opts) => {
      calls.snapshot++;
      if (opts.maxAgeMs === 0) calls.refresh++;
      return snapshot(NOW - MINUTE, rows);
    },
    pane: () => "idle",
    dispatch: (row, to) => { calls.dispatch.push({ id: row.id, to }); },
    run: newRebalanceRun(),
    ...o,
  };
  return { d, calls };
}

function events(msHome: string, id: string): Record<string, unknown>[] {
  const f = path.join(msHome, "sessions", id, "events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("the gate off costs one store read and nothing else: no snapshot, no move", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOff(w.st);
  const { d, calls } = deps();
  const decision = await rebalanced("s1", d);
  assert.deepEqual(decision, { move: false, better: null, reason: "the gate is off" });
  assert.equal(calls.snapshot, 0, "the gate is asked before the snapshot, so off costs no reading at all");
  assert.deepEqual(calls.dispatch, []);
});

test("the gate defaults ON: nothing stored, no env, and a condition true still moves", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  // No gateOn/gateOff call: nothing has ever been stored, and `world()` has
  // already deleted MS_REBALANCE — this is the untouched, out-of-the-box state.
  const { d, calls } = deps();
  const decision = await rebalanced("s1", d);
  assert.deepEqual(decision, { move: true, to: "there", better: "there", reason: "imminent-wall" });
  assert.deepEqual(calls.dispatch, [{ id: "s1", to: "there" }]);
});

test("the gate on and a condition true: one dispatch, one event, one stamp", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOn(w.st);
  const { d, calls } = deps();
  const decision = await rebalanced("s1", d);

  assert.deepEqual(decision, { move: true, to: "there", better: "there", reason: "imminent-wall" });
  assert.deepEqual(calls.dispatch, [{ id: "s1", to: "there" }]);

  const ev = events(w.msHome, "s1").filter((e) => e.kind === "rebalance");
  assert.equal(ev.length, 1);
  assert.deepEqual(
    [ev[0].from, ev[0].to, ev[0].kindDetail, ev[0].generation, ev[0].t],
    ["here", "there", "imminent-wall", 1, Math.floor(NOW / 1000)],
  );
  assert.equal(w.st.getSession("s1")!.lastMoveAt, Math.floor(NOW / 1000), "the hysteresis stamp is written with the move");
});

test("the dispatched argv is the switch worker for this session and account", () => {
  assert.deepEqual(rebalanceArgv("s1", "there"), [msBinary(), "_rebalance", "s1", "--to", "there"]);
});

test("at most ONE move per hook run, however many sessions are eligible", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  session(w.st, "s2");
  gateOn(w.st);
  const { d, calls } = deps();           // one `run`, shared by both calls
  const first = await rebalanced("s1", d);
  const second = await rebalanced("s2", d);

  assert.equal(first.move, true);
  assert.equal(second.move, false);
  assert.equal(second.better, "there", "it still says where s2 belongs");
  assert.equal(second.reason, "another session already moved this run");
  assert.deepEqual(calls.dispatch, [{ id: "s1", to: "there" }], "the second session waits for the next turn end");
  assert.equal(w.st.getSession("s2")!.lastMoveAt, null, "and is not charged a cooldown for a move it did not get");
});

test("a fresh run moves the second session — the bound is per run, not for ever", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  session(w.st, "s2");
  gateOn(w.st);
  const a = deps();
  await maybeRebalance("s1", a.d);
  const b = deps();                       // the next hook: a new process, a new run
  await maybeRebalance("s2", b.d);
  assert.deepEqual(b.calls.dispatch, [{ id: "s2", to: "there" }]);
});

test("a second turn end within six hours of the stamp moves nothing", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOn(w.st);
  w.st.updateSession("s1", { lastMoveAt: Math.floor((NOW - 5 * HOUR) / 1000) });
  const { d, calls } = deps();
  const decision = await rebalanced("s1", d);
  assert.equal(decision.move, false);
  assert.equal(decision.reason, "it moved within the last 6h");
  assert.deepEqual(calls.dispatch, []);
});

test("a HUMAN's switch counts as a move: a launch row at generation 2 holds the cooldown", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOn(w.st);
  // Exactly what `ms switch` leaves behind, and nothing rebalance wrote.
  w.st.createLaunch({ id: "l1", sessionId: "s1", generation: 2, account: "elsewhere", command: ["claude"], env: {},
    createdAt: Math.floor((NOW - HOUR) / 1000) });
  const { d, calls } = deps();
  const decision = await rebalanced("s1", d);
  assert.equal(decision.reason, "it moved within the last 6h");
  assert.deepEqual(calls.dispatch, []);

  // …and the session's BIRTH launch is not a move.
  const w2 = world();
  t.after(() => w2.st.close());
  session(w2.st, "s1");
  gateOn(w2.st);
  w2.st.createLaunch({ id: "l0", sessionId: "s1", generation: 1, account: "here", command: ["claude"], env: {},
    createdAt: Math.floor((NOW - HOUR) / 1000) });
  const again = deps();
  assert.equal((await rebalanced("s1", again.d)).move, true);
});

test("a wall in the last thirty minutes moves nothing — the wall's own record is the clock", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOn(w.st);
  const { appendEvent } = await import("../src/events.ts");
  appendEvent({ t: Math.floor((NOW - 10 * MINUTE) / 1000), kind: "rate_limited", session: "s1", generation: 1, kindDetail: "session" });
  const { d, calls } = deps();
  const decision = await rebalanced("s1", d);
  assert.equal(decision.reason, "it rotated off a wall within the last 30m");
  assert.deepEqual(calls.dispatch, []);
});

test("a parked row moves nothing", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1", { state: "parked" });
  gateOn(w.st);
  const { d, calls } = deps();
  assert.equal((await rebalanced("s1", d)).reason, "the session is parked");
  assert.deepEqual(calls.dispatch, []);
});

test("a pane that has gone busy since the turn ended moves nothing", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOn(w.st);
  const { d, calls } = deps(MOVING, { pane: () => "busy" });
  assert.equal((await rebalanced("s1", d)).reason, "the pane is mid-turn");
  assert.deepEqual(calls.dispatch, []);
});

test("nothing to move for: the snapshot is read, the pane is not moved", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOn(w.st);
  const { d, calls } = deps(SETTLED);
  const decision = await rebalanced("s1", d);
  assert.equal(decision.move, false);
  assert.equal(calls.snapshot, 1);
  assert.deepEqual(calls.dispatch, []);
});

test("an unknown session decides nothing at all", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  const { d, calls } = deps();
  assert.equal(await maybeRebalance("nobody", d), null);
  assert.equal(calls.snapshot, 0);
});

test("a stale snapshot is refreshed ONCE per run, for the whole fleet", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  session(w.st, "s2");
  gateOn(w.st);
  const calls = { refresh: 0 };
  const run = newRebalanceRun();
  const d: RebalanceDeps = {
    now: () => NOW,
    // Always answers "taken half an hour ago", so a rule that did not latch
    // would poll again for the second session.
    snapshot: async (opts) => {
      if (opts.maxAgeMs === 0) calls.refresh++;
      return snapshot(NOW - 30 * MINUTE, SETTLED);
    },
    pane: () => "idle",
    dispatch: () => {},
    run,
  };
  await maybeRebalance("s1", d);
  await maybeRebalance("s2", d);
  assert.equal(calls.refresh, 1, "one usage round for every account, once");
  assert.equal(run.refreshed, true);
});

test("a fresh snapshot is never refreshed", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  session(w.st, "s1");
  gateOn(w.st);
  const { d, calls } = deps(SETTLED);     // taken a minute ago
  await maybeRebalance("s1", d);
  assert.equal(calls.refresh, 0);
});

// --- The worker ----------------------------------------------------------

test("the worker runs the switch transaction with NO continuation and no force", async () => {
  const calls: unknown[] = [];
  const code = await rebalanceWorker(["s1", "--to", "there"], async (id, to, opts) => {
    calls.push([id, to, opts]);
    return { code: 0, message: "switched → there" };
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [["s1", "there", { continueAfter: false, force: false }]]);
});

test("the worker refuses a command line it cannot act on, and runs nothing", async () => {
  let ran = false;
  const nope = async () => { ran = true; return { code: 0, message: "" }; };
  for (const argv of [[], ["s1"], ["--to", "there"], ["s1", "--to"]]) {
    assert.equal(await rebalanceWorker(argv, nope), 2, JSON.stringify(argv));
  }
  assert.equal(ran, false);
});

test("a refused switch is written where a human will find it, not to a stderr nobody reads", async (t) => {
  const w = world();
  t.after(() => w.st.close());
  const code = await rebalanceWorker(["s1", "--to", "there"], async () => ({ code: 1, message: "the pane is busy" }));
  assert.equal(code, 1);
  const note = events(w.msHome, "s1").find((e) => e.kind === "note");
  assert.equal(note?.kindDetail, "rebalance");
  assert.match(String(note?.text), /refused: the pane is busy/);
});
