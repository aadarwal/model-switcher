// src/dashboard/client-logic.ts
//
// Pure logic shared between the dashboard page's inline client script
// (src/dashboard/page.ts) and this project's own tests
// (test/dashboard-client.test.ts) — review round 1 (P4-T2), finding 8: "no
// tests over the page's client JS". Every export here is self-contained —
// no closures over outer scope, nothing DOM-shaped — so `page.ts` can embed
// each function's own runtime source (`fn.toString()`) directly into the
// page's single inline <script> tag: no bundler, no build step, and the
// exact code this file's tests exercise under Node is byte-for-byte what
// runs in the browser.
//
// The four body builders mirror src/dashboard/api.ts's own parsers exactly
// (parseRotateBody/parseSwitchBody/parseStopBody/parseSwitchAllBody). Per
// review round 1's ruling on finding 5 (the Force checkbox), only
// `buildSwitchAllBody` ever carries `force` — a per-row Rotate/Switch must
// never bypass the mid-turn guard through the move-all checkbox, so
// `buildRotateBody`/`buildSwitchBody`/`buildStopBody` don't accept a force
// argument at all; there is no way to build a body that sends one.

/** `&<>"'` only — the five characters that matter inside an HTML attribute
 *  or text node built by string concatenation, which is everything the
 *  page's `innerHTML` interpolations do. */
export function esc(s: unknown): string {
  var map: { [k: string]: string } = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, function (c) {
    return map[c] || c;
  });
}

export function buildRotateBody(session: string): { session: string } {
  return { session: session };
}

export function buildSwitchBody(session: string, to: string): { session: string; to: string } {
  return { session: session, to: to };
}

export function buildStopBody(session: string): { session: string } {
  return { session: session };
}

export function buildSwitchAllBody(to: string, force: boolean, provider: string): { to: string; force: boolean; provider: string } {
  return { to: to, force: force, provider: provider };
}

// --- Poll retry/backoff state machine (finding 6) --------------------------
//
// "Polling never stops" — the page used to `setInterval` forever, so a
// dashboard left open against a server that had exited kept trying every 5s,
// indefinitely, with no sign anything was wrong. `nextPollState` is the pure
// transition (success resets; failure counts up to MAX_POLL_FAILURES, at
// which point polling stops); `pollStateOnVisible` is what a later tab
// foreground does to a stopped state — exactly one more try, not a silent
// resumption of the full retry budget.

export const MAX_POLL_FAILURES = 6;

export type PollState = { failures: number; stopped: boolean };

export function nextPollState(state: PollState, ok: boolean): PollState {
  if (ok) return { failures: 0, stopped: false };
  var failures = state.failures + 1;
  return { failures: failures, stopped: failures >= MAX_POLL_FAILURES };
}

export function pollStateOnVisible(state: PollState): PollState {
  if (!state.stopped) return state;
  // Arm exactly one more attempt: `stopped` clears so the next tick actually
  // runs, and `failures` is primed one short of the limit so a single
  // further failure re-stops it rather than quietly resuming a full budget
  // of retries the human never asked for.
  return { failures: MAX_POLL_FAILURES - 1, stopped: false };
}

// --- The rows themselves (whole-branch review, area C) ----------------------
//
// Parked from Task 2 and now unparked: "page render of label/pending/walled
// untested". The page used to build both tables inline, inside a template
// string, where nothing could reach them — so the one thing review round 1's
// finding 1 was about (LABEL/STATE/PENDING/WALLED? travelling as computed
// words, not re-derived) had no test on the side that renders them. They live
// here now, as pure string builders over `statusJson()`'s own row shapes, and
// page.ts embeds them like every other function in this file.
//
// Each one calls only OTHER functions from this file, which page.ts embeds
// alongside it — test/dashboard-client.test.ts pins that "all of them" is
// what gets embedded, so a helper can never be left behind.

