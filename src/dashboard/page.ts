// src/dashboard/page.ts
//
// The one page `ms dashboard` serves — a template string, inline CSS + inline
// JS, no external assets, no framework (Plan 4, Task 2). It polls
// `/api/state` every 5 s (src/dashboard/api.ts), which is also what keeps
// `ms dashboard` alive: server.ts's idle timer resets on every request the
// poll makes, so an open tab is the thing holding the process open, and
// closing it lets the process exit within `idleMs` (90 s by default —
// review round 1, finding 4). A `visibilitychange` listener re-polls
// immediately when the tab is foregrounded again — a hidden tab's own JS
// timers get throttled by the browser, so the 5 s interval alone can't be
// trusted to keep the server's idle clock fresh while backgrounded.
//
// It renders `statusJson()`'s own rows — `{ accounts, sessions, takenAt }` —
// which, since review round 1's finding 1, carry the exact computed words the
// text table renders (LABEL, STATE, PENDING, WALLED?), not just the raw
// snapshot/store rows: this file renders them as given, it does not
// re-derive any of them (finding 2 was exactly that — a re-derived STATE
// that skipped the hasToken/no-token check).
//
// LOOK (final review, the restyle): the page wears the home dashboard's own
// language — the accounts block at home.aadarwal.com, which Plan 4 Task 2
// named as the reference and then didn't follow. Near-black plane, one
// grotesque at every size, mono reserved for identifiers, quiet gray labels,
// sentence-case titles, and colour that only ever means "how worried should
// you be". Accounts are the reference's `lim-*` panel: a provider group per
// provider, a brand rail naming it, a card per account whose windows are
// meters on one shared scale. Sessions are a ledger in the same grammar. The
// tokens below are copied from the reference's `:root`; the brand colours are
// worn by rails and marks ONLY, never by a bar (Anthropic's coral sits next
// to --status-high, so a brand-coloured bar would read as a severity).
// Nothing here is fetched: no font file, no icon set, no stylesheet, no
// framework — the marks are inline SVG and the chevrons are gradients.
//
// Every POST body and the `esc()` escaper live in ./client-logic.ts as
// plain, closure-free functions — this file imports them and embeds each
// one's own runtime source (`fn.toString()`) into the single inline
// <script> below, so test/dashboard-client.test.ts exercises the EXACT code
// that runs in the browser, with no bundler and no second copy to drift
// out of sync (review round 1, finding 8).

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
  pad2,
  localTime,
  earliestWeeklyReset,
  chosenAccount,
  severityWord,
  providerLabel,
  providerMark,
  resetNote,
  laneHtml,
  accountLanesHtml,
  accountSessionsHtml,
  accountRowHtml,
  accountGroupsHtml,
  providerSegHtml,
  shortSessionId,
  sessionRowHtml,
  formatSwitchAll,
  fleetCandidateIds,
  isFinishedSession,
  visibleSessions,
  finishedToggleText,
  MAX_POLL_FAILURES,
  calendarDayLabel,
  calendarHtml,
} from "./client-logic.ts";

const DASH = "—"; // matches status.ts's own DASH exactly

