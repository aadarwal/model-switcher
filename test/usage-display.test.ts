import test from "node:test";
import assert from "node:assert/strict";
import { reportedResetCount, usedPercentText, windowPeriod, windowResetState } from "../src/usage-display.ts";

test("reported window durations replace legacy labels without guessing missing facts", () => {
  for (const [seconds, expected] of [[18000, "5h"], [604800, "7d"], [2592000, "30d"], [90, "90s"], [120, "2m"]] as const) {
    assert.equal(windowPeriod({ windowSeconds: seconds }, "week"), expected);
  }
  for (const seconds of [undefined, 0, -1, Number.NaN, Infinity]) assert.equal(windowPeriod({ windowSeconds: seconds }, "week"), "week");
  assert.equal(windowPeriod(null, "5h"), "5h");
});

test("used percentages preserve small fractions and never invent zero or saturation", () => {
  for (const value of [0, 0.7, 0.01, 99.99, 100]) assert.equal(usedPercentText(value, "—"), `${value}%`);
  for (const value of [undefined, null, Number.NaN, Infinity, "0"]) assert.equal(usedPercentText(value, "—"), "—");
});

test("only a provider-proven false resetStarted value means not started", () => {
  assert.equal(windowResetState({ resetStarted: false }), "reset not started");
  for (const value of [null, undefined, {}, { resetStarted: true }]) assert.equal(windowResetState(value), "reset unknown");
});

test("reset credits require a reported nonnegative integer, including a genuine zero", () => {
  for (const n of [0, 1, 2]) assert.equal(reportedResetCount({ resetsAvailable: n }), n);
  for (const n of [undefined, -1, 0.5, Number.NaN, Infinity]) assert.equal(reportedResetCount({ resetsAvailable: n }), null);
  assert.equal(reportedResetCount(null), null);
});
