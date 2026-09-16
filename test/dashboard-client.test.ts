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
  worryAttr,
  fmtPercent,
  localTime,
  earliestWeeklyReset,
  chosenAccount,
  accountRowHtml,
  sessionRowHtml,
  formatSwitchAll,
  fleetCandidateIds,
  MAX_POLL_FAILURES,
  type PollState,
  type SessionRowView,
  type AccountRowView,
} from "../src/dashboard/client-logic.ts";
import * as clientLogic from "../src/dashboard/client-logic.ts";
import { EMBEDDED_FUNCTION_NAMES } from "../src/dashboard/page.ts";

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
  const fns = Object.values(clientLogic as Record<string, unknown>).filter((v) => typeof v === "function") as { name: string; toString(): string }[];
  assert.ok(fns.length >= 15, `client-logic.ts exports only ${fns.length} functions`);
  for (const fn of fns) {
    const src = fn.toString();
    assert.match(src, /^function\s+\w+\s*\(/, `${fn.name} did not serialize as a named function declaration: ${src}`);
  }
});

// --- page.ts embeds ALL of them -------------------------------------------
//
// The row builders below call each other (`sessionRowHtml` → `chosenAccount`,
// `worryAttr`, `localTime`, `esc`), and those calls resolve in the page's own
// script scope — so a helper page.ts forgot to embed would be a ReferenceError
// in the browser and nothing else. This is the rule that makes that
// impossible: client-logic.ts holds exactly the page's client functions, and
// page.ts embeds every one of them.

test("page.ts embeds every function client-logic.ts exports — a helper can never be left behind", () => {
  const exported = Object.entries(clientLogic as Record<string, unknown>)
    .filter(([, v]) => typeof v === "function")
    .map(([name]) => name)
    .sort();
  assert.deepStrictEqual([...EMBEDDED_FUNCTION_NAMES].sort(), exported);
});

// --- Finding C3: what a fleet move came to --------------------------------

const MOVE_JSON = {
  code: 1,
  message: null,
  results: [
    { session: "s1", code: 0, message: "switched → home" },
    { session: "s2", code: 1, message: "s2 is mid-turn; moving it now would kill that turn (use --force)" },
    { session: "s3", code: 0, message: "switched → home" },
  ],
};

test("formatSwitchAll: names every session and ends with the CLI's own summary — never 'HTTP 200'", () => {
  const text = formatSwitchAll(200, MOVE_JSON);
  assert.deepStrictEqual(text.split("\n"), [
    "s1 moved",
    "s2 refused: s2 is mid-turn; moving it now would kill that turn (use --force)",
    "s3 moved",
    "moved 2, refused 1",
  ]);
  assert.ok(!text.includes("HTTP"), text);
});

test("formatSwitchAll: a move where everything worked still says so, and counts it", () => {
  const text = formatSwitchAll(200, { code: 0, message: null, results: [{ session: "s1", code: 0, message: "switched → home" }] });
  assert.deepStrictEqual(text.split("\n"), ["s1 moved", "moved 1, refused 0"]);
});

test("formatSwitchAll: a destination with no answer is its own message, with no summary under it", () => {
  // `switchAll` returns `message` non-null ONLY when nothing was started.
  assert.equal(formatSwitchAll(200, { code: 1, message: "no such account 'nobody'", results: [] }), "no such account 'nobody'");
  assert.equal(
    formatSwitchAll(200, { code: 1, message: "'home' names a claude and a codex account; --all cannot tell which fleet you mean", results: [] }),
    "'home' names a claude and a codex account; --all cannot tell which fleet you mean",
  );
});

test("formatSwitchAll: a fleet already where it was asked to be reads as a move of nothing, not as an error", () => {
  assert.equal(formatSwitchAll(200, { code: 0, message: null, results: [] }), "moved 0, refused 0");
});

test("formatSwitchAll: a transport or server failure shows its own error, and an unreadable answer falls back to the status", () => {
  assert.equal(formatSwitchAll(500, { error: "the store could not be opened" }), "the store could not be opened");
  assert.equal(formatSwitchAll(0, { error: "TypeError: Failed to fetch" }), "TypeError: Failed to fetch");
  assert.equal(formatSwitchAll(502, null), "HTTP 502");
  assert.equal(formatSwitchAll(200, {}), "HTTP 200");
});