// The reference's tokens, verbatim (the data repo's app/globals.css `:root`),
// plus the two families. No font is fetched: the stack names Geist and Inter
// in case the machine already has them and falls through to the system
// grotesque, which is what every mac actually renders.
const CSS = `
:root {
  color-scheme: dark;
  --plane: #090909;
  --surface: #131312;
  --surface-2: #1b1b19;
  --ink: #f6f5f1;
  --ink-2: #bab8b0;
  --muted: #898781;
  --grid: #262624;
  --baseline: #36352f;
  --border: rgba(255, 255, 255, 0.075);
  --status-warn: #fab219;
  --status-high: #ec835a;
  --status-critical: #d03b3b;
  /* Worn by rails and marks only — never by a bar. */
  --brand-claude: #d97757;
  --brand-openai: #10a37f;
  --sans: "Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--plane); color: var(--ink);
  font-family: var(--sans); font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 980px; margin: 0 auto; padding: 40px 24px 72px; }

/* ———— Masthead: the title, and the one caption on the page ———— */
h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; }
.meta { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }

/* Sections are named, never captioned. */
.ms-sechead { display: flex; align-items: baseline; margin: 38px 0 12px; }
h2 { margin: 0; font-size: 13px; font-weight: 500; letter-spacing: -0.01em; color: var(--ink); }
.ms-empty { font-size: 12.5px; color: var(--muted); }
.worry { color: var(--status-warn); }

/* ———— The accounts panel ————
   One provider, one rail: the mark says who, the cards under it say how much
   each account has spent. A 2px brand spine runs the whole zone. */
.ms-panel {
  margin-top: 30px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  overflow: hidden;
}
.ms-group { --rail-brand: var(--baseline); box-shadow: inset 2px 0 0 var(--rail-brand); }
.ms-group[data-provider="claude"] { --rail-brand: var(--brand-claude); }
.ms-group[data-provider="codex"] { --rail-brand: var(--brand-openai); }
.ms-rail {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 18px 8px;
  background: color-mix(in srgb, var(--rail-brand) 5%, var(--surface-2));
  border-bottom: 1px solid var(--grid);
}
.ms-group + .ms-group .ms-rail { border-top: 1px solid var(--grid); }
.ms-rail-mark { display: flex; color: var(--rail-brand); }
.ms-rail-name { font-size: 11.5px; font-weight: 500; letter-spacing: 0.015em; color: var(--ink-2); }
.ms-rail-count { margin-left: auto; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ms-group-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ms-acct { padding: 15px 18px 17px; min-width: 0; }
/* Drawn on the left column, so the divider still runs when an odd account
   count leaves the last row half empty. */
.ms-acct:nth-child(odd) { border-right: 1px solid var(--grid); }
.ms-acct:nth-child(n + 3) { border-top: 1px solid var(--grid); }
.ms-acct-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 13px; }
.ms-name {
  margin: 0; font-size: 13px; font-weight: 500; letter-spacing: -0.01em; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ms-meta { margin-left: auto; font-size: 11px; color: var(--muted); white-space: nowrap; }
.ms-chip {
  flex: none;
  font-size: 9.5px; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--ink-2); border: 1px solid var(--baseline); border-radius: 4px;
  padding: 1.5px 5px 1px; white-space: nowrap;
}
.ms-chip.worry { color: var(--status-warn); border-color: color-mix(in srgb, var(--status-warn) 45%, transparent); }
.ms-acct-head .ms-chip { transform: translateY(-1px); }
.ms-note { padding: 4px 0 2px; font-size: 12.5px; color: var(--muted); }

/* ———— The meter ————
   Two rows, always: label · reset · number on one baseline, then a hairline
   bar, so every lane in the panel is the same height and one scale. */
.ms-lane { padding: 3px 0 11px; }
.ms-lane:last-child { padding-bottom: 2px; }
.ms-lane-top { display: flex; align-items: baseline; gap: 12px; row-gap: 2px; flex-wrap: wrap; margin-bottom: 6px; }
.ms-lane-label { font-size: 12px; color: var(--ink-2); white-space: nowrap; }
.ms-lane-read { margin-left: auto; display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
.ms-lane-note { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ms-lane-value { min-width: 52px; font-size: 12.5px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--ink); text-align: right; }
.ms-lane-value[data-idle] { color: var(--muted); font-weight: 400; }
.ms-track { position: relative; height: 3px; border-radius: 1.5px; background: color-mix(in srgb, var(--grid) 60%, var(--surface)); }
/* The severity palette and nothing else — no brand colour ever reaches a
   fill, whatever provider the card belongs to. */
.ms-fill { position: absolute; inset: 0 auto 0 0; border-radius: 1.5px; background: var(--ink-2); transition: width 0.5s ease; }
.ms-fill[data-severity="idle"] { background: var(--baseline); }
.ms-fill[data-severity="elevated"] { background: var(--status-warn); }
.ms-fill[data-severity="high"] { background: var(--status-high); }
.ms-fill[data-severity="critical"] { background: var(--status-critical); }
@media (prefers-reduced-motion: reduce) { .ms-fill { transition: none; } }

/* ———— The sessions ledger ———— */
.ms-scroll { overflow-x: auto; }
.ms-email, .ms-onacct { font-size: 11.5px; color: var(--muted); margin: 2px 0 0; overflow-wrap: anywhere; }
.ms-onacct { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.ms-ledger { width: 100%; border-collapse: collapse; }
.ms-ledger th {
  text-align: left; font-weight: 400; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); padding: 0 14px 8px 0; white-space: nowrap; border-bottom: 1px solid var(--grid);
}
.ms-ledger td {
  font-size: 12.5px; color: var(--ink-2); padding: 9px 14px 9px 0;
  white-space: nowrap; border-bottom: 1px solid var(--border); vertical-align: middle;
}
.ms-ledger tr:last-child td { border-bottom: 0; }
.ms-ledger td.mono { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.ms-ledger td.num { font-variant-numeric: tabular-nums; }
.ms-ledger td:nth-child(4) { color: var(--ink); }
.ms-sub { margin-left: 6px; font-size: 11px; color: var(--muted); }
.ms-sub .worry { color: var(--status-warn); }

/* Per-row actions: quiet text, the dots drawn between them. */
.ms-ledger td.actions { display: flex; align-items: center; gap: 8px; padding-right: 0; white-space: nowrap; }
.ms-ledger td.actions button {
  appearance: none; background: transparent; border: 0; padding: 0;
  font-family: inherit; font-size: 11.5px; color: var(--muted); cursor: pointer;
}
.ms-ledger td.actions button:hover:not(:disabled) { color: var(--ink); }
.ms-ledger td.actions button:disabled { opacity: 0.4; cursor: default; }

/* Calendar: upcoming limit resets, one quiet row each. The only colour is the link. */
.ms-calday { margin: 14px 0 4px; font-size: 11.5px; font-weight: 500; color: var(--muted); letter-spacing: 0.02em; }
.ms-calday:first-child { margin-top: 0; }
.ms-cal { list-style: none; margin: 0; padding: 0; }
.ms-cal li { display: grid; grid-template-columns: 52px minmax(120px, 1.4fr) minmax(90px, 1fr) 84px auto; gap: 12px; align-items: baseline;
  padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.ms-cal li:last-child { border-bottom: 0; }
.ms-caltime, .ms-calpct { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ms-calwho { color: var(--ink); overflow-wrap: anywhere; }
.ms-calprov, .ms-calwin { color: var(--muted); }
.ms-callink, .ms-calfeed { color: var(--muted); text-decoration: none; border-bottom: 1px solid var(--baseline); white-space: nowrap; }
.ms-calfeed { margin-left: 10px; }
.ms-callink:hover, .ms-calfeed:hover, .ms-callink:focus-visible, .ms-calfeed:focus-visible { color: var(--ink); border-bottom-color: var(--ink); }
.ms-calempty { font-size: 12.5px; color: var(--muted); padding: 6px 0; }
@media (max-width: 640px) { .ms-cal li { grid-template-columns: 52px 1fr; } .ms-calpct, .ms-calwin { grid-column: 2; } .ms-callink { grid-column: 2; justify-self: start; } }
.ms-ledger td.actions button:not(:first-child)::before { content: "·"; margin-right: 8px; color: var(--baseline); }
select {
  appearance: none; font-family: inherit; font-size: 11.5px; color: var(--ink);
  background-color: transparent; border: 0; border-bottom: 1px solid var(--grid);
  padding: 1px 13px 1px 2px; cursor: pointer;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--muted) 50%),
    linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 6px) calc(50% - 1px), calc(100% - 3px) calc(50% - 1px);
  background-size: 3px 3px, 3px 3px;
  background-repeat: no-repeat;
}
select:disabled { opacity: 0.4; cursor: default; }
select option { background: var(--surface); color: var(--ink); }
.rowmsg { font-size: 11.5px; color: var(--muted); }
.rowmsg.error { color: var(--status-high); }

/* ———— Move every pane: one quiet control row under the ledger ———— */
.ms-move { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 18px; font-size: 12px; color: var(--muted); }
#moveall-provider { display: none; }
.ms-seg { display: inline-flex; gap: 2px; padding: 2px; background: var(--surface-2); border-radius: 7px; }
.ms-seg button {
  appearance: none; border: 0; background: transparent; color: var(--muted);
  font-family: inherit; font-size: 10.5px; font-weight: 500; letter-spacing: 0.09em; text-transform: uppercase;
  padding: 4px 11px; border-radius: 5px; cursor: pointer; white-space: nowrap;
}
.ms-seg button:hover { color: var(--ink-2); }
.ms-seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--ink) 13%, var(--surface-2)); color: var(--ink); }
.ms-force { display: inline-flex; align-items: center; gap: 5px; }
#moveall-go {
  appearance: none; background: var(--surface-2); border: 1px solid var(--grid); border-radius: 6px;
  color: var(--ink); font-family: inherit; font-size: 11.5px; padding: 4px 13px; cursor: pointer;
}
#moveall-go:hover:not(:disabled) { border-color: var(--baseline); }
#moveall-go:disabled { opacity: 0.45; cursor: default; }
/* The fleet move's answer is one line per session plus a summary (finding
   C3), so it needs its own block and its newlines honoured — inside the
   flex control it would have been one squashed run of text. */
#moveall-msg { display: block; white-space: pre-line; line-height: 1.6; margin-top: 10px; }
.finished-toggle {
  appearance: none; background: transparent; border: 0; padding: 0; margin-left: 10px;
  font-family: inherit; font-size: 11px; color: var(--muted); cursor: pointer;
}
.finished-toggle:hover { color: var(--ink-2); }

/* ———— Phone: the cards stack, the gutter is 16, the page never scrolls
   sideways (the ledger scrolls inside its own frame instead). ———— */
@media (max-width: 1100px) {
  .ms-group-grid { grid-template-columns: 1fr; }
  .ms-acct:nth-child(odd) { border-right: 0; }
  .ms-acct:nth-child(n + 2) { border-top: 1px solid var(--grid); }
}
@media (max-width: 720px) {
  main { padding: 28px 16px 56px; }
  .ms-rail { padding: 9px 14px 8px; }
  .ms-acct { padding: 14px 14px 16px; }
  .ms-panel { margin-top: 24px; }
  .ms-move { gap: 8px; }
}
`;

