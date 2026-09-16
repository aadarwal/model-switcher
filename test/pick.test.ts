import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAccounts, parseNeed, type PickInput } from "../src/pick.ts";

const w = (used: number, resets: string | null = "2026-09-20T00:00:00Z") => ({ usedPercent: used, resetsAt: resets });
const acct = (name: string, o: Partial<PickInput> = {}): PickInput => ({
  name, provider: "claude", shared: false, session: w(10, "2026-09-15T05:00:00Z"),
  weeklyAll: w(50, "2026-09-18T00:00:00Z"), weeklyFable: w(50, "2026-09-18T00:00:00Z"), error: null, ...o,
});

test("a window at 100 is out; earliest weekly reset orders the rest", () => {
  const r = pickAccounts([
    acct("late", { weeklyAll: w(10, "2026-09-21T00:00:00Z") }),
    acct("early", { weeklyAll: w(90, "2026-09-16T00:00:00Z") }),
    acct("full", { session: w(100, "2026-09-15T06:00:00Z") }),
  ], "any");
  assert.deepEqual(r.picks.map((x) => x.name), ["early", "late"]);
  assert.deepEqual(r.out, [{ name: "full", why: "session window at 100" }]);
});

test("99.6 is not 100 (no rounding)", () => {
  const r = pickAccounts([acct("almost", { weeklyAll: w(99.6) })], "any");
  assert.equal(r.picks.length, 1);
});

test("need=fable gates on the fable window; need=any ignores it", () => {
  const a = [acct("x", { weeklyFable: w(100) })];
  assert.equal(pickAccounts(a, "fable").out[0]?.why, "fable window at 100");
  assert.equal(pickAccounts(a, "any").picks.length, 1);
});

test("a missing window makes the account ineligible with a reason", () => {
  const r = pickAccounts([acct("nowk", { weeklyAll: null })], "any");
  assert.deepEqual(r.out, [{ name: "nowk", why: "no weekly window" }]);
});

test("ties on reset: more remaining first, then solo before shared", () => {
  const r = pickAccounts([
    acct("shared", { shared: true, weeklyAll: w(20) }),
    acct("solo", { weeklyAll: w(20) }),
    acct("fuller", { weeklyAll: w(60) }),
  ], "any");
  assert.deepEqual(r.picks.map((x) => x.name), ["solo", "shared", "fuller"]);
});

test("exclude and error", () => {
  const r = pickAccounts([acct("a"), acct("b", { error: "token dead" })], "any", ["a"]);
  assert.deepEqual(r.picks, []);
  assert.deepEqual(r.out.map((o) => o.why), ["excluded", "error: token dead"]);
});

test("an excluded name that also has an error reports only excluded", () => {
  const r = pickAccounts([acct("a", { error: "token dead" })], "any", ["a"]);
  assert.deepEqual(r.out, [{ name: "a", why: "excluded" }]);
});

test("a non-finite usedPercent is malformed, not eligible", () => {
  const rSession = pickAccounts([acct("s", { session: w(NaN) })], "any");
  assert.deepEqual(rSession.out, [{ name: "s", why: "malformed session percent" }]);

  const rWeekly = pickAccounts(
    [acct("w", { weeklyAll: { usedPercent: "80" as unknown as number, resetsAt: null } })],
    "any",
  );
  assert.deepEqual(rWeekly.out, [{ name: "w", why: "malformed weekly percent" }]);

  const fableBad = acct("f", { weeklyFable: { usedPercent: NaN, resetsAt: null } });
  assert.deepEqual(pickAccounts([fableBad], "fable").out, [{ name: "f", why: "malformed fable percent" }]);
  assert.equal(pickAccounts([fableBad], "any").picks.length, 1);
});

// A Codex row's `weeklyFable` is always null (Codex has no Fable-scoped
// window): out for need=fable, in for need=any — never gated by a window
// that provider simply does not have.
test("a null weeklyFable is out for need=fable and in for need=any", () => {
  const a = [acct("cdx", { provider: "codex", weeklyFable: null })];
  const fable = pickAccounts(a, "fable");
  assert.deepEqual(fable.out, [{ name: "cdx", why: "no fable window" }]);
  const any = pickAccounts(a, "any");
  assert.equal(any.picks.length, 1);
  assert.equal(any.picks[0]?.name, "cdx");
});

test("parseNeed", () => {
  assert.equal(parseNeed(undefined), "any"); assert.equal(parseNeed("fable"), "fable"); assert.equal(parseNeed("fabel"), null);
});