// --- rereview-C.md defect 3: which rows a fleet move disables --------------
//
// `moveBusy` (the "Go" button's own flag) never reached the per-row controls
// — a click there mid-move queued a second, redundant handoff. The page's
// `applyBusy()` now also busies every id `fleetCandidateIds` names, for as
// long as the move is in flight.

const FLEET_ROWS: SessionRowView[] = [
  { id: "s1", pane: "%1", provider: "claude", account: "away", need: "any", state: "running", generation: 1, pending: null, wakeupAt: null, walled: "" },
  { id: "s2", pane: "%2", provider: "claude", account: "away", need: "any", state: "running", generation: 1, pending: null, wakeupAt: null, walled: "" },
  { id: "s3", pane: "%3", provider: "claude", account: "home", need: "any", state: "running", generation: 1, pending: null, wakeupAt: null, walled: "" },
  { id: "s4", pane: "%4", provider: "codex", account: "away", need: "any", state: "running", generation: 1, pending: null, wakeupAt: null, walled: "" },
];

test("fleetCandidateIds: same provider, not already on the destination — the same two rules switchAll itself candidates on", () => {
  assert.deepStrictEqual(fleetCandidateIds(FLEET_ROWS, "claude", "home"), ["s1", "s2"]);
});

test("fleetCandidateIds: a session already on the destination is never a candidate", () => {
  assert.deepStrictEqual(fleetCandidateIds(FLEET_ROWS, "claude", "away"), ["s3"]);
});

test("fleetCandidateIds: a different provider's sessions are never candidates, whatever the destination", () => {
  const only = fleetCandidateIds(FLEET_ROWS, "codex", "cdx");
  assert.deepStrictEqual(only, ["s4"]);
  assert.ok(!only.includes("s1") && !only.includes("s2") && !only.includes("s3"));
});

test("fleetCandidateIds: no sessions is no candidates, not a throw", () => {
  assert.deepStrictEqual(fleetCandidateIds([], "claude", "home"), []);
});

// --- Finding C5: a row's chosen account survives the 5s re-render ----------

test("chosenAccount: a remembered choice is kept; one no longer offered falls back to the first, as a fresh select would", () => {
  assert.equal(chosenAccount(["dirk", "work", "gmail"], "gmail"), "gmail");
  assert.equal(chosenAccount(["dirk", "work", "gmail"], ""), "dirk");
  assert.equal(chosenAccount(["dirk", "work", "gmail"], "gone"), "dirk");
  assert.equal(chosenAccount([], "gmail"), "");
});

test("finding C5: a selection made before a re-render is what the POST body carries", () => {
  const options = ["dirk", "work", "gmail"];
  // The human picks the third option and the page records it…
  const remembered = "gmail";
  // …then a poll rebuilds the whole tbody. The new row marks it `selected`,
  // so the select's value — and the body built from it — is still theirs.
  const rerendered = sessionRowHtml(
    { id: "s1", pane: "%7", provider: "claude", account: "dirk", need: "any", state: "running", generation: 2, pending: null, wakeupAt: null, walled: "" },
    options,
    remembered,
    null,
    "—",
  );
  assert.ok(rerendered.includes('<option value="gmail" selected>gmail</option>'), rerendered);
  assert.ok(!rerendered.includes('<option value="dirk" selected>'), "the first option was selected over the human's choice");
  assert.deepStrictEqual(buildSwitchBody("s1", chosenAccount(options, remembered)), { session: "s1", to: "gmail" });
});

// --- Parked from Task 2: the rows themselves ------------------------------

const SESSION: SessionRowView = {
  id: "s1",
  pane: "%7",
  provider: "claude",
  account: "dirk",
  need: "fable",
  state: "walled",
  generation: 3,
  pending: "owned",
  wakeupAt: null,
  walled: "unreported",
};

test("sessionRowHtml: PENDING and WALLED? are rendered as statusJson() gives them, and a null pending is the dash", () => {
  const html = sessionRowHtml(SESSION, [], "", null, "—");
  assert.ok(html.includes("<td>owned</td>"), html);
  assert.ok(html.includes('<td class="worry">unreported</td>'), html);
  assert.ok(html.includes('<td class="worry">walled</td>'), html);
  assert.ok(html.includes("<td>fable</td>"));
  assert.ok(html.includes("<td>3</td>"));

  const quiet = sessionRowHtml({ ...SESSION, state: "running", pending: null, walled: "" }, [], "", null, "—");
  assert.ok(quiet.includes("<td>—</td>"), `a null pending must read as the dash: ${quiet}`);
  assert.ok(!quiet.includes('class="worry"'), `a healthy row is all ink: ${quiet}`);
});