// Every function in this list is imported from ./client-logic.ts, so its
// `.toString()` here is the exact compiled body test/dashboard-client.test.ts
// already exercises under Node — never a hand-copied duplicate. Each is a
// closure-free named `function` declaration, so re-emitting its source as a
// statement in the page's own script scope defines the same callable name.
const EMBEDDED = [
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
  pad2,
  localTime,
  earliestWeeklyReset,
  chosenAccount,
  severityWord,
  providerLabel,
  providerMark,
  resetNote,
  laneHtml,
  accountLanesHtml,
  accountSessionsHtml,
  accountRowHtml,
  accountGroupsHtml,
  providerSegHtml,
  shortSessionId,
  sessionRowHtml,
  formatSwitchAll,
  fleetCandidateIds,
  isFinishedSession,
  visibleSessions,
  finishedToggleText,
  calendarDayLabel,
  calendarHtml,
];

/** The names the page's own script depends on being present, verbatim, in
 *  whatever ships. The served page is checked against this list by
 *  test/dashboard-server.test.ts, and the BUILT bundle by
 *  `scripts/check-dist.mjs` (which esbuild would happily rename `esc` to
 *  `esc2` behind, silently, if a second top-level `esc` ever appeared). */
export const EMBEDDED_FUNCTION_NAMES = EMBEDDED.map((fn) => fn.name);

