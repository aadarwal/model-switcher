import { test } from "node:test";
import assert from "node:assert/strict";
import { poolSummaries, poolSummaryText } from "../src/pool-summary.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const after = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const win = (usedPercent: number, hours: number | null = null) => ({ usedPercent, resetsAt: hours === null ? null : after(hours) });
type Account = Parameters<typeof poolSummaries>[0][number];
function account(name: string, over: Partial<Account> = {}): Account {
  return { name, provider: "claude", shared: false, state: "ok", reservePercent: 0, usage: { session: win(20), weeklyAll: win(20), weeklyFable: null }, ...over };
}

test("pool summaries count the table's ok states per provider, including personal accounts", () => {
  const accounts = [
    account("home"), account("shared", { shared: true }),
    ...["no room", "reserved", "auth", "no-grant", "no-token", "transient", "stale"].map((state) => account(state, { state })),
    account("home", { provider: "codex", usage: { session: null, weeklyAll: win(20), weeklyFable: null } }),
  ];
  const pools = poolSummaries(accounts, NOW);
  assert.equal(pools.claude?.withRoom, 2);
  assert.equal(pools.claude?.total, 9);
  assert.equal(pools.claude?.lastAccount, null);
  assert.deepEqual(pools.codex?.lastAccount, { account: "home", sessionUsedPercent: null });
  assert.equal(pools.codex?.withRoom, 1);
  assert.equal(pools.codex?.total, 1);
  assert.equal("resetsAvailable" in pools.claude!, false);
  assert.deepEqual(poolSummaries([], NOW), {});
});

test("pool reset events use the next 24h, group simultaneous windows, sort chronologically, and keep provider identity", () => {
  const pools = poolSummaries([
    account("alpha", { usage: { session: win(20, 1), weeklyAll: win(30, 2), weeklyFable: win(40, 2) } }),
    account("boundary", { usage: { session: win(10, 0), weeklyAll: win(10, 24), weeklyFable: win(10, 24.01) } }),
    account("invalid", { usage: { session: { usedPercent: 10, resetsAt: "bad-date" }, weeklyAll: win(20, -1), weeklyFable: null } }),
    account("alpha", { provider: "codex", usage: { session: null, weeklyAll: win(10, 0.5), weeklyFable: null } }),
  ], NOW);
  assert.deepEqual(pools.claude?.resetsNext24h, [
    { account: "alpha", resetsAt: after(1), windows: ["5h"] },
    { account: "alpha", resetsAt: after(2), windows: ["week", "fable"] },
    { account: "boundary", resetsAt: after(24), windows: ["week"] },
  ]);
  assert.deepEqual(pools.codex?.resetsNext24h, [{ account: "alpha", resetsAt: after(0.5), windows: ["week"] }]);
});

test("pool capacity recovery waits for all blocked windows and accounts for owner reserve", () => {
  const accounts = [
    account("alpha", { state: "no room", usage: { session: win(100, 1), weeklyAll: win(100, 30), weeklyFable: null } }),
    account("bravo", { state: "no room", usage: { session: win(20), weeklyAll: win(100, 4), weeklyFable: null } }),
    account("reserved", { state: "reserved", reservePercent: 30, usage: { session: win(20), weeklyAll: win(75, 3), weeklyFable: null } }),
  ];
  assert.deepEqual(poolSummaries(accounts, NOW).claude?.nextRoom, { account: "reserved", resetsAt: after(3) });
  assert.deepEqual(poolSummaries(accounts.slice(0, 2), NOW).claude?.nextRoom, { account: "bravo", resetsAt: after(4) });
  assert.deepEqual(poolSummaries(accounts.slice(0, 1), NOW).claude?.nextRoom, { account: "alpha", resetsAt: after(30) });
});

test("a Fable reset is an event; ordinary capacity waits only for session and week", () => {
  const a = account("alpha", { state: "no room", usage: { session: win(100, 3), weeklyAll: win(20, 2), weeklyFable: win(100, 1) } });
  const summary = poolSummaries([a], NOW).claude!;
  assert.equal(summary.resetsNext24h.length, 3);
  assert.deepEqual(summary.nextRoom, { account: "alpha", resetsAt: after(3) });
});