test("sessionRowHtml: a session with nowhere to go gets no Switch control at all, and a wake-up is a local time", () => {
  assert.ok(!sessionRowHtml(SESSION, [], "", null, "—").includes("data-switch-select"));
  assert.ok(sessionRowHtml(SESSION, ["gmail"], "", null, "—").includes("data-switch-select"));

  const at = Math.floor(new Date(2026, 8, 16, 7, 5).getTime() / 1000);
  assert.ok(sessionRowHtml({ ...SESSION, wakeupAt: at }, [], "", null, "—").includes("<td>2026-09-16 07:05</td>"));
});

test("sessionRowHtml: every interpolation is escaped, including the row message and the account options", () => {
  const nasty = '<img src=x onerror="alert(1)">';
  const html = sessionRowHtml({ ...SESSION, account: nasty }, [nasty], nasty, { text: nasty, error: true }, "—");
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;img"), html);
  assert.ok(html.includes('<span class="rowmsg error">'));
});

const ACCOUNT: AccountRowView = {
  name: "dirk",
  label: "Dirk",
  state: "no-token",
  provider: "claude",
  usage: {
    session: { usedPercent: 12.25, resetsAt: null },
    weeklyAll: { usedPercent: 30, resetsAt: new Date(2026, 8, 20, 9, 0).toISOString() },
    weeklyFable: null,
  },
};

test("accountRowHtml: LABEL and STATE are rendered as given, percentages round to one place, a missing window is the dash", () => {
  const html = accountRowHtml(ACCOUNT, "—");
  assert.ok(html.includes("<td>Dirk</td>"), html);
  assert.ok(html.includes("<td>12.3%</td>"), html);
  assert.ok(html.includes("<td>30%</td>"), html);
  assert.ok(html.includes("<td>—</td>"), `the absent fable window must be the dash: ${html}`);
  assert.ok(html.includes("<td>2026-09-20 09:00</td>"), html);
});

test("the worry set: an account nobody can launch or poll is amber, exactly like one that needs re-auth", () => {
  // Parked from Task 2: `no-token`/`no-grant` are as actionable as `auth` and
  // used to render as ordinary ink.
  for (const state of ["auth", "no-token", "no-grant"]) assert.equal(worryAttr(state), ' class="worry"', state);
  for (const state of ["walled", "parked", "unreported"]) assert.equal(worryAttr(state), ' class="worry"', state);
  for (const state of ["ok", "stale", "transient", "running", "launching", "waiting", "reported", ""]) {
    assert.equal(worryAttr(state), "", `${state} should be ink`);
  }
  assert.ok(accountRowHtml(ACCOUNT, "—").includes('<td class="worry">no-token</td>'));
});

test("fmtPercent / localTime / earliestWeeklyReset: the small readings the tables are built from", () => {
  assert.equal(fmtPercent({ usedPercent: 0, resetsAt: null }, "—"), "0%");
  assert.equal(fmtPercent({ usedPercent: 99.94, resetsAt: null }, "—"), "99.9%");
  assert.equal(fmtPercent(null, "—"), "—");
  assert.equal(fmtPercent(undefined, "—"), "—");
  assert.equal(fmtPercent({ usedPercent: null, resetsAt: null }, "—"), "—");

  assert.equal(localTime(new Date(2026, 0, 2, 3, 4).getTime()), "2026-01-02 03:04");

  const early = new Date(2026, 8, 18, 1, 0).toISOString();
  const late = new Date(2026, 8, 25, 1, 0).toISOString();
  assert.equal(earliestWeeklyReset({ weeklyAll: { usedPercent: 1, resetsAt: late }, weeklyFable: { usedPercent: 1, resetsAt: early } }), early);
  assert.equal(earliestWeeklyReset({ weeklyAll: null, weeklyFable: null }), null);
  assert.equal(earliestWeeklyReset(null), null);
});