const EMBEDDED_FUNCTIONS = EMBEDDED.map((fn) => fn.toString()).join("\n\n");

// Kept as one string so the whole client is visible in one place, the way
// the page's own panel and ledger read as one instrument rather than
// assembled parts. It is plain ES5-ish JS (no build step, no bundler — this
// ships as-is to whatever browser `open` points at) and touches the DOM
// directly.
const JS = `
(function () {
  "use strict";

${EMBEDDED_FUNCTIONS}

  var POLL_MS = 5000;
  var MSG_MS = 10000;
  var DASH = ${JSON.stringify(DASH)};
  var MAX_POLL_FAILURES = ${MAX_POLL_FAILURES};

  var rowMessages = Object.create(null);
  // Finding C5: which account each row's "Switch to" select is showing,
  // kept across the 5s re-render by session id — a fresh <select> shows its
  // first option, so without this a human who picked the third account and
  // read the row for six seconds sent a move to whichever sorted first.
  var rowChoice = Object.create(null);
  // Finding C6's page half: a session whose verb is still in flight from this
  // tab. Its buttons are disabled until the answer lands, so the second click
  // that used to be a second handoff cannot be made.
  var busySessions = Object.create(null);
  var moveMsg = null;
  var moveBusy = false;
  // rereview-C.md defect 3: every candidate id fleetCandidateIds() named
  // when the current fleet move started — set alongside moveBusy, cleared
  // alongside it. Without this, moveBusy only ever disabled the "Go" button
  // itself, and a click on a per-row button for one of these sessions
  // queued a second, redundant handoff for the whole --all budget.
  var moveBusyIds = [];
  var lastTakenAt = null;
  var currentAccounts = [];
  var currentSessions = [];
  // Finding F6: gone/stopped sessions are hidden by default, over the SAME
  // /api/state json — the toggle just flips what renderSessions() draws.
  var showFinished = false;
  var pollState = { failures: 0, stopped: false };
  var pollTimer = null;

  function el(id) { return document.getElementById(id); }

  // LABEL and STATE are statusJson()'s own computed words (src/status.ts's
  // computeAccount()) — rendered as given, never re-derived here. The panel
  // itself (groups, rails, cards, meters) is accountGroupsHtml().
  function renderAccounts(accounts) {
    el("accounts").innerHTML = accountGroupsHtml(accounts, DASH);
  }

  function otherAccounts(accounts, provider, exclude) {
    var out = [];
    accounts.forEach(function (a) { if (a.provider === provider && a.name !== exclude) out.push(a.name); });
    return out;
  }

  // PENDING, STATE and the WALLED? reading are statusJson()'s own computed
  // words too (src/status.ts's computeSession()) — "pending" is null exactly
  // where the text table prints "—".
  //
  // Finding F6: "sessions" here is still the FULL list from /api/state —
  // gone/stopped rows included — so the toggle's own count is always right;
  // only the rows the table actually draws are narrowed by showFinished.
  function renderSessions(sessions, accounts) {
    var visible = visibleSessions(sessions, showFinished);
    var tbody = document.querySelector("#sessions-table tbody");
    if (!visible.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="ms-empty">' + (sessions.length ? "no sessions to show" : "no sessions") + "</td></tr>";
    } else {
      tbody.innerHTML = visible.map(function (s) {
        var m = rowMessages[s.id];
        var msg = (m && m.expiresAt > Date.now()) ? { text: m.text, error: m.error } : null;
        var others = otherAccounts(accounts, s.provider, s.account);
        return sessionRowHtml(s, others, rowChoice[s.id] || "", msg, DASH);
      }).join("");
    }
    renderFinishedToggle(sessions);
    applyBusy();
  }

  function renderFinishedToggle(sessions) {
    var btn = el("finished-toggle");
    var text = finishedToggleText(sessions, showFinished);
    btn.textContent = text;
    btn.style.display = text ? "" : "none";
  }

  // One place decides what a row's controls may do, so a re-render mid-verb
  // cannot quietly hand the buttons back.
  function applyBusy() {
    var cells = document.querySelectorAll("#sessions-table td[data-session]");
    Array.prototype.forEach.call(cells, function (cell) {
      var id = cell.getAttribute("data-session");
      var busy = !!busySessions[id] || moveBusyIds.indexOf(id) >= 0;
      Array.prototype.forEach.call(cell.querySelectorAll("button, select"), function (c) { c.disabled = busy; });
    });
    el("moveall-go").disabled = moveBusy;
  }

  function uniqueProviders(accounts) {
    var seen = {}, out = [];
    accounts.forEach(function (a) { if (!seen[a.provider]) { seen[a.provider] = 1; out.push(a.provider); } });
    return out;
  }

  function refreshMoveAllAccounts() {
    var acctSel = el("moveall-account");
    var provider = el("moveall-provider").value;
    var prev = acctSel.value;
    var list = currentAccounts.filter(function (a) { return a.provider === provider; });
    acctSel.innerHTML = list.map(function (a) { return '<option value="' + esc(a.name) + '">' + esc(a.name) + "</option>"; }).join("");
    if (list.some(function (a) { return a.name === prev; })) acctSel.value = prev;
  }

  // The segmented pill is the visible provider control; the <select> it
  // writes through to is still the one buildSwitchAllBody() reads, so the
  // control changed shape and the request did not.
  function renderSeg() {
    el("moveall-seg").innerHTML = providerSegHtml(uniqueProviders(currentAccounts), el("moveall-provider").value);
  }

  function renderMoveAll(accounts) {
    var providerSel = el("moveall-provider");
    var prev = providerSel.value;
    var providers = uniqueProviders(accounts);
    providerSel.innerHTML = providers.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + "</option>"; }).join("");
    if (providers.indexOf(prev) >= 0) providerSel.value = prev;
    refreshMoveAllAccounts();
    renderSeg();
    renderMoveMsg();
  }

  function renderMoveMsg() {
    var span = el("moveall-msg");

    if (moveMsg && moveMsg.expiresAt > Date.now()) {
      span.textContent = moveMsg.text;
      span.className = "rowmsg" + (moveMsg.error ? " error" : "");
    } else {
      span.textContent = "";
      span.className = "rowmsg";
    }
  }

  // While polling has given up (finding 6), the meta line belongs to
  // showStopped() — a 1s tick must not paper over "the dashboard has
  // exited" with "read Ns ago" using a takenAt that is now definitely stale.
  function updateMeta() {
    if (pollState.stopped) return;
    var m = el("meta");
    if (lastTakenAt == null) { m.textContent = "reading…"; return; }
    var secs = Math.max(0, Math.round((Date.now() - lastTakenAt) / 1000));
    m.textContent = "read " + secs + " s ago";
  }

  function showStopped() {
    el("meta").textContent = "the dashboard has exited — run ms dashboard again";
  }

  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (json) { return { status: r.status, json: json }; }); })
      .catch(function (e) { return { status: 0, json: { error: String(e) } }; });
  }

  function resultText(r) {
    if (r.json && typeof r.json.message === "string") return r.json.message;
    if (r.json && typeof r.json.error === "string") return r.json.error;
    return "HTTP " + r.status;
  }
  function resultIsError(r) {
    if (r.status === 0 || r.status >= 400) return true;
    return !!(r.json && typeof r.json.code === "number" && r.json.code !== 0);
  }

  function setRowMessage(id, r) {
    rowMessages[id] = { text: resultText(r), error: resultIsError(r), expiresAt: Date.now() + MSG_MS };
    renderSessions(currentSessions, currentAccounts);
  }

  // The Force checkbox governs ONLY the move-all control (review round 1,
  // finding 5's ruling) — per-row Rotate/Switch never read it, so a busy
  // session's own mid-turn guard can't be bypassed from a checkbox that
  // visually sits next to a completely different button. See
  // buildRotateBody()/buildSwitchBody() above: neither one even accepts a
  // force argument, so there is no way to build a body that sends one.
  function forceChecked() { return el("force").checked; }

  // Finding C5: the human's own choice, recorded the moment they make it, so
  // the next poll's re-render puts it back rather than resetting the row.
  document.querySelector("#sessions-table tbody").addEventListener("change", function (e) {
    var sel = e.target;
    if (!sel || !sel.matches || !sel.matches("select[data-switch-select]")) return;
    var cell = sel.closest("td[data-session]");
    if (cell) rowChoice[cell.getAttribute("data-session")] = sel.value;
  });

  document.querySelector("#sessions-table tbody").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-act]") : null;
    if (!btn) return;
    var cell = btn.closest("td[data-session]");
    if (!cell) return;
    var id = cell.getAttribute("data-session");
    if (busySessions[id]) return; // finding C6: one move at a time, per session
    var act = btn.getAttribute("data-act");
    var sent = null;
    if (act === "rotate") {
      sent = post("/api/rotate", buildRotateBody(id));
    } else if (act === "stop") {
      sent = post("/api/stop", buildStopBody(id));
    } else if (act === "switch") {
      var sel = cell.querySelector("select[data-switch-select]");
      var to = sel ? sel.value : "";
      if (!to) return;
      rowChoice[id] = to;
      sent = post("/api/switch", buildSwitchBody(id, to));
    }
    if (!sent) return;
    busySessions[id] = 1;
    applyBusy();
    sent.then(function (r) {
      delete busySessions[id];
      setRowMessage(id, r); // re-renders, and applyBusy() with it
    });
  });

  el("finished-toggle").addEventListener("click", function () {
    showFinished = !showFinished;
    renderSessions(currentSessions, currentAccounts);
  });

  el("moveall-seg").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-provider]") : null;
    if (!btn) return;
    el("moveall-provider").value = btn.getAttribute("data-provider");
    refreshMoveAllAccounts();
    renderSeg();
  });
  el("moveall-provider").addEventListener("change", refreshMoveAllAccounts);
  el("moveall-go").addEventListener("click", function () {
    var to = el("moveall-account").value;
    if (!to || moveBusy) return;
    var provider = el("moveall-provider").value;
    moveBusy = true;
    // rereview-C.md defect 3: every row this move can touch is busy too,
    // from the moment the request goes out — not just the "Go" button.
    moveBusyIds = fleetCandidateIds(currentSessions, provider, to);
    applyBusy();
    post("/api/switch-all", buildSwitchAllBody(to, forceChecked(), provider)).then(function (r) {
      moveBusy = false;
      moveBusyIds = [];
      applyBusy();
      // Finding C3: one line per session and the same summary the CLI
      // prints — never "HTTP 200", which is all this used to say whether
      // three moved or three were refused.
      moveMsg = { text: formatSwitchAll(r.status, r.json), error: resultIsError(r), expiresAt: Date.now() + MSG_MS };
      renderMoveMsg();
    });
  });

  function scheduleNext() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, POLL_MS);
  }

  // Finding 6: polling used to run forever on a plain setInterval, so a
  // dashboard left open against a server that had exited kept trying every
  // 5s with no sign anything was wrong. After MAX_POLL_FAILURES consecutive
  // failures the interval stops outright; a later visibilitychange (finding
  // 4) gets exactly one more try via pollStateOnVisible(), not a silently
  // restored full retry budget.
  // The calendar rides on the state poll but is its own request: a failure here
  // leaves the last good calendar on screen and never stops the accounts poll.
  function refreshCalendar() {
    fetch("/api/calendar").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      el("calendar").innerHTML = calendarHtml(data.events || [], DASH);
    }).catch(function () { /* keep what is shown */ });
  }

  function tick() {
    fetch("/api/state").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (data) {
      pollState = nextPollState(pollState, true);
      currentAccounts = data.accounts || [];
      currentSessions = data.sessions || [];
      lastTakenAt = data.takenAt;
      renderAccounts(currentAccounts);
      renderSessions(currentSessions, currentAccounts);
      renderMoveAll(currentAccounts);
      updateMeta();
      refreshCalendar();
      scheduleNext();
    }).catch(function (e) {
      pollState = nextPollState(pollState, false);
      if (pollState.stopped) {
        showStopped();
        return; // no scheduleNext(): the interval stops until a retry
      }
      el("meta").textContent = "could not read state: " + e;
      scheduleNext();
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    pollState = pollStateOnVisible(pollState);
    tick();
  });

  tick();
  setInterval(updateMeta, 1000);
})();
`;

