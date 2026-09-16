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

export function buildSwitchAllBody(to: string, force: boolean): { to: string; force: boolean } {
  return { to: to, force: force };
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