export type UsageWindow = { usedPercent?: number | null; resetsAt?: string | null } | null;
export type AccountRowView = {
  name: string;
  label: string;
  state: string;
  provider?: string;
  usage?: { session?: UsageWindow; weeklyAll?: UsageWindow; weeklyFable?: UsageWindow } | null;
  /** The login behind the name; absent from an older /api/state and until the account is next verified. */
  email?: string | null;
  /** Live sessions on this account (src/status.ts's sessionsByAccount). */
  sessions?: { id: string; pane: string; state: string }[];
};
export type SessionRowView = {
  id: string;
  pane: string;
  provider: string;
  account: string;
  need: string;
  state: string;
  generation: number;
  pending: string | null;
  wakeupAt: number | null;
  walled: string;
};
export type RowMessage = { text: string; error: boolean } | null;

/**
 * The amber cells, and only these: a session STATE that needs a human
 * (`walled`, `parked`), an account STATE that does (`auth`, and — parked from
 * Task 2, added here — `no-token`/`no-grant`, which are exactly as actionable
 * and were reading as ordinary ink), and a WALLED? of `unreported`. Colour is
 * worry only; everything else stays ink, because a table where most cells are
 * coloured says nothing with colour at all.
 *
 * `no room` (0.2.5) joins them: an account the chooser is about to pass over
 * is the one thing a pool panel exists to show, and it used to read `ok`.
 */
export function isWorry(v: unknown): boolean {
  var worry: { [k: string]: number } = { walled: 1, parked: 1, auth: 1, unreported: 1, "no-token": 1, "no-grant": 1, "no room": 1 };
  return !!worry[String(v)];
}

export function worryAttr(v: unknown): string {
  return isWorry(v) ? ' class="worry"' : "";
}

/** A chip's own class list. The pill is structure (every chip is one); the
 *  colour is worry, and only worry — `stale` and `transient` wear the same
 *  pill in ink, because a panel where every chip is amber says nothing with
 *  amber at all. */
export function chipClass(v: unknown): string {
  return isWorry(v) ? "ms-chip worry" : "ms-chip";
}

export function fmtPercent(w: UsageWindow | undefined, dash: string): string {
  if (!w || typeof w.usedPercent !== "number" || !isFinite(w.usedPercent)) return dash;
  var v = Math.round(w.usedPercent * 10) / 10;
  return (Math.floor(v) === v ? String(v) : v.toFixed(1)) + "%";
}

/**
 * Two digits.
 *
 * A top-level function, not the inner `var pad = function …` this used to be,
 * and that is load-bearing: esbuild (tsx, and `scripts/build.mjs`) compiles a
 * NAMED function expression assigned to a variable into
 * `var pad = __name(function (n) { … }, "pad")` — a call to a helper it
 * defines once at module scope. `fn.toString()` faithfully re-emits that
 * call, and the page's script scope has no `__name`, so the embedded function
 * threw `ReferenceError: __name is not defined` the first time it ran in a
 * browser. (Found by loading the real served page: `localTime` had carried
 * this since Task 2, which is every account row with a weekly reset and every
 * session with a wake-up.) Nothing embedded here may close over anything —
 * including a helper a compiler quietly inserted. The test
 * "no embedded function depends on a compiler-inserted helper" is the rule.
 */
export function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function localTime(ms: number): string {
  var d = new Date(ms);
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes())
  );
}

/** The earliest of an account's WEEKLY resets. The RESETS column it used to
 *  feed is gone — every meter now carries its own reset, in its own lane —
 *  but it stays exported and tested: it is part of client-logic's contract,
 *  and the dist guard embeds it by name. */
export function earliestWeeklyReset(u: AccountRowView["usage"]): string | null {
  if (!u) return null;
  var c: string[] = [];
  if (u.weeklyAll && u.weeklyAll.resetsAt) c.push(u.weeklyAll.resetsAt);
  if (u.weeklyFable && u.weeklyFable.resetsAt) c.push(u.weeklyFable.resetsAt);
  if (!c.length) return null;
  return c.reduce(function (a, b) {
    return Date.parse(a) <= Date.parse(b) ? a : b;
  });
}

