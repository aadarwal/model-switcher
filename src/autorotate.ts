// src/autorotate.ts
//
// The gate on Codex AUTOMATIC recovery — and why it is a stored setting with
// an environment variable in front of it, rather than an environment variable.
//
// The two processes that have to read this gate are the two that no shell
// starts. `ms _recover` and `ms _codex_watch` are dispatched with `tmux
// run-shell`, and tmux runs those "with the tmux global environment set"
// (tmux(1)) — the environment the SERVER was started with, not the shell that
// typed `export MS_CODEX_AUTOROTATE=1`. So reading `process.env` there
// answered the wrong question: inside an existing tmux the flag was invisible,
// a wall was recorded, nothing opened, and no line anywhere said why. It only
// appeared to work when `ms codex` had itself started the tmux server, from
// the flagged shell, and the server inherited it by accident.
//
// The gate is therefore one row in the store, which every process — dispatched
// or not — reads identically. The environment variable stays the way a human
// sets it: any `ms` that DOES run in their shell and sees it mirrors it into
// the store on the way past, so exporting it keeps working and the stored
// value keeps up with them. When nothing has ever mirrored one, the variable
// is still read directly as a fallback, so a `ms _recover` run by hand from a
// flagged shell behaves the way the person in front of it expects.
//
// Absent means OFF (spike verdict G1: PARTIAL — no live Codex wall has been
// observed, so the automatic path ships disabled).

/** The one key. Its value is exactly "1" or "0"; absent is off. */
export const CODEX_AUTOROTATE_KEY = "codexAutorotate";

/** The minimum of `State` this module needs — structural on purpose, so
 * `src/hooks/codex-hook.ts` can import this file at module scope without
 * pulling `node:sqlite` (and its ExperimentalWarning) into every `ms` verb. */
export type AutorotateStore = { getKv(k: string): string | null; setKv(k: string, v: string): void };

/**
 * What the environment says, or null when it says nothing.
 *
 * Exactly "1" is on: a variable somebody exported as "0", "false" or "" to
 * turn this OFF must never read as having turned it on. The three-valued
 * answer is what lets "not set here" differ from "set to off" — only the
 * second is worth writing down.
 */
export function codexAutorotateEnv(): boolean | null {
  const v = process.env.MS_CODEX_AUTOROTATE;
  if (v === undefined || v === "") return null;
  return v === "1";
}

/**
 * The gate. The stored value wins whenever there is one, because the store is
 * the only thing a tmux-dispatched process can see; the environment is the
 * fallback for the case where nothing has mirrored one yet.
 */
export function codexAutorotateEnabled(st: AutorotateStore): boolean {
  const stored = st.getKv(CODEX_AUTOROTATE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return codexAutorotateEnv() === true;
}

/**
 * Mirror an exported `MS_CODEX_AUTOROTATE` into the store.
 *
 * Called by the `ms` processes that DO run in the human's own shell — the
 * Codex hook (which the CLI runs with the environment the pane was launched
 * under) and `ms codex` itself. A process that cannot see the variable leaves
 * the stored gate exactly as it found it: absence here is "I was not told",
 * never "turn it off".
 */
export function syncCodexAutorotate(st: AutorotateStore): void {
  const env = codexAutorotateEnv();
  if (env === null) return;
  const want = env ? "1" : "0";
  if (st.getKv(CODEX_AUTOROTATE_KEY) === want) return; // no write when nothing moved
  st.setKv(CODEX_AUTOROTATE_KEY, want);
}

/** The doctor line's text, so the gate is stated in exactly one place. */
export function codexAutorotateLine(on: boolean): string {
  return on
    ? "codex auto-recovery: on"
    : "codex auto-recovery: off (set MS_CODEX_AUTOROTATE=1 in the shell that runs codex)";
}
