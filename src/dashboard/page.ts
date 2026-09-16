// src/dashboard/page.ts
//
// The one page `ms dashboard` serves — a template string, inline CSS + inline
// JS, no external assets, no framework (Plan 4, Task 2). It polls
// `/api/state` every 5 s (src/dashboard/api.ts), which is also what keeps
// `ms dashboard` alive: server.ts's idle timer resets on every request the
// poll makes, so an open tab is the thing holding the process open, and
// closing it lets the process exit within `idleMs`.
//
// It renders the same two tables `ms status` prints (src/status.ts), reading
// the RAW rows `statusJson()` returns — `{ accounts, sessions, takenAt }` —
// not that file's own pre-rendered strings. Three columns `ms status` itself
// computes from data the JSON API does not carry are approximated rather than
// invented:
//   * accounts LABEL — the registry's label never crosses the API (the API
//     has no registry access of its own); this renders the account name.
//   * sessions PENDING and WALLED? — both need a live tmux capture and the
//     event log (src/status.ts's `sessionRow`/`sessionWalled`), which
//     `statusJson()` does not serialize. Both render "—".
// Nothing here ever renders a token or credential — the API it reads never
// carries one (src/dashboard/api.ts's own header comment).

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

// Kept as one string so the whole client is visible in one place, the way
// the page's own tables read as one instrument rather than assembled parts.
// It is plain ES5-ish JS (no build step, no bundler — this ships as-is to
// whatever browser `open` points at) and touches the DOM directly.
const JS = `
(function () {
  "use strict";
  var POLL_MS = 5000;
  var MSG_MS = 10000;
  var DASH = ${JSON.stringify(DASH)};
  var WORRY = { walled: 1, parked: 1, auth: 1, unreported: 1 };

  var rowMessages = Object.create(null);
  var moveMsg = null;
  var lastTakenAt = null;
  var currentAccounts = [];
  var currentSessions = [];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[c];
    });
  }

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

  var NO_GRANT_RE = /no poll grant|credentials missing|no credentials/i;

  function accountState(a) {
    if (a.errorKind === "auth") return NO_GRANT_RE.test(a.error || "") ? "no-grant" : "auth";
    if (a.errorKind === "transient" || a.errorKind === "other") return "transient";
    if (a.stale) return "stale";
    return "ok";
  }

  function el(id) { return document.getElementById(id); }

  function renderAccounts(accounts) {
    var tbody = document.querySelector("#accounts-table tbody");
    if (!accounts.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">no accounts</td></tr>'; return; }
    tbody.innerHTML = accounts.map(function (a) {
      var st = accountState(a);
      var reset = earliestWeeklyReset(a.usage);
      var u = a.usage || {};
      return "<tr>" +
        "<td>" + esc(a.name) + "</td>" +
        "<td>" + esc(a.name) + "</td>" +
        "<td>" + fmtPercent(u.session) + "</td>" +
        "<td>" + fmtPercent(u.weeklyAll) + "</td>" +
        "<td>" + fmtPercent(u.weeklyFable) + "</td>" +
        "<td>" + (reset ? localTime(Date.parse(reset)) : DASH) + "</td>" +
        "<td" + worryAttr(st) + ">" + esc(st) + "</td>" +
        "</tr>";
    }).join("");
  }

  function otherAccounts(accounts, provider, exclude) {
    return accounts.filter(function (a) { return a.provider === provider && a.name !== exclude; });
  }

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
      return "<tr>" +
        "<td>" + esc(s.id) + "</td>" +
        "<td>" + esc(s.pane || DASH) + "</td>" +
        "<td>" + esc(s.provider) + "</td>" +
        "<td>" + esc(s.account) + "</td>" +
        "<td>" + esc(s.need) + "</td>" +
        "<td" + worryAttr(s.state) + ">" + esc(s.state) + "</td>" +
        "<td>" + esc(String(s.generation)) + "</td>" +
        "<td>" + DASH + "</td>" +
        "<td>" + wakeup + "</td>" +
        "<td>" + DASH + "</td>" +
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

  function updateMeta() {
    var m = el("meta");
    if (lastTakenAt == null) { m.textContent = "reading…"; return; }
    var secs = Math.max(0, Math.round((Date.now() - lastTakenAt) / 1000));
    m.textContent = "read " + secs + " s ago";
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

  function forceChecked() { return el("force").checked; }

  document.querySelector("#sessions-table tbody").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("button[data-act]") : null;
    if (!btn) return;
    var cell = btn.closest("td[data-session]");
    if (!cell) return;
    var id = cell.getAttribute("data-session");
    var act = btn.getAttribute("data-act");
    if (act === "rotate") {
      post("/api/rotate", { session: id, force: forceChecked() }).then(function (r) { setRowMessage(id, r); });
    } else if (act === "stop") {
      post("/api/stop", { session: id }).then(function (r) { setRowMessage(id, r); });
    } else if (act === "switch") {
      var sel = cell.querySelector("select[data-switch-select]");
      var to = sel ? sel.value : "";
      if (!to) return;
      post("/api/switch", { session: id, to: to, force: forceChecked() }).then(function (r) { setRowMessage(id, r); });
    }
  });

  el("moveall-provider").addEventListener("change", refreshMoveAllAccounts);
  el("moveall-go").addEventListener("click", function () {
    var to = el("moveall-account").value;
    if (!to) return;
    post("/api/switch-all", { to: to, force: forceChecked() }).then(function (r) {
      moveMsg = { text: resultText(r), error: resultIsError(r), expiresAt: Date.now() + MSG_MS };
      renderMoveMsg();
    });
  });

  function tick() {
    fetch("/api/state").then(function (r) { return r.json(); }).then(function (data) {
      currentAccounts = data.accounts || [];
      currentSessions = data.sessions || [];
      lastTakenAt = data.takenAt;
      renderAccounts(currentAccounts);
      renderSessions(currentSessions, currentAccounts);
      renderMoveAll(currentAccounts);
      updateMeta();
    }).catch(function (e) {
      el("meta").textContent = "could not read state: " + e;
    });
  }

  tick();
  setInterval(tick, POLL_MS);
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
      <label class="force"><input type="checkbox" id="force"> Force</label>
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