/**
 * Finding C5: which account a row's "Switch to" select is showing.
 *
 * The page rebuilds the whole `<tbody>` on every 5 s poll, and a fresh
 * `<select>` shows its first option — so a human who picked the third account,
 * read the row for six seconds and clicked Go sent a move to whichever account
 * happened to sort first. (The move-all selects already kept their `prev`; the
 * row selects did not.) The page remembers each row's choice by session id and
 * asks this which option to mark `selected`; a remembered account that is no
 * longer offered falls back to the first, exactly as a new select would.
 */
export function chosenAccount(options: string[], chosen: string): string {
  for (var i = 0; i < options.length; i++) {
    if (options[i] === chosen) return chosen;
  }
  return options.length ? options[0]! : "";
}

// --- The accounts panel ----------------------------------------------------
//
// The page wears the home dashboard's own accounts block (its `lim-*` panel):
// one group per provider, a brand rail naming it, and a card per account whose
// windows are meters on one shared scale — not a row of bare percentages in a
// table. The reference's rules travel with the shape:
//
//   * colour is worry only. A meter's fill takes the severity palette at the
//     reference's own thresholds (`severityWord` below) and nothing else; the
//     brand colours are worn by the rails and the marks, never by a bar —
//     Anthropic's coral sits next to `--status-high` and OpenAI's green next
//     to a healthy one, so a brand-coloured bar would read as a severity.
//   * a window the JSON does not carry is simply absent. A Codex account
//     reporting only its weekly window gets one lane, not a lane and a dash;
//     a dash lane is a meter that measures nothing.
//   * the percentages are USED, said once in the rail's count text, so no
//     lane has to repeat the unit.

/** The reference's own thresholds (`severityFor` in the data repo's
 *  lib/types.ts), copied verbatim: 70 / 85 / 95. */
export function severityWord(percent: number): string {
  if (percent >= 95) return "critical";
  if (percent >= 85) return "high";
  if (percent >= 70) return "elevated";
  return "normal";
}

/** Brand casing, not the provider key: a rail says "Claude" and "Codex". */
export function providerLabel(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return provider;
}

/** The provider's own mark, inlined as SVG so it renders in any ink and the
 *  page keeps its one rule: no external asset, ever. `currentColor` lets the
 *  rail decide, which is the only place a brand colour is allowed. */
export function providerMark(provider: string): string {
  var paths: { [k: string]: string } = {
    claude:
      "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    codex:
      "M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z",
  };
  var d = paths[provider];
  if (!d) return "";
  return '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' + d + '"></path></svg>';
}

/** "resets Tue 20:00" — local wall clock, the weekday named because every
 *  weekly window resets days out and "20:00" alone would read as tonight.
 *  A window with no reset says nothing rather than guessing one. */
