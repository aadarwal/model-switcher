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
 */
export function worryAttr(v: unknown): string {
  var worry: { [k: string]: number } = { walled: 1, parked: 1, auth: 1, unreported: 1, "no-token": 1, "no-grant": 1 };
  return worry[String(v)] ? ' class="worry"' : "";
}

export function fmtPercent(w: UsageWindow | undefined, dash: string): string {
  if (!w || typeof w.usedPercent !== "number" || !isFinite(w.usedPercent)) return dash;
  var v = Math.round(w.usedPercent * 10) / 10;
  return (Math.floor(v) === v ? String(v) : v.toFixed(1)) + "%";
}

export function localTime(ms: number): string {
  var d = new Date(ms);
  var pad = function (n: number): string {
    return n < 10 ? "0" + n : String(n);
  };
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
  );
}

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

export function accountRowHtml(a: AccountRowView, dash: string): string {
  var u = a.usage || {};
  var reset = earliestWeeklyReset(a.usage);
  return (
    "<tr>" +
    "<td>" + esc(a.name) + "</td>" +
    "<td>" + esc(a.provider || dash) + "</td>" +
    "<td>" + esc(a.label) + "</td>" +
    "<td>" + fmtPercent(u.session, dash) + "</td>" +
    "<td>" + fmtPercent(u.weeklyAll, dash) + "</td>" +
    "<td>" + fmtPercent(u.weeklyFable, dash) + "</td>" +
    "<td>" + (reset ? localTime(Date.parse(reset)) : dash) + "</td>" +
    "<td" + worryAttr(a.state) + ">" + esc(a.state) + "</td>" +
    "</tr>"
  );
}

export function sessionRowHtml(s: SessionRowView, others: string[], chosen: string, msg: RowMessage, dash: string): string {
  var pick = chosenAccount(others, chosen);
  var options = "";
  for (var i = 0; i < others.length; i++) {
    options += '<option value="' + esc(others[i]) + '"' + (others[i] === pick ? " selected" : "") + ">" + esc(others[i]) + "</option>";
  }
  var switchCell = others.length ? "<select data-switch-select>" + options + '</select><button data-act="switch">Go</button>' : "";
  var msgHtml = msg ? '<span class="rowmsg' + (msg.error ? " error" : "") + '">' + esc(msg.text) + "</span>" : "";
  return (
    "<tr>" +
    "<td>" + esc(s.id) + "</td>" +
    "<td>" + esc(s.pane || dash) + "</td>" +
    "<td>" + esc(s.provider) + "</td>" +
    "<td>" + esc(s.account) + "</td>" +
    "<td>" + esc(s.need) + "</td>" +
    "<td" + worryAttr(s.state) + ">" + esc(s.state) + "</td>" +
    "<td>" + esc(String(s.generation)) + "</td>" +
    "<td>" + (s.pending == null ? dash : esc(s.pending)) + "</td>" +
    "<td>" + (s.wakeupAt != null ? localTime(s.wakeupAt * 1000) : dash) + "</td>" +
    "<td" + worryAttr(s.walled) + ">" + esc(s.walled || dash) + "</td>" +
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