test("unusable accounts and an unknown blocking reset cannot promise pool recovery", () => {
  const full = { session: win(100, 1), weeklyAll: win(100, 2), weeklyFable: null };
  const accounts = [
    ...["auth", "no-grant", "no-token", "transient", "stale"].map((state) => account(state, { state, usage: full })),
    account("unknown", { state: "no room", usage: { ...full, weeklyAll: win(100) } }),
    account("past", { state: "no room", usage: { ...full, weeklyAll: win(100, -1) } }),
    account("missing", { state: "no room", usage: { ...full, session: null } }),
    account("malformed", { state: "no room", usage: { ...full, weeklyAll: win(Number.NaN, 2) } }),
  ];
  const summary = poolSummaries(accounts, NOW).claude!;
  assert.equal(summary.withRoom, 0);
  assert.equal(summary.nextRoom, null);
  assert.equal(summary.lastAccount, null);
});

test("pool summary text names the last account, its 5h usage, reset events and the next recovery", () => {
  const summary = poolSummaries([
    account("last", { usage: { session: win(68), weeklyAll: win(18), weeklyFable: null } }),
    account("waiting", { state: "no room", usage: { session: win(100, 2), weeklyAll: win(20), weeklyFable: null } }),
  ], NOW).claude!;
  const text = poolSummaryText("claude", summary, NOW);
  assert.match(text, /^claude: 1\/2 with room · resets in next 24 h: 1 \(waiting 5h \d{4}-\d\d-\d\d \d\d:\d\d\)/);
  assert.match(text, /next room: waiting .* \(in 2h 0m\)/);
  assert.match(text, /LAST ACCOUNT WITH ROOM \(last, 5H 68% used\)$/);
  assert.doesNotMatch(text, /resets available/);
});

test("reported reset credits distinguish complete, partial, stale, malformed, and unknown coverage", () => {
  const credited = (name: string, count: number) => account(name, { provider: "codex", usage: Object.assign({ session: null, weeklyAll: win(0), weeklyFable: null }, { resetsAvailable: count }) });
  const members = [credited("aadarwal", 1), credited("kratuvak", 2), credited("tulp", 0)];
  const complete = poolSummaries(members, NOW).codex!;
  assert.equal(complete.resetsAvailable, 3);
  assert.equal("reportedResetsAvailable" in complete, false);
  assert.match(poolSummaryText("codex", complete, NOW), /resets available: 3$/);
  const partial = poolSummaries([members[0]!, account("unknown", { provider: "codex" })], NOW).codex!;
  assert.equal("resetsAvailable" in partial, false);
  assert.deepEqual(partial.reportedResetsAvailable, { count: 1, accounts: 1, total: 2 });
  assert.match(poolSummaryText("codex", partial, NOW), /1 reported \(1\/2 accounts; 1 unknown\)/);
  const stale = poolSummaries([members[0]!, { ...members[1]!, stale: true }, { ...members[2]!, error: "timeout" }], NOW).codex!;
  assert.equal("resetsAvailable" in stale, false);
  assert.deepEqual(stale.reportedResetsAvailable, { count: 1, accounts: 1, total: 3 });
  for (const value of [-1, 0.5, Number.NaN, Infinity]) {
    const invalid = poolSummaries([credited("bad", value)], NOW).codex!;
    assert.equal("resetsAvailable" in invalid, false);
    assert.equal("reportedResetsAvailable" in invalid, false);
  }
  assert.equal(poolSummaries([credited("zero", 0)], NOW).codex!.resetsAvailable, 0);
  const partialZero = poolSummaries([credited("zero", 0), account("unknown", { provider: "codex" })], NOW).codex!;
  assert.equal("resetsAvailable" in partialZero, false);
  assert.deepEqual(partialZero.reportedResetsAvailable, { count: 0, accounts: 1, total: 2 });
});

test("pool reset events name actual long-window durations", () => {
  const a = account("free", { provider: "codex", usage: { session: null, weeklyAll: Object.assign(win(0.7, 2), { windowSeconds: 2592000 }), weeklyFable: null } });
  assert.deepEqual(poolSummaries([a], NOW).codex!.resetsNext24h[0]!.windows, ["30d"]);
});

test("window reset dates do not promise recovery from an independent provider refusal", () => {
  for (const facts of [{ requestsAllowed: false }, { limitReached: true }]) {
    const a = account("blocked", { provider: "codex", state: "no room", usage: Object.assign({ session: win(100, 1), weeklyAll: win(100, 2), weeklyFable: null }, facts) });
    const summary = poolSummaries([a], NOW).codex!;
    assert.equal(summary.nextRoom, null);
    assert.equal(summary.withRoom, 0);
    assert.equal(summary.resetsNext24h.length, 2, "scheduled window events remain separate from a capacity promise");
  }
});