export function resetNote(iso: string | null | undefined): string {
  if (!iso) return "";
  var t = Date.parse(String(iso));
  if (!isFinite(t)) return "";
  var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var d = new Date(t);
  return "resets " + days[d.getDay()] + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/**
 * One window as a meter: the label, the reset as a quiet note, the used
 * percentage, then the bar. Returns "" for a window the account does not
 * have — the panel's rule that a missing window is absent, not a dash, lives
 * here so every caller gets it.
 */
export function laneHtml(label: string, w: UsageWindow | undefined, dash: string): string {
  if (!w || typeof w.usedPercent !== "number" || !isFinite(w.usedPercent)) return "";
  var pct = Math.max(0, Math.min(100, w.usedPercent));
  var idle = pct === 0;
  var note = resetNote(w.resetsAt);
  return (
    '<div class="ms-lane">' +
    '<div class="ms-lane-top">' +
    '<span class="ms-lane-label">' + esc(label) + "</span>" +
    '<span class="ms-lane-read">' +
    (note ? '<span class="ms-lane-note">' + esc(note) + "</span>" : "") +
    '<span class="ms-lane-value"' + (idle ? " data-idle" : "") + ">" + fmtPercent(w, dash) + "</span>" +
    "</span>" +
    "</div>" +
    '<div class="ms-track" role="progressbar" aria-valuenow="' + Math.round(pct) + '" aria-valuemin="0" aria-valuemax="100" aria-label="' + esc(label) + ": " + fmtPercent(w, dash) + ' used">' +
    '<span class="ms-fill" data-severity="' + (idle ? "idle" : severityWord(pct)) + '" style="width:' + pct + '%"></span>' +
    "</div>" +
    "</div>"
  );
}

/** Every window this account actually reports, in the order a human reads
 *  them: the session first, then the week. Claude's Fable lane only exists
 *  when Claude reports it; Codex never carries one, so nothing has to know
 *  which provider it is looking at. */
export function accountLanesHtml(a: AccountRowView, dash: string): string {
  var u = a.usage || {};
  return (
    laneHtml("Session · 5h", u.session, dash) +
    laneHtml("Week · all models", u.weeklyAll, dash) +
    laneHtml("Week · Fable", u.weeklyFable, dash)
  );
}

/** `2 sessions · %1 · %2 walled`: what runs on the account, by pane; a state is named only when it is not
 *  plain `running`. Nothing running says nothing -- an empty line on every idle card is noise. */
export function accountSessionsHtml(sessions: { id: string; pane: string; state: string }[] | undefined): string {
  if (!sessions || !sessions.length) return "";
  var parts = sessions.map(function (s) {
    return esc(s.pane) + (s.state && s.state !== "running" ? " " + esc(s.state) : "");
  });
  return '<div class="ms-onacct">' + sessions.length + (sessions.length === 1 ? " session" : " sessions") + " · " + parts.join(" · ") + "</div>";
}

/** One account card: the name, the registry's LABEL when it says something
 *  the name doesn't, a chip for a STATE that isn't `ok`, then the meters.
 *  LABEL and STATE are `statusJson()`'s own computed words — rendered as
 *  given, never re-derived here. */
export function accountRowHtml(a: AccountRowView, dash: string): string {
  var lanes = accountLanesHtml(a, dash);
  var showLabel = a.label && a.label !== a.name;
  return (
    '<section class="ms-acct">' +
    '<header class="ms-acct-head">' +
    '<h3 class="ms-name">' + esc(a.name) + "</h3>" +
    (a.state && a.state !== "ok" ? '<span class="' + chipClass(a.state) + '">' + esc(a.state) + "</span>" : "") +
    (showLabel ? '<span class="ms-meta">' + esc(a.label) + "</span>" : "") +
    "</header>" +
    (a.email ? '<div class="ms-email">' + esc(a.email) + "</div>" : "") +
    accountSessionsHtml(a.sessions) +
    (lanes || '<div class="ms-note">no windows reported</div>') +
    "</section>"
  );
}

/** The whole panel: one group per provider present in the JSON, in the order
 *  the JSON names them, each behind its own brand rail. */
export function accountGroupsHtml(accounts: AccountRowView[], dash: string): string {
  if (!accounts.length) return '<div class="ms-empty">no accounts</div>';
  var order: string[] = [];
  var byProvider: { [k: string]: AccountRowView[] } = {};
  for (var i = 0; i < accounts.length; i++) {
    var p = accounts[i]!.provider || "";
    if (!byProvider[p]) {
      byProvider[p] = [];
      order.push(p);
    }
    byProvider[p]!.push(accounts[i]!);
  }
  var out = "";
  for (var g = 0; g < order.length; g++) {
    var key = order[g]!;
    var members = byProvider[key]!;
    var mark = providerMark(key);
    out +=
      '<div class="ms-group" data-provider="' + esc(key) + '">' +
      '<div class="ms-rail">' +
      (mark ? '<span class="ms-rail-mark">' + mark + "</span>" : "") +
      '<span class="ms-rail-name">' + esc(providerLabel(key)) + "</span>" +
      '<span class="ms-rail-count">' + members.length + " " + (members.length === 1 ? "account" : "accounts") + " · used</span>" +
      "</div>" +
      '<div class="ms-group-grid">';
    for (var m = 0; m < members.length; m++) out += accountRowHtml(members[m]!, dash);
    out += "</div></div>";
  }
  return '<div class="ms-panel">' + out + "</div>";
}

/** The fleet move's provider control: a segmented pill over whichever
 *  providers the pool actually has. It writes through to the `<select>` the
 *  POST body is still built from, so the control changed shape and nothing
 *  else did. */
export function providerSegHtml(providers: string[], current: string): string {
  var out = "";
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i]!;
    var on = p === current;
    out += '<button type="button" data-provider="' + esc(p) + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(providerLabel(p)) + "</button>";
  }
  return out;
}