// --- The served page, actually run ----------------------------------------
//
// Parked from Task 2: "page render of label/pending/walled untested". The
// pure builders above are tested directly, but the page's own inline script —
// the `.toString()` embedding, the wiring, the initial `tick()` — was never
// executed by anything. This runs the EXACT script `renderDashboardPage()`
// serves, in a `vm` context with the smallest DOM that script touches, over a
// fixture `/api/state` response, and reads what it wrote into the tables.

/** Every element the page's script asks for, remembered by the selector or
 *  id it asked with — enough for the script's own render path and nothing
 *  more (no parsing, no layout, no events). */
function fakeDom(state: unknown): { context: Record<string, unknown>; el: (key: string) => { innerHTML: string; textContent: string } } {
  const els = new Map<string, Record<string, unknown>>();
  const el = (key: string): Record<string, unknown> => {
    let e = els.get(key);
    if (!e) {
      e = {
        innerHTML: "",
        textContent: "",
        className: "",
        value: "",
        disabled: false,
        addEventListener: () => undefined,
        querySelector: () => null,
        querySelectorAll: () => [],
        getAttribute: () => null,
      };
      els.set(key, e);
    }
    return e;
  };
  const document = {
    getElementById: (id: string) => el("#" + id),
    querySelector: (sel: string) => el(sel),
    querySelectorAll: () => [] as unknown[],
    addEventListener: () => undefined,
    visibilityState: "visible",
  };
  const context = {
    document,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(state) }),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    console,
  };
  return { context, el: el as unknown as (key: string) => { innerHTML: string; textContent: string } };
}

const FIXTURE_STATE = {
  takenAt: Date.now(),
  accounts: [
    {
      name: "dirk",
      provider: "claude",
      label: "Dirk (shared)",
      state: "no-grant",
      usage: { session: { usedPercent: 41.5, resetsAt: null }, weeklyAll: { usedPercent: 12, resetsAt: null }, weeklyFable: null },
    },
    { name: "gmail", provider: "claude", label: "Gmail", state: "ok", usage: null },
  ],
  sessions: [
    {
      id: "s1",
      pane: "%7",
      provider: "claude",
      account: "dirk",
      need: "any",
      state: "walled",
      generation: 2,
      pending: "owned",
      wakeupAt: null,
      walled: "unreported",
    },
  ],
};

test("the served page's own script renders LABEL, PENDING and WALLED? from a fixture /api/state", async () => {
  const { renderDashboardPage } = await import("../src/dashboard/page.ts");
  const vm = await import("node:vm");
  const html = renderDashboardPage();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

  const { context, el } = fakeDom(FIXTURE_STATE);
  vm.runInNewContext(script, context); // a syntax error here is a page that never ran
  // Let the initial tick()'s fetch chain settle.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  const accounts = el("#accounts-table tbody").innerHTML;
  assert.ok(accounts.includes("Dirk (shared)"), `LABEL never reached the page: ${accounts}`);
  assert.ok(accounts.includes('<td class="worry">no-grant</td>'), `a no-grant account is not amber: ${accounts}`);
  assert.ok(accounts.includes("41.5%"), accounts);
  assert.ok(accounts.includes("<td>Gmail</td>"), accounts);

  const sessions = el("#sessions-table tbody").innerHTML;
  assert.ok(sessions.includes("<td>owned</td>"), `PENDING never reached the page: ${sessions}`);
  assert.ok(sessions.includes('<td class="worry">unreported</td>'), `WALLED? never reached the page: ${sessions}`);
  assert.ok(sessions.includes('<td class="worry">walled</td>'), sessions);
  assert.ok(sessions.includes('data-session="s1"'), sessions);
  // gmail is the only other claude account, so the row offers exactly it.
  assert.ok(sessions.includes('<option value="gmail" selected>gmail</option>'), sessions);

  assert.match(el("#meta").textContent, /^read \d+ s ago$/);
});

test("the served page's own script survives an empty store without throwing", async () => {
  const { renderDashboardPage } = await import("../src/dashboard/page.ts");
  const vm = await import("node:vm");
  const script = renderDashboardPage().match(/<script>([\s\S]*?)<\/script>/)![1]!;

  const { context, el } = fakeDom({ takenAt: Date.now(), accounts: [], sessions: [] });
  vm.runInNewContext(script, context);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  assert.match(el("#accounts-table tbody").innerHTML, /no accounts/);
  assert.match(el("#sessions-table tbody").innerHTML, /no sessions/);
});
