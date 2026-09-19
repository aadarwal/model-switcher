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
  isWorry,
  worryAttr,
  chipClass,
  fmtPercent,
  localTime,
  earliestWeeklyReset,
  chosenAccount,
  severityWord,
  providerMark,
  resetNote,
  accountRowHtml,
  accountGroupsHtml,
  providerSegHtml,
  sessionRowHtml,
  formatSwitchAll,
  fleetCandidateIds,
  isFinishedSession,
  visibleSessions,
  finishedToggleText,
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

test("buildSwitchAllBody: the ONLY builder that carries force, both ways, plus the provider the page has selected", () => {
  assert.deepStrictEqual(buildSwitchAllBody("gmail", true, "claude"), { to: "gmail", force: true, provider: "claude" });
  assert.deepStrictEqual(buildSwitchAllBody("gmail", false, "codex"), { to: "gmail", force: false, provider: "codex" });
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

test("no embedded function depends on a compiler-inserted helper — the page's script scope has none", () => {
  // The other half of "self-contained", and the one nothing caught: esbuild
  // (tsx here, scripts/build.mjs in the bundle) rewrites a NAMED function
  // expression assigned to a variable — `var pad = function (n) { … }` —
  // into `var pad = __name(function (n) { … }, "pad")`, a call to a helper it
  // defines ONCE at module scope. `fn.toString()` re-emits the call; the
  // page's own <script> has no `__name`; the function throws
  // `ReferenceError: __name is not defined` the first time a browser runs it.
  // `localTime` shipped exactly that from Task 2 until the restyle — every
  // account row with a weekly reset, every session with a wake-up. A helper
  // the compiler inserted is a closure over module scope like any other, and
  // nothing embedded may have one.
  const fns = Object.values(clientLogic as Record<string, unknown>).filter((v) => typeof v === "function") as { name: string; toString(): string }[];
  for (const fn of fns) {
    const helper = fn.toString().match(/\b__[A-Za-z_$][\w$]*/);
    assert.equal(helper, null, `${fn.name} calls the compiler helper ${helper?.[0]}, which does not exist in the page's script scope`);
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

test("sessionRowHtml: PENDING and the WALLED? reading are rendered as statusJson() gives them, and a null pending is the dash", () => {
  const html = sessionRowHtml(SESSION, [], "", null, "—");
  assert.ok(html.includes("<td>owned</td>"), html);
  // WALLED? no longer has a column: it rides in the STATE cell, under the
  // state's own chip, and keeps its own worry colour.
  assert.ok(html.includes('<small class="ms-sub"><span class="worry">unreported</span></small>'), html);
  assert.ok(html.includes('<span class="ms-chip worry">walled</span>'), html);
  assert.ok(html.includes("<td>fable</td>"));
  assert.ok(html.includes('<td class="num">3</td>'));

  const quiet = sessionRowHtml({ ...SESSION, state: "running", pending: null, walled: "" }, [], "", null, "—");
  assert.ok(quiet.includes("<td>—</td>"), `a null pending must read as the dash: ${quiet}`);
  assert.ok(quiet.includes('<td class="ms-state">running</td>'), `a quiet state wears no chip: ${quiet}`);
  assert.ok(!quiet.includes("worry"), `a healthy row is all ink: ${quiet}`);
});

test("sessionRowHtml: the id is short and mono, with the whole id kept in the cell's title and the row's own data-session", () => {
  const uuid = "9f1c2d3e-aaaa-bbbb-cccc-0123456789ab";
  const html = sessionRowHtml({ ...SESSION, id: uuid }, [], "", null, "—");
  assert.ok(html.includes(`<td class="mono" title="${uuid}">9f1c2d3e</td>`), html);
  assert.ok(html.includes(`data-session="${uuid}"`), html);
  assert.ok(html.includes('<td class="mono">%7</td>'), `the pane id is mono too: ${html}`);
});

test("sessionRowHtml: a session with nowhere to go gets no Switch control at all, and a wake-up is a local time", () => {
  assert.ok(!sessionRowHtml(SESSION, [], "", null, "—").includes("data-switch-select"));
  assert.ok(sessionRowHtml(SESSION, ["gmail"], "", null, "—").includes("data-switch-select"));
  assert.ok(sessionRowHtml(SESSION, ["gmail"], "", null, "—").includes('<button data-act="switch">Switch to</button>'));

  const at = Math.floor(new Date(2026, 8, 16, 7, 5).getTime() / 1000);
  assert.ok(sessionRowHtml({ ...SESSION, wakeupAt: at }, [], "", null, "—").includes('<td class="num">2026-09-16 07:05</td>'));
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

test("accountRowHtml: a card — the name, the LABEL when it says something the name doesn't, the STATE as a chip", () => {
  const html = accountRowHtml(ACCOUNT, "—");
  assert.ok(html.startsWith('<section class="ms-acct">'), html);
  assert.ok(html.includes('<h3 class="ms-name">dirk</h3>'), html);
  assert.ok(html.includes('<span class="ms-meta">Dirk</span>'), html);
  assert.ok(html.includes('<span class="ms-chip worry">no-token</span>'), html);

  // A label that only repeats the name is not a second fact; it is silence.
  const same = accountRowHtml({ ...ACCOUNT, label: "dirk" }, "—");
  assert.ok(!same.includes("ms-meta"), `a label equal to the name must not be printed twice: ${same}`);
  // An `ok` account carries no chip at all — a panel where every card is
  // chipped says nothing with a chip.
  const fine = accountRowHtml({ ...ACCOUNT, state: "ok" }, "—");
  assert.ok(!fine.includes("ms-chip"), fine);
  // …and a state that is merely old wears the pill in ink, not amber.
  assert.ok(accountRowHtml({ ...ACCOUNT, state: "stale" }, "—").includes('<span class="ms-chip">stale</span>'));
});

test("accountRowHtml: one lane per window the account reports, percentages round to one place, a missing window is absent — never a dash lane", () => {
  const html = accountRowHtml(ACCOUNT, "—");
  assert.ok(html.includes(">Session · 5h</span>"), html);
  assert.ok(html.includes(">Week · all models</span>"), html);
  assert.ok(!html.includes("Week · Fable"), `the absent fable window must not draw a lane: ${html}`);
  assert.ok(!html.includes("—"), `a lane never reads as a dash: ${html}`);
  assert.ok(html.includes(">12.3%</span>"), html);
  assert.ok(html.includes(">30%</span>"), html);
  // Each lane carries its own reset, in local time.
  assert.ok(html.includes('<span class="ms-lane-note">resets Sun 09:00</span>'), html);
  // A window with no reset says nothing rather than guessing one: the 5h
  // window here has `resetsAt: null`.
  assert.equal(html.match(/ms-lane-note/g)!.length, 1, html);
  // The fill is the severity palette only; a brand colour on a bar would
  // read as a severity.
  assert.ok(html.includes('data-severity="normal"'), html);
  assert.ok(!html.includes("brand"), html);
});

test("accountRowHtml: an account with no readable window says so, rather than drawing meters of nothing", () => {
  assert.ok(accountRowHtml({ ...ACCOUNT, usage: null }, "—").includes('<div class="ms-note">no windows reported</div>'));
  assert.ok(accountRowHtml({ ...ACCOUNT, usage: { session: { usedPercent: null } } }, "—").includes("no windows reported"));
});

test("the worry set: an account nobody can launch or poll is amber, exactly like one that needs re-auth", () => {
  // Parked from Task 2: `no-token`/`no-grant` are as actionable as `auth` and
  // used to render as ordinary ink.
  for (const state of ["auth", "no-token", "no-grant"]) assert.equal(worryAttr(state), ' class="worry"', state);
  for (const state of ["walled", "parked", "unreported"]) assert.equal(worryAttr(state), ' class="worry"', state);
  for (const state of ["ok", "stale", "transient", "running", "launching", "waiting", "reported", ""]) {
    assert.equal(worryAttr(state), "", `${state} should be ink`);
  }
  assert.ok(accountRowHtml(ACCOUNT, "—").includes('<span class="ms-chip worry">no-token</span>'));
  // `chipClass` is the same rule in the form a chip can wear: the pill is
  // structure, the colour is worry.
  assert.equal(chipClass("walled"), "ms-chip worry");
  assert.equal(chipClass("stale"), "ms-chip");
  assert.equal(isWorry("no-grant"), true);
  assert.equal(isWorry("ok"), false);
});

// --- The panel the accounts block is (the home dashboard's own shape) ------

const PANEL_ACCOUNTS: AccountRowView[] = [
  {
    name: "dirk",
    provider: "claude",
    label: "Dirk (shared)",
    state: "ok",
    usage: {
      session: { usedPercent: 97, resetsAt: null },
      weeklyAll: { usedPercent: 88, resetsAt: null },
      weeklyFable: { usedPercent: 71, resetsAt: null },
    },
  },
  { name: "gmail", provider: "claude", label: "Gmail", state: "no-token", usage: { session: { usedPercent: 0, resetsAt: null } } },
  // A Codex account reporting only its weekly window — the Pro case.
  { name: "tulp", provider: "codex", label: "Tulp", state: "ok", usage: { weeklyAll: { usedPercent: 40, resetsAt: null } } },
];

test("accountGroupsHtml: one group per provider present in the JSON, each behind its own rail, each card with its own lanes", () => {
  const html = accountGroupsHtml(PANEL_ACCOUNTS, "—");
  assert.equal(html.match(/class="ms-group"/g)!.length, 2, html);
  assert.ok(html.includes('data-provider="claude"'), html);
  assert.ok(html.includes('data-provider="codex"'), html);
  // The rail names the provider in brand casing and counts what is under it,
  // saying "used" once so no lane has to repeat the unit.
  assert.ok(html.includes('<span class="ms-rail-name">Claude</span>'), html);
  assert.ok(html.includes('<span class="ms-rail-count">2 accounts · used</span>'), html);
  assert.ok(html.includes('<span class="ms-rail-name">Codex</span>'), html);
  assert.ok(html.includes('<span class="ms-rail-count">1 account · used</span>'), html);
  // A card per account, in the JSON's own order.
  assert.equal(html.match(/class="ms-acct"/g)!.length, 3, html);
  assert.ok(html.indexOf("dirk") < html.indexOf("gmail"), html);

  // Claude's Fable lane exists only where Claude reports it; the Codex
  // account shows the one window it carries and no other — never a dash lane.
  assert.equal(html.match(/<span class="ms-lane-label">Week · Fable<\/span>/g)!.length, 1, html);
  assert.equal(html.match(/<span class="ms-lane-label">Session · 5h<\/span>/g)!.length, 2, html);
  const codex = html.slice(html.indexOf('data-provider="codex"'));
  assert.ok(codex.includes("Week · all models"), codex);
  assert.ok(!codex.includes("Session · 5h"), `a window the Codex JSON never carried was invented: ${codex}`);
  assert.ok(!codex.includes("—"), codex);
});

test("accountGroupsHtml: the fill takes the severity palette at the reference's own thresholds, and no brand colour ever reaches a bar", () => {
  const html = accountGroupsHtml(PANEL_ACCOUNTS, "—");
  assert.ok(html.includes('data-severity="critical" style="width:97%"'), html); // >= 95
  assert.ok(html.includes('data-severity="high" style="width:88%"'), html); // >= 85
  assert.ok(html.includes('data-severity="elevated" style="width:71%"'), html); // >= 70
  assert.ok(html.includes('data-severity="normal" style="width:40%"'), html);
  assert.ok(html.includes('data-severity="idle" style="width:0%"'), html); // untouched
  assert.equal(severityWord(95), "critical");
  assert.equal(severityWord(94.9), "high");
  assert.equal(severityWord(85), "high");
  assert.equal(severityWord(84.9), "elevated");
  assert.equal(severityWord(70), "elevated");
  assert.equal(severityWord(69.9), "normal");
  assert.equal(severityWord(0), "normal");

  // The brand colours are worn by the rails and the marks, never by a fill:
  // Anthropic's coral sits next to --status-high, so a brand-coloured bar
  // would read as a severity. No fill carries a colour of its own at all —
  // the palette is chosen by `data-severity`, in CSS.
  for (const fill of html.match(/<span class="ms-fill"[^>]*>/g)!) {
    assert.ok(!/brand|#|rgb|var\(/.test(fill), `a fill carried a colour of its own: ${fill}`);
    assert.match(fill, /data-severity="(idle|normal|elevated|high|critical)"/);
  }
});

test("accountGroupsHtml: a walled-class account state is a chip in the worry class, and an empty pool is a quiet line, not an empty panel", () => {
  const html = accountGroupsHtml(PANEL_ACCOUNTS, "—");
  assert.ok(html.includes('<span class="ms-chip worry">no-token</span>'), html);
  assert.equal(html.match(/ms-chip/g)!.length, 1, `only the account that needs a human wears a chip: ${html}`);
  assert.equal(accountGroupsHtml([], "—"), '<div class="ms-empty">no accounts</div>');
});

test("providerMark: an inline SVG per provider — no external asset, and the colour comes from the rail", () => {
  assert.match(providerMark("claude"), /^<svg /);
  assert.match(providerMark("codex"), /^<svg /);
  assert.ok(providerMark("claude").includes('fill="currentColor"'));
  assert.notEqual(providerMark("claude"), providerMark("codex"));
  assert.equal(providerMark("nobody"), "");
  for (const p of ["claude", "codex"]) {
    assert.ok(!/https?:|url\(|<script/.test(providerMark(p)), `the mark reaches outside the page: ${p}`);
  }
});

test("resetNote: the weekday and the local clock, and silence for a window that never said", () => {
  assert.equal(resetNote(new Date(2026, 8, 15, 20, 0).toISOString()), "resets Tue 20:00");
  assert.equal(resetNote(new Date(2026, 8, 20, 9, 5).toISOString()), "resets Sun 09:05");
  assert.equal(resetNote(null), "");
  assert.equal(resetNote(undefined), "");
  assert.equal(resetNote("not a date"), "");
});

test("providerSegHtml: one pressed segment, in brand casing, over whichever providers the pool has", () => {
  const html = providerSegHtml(["claude", "codex"], "codex");
  assert.ok(html.includes('<button type="button" data-provider="claude" aria-pressed="false">Claude</button>'), html);
  assert.ok(html.includes('<button type="button" data-provider="codex" aria-pressed="true">Codex</button>'), html);
  assert.equal(html.match(/aria-pressed="true"/g)!.length, 1, html);
  assert.equal(providerSegHtml([], ""), "");
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
 *  id it asked with — enough for the script's own render path and, since the
 *  fleet-move wiring review, its click handlers too.
 *
 *  Two behaviours are modelled rather than stubbed flat, because the page's
 *  own correctness depends on them: `addEventListener` really remembers its
 *  handlers (so `fire()` can deliver a click the way a browser would), and
 *  setting a select's `innerHTML` re-reads its options and lands `value` on
 *  the first one unless the old value is still offered — exactly what a real
 *  `<select>` does, and what the move-all control's provider/account pair
 *  relies on. Everything else is the same flat stub: no parsing, no layout. */
type FakeEl = {
  innerHTML: string;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  style: { display: string };
  addEventListener: (type: string, fn: (e: unknown) => void) => void;
  handlers: Map<string, ((e: unknown) => void)[]>;
};
type FetchCall = { url: string; init?: { method?: string; body?: string } };

function fakeDom(state: unknown): {
  context: Record<string, unknown>;
  el: (key: string) => FakeEl;
  fire: (key: string, type: string, event?: unknown) => void;
  calls: FetchCall[];
} {
  const els = new Map<string, Record<string, unknown>>();
  const el = (key: string): Record<string, unknown> => {
    let e = els.get(key);
    if (!e) {
      const handlers = new Map<string, ((ev: unknown) => void)[]>();
      let html = "";
      let value = "";
      e = {
        textContent: "",
        className: "",
        checked: false,
        disabled: false,
        style: {},
        handlers,
        addEventListener: (type: string, fn: (ev: unknown) => void) => {
          handlers.set(type, [...(handlers.get(type) ?? []), fn]);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        getAttribute: () => null,
      };
      Object.defineProperty(e, "innerHTML", {
        enumerable: true,
        get: () => html,
        set: (v: string) => {
          html = String(v);
          const options = [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]!);
          if (options.length) {
            // A real <select> lands on the first option unless the one it
            // was showing is still offered.
            if (!options.includes(value)) value = options[0]!;
          } else if (html === "") {
            value = "";
          }
        },
      });
      Object.defineProperty(e, "value", {
        enumerable: true,
        get: () => value,
        set: (v: string) => {
          value = String(v);
        },
      });
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
  const calls: FetchCall[] = [];
  const context = {
    document,
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(state) });
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    console,
  };
  const fire = (key: string, type: string, event?: unknown): void => {
    const handlers = (el(key) as unknown as FakeEl).handlers.get(type) ?? [];
    for (const fn of handlers) fn(event ?? {});
  };
  return { context, el: el as unknown as (key: string) => FakeEl, fire, calls };
}

/** A click's `event.target`, shaped the way the page's delegated handlers
 *  read it: `closest(selector)` answers with the element itself when it
 *  matches, and attributes come back as given. */
function clickTarget(selector: string, attrs: Record<string, string>): unknown {
  const target: Record<string, unknown> = {
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (sel: string) => (sel === selector ? target : null),
    querySelector: () => null,
  };
  return { target };
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
    { name: "tulp", provider: "codex", label: "Tulp", state: "ok", usage: null },
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

  const accounts = el("#accounts").innerHTML;
  assert.ok(accounts.includes("Dirk (shared)"), `LABEL never reached the page: ${accounts}`);
  assert.ok(accounts.includes('<span class="ms-chip worry">no-grant</span>'), `a no-grant account is not amber: ${accounts}`);
  assert.ok(accounts.includes("41.5%"), accounts);
  assert.ok(accounts.includes("Gmail"), accounts);
  // Provider groups: the point of the grouping is telling apart a claude
  // account from a codex one of the same name, so both rails must actually
  // reach the page.
  assert.ok(accounts.includes('data-provider="codex"'), `the codex group never reached the page: ${accounts}`);
  assert.ok(accounts.includes('<span class="ms-rail-name">Codex</span>'), accounts);

  const sessions = el("#sessions-table tbody").innerHTML;
  assert.ok(sessions.includes("<td>owned</td>"), `PENDING never reached the page: ${sessions}`);
  assert.ok(sessions.includes('<span class="worry">unreported</span>'), `the WALLED? reading never reached the page: ${sessions}`);
  assert.ok(sessions.includes('<span class="ms-chip worry">walled</span>'), sessions);
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

  assert.match(el("#accounts").innerHTML, /no accounts/);
  assert.match(el("#sessions-table tbody").innerHTML, /no sessions/);
});

// --- The fleet move's own wiring, driven through the served page ----------
//
// The review of the fleet-move fix found the hole this closes: a reviewer
// mutated the page's "Go" handler to hardcode `provider: "claude"` and every
// test still passed. `buildSwitchAllBody` was tested directly, and the page's
// click wiring — the only place the SELECTED provider is read — was not
// exercised by anything. So this drives the served script itself: it presses
// the codex segment, clicks Go, and reads the body that actually went out.

const TWO_PROVIDER_STATE = {
  takenAt: Date.now(),
  accounts: [
    { name: "dirk", provider: "claude", label: "Dirk", state: "ok", usage: null },
    { name: "gmail", provider: "claude", label: "Gmail", state: "ok", usage: null },
    { name: "tulp", provider: "codex", label: "Tulp", state: "ok", usage: null },
  ],
  sessions: [],
};

async function runPage(state: unknown): Promise<ReturnType<typeof fakeDom>> {
  const { renderDashboardPage } = await import("../src/dashboard/page.ts");
  const vm = await import("node:vm");
  const script = renderDashboardPage().match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const dom = fakeDom(state);
  vm.runInNewContext(script, dom.context);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return dom;
}

function lastSwitchAllBody(calls: FetchCall[]): Record<string, unknown> | null {
  const call = [...calls].reverse().find((c) => c.url === "/api/switch-all");
  return call?.init?.body ? (JSON.parse(call.init.body) as Record<string, unknown>) : null;
}

test("the served page sends the PROVIDER the human actually selected — the segmented pill writes through to the request", async () => {
  const dom = await runPage(TWO_PROVIDER_STATE);

  // The pill is drawn over the providers the pool has, with the current one
  // pressed — claude, the first, until the human says otherwise.
  assert.ok(dom.el("#moveall-seg").innerHTML.includes('data-provider="codex"'), dom.el("#moveall-seg").innerHTML);
  assert.equal(dom.el("#moveall-provider").value, "claude");
  assert.equal(dom.el("#moveall-account").value, "dirk");

  // The human presses "Codex". The account select follows it.
  dom.fire("#moveall-seg", "click", clickTarget("button[data-provider]", { "data-provider": "codex" }));
  assert.equal(dom.el("#moveall-provider").value, "codex");
  assert.equal(dom.el("#moveall-account").value, "tulp", "the account select did not follow the provider");
  assert.ok(dom.el("#moveall-seg").innerHTML.includes('data-provider="codex" aria-pressed="true"'), dom.el("#moveall-seg").innerHTML);

  // …and clicks Go. The body that goes out carries THAT provider — a handler
  // that hardcoded "claude" would pass every other test in this file.
  dom.fire("#moveall-go", "click");
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastSwitchAllBody(dom.calls), { to: "tulp", force: false, provider: "codex" });
});

test("the served page's Go control sends the default provider, and the Force checkbox it reads is its own", async () => {
  const dom = await runPage(TWO_PROVIDER_STATE);

  dom.fire("#moveall-go", "click");
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastSwitchAllBody(dom.calls), { to: "dirk", force: false, provider: "claude" });

  // Review round 1, finding 5's ruling: the checkbox governs this control
  // and nothing else — when it is on, this body carries it.
  dom.el("#force").checked = true;
  dom.fire("#moveall-go", "click");
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastSwitchAllBody(dom.calls), { to: "dirk", force: true, provider: "claude" });
});

// --- Finding F6: gone/stopped sessions hidden by default --------------------
//
// /api/state always carries every session the store has ever recorded — the
// route is unchanged. The page filters client-side, over the SAME rows, on
// the same two words ms status's own --all toggles (gone, stopped).

const FINISHED_ROWS: SessionRowView[] = [
  { id: "s1", pane: "%1", provider: "claude", account: "home", need: "any", state: "running", generation: 1, pending: null, wakeupAt: null, walled: "" },
  { id: "s2", pane: "", provider: "claude", account: "home", need: "any", state: "gone", generation: 1, pending: null, wakeupAt: null, walled: "" },
  { id: "s3", pane: "%3", provider: "codex", account: "cdx", need: "any", state: "stopped", generation: 1, pending: null, wakeupAt: null, walled: "" },
  { id: "s4", pane: "%4", provider: "claude", account: "home", need: "any", state: "walled", generation: 2, pending: null, wakeupAt: null, walled: "unreported" },
];

test("isFinishedSession: gone and stopped are finished, every other state is not", () => {
  assert.equal(isFinishedSession({ ...FINISHED_ROWS[0]!, state: "gone" }), true);
  assert.equal(isFinishedSession({ ...FINISHED_ROWS[0]!, state: "stopped" }), true);
  for (const state of ["running", "walled", "launching", "resuming", "continuing", "parked", "waiting", "stopping"]) {
    assert.equal(isFinishedSession({ ...FINISHED_ROWS[0]!, state }), false, state);
  }
});

test("visibleSessions: hides gone/stopped by default, shows everything when showFinished is true", () => {
  assert.deepStrictEqual(
    visibleSessions(FINISHED_ROWS, false).map((s) => s.id),
    ["s1", "s4"],
  );
  assert.deepStrictEqual(
    visibleSessions(FINISHED_ROWS, true).map((s) => s.id),
    ["s1", "s2", "s3", "s4"],
  );
});

test("visibleSessions: no finished rows at all is a no-op either way", () => {
  const rows = [FINISHED_ROWS[0]!, FINISHED_ROWS[3]!];
  assert.deepStrictEqual(visibleSessions(rows, false), rows);
  assert.deepStrictEqual(visibleSessions(rows, true), rows);
});

test("finishedToggleText: counts the finished rows, says show/hide depending on the current toggle state", () => {
  assert.equal(finishedToggleText(FINISHED_ROWS, false), "show 2 finished");
  assert.equal(finishedToggleText(FINISHED_ROWS, true), "hide 2 finished");
});

test("finishedToggleText: blank — which the page reads as 'hide the control' — when nothing is finished", () => {
  const rows = [FINISHED_ROWS[0]!, FINISHED_ROWS[3]!];
  assert.equal(finishedToggleText(rows, false), "");
  assert.equal(finishedToggleText(rows, true), "");
  assert.equal(finishedToggleText([], false), "");
});

test("the served page's own script hides gone/stopped sessions by default and shows the toggle's own count", async () => {
  const { renderDashboardPage } = await import("../src/dashboard/page.ts");
  const vm = await import("node:vm");
  const script = renderDashboardPage().match(/<script>([\s\S]*?)<\/script>/)![1]!;

  const state = { takenAt: Date.now(), accounts: [], sessions: FINISHED_ROWS };
  const { context, el } = fakeDom(state);
  vm.runInNewContext(script, context);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  const sessions = el("#sessions-table tbody").innerHTML;
  assert.ok(sessions.includes('data-session="s1"'), sessions);
  assert.ok(sessions.includes('data-session="s4"'), sessions);
  assert.ok(!sessions.includes('data-session="s2"'), `a gone session rendered by default: ${sessions}`);
  assert.ok(!sessions.includes('data-session="s3"'), `a stopped session rendered by default: ${sessions}`);

  const toggle = el("#finished-toggle");
  assert.equal(toggle.textContent, "show 2 finished");
  assert.notEqual((toggle as unknown as { style: { display: string } }).style.display, "none", "two finished rows exist; the toggle must not be hidden");
});

test("the served page's own script hides the toggle entirely when nothing is finished", async () => {
  const { renderDashboardPage } = await import("../src/dashboard/page.ts");
  const vm = await import("node:vm");
  const script = renderDashboardPage().match(/<script>([\s\S]*?)<\/script>/)![1]!;

  const state = { takenAt: Date.now(), accounts: [], sessions: [FINISHED_ROWS[0]!, FINISHED_ROWS[3]!] };
  const { context, el } = fakeDom(state);
  vm.runInNewContext(script, context);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  const toggle = el("#finished-toggle");
  assert.equal(toggle.textContent, "");
  assert.equal((toggle as unknown as { style: { display: string } }).style.display, "none");
});

test("the worry set: an account with no room is amber — the page says what ms status says (0.2.5)", () => {
  assert.equal(worryAttr("no room"), ' class="worry"');
  assert.equal(chipClass("no room"), "ms-chip worry");
  assert.equal(isWorry("no room"), true);
  assert.ok(
    accountRowHtml({ ...ACCOUNT, state: "no room" }, "—").includes('<span class="ms-chip worry">no room</span>'),
  );
});

// --- Calendar panel ----------------------------------------------------------

test("calendarHtml: events grouped under local-day headings, each with its Google Calendar link; names are escaped", async () => {
  const { calendarHtml } = await import("../src/dashboard/client-logic.ts");
  const ev = [
    { account: "<work>", provider: "claude", label: "", windows: ["5h"], at: "2026-09-18T15:00:00.000Z", usedPercent: 62, title: "t1", googleUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=a%26b" },
    { account: "mit", provider: "codex", label: "", windows: ["week", "fable"], at: "2026-09-20T09:00:00.000Z", usedPercent: 5, title: "t2", googleUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=x" },
  ];
  const html = calendarHtml(ev, "—");
  assert.equal(html.match(/class="ms-calday"/g)!.length, 2, "two days, two headings");
  assert.ok(html.includes("&lt;work&gt;") && !html.includes("<work>"), "account names are escaped");
  assert.ok(html.includes('href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=a%26b"'), "the link survives as an attribute");
  assert.ok(html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes("week + fable") && html.includes("62%"));
});

test("calendarHtml: nothing upcoming reads as a sentence, never as an empty panel", async () => {
  const { calendarHtml } = await import("../src/dashboard/client-logic.ts");
  assert.match(calendarHtml([], "—"), /No limit resets/);
});