export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>model-switcher</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <h1>model-switcher</h1>
  <div class="meta" id="meta">reading…</div>

  <div id="accounts"></div>

  <section>
    <div class="ms-sechead">
      <h2>Sessions</h2>
      <button id="finished-toggle" class="finished-toggle" style="display:none"></button>
    </div>
    <div class="ms-scroll">
      <table class="ms-ledger" id="sessions-table">
        <thead><tr>
          <th>Session</th><th>Pane</th><th>Provider</th><th>Account</th><th>Need</th>
          <th>State</th><th>Gen</th><th>Pending</th><th>Wakeup</th><th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="ms-move">
      <span>Move every</span>
      <span class="ms-seg" id="moveall-seg"></span>
      <select id="moveall-provider"></select>
      <span>pane to</span>
      <select id="moveall-account"></select>
      <label class="ms-force"><input type="checkbox" id="force"> Force (governs "Move every…" only)</label>
      <button id="moveall-go">Go</button>
    </div>
    <div class="rowmsg" id="moveall-msg"></div>
  </section>

  <section>
    <div class="ms-sechead">
      <h2>Calendar</h2>
      <a class="ms-calfeed" href="/calendar.ics" download="model-switcher-resets.ics">Download .ics</a>
    </div>
    <div id="calendar"><div class="ms-calempty">reading…</div></div>
  </section>
</main>
<script>${JS}</script>
</body>
</html>
`;
}
