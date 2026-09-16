// test/dashboard-client.test.ts
//
// Review round 1 (P4-T2), finding 8: "no tests over the page's client JS".
// src/dashboard/client-logic.ts holds every pure piece of the dashboard
// page's inline script (src/dashboard/page.ts embeds each function's own
// source via `.toString()`), so these run directly under Node — no DOM, no
// browser, no fixture beyond the functions themselves.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esc,
  buildRotateBody,
  buildSwitchBody,
  buildStopBody,
  buildSwitchAllBody,
  nextPollState,
  pollStateOnVisible,
  MAX_POLL_FAILURES,
  type PollState,
} from "../src/dashboard/client-logic.ts";

// --- esc() -----------------------------------------------------------------

test("esc(): escapes & < > \" ' and leaves everything else alone", () => {
  assert.equal(esc("&"), "&amp;");
  assert.equal(esc("<"), "&lt;");
  assert.equal(esc(">"), "&gt;");
  assert.equal(esc('"'), "&quot;");
  assert.equal(esc("'"), "&#39;");
  assert.equal(esc("plain text 123"), "plain text 123");
});

test("esc(): a combined string with every special character, in one pass", () => {
  const input = `<script>alert("x & y's")</script>`;
  assert.equal(esc(input), "&lt;script&gt;alert(&quot;x &amp; y&#39;s&quot;)&lt;/script&gt;");
});

test("esc(): coerces non-string input the same way String() does", () => {
  assert.equal(esc(42), "42");
  assert.equal(esc(null), "null");
});

// --- Body builders (finding 5's ruling: no `force` on per-row actions) ----

test("buildRotateBody: exactly { session }, no force key at all", () => {
  const body = buildRotateBody("s1");
  assert.deepStrictEqual(body, { session: "s1" });
  assert.deepStrictEqual(Object.keys(body), ["session"]);
});

test("buildSwitchBody: exactly { session, to }, no force/continue key", () => {
  const body = buildSwitchBody("s1", "gmail");
  assert.deepStrictEqual(body, { session: "s1", to: "gmail" });
  assert.deepStrictEqual(Object.keys(body).sort(), ["session", "to"]);
});

test("buildStopBody: exactly { session }", () => {
  const body = buildStopBody("s1");
  assert.deepStrictEqual(body, { session: "s1" });
  assert.deepStrictEqual(Object.keys(body), ["session"]);
});

test("buildSwitchAllBody: the ONLY builder that carries force, both ways", () => {
  assert.deepStrictEqual(buildSwitchAllBody("gmail", true), { to: "gmail", force: true });
  assert.deepStrictEqual(buildSwitchAllBody("gmail", false), { to: "gmail", force: false });
});

// --- Poll state machine (finding 6) -----------------------------------------

test("nextPollState: a success always resets to { failures: 0, stopped: false }, even from a stopped state", () => {
  assert.deepStrictEqual(nextPollState({ failures: 0, stopped: false }, true), { failures: 0, stopped: false });
  assert.deepStrictEqual(nextPollState({ failures: 6, stopped: true }, true), { failures: 0, stopped: false });
});

test("nextPollState: failures count up and stop exactly at MAX_POLL_FAILURES, not one before or after", () => {
  assert.equal(MAX_POLL_FAILURES, 6);
  let state: PollState = { failures: 0, stopped: false };
  for (let i = 1; i < MAX_POLL_FAILURES; i++) {
    state = nextPollState(state, false);
    assert.deepStrictEqual(state, { failures: i, stopped: false }, `after ${i} failures`);
  }
  state = nextPollState(state, false);
  assert.deepStrictEqual(state, { failures: MAX_POLL_FAILURES, stopped: true }, "did not stop at the Nth failure");
});

test("nextPollState: never overshoots — a further failure past the limit stays stopped, failures keeps counting", () => {
  const stopped = nextPollState({ failures: MAX_POLL_FAILURES, stopped: true }, false);
  assert.deepStrictEqual(stopped, { failures: MAX_POLL_FAILURES + 1, stopped: true });
});

test("pollStateOnVisible: a non-stopped state is returned unchanged (finding 4's immediate re-poll on visible needs no retry-budget reset)", () => {
  const running: PollState = { failures: 2, stopped: false };
  assert.deepStrictEqual(pollStateOnVisible(running), running);
});

test("pollStateOnVisible: a stopped state gets exactly one retry armed — one more failure re-stops it, a success clears it", () => {
  const armed = pollStateOnVisible({ failures: MAX_POLL_FAILURES, stopped: true });
  assert.deepStrictEqual(armed, { failures: MAX_POLL_FAILURES - 1, stopped: false });

  // One more failure from the armed state re-stops it — a real "one retry",
  // not a quietly restored full budget.
  assert.deepStrictEqual(nextPollState(armed, false), { failures: MAX_POLL_FAILURES, stopped: true });

  // A success from the armed state resumes normal polling.
  assert.deepStrictEqual(nextPollState(armed, true), { failures: 0, stopped: false });
});

// --- .toString() embeddability (page.ts's entire mechanism depends on this) -

test("every embedded function serializes to a self-contained named function declaration (no closures over outer scope)", () => {
  for (const fn of [esc, buildRotateBody, buildSwitchBody, buildStopBody, buildSwitchAllBody, nextPollState, pollStateOnVisible]) {
    const src = fn.toString();
    assert.match(src, /^function\s+\w+\s*\(/, `${fn.name} did not serialize as a named function declaration: ${src}`);
  }
});