/** A session id is a UUID; the ledger shows its first group, which is what a
 *  human types at `ms switch` anyway. The full id stays in the cell's title
 *  and, verbatim, in the row's own `data-session`. */
export function shortSessionId(id: string): string {
  var s = String(id);
  var cut = s.indexOf("-");
  return cut > 0 ? s.slice(0, cut) : s;
}

/**
 * One session as a ledger row, in the panel's own language: hairline rows, a
 * quiet header, mono reserved for the two identifiers (the session id and the
 * pane), and colour only where a human has to act.
 *
 * STATE carries the WALLED? reading with it rather than in a column of its
 * own — `walled · unreported` is one fact about one session, and the tenth
 * column it used to occupy was a column of blanks. Both words are
 * `statusJson()`'s own computed ones (src/status.ts's `computeSession()`),
 * rendered as given.
 */
export function sessionRowHtml(s: SessionRowView, others: string[], chosen: string, msg: RowMessage, dash: string): string {
  var pick = chosenAccount(others, chosen);
  var options = "";
  for (var i = 0; i < others.length; i++) {
    options += '<option value="' + esc(others[i]) + '"' + (others[i] === pick ? " selected" : "") + ">" + esc(others[i]) + "</option>";
  }
  var switchCell = others.length
    ? '<button data-act="switch">Switch to</button><select data-switch-select>' + options + "</select>"
    : "";
  var msgHtml = msg ? '<span class="rowmsg' + (msg.error ? " error" : "") + '">' + esc(msg.text) + "</span>" : "";
  var state = isWorry(s.state) ? '<span class="' + chipClass(s.state) + '">' + esc(s.state) + "</span>" : esc(s.state);
  var walled = s.walled ? '<small class="ms-sub"><span' + worryAttr(s.walled) + ">" + esc(s.walled) + "</span></small>" : "";
  return (
    "<tr>" +
    '<td class="mono" title="' + esc(s.id) + '">' + esc(shortSessionId(s.id)) + "</td>" +
    '<td class="mono">' + esc(s.pane || dash) + "</td>" +
    "<td>" + esc(s.provider) + "</td>" +
    "<td>" + esc(s.account) + "</td>" +
    "<td>" + esc(s.need) + "</td>" +
    '<td class="ms-state">' + state + walled + "</td>" +
    '<td class="num">' + esc(String(s.generation)) + "</td>" +
    "<td>" + (s.pending == null ? dash : esc(s.pending)) + "</td>" +
    '<td class="num">' + (s.wakeupAt != null ? esc(localTime(s.wakeupAt * 1000)) : dash) + "</td>" +
    '<td class="actions" data-session="' + esc(s.id) + '">' +
    '<button data-act="rotate">Rotate</button>' +
    switchCell +
    '<button data-act="stop">Stop</button>' +
    msgHtml +
    "</td>" +
    "</tr>"
  );
}

// --- What a fleet move came to (finding C3) --------------------------------

export type SwitchAllResultView = { session: string; code: number; message: string };
export type SwitchAllJson = {
  code?: number;
  message?: string | null;
  error?: string;
  results?: SwitchAllResultView[];
} | null;

