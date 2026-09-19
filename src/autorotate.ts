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
// Absent means ON. The gate shipped off while no live Codex wall had been
// observed (spike verdict G1: PARTIAL); that gap is closed. The wall's on-disk
// record was checked against 85 real walled rollouts on this machine, and the
// whole chain — watchdog, handoff, `codex resume` with the continuation, the
// real account answering — was observed end to end against a mock-walled
// scratch account (docs/superpowers/plans/2026-09-16-live-matrix-codex-wall.md).
// So the default inverts: automatic Codex recovery is on unless somebody says
// otherwise, and `MS_CODEX_AUTOROTATE=0` (or a stored "0") is how they say it.

/** The one key. Its value is exactly "1" or "0"; absent is on. */
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
 *
 * Only an explicit "off" turns this off — a stored "0", or, while nothing has
 * been stored, an exported `MS_CODEX_AUTOROTATE` that is not "1". Everything
 * else, silence included, is on.
 */
export function codexAutorotateEnabled(st: AutorotateStore): boolean {
  const stored = st.getKv(CODEX_AUTOROTATE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return codexAutorotateEnv() !== false;
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

/** The doctor line's text, so the gate is stated in exactly one place. Each
 * half names the export that would flip it, in the shell that runs `codex`. */
export function codexAutorotateLine(on: boolean): string {
  return on
    ? "codex auto-recovery: on (export MS_CODEX_AUTOROTATE=0 to disable)"
    : "codex auto-recovery: off (export MS_CODEX_AUTOROTATE=1 to enable)";
}

// --- The rebalance gate --------------------------------------------------
//
// Rebalance (docs/superpowers/specs/2026-09-19-rebalance-design.md) moves an
// IDLE session to a better account at a turn end. It is a stored setting with
// an environment variable in front of it for exactly the reason the Codex gate
// above is: the processes that read it include ones tmux dispatches, which
// carry the SERVER's environment and not the shell that typed the export.
//
// The one difference is the default, and it is the whole point of shipping it
// this way: absent means OFF. Automatic Codex recovery earned its default by
// being watched against 85 real walls; this rule moves work nobody asked it to
// move, so it ships behind a switch in 0.3.1 and flips to on in 0.3.2 once it
// has been observed doing the right thing.

/** The one key. Its value is exactly "1" or "0"; absent is off. */
export const REBALANCE_KEY = "rebalance";

/**
 * What the environment says, or null when it says nothing.
 *
 * Exactly "1" is on, the same rule the Codex gate reads — so a variable
 * somebody exported as "0", "false" or "" can never read as having turned
 * this on, and "not set here" stays distinguishable from "set to off".
 */
export function rebalanceEnv(): boolean | null {
  const v = process.env.MS_REBALANCE;
  if (v === undefined || v === "") return null;
  return v === "1";
}

/**
 * The gate. The stored value wins whenever there is one, because the store is
 * the only thing a tmux-dispatched process can see; the environment is the
 * fallback while nothing has mirrored one yet.
 *
 * Only an explicit "on" turns this on — a stored "1", or, while nothing has
 * been stored, an exported `MS_REBALANCE` that is exactly "1". Everything
 * else, silence included, is off.
 */
export function rebalanceEnabled(st: AutorotateStore): boolean {
  const stored = st.getKv(REBALANCE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return rebalanceEnv() === true;
}

/**
 * Mirror an exported `MS_REBALANCE` into the store.
 *
 * Called by the `ms` processes that DO run in the human's own shell: both
 * hooks (which each CLI runs with the environment its pane was launched
 * under) and `ms claude`/`ms codex` themselves. A process that cannot see the
 * variable leaves the stored gate exactly as it found it — absence here is
 * "I was not told", never "turn it off".
 */
export function syncRebalance(st: AutorotateStore): void {
  const env = rebalanceEnv();
  if (env === null) return;
  const want = env ? "1" : "0";
  if (st.getKv(REBALANCE_KEY) === want) return; // no write when nothing moved
  st.setKv(REBALANCE_KEY, want);
}

/** The doctor line's text, so the gate is stated in exactly one place. The
 *  off half names the shell the export has to happen in, because that is the
 *  mistake this gate invites: a variable exported in some other terminal is
 *  one no hook will ever see. */
export function rebalanceLine(on: boolean): string {
  return on
    ? "rebalance: on (export MS_REBALANCE=0 to disable)"
    : "rebalance: off (export MS_REBALANCE=1 in the shell that runs claude/codex)";
}
