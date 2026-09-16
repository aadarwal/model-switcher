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

import { esc, buildRotateBody, buildSwitchBody, buildStopBody, buildSwitchAllBody, nextPollState, pollStateOnVisible, MAX_POLL_FAILURES } from "./client-logic.ts";

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
.empty { color: #bab8b0; font-style: italic; }
`;

// Every function in this list is imported from ./client-logic.ts, so its
// `.toString()` here is the exact compiled body test/dashboard-client.test.ts
// already exercises under Node — never a hand-copied duplicate. Each is a
// closure-free named `function` declaration, so re-emitting its source as a
// statement in the page's own script scope defines the same callable name.
const EMBEDDED_FUNCTIONS = [esc, buildRotateBody, buildSwitchBody, buildStopBody, buildSwitchAllBody, nextPollState, pollStateOnVisible]
  .map((fn) => fn.toString())
  .join("\n\n");

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
  // Amber-worry cells: session STATE ("walled"/"parked"), account STATE
  // ("auth"), session WALLED? ("unreported"). Everything else stays ink.
  var WORRY = { walled: 1, parked: 1, auth: 1, unreported: 1 };

  var rowMessages = Object.create(null);
  var moveMsg = null;
  var lastTakenAt = null;
  var currentAccounts = [];
  var currentSessions = [];
  var pollState = { failures: 0, stopped: false };
  var pollTimer = null;

  function worryAttr(v) { return WORRY[v] ? ' class="worry"' : ""; }

  function fmtPercent(w) {
    if (!w || typeof w.usedPercent !== "number" || !isFinite(w.usedPercent)) return DASH;
    var v = Math.round(w.usedPercent * 10) / 10;
    return (Math.floor(v) === v ? String(v) : v.toFixed(1)) + "%";
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function localTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function earliestWeeklyReset(u) {
    if (!u) return null;
    var c = [];
    if (u.weeklyAll && u.weeklyAll.resetsAt) c.push(u.weeklyAll.resetsAt);
    if (u.weeklyFable && u.weeklyFable.resetsAt) c.push(u.weeklyFable.resetsAt);
    if (!c.length) return null;
    return c.reduce(function (a, b) { return Date.parse(a) <= Date.parse(b) ? a : b; });
  }

  function el(id) { return document.getElementById(id); }

  // LABEL and STATE are statusJson()'s own computed words (src/status.ts's
  // computeAccount()) — rendered as given, never re-derived here.
  function renderAccounts(accounts) {
    var tbody = document.querySelector("#accounts-table tbody");
    if (!accounts.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">no accounts</td></tr>'; return; }
    tbody.innerHTML = accounts.map(function (a) {
      var reset = earliestWeeklyReset(a.usage);
      var u = a.usage || {};
      return "<tr>" +
        "<td>" + esc(a.name) + "</td>" +
        "<td>" + esc(a.label) + "</td>" +
        "<td>" + fmtPercent(u.session) + "</td>" +
        "<td>" + fmtPercent(u.weeklyAll) + "</td>" +
        "<td>" + fmtPercent(u.weeklyFable) + "</td>" +
        "<td>" + (reset ? localTime(Date.parse(reset)) : DASH) + "</td>" +
        "<td" + worryAttr(a.state) + ">" + esc(a.state) + "</td>" +
        "</tr>";
    }).join("");
  }

  function otherAccounts(accounts, provider, exclude) {
    return accounts.filter(function (a) { return a.provider === provider && a.name !== exclude; });
  }

  // PENDING and WALLED? are statusJson()'s own computed words too
  // (src/status.ts's computeSession()) — "pending" is null exactly where
  // the text table prints "—".
  function renderSessions(sessions, accounts) {
    var tbody = document.querySelector("#sessions-table tbody");
    if (!sessions.length) { tbody.innerHTML = '<tr><td colspan="11" class="empty">no sessions</td></tr>'; return; }
    tbody.innerHTML = sessions.map(function (s) {
      var msg = rowMessages[s.id];
      var msgHtml = (msg && msg.expiresAt > Date.now())
        ? '<span class="rowmsg' + (msg.error ? " error" : "") + '">' + esc(msg.text) + "</span>"
        : "";
      var others = otherAccounts(accounts, s.provider, s.account);
      var options = others.map(function (a) { return '<option value="' + esc(a.name) + '">' + esc(a.name) + "</option>"; }).join("");
      var switchCell = others.length
        ? '<select data-switch-select>' + options + '</select><button data-act="switch">Go</button>'
        : "";
      var wakeup = s.wakeupAt != null ? localTime(s.wakeupAt * 1000) : DASH;
      var pending = s.pending == null ? DASH : esc(s.pending);
      return "<tr>" +
        "<td>" + esc(s.id) + "</td>" +
        "<td>" + esc(s.pane || DASH) + "</td>" +
        "<td>" + esc(s.provider) + "</td>" +
        "<td>" + esc(s.account) + "</td>" +
        "<td>" + esc(s.need) + "</td>" +
        "<td" + worryAttr(s.state) + ">" + esc(s.state) + "</td>" +
        "<td>" + esc(String(s.generation)) + "</td>" +
        "<td>" + pending + "</td>" +
        "<td>" + wakeup + "</td>" +
        "<td" + worryAttr(s.walled) + ">" + esc(s.walled || DASH) + "</td>" +
        '<td class="actions" data-session="' + esc(s.id) + '">' +
          '<button data-act="rotate">Rotate</button>' +
          switchCell +
          '<button data-act="stop">Stop</button>' +
          msgHtml +
        "</td>" +
        "</tr>";
    }).join("");
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

  document.querySelector("#sessions-table tbody").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-act]") : null;
    if (!btn) return;
    var cell = btn.closest("td[data-session]");
    if (!cell) return;
    var id = cell.getAttribute("data-session");
    var act = btn.getAttribute("data-act");
    if (act === "rotate") {
      post("/api/rotate", buildRotateBody(id)).then(function (r) { setRowMessage(id, r); });
    } else if (act === "stop") {
      post("/api/stop", buildStopBody(id)).then(function (r) { setRowMessage(id, r); });
    } else if (act === "switch") {
      var sel = cell.querySelector("select[data-switch-select]");
      var to = sel ? sel.value : "";
      if (!to) return;
      post("/api/switch", buildSwitchBody(id, to)).then(function (r) { setRowMessage(id, r); });
    }
  });

  el("moveall-provider").addEventListener("change", refreshMoveAllAccounts);
  el("moveall-go").addEventListener("click", function () {
    var to = el("moveall-account").value;
    if (!to) return;
    post("/api/switch-all", buildSwitchAllBody(to, forceChecked())).then(function (r) {
      moveMsg = { text: resultText(r), error: resultIsError(r), expiresAt: Date.now() + MSG_MS };
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
      <thead><tr><th>NAME</th><th>LABEL</th><th>5H</th><th>WEEK</th><th>FABLE</th><th>RESETS</th><th>STATE</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section>
    <h2>Sessions</h2>
    <div class="moveall">
      <span>Move every</span>
      <select id="moveall-provider"></select>
      <span>pane to</span>
      <select id="moveall-account"></select>
      <label class="force"><input type="checkbox" id="force"> Force (governs "Move every…" only)</label>
      <button id="moveall-go">Go</button>
      <span class="rowmsg" id="moveall-msg"></span>
    </div>
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