/**
 * Finding C3: the page never showed a fleet move's outcome.
 *
 * `/api/switch-all` answers `message: null` on every move it actually started,
 * and the control only ever printed `json.message` — so it read "HTTP 200"
 * whether three sessions moved or three were refused, with colour the single
 * signal and no refused session named anywhere. (`results[]` was never
 * rendered, and each transaction refusal says "the reason is above" — on the
 * page there is no above; that reason went to the `ms dashboard` terminal,
 * which is finding C2.)
 *
 * So: one line per session, in the CLI's own words (`ms: s3 moved → home` /
 * `ms: s3 refused: …` minus the `ms:` voice, which belongs to a terminal),
 * then the CLI's own summary. `message` is non-null only when the destination
 * itself had no answer — nothing was started, so there is nothing to count
 * under it, exactly as `switchAllVerb` decides.
 */
export function formatSwitchAll(status: number, json: SwitchAllJson): string {
  if (json && typeof json.error === "string") return json.error;
  if (json && typeof json.message === "string" && json.message) return json.message;
  var results = json && json.results;
  if (!results || typeof results.length !== "number") return "HTTP " + status;
  var lines: string[] = [];
  var moved = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i]!;
    if (r.code === 0) {
      moved++;
      lines.push(r.session + " moved");
    } else {
      lines.push(r.session + " refused: " + r.message);
    }
  }
  lines.push("moved " + moved + ", refused " + (results.length - moved));
  return lines.join("\n");
}

// --- Which rows a fleet move touches (rereview-C.md, defect 3) -------------

/**
 * Which session ids `POST /api/switch-all` would touch: same provider as the
 * move, not already on the destination account — the same two of
 * `switchAll`'s (src/manual.ts) own candidate rules the client can see from
 * a session row (it never sees `desired`, so this can only ever be a
 * superset of the server's real candidates, never a subset — safe, since a
 * row wrongly marked busy is never a missed handoff, only a row disabled
 * one poll longer than strictly necessary).
 *
 * The page uses this to disable exactly these rows' controls while a fleet
 * move is in flight: without it, a click on a candidate row mid-move queues
 * a second, redundant handoff for that session, for up to the whole `--all`
 * budget — `moveBusy` alone (the "Go" button's own flag) never reached the
 * per-row buttons at all.
 */
export function fleetCandidateIds(sessions: SessionRowView[], provider: string, to: string): string[] {
  var out: string[] = [];
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i]!;
    if (s.provider === provider && s.account !== to) out.push(s.id);
  }
  return out;
}

// --- Finished sessions: hidden by default (finding F6) ---------------------
//
// `/api/state` always carries every session the store has ever recorded —
// `gone` (the pane is dead) and `stopped` (ended, by a human or a handoff)
// included, which is how the sessions table only ever grew. That route stays
// exactly as it is (`src/status.ts`'s `statusJson()` is the dashboard's own
// data source too, and other pages may want the full history) — the page
// filters client-side over the SAME json instead, on the same two words `ms
// status`'s own `--all` toggles, so the CLI table and this page can never
// disagree about what "finished" means.

export function isFinishedSession(s: SessionRowView): boolean {
  var FINISHED_STATES: { [k: string]: number } = { gone: 1, stopped: 1 };
  return !!FINISHED_STATES[s.state];
}

/** The rows the sessions table actually renders: every row once the human
 *  has asked to see finished ones, otherwise every row that isn't finished. */
export function visibleSessions(sessions: SessionRowView[], showFinished: boolean): SessionRowView[] {
  if (showFinished) return sessions;
  var out: SessionRowView[] = [];
  for (var i = 0; i < sessions.length; i++) {
    if (!isFinishedSession(sessions[i]!)) out.push(sessions[i]!);
  }
  return out;
}

/** The toggle's own label: blank — which the page reads as "hide the
 *  control" — when nothing is finished, otherwise how many are hidden (or,
 *  once shown, how many a second click would hide again). */
export function finishedToggleText(sessions: SessionRowView[], showFinished: boolean): string {
  var n = 0;
  for (var i = 0; i < sessions.length; i++) {
    if (isFinishedSession(sessions[i]!)) n++;
  }
  if (!n) return "";
  return (showFinished ? "hide " : "show ") + n + " finished";
}
