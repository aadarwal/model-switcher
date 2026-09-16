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
// It renders the same two tables `ms status` prints (src/status.ts), reading
// `statusJson()`'s own rows — `{ accounts, sessions, takenAt }` — which,
// since review round 1's finding 1, carry the exact computed words the
// table renders (LABEL, STATE, PENDING, WALLED?), not just the raw
// snapshot/store rows: this file renders them as given, it does not
// re-derive any of them (finding 2 was exactly that — a re-derived STATE
// that skipped the hasToken/no-token check).
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
  worryAttr,
  fmtPercent,
  localTime,
  earliestWeeklyReset,
  chosenAccount,
  accountRowHtml,
  sessionRowHtml,
  formatSwitchAll,
  fleetCandidateIds,
  isFinishedSession,
  visibleSessions,
  finishedToggleText,
  MAX_POLL_FAILURES,
} from "./client-logic.ts";

const DASH = "—"; // matches status.ts's own DASH exactly

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: #090909; color: #f6f5f1;
  font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
}
main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 14px; font-weight: 600; margin: 32px 0 10px; }
.meta { color: #bab8b0; font-size: 12px; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 12px 6px 0; font-size: 12.5px; white-space: nowrap; border-bottom: 1px solid #1c1c1a; }
th { color: #bab8b0; font-weight: 500; }
td.worry { color: #e0b25a; }
.moveall { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: #bab8b0; font-size: 12.5px; margin-bottom: 10px; }
select, button, input[type="checkbox"] { font-family: inherit; }
select, button {
  background: #141412; color: #f6f5f1; border: 1px solid #2a2a26; border-radius: 6px;
  padding: 3px 9px; font-size: 12.5px;
}
button { cursor: pointer; }
button:hover { border-color: #47453f; }
label.force { display: inline-flex; align-items: center; gap: 4px; }
td.actions { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.rowmsg { color: #bab8b0; font-size: 12px; }
.rowmsg.error { color: #e06c5a; }
/* The fleet move's answer is one line per session plus a summary (finding
   C3), so it needs its own block and its newlines honoured — inside the
   flex control it would have been one squashed run of text. */
#moveall-msg { display: block; white-space: pre-line; line-height: 1.5; margin: 0 0 10px; }
.empty { color: #bab8b0; font-style: italic; }
.finished-toggle { font-size: 11px; font-weight: 400; padding: 2px 8px; margin-left: 8px; vertical-align: middle; color: #bab8b0; }
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
  worryAttr,
  fmtPercent,
  localTime,
  earliestWeeklyReset,
  chosenAccount,
  accountRowHtml,
  sessionRowHtml,
  formatSwitchAll,
  fleetCandidateIds,
  isFinishedSession,
  visibleSessions,
  finishedToggleText,
];

/** The names the page's own script depends on being present, verbatim, in
 *  whatever ships. The served page is checked against this list by
 *  test/dashboard-server.test.ts, and the BUILT bundle by
 *  `scripts/check-dist.mjs` (which esbuild would happily rename `esc` to
 *  `esc2` behind, silently, if a second top-level `esc` ever appeared). */
export const EMBEDDED_FUNCTION_NAMES = EMBEDDED.map((fn) => fn.name);

const EMBEDDED_FUNCTIONS = EMBEDDED.map((fn) => fn.toString()).join("\n\n");

// Kept as one string so the whole client is visible in one place, the way
// the page's own tables read as one instrument rather than assembled parts.
// It is plain ES5-ish JS (no build step, no bundler — this ships as-is to
// whatever browser `open` points at) and touches the DOM directly.
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
  // computeAccount()) — rendered as given, never re-derived here.
  function renderAccounts(accounts) {
    var tbody = document.querySelector("#accounts-table tbody");
    if (!accounts.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">no accounts</td></tr>'; return; }
    tbody.innerHTML = accounts.map(function (a) { return accountRowHtml(a, DASH); }).join("");
  }

  function otherAccounts(accounts, provider, exclude) {
    var out = [];
    accounts.forEach(function (a) { if (a.provider === provider && a.name !== exclude) out.push(a.name); });
    return out;
  }

  // PENDING and WALLED? are statusJson()'s own computed words too
  // (src/status.ts's computeSession()) — "pending" is null exactly where
  // the text table prints "—".
  //
  // Finding F6: "sessions" here is still the FULL list from /api/state —
  // gone/stopped rows included — so the toggle's own count is always right;
  // only the rows the table actually draws are narrowed by showFinished.
  function renderSessions(sessions, accounts) {
    var visible = visibleSessions(sessions, showFinished);
    var tbody = document.querySelector("#sessions-table tbody");
    if (!visible.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">' + (sessions.length ? "no sessions to show" : "no sessions") + "</td></tr>";
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

  function renderMoveAll(accounts) {
    var providerSel = el("moveall-provider");
    var prev = providerSel.value;
    var providers = uniqueProviders(accounts);
    providerSel.innerHTML = providers.map(function (p) { return '<option value="' + esc(p) + '">' + esc(p) + "</option>"; }).join("");
    if (providers.indexOf(prev) >= 0) providerSel.value = prev;
    refreshMoveAllAccounts();
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

  <section>
    <h2>Accounts</h2>
    <table id="accounts-table">
      <thead><tr><th>NAME</th><th>PROVIDER</th><th>LABEL</th><th>5H</th><th>WEEK</th><th>FABLE</th><th>RESETS</th><th>STATE</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section>
    <h2>Sessions <button id="finished-toggle" class="finished-toggle" style="display:none"></button></h2>
    <div class="moveall">
      <span>Move every</span>
      <select id="moveall-provider"></select>
      <span>pane to</span>
      <select id="moveall-account"></select>
      <label class="force"><input type="checkbox" id="force"> Force (governs "Move every…" only)</label>
      <button id="moveall-go">Go</button>
    </div>
    <div class="rowmsg" id="moveall-msg"></div>
    <table id="sessions-table">
      <thead><tr>
        <th>SESSION</th><th>PANE</th><th>PROVIDER</th><th>ACCOUNT</th><th>NEED</th>
        <th>STATE</th><th>GEN</th><th>PENDING</th><th>WAKEUP</th><th>WALLED?</th><th></th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </section>
</main>
<script>${JS}</script>
</body>
</html>
`;
}
