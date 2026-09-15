// src/status.ts
//
// `ms status`: read-only. Polls usage on demand (through the coalesced
// snapshot — this is just another caller of it, so a human running `ms
// status` never costs a second poll when a launch or a recovery already took
// one in the last 20 s), reads the state store and the event logs, and
// cross-checks tmux for what the store cannot know on its own (whether a
// pane still exists, what its screen currently reads). Two tables: accounts
// (the pool, as usage sees it) and sessions (what is running, and whether it
// needs a human).
//
// Task 18 (reconciliation) runs `reconcile()` at the top of every public verb
// — this file does not call it and must not: that wiring lands with Task 18.

import { setTimeout as sleep } from "node:timers/promises";
import type { Verb } from "./cli.ts";
import { findAccount, loadRegistry, type Registry } from "./registry.ts";
import { getSnapshot, type AccountUsage } from "./snapshot.ts";
import type { Window } from "./pick.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { openState, type SessionRow, type State } from "./state.ts";
import { readEvents, type Event } from "./events.ts";
import { Tmux } from "./tmux.ts";
import { wallKindFromText } from "./wall.ts";

const SNAPSHOT_MAX_AGE_MS = 20_000;
const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const DASH = "—";

// --- Accounts table ------------------------------------------------------

export type AccountState = "ok" | "stale" | "auth" | "transient" | "no-grant" | "no-token";

/** `pollOne` (src/snapshot.ts) names a missing poll grant with this exact
 *  phrase; anything else classified `auth` is a live credential that the
 *  provider itself rejected (a dead refresh token, a revoked grant). */
const NO_GRANT_RE = /no poll grant|credentials missing/i;

/**
 * The single STATE word for an account row.
 *
 * `no-token` is checked first and independently of the usage poll: the
 * launch grant and the poll grant are two separate credentials (spec §6),
 * and an account with no launch token cannot be run with at all, however
 * well its usage reads. Everything after that is what the last poll found,
 * worst first: a dead credential outranks a slow network, which outranks a
 * reading this round merely didn't refresh.
 */
export function accountState(a: AccountUsage, hasToken: boolean): AccountState {
  if (!hasToken) return "no-token";
  if (a.errorKind === "auth") return NO_GRANT_RE.test(a.error ?? "") ? "no-grant" : "auth";
  // "other" (e.g. codex's not-yet-implemented poller) is not one of the six
  // named states; it is folded into "transient" — not fatal, not a reason to
  // re-login, worth another look later.
  if (a.errorKind === "transient" || a.errorKind === "other") return "transient";
  if (a.stale) return "stale";
  return "ok";
}

/** One decimal only when the value isn't integral (42, not 42.0; 42.5, not
 *  42.50); "—" for a window the account doesn't have. */
function fmtPercent(w: Window | null | undefined): string {
  if (!w || !Number.isFinite(w.usedPercent)) return DASH;
  const v = Math.round(w.usedPercent * 10) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}

/** The earliest of the account's WEEKLY resets — session/5h resets far more
 *  often and is not "the" reset a human waiting on this account cares about. */
export function earliestWeeklyReset(u: AccountUsage["usage"]): string | null {
  if (!u) return null;
  const candidates = [u.weeklyAll?.resetsAt, u.weeklyFable?.resetsAt].filter((x): x is string => !!x);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** Local wall-clock time, `YYYY-MM-DD HH:MM` — never UTC, never an ISO
 *  string a human has to convert in their head. */
export function localTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function accountRow(a: AccountUsage, registry: Registry): string[] {
  const label = findAccount(registry, a.name, a.provider)?.label ?? a.name;
  const hasToken = !!readLaunchToken(a.name);
  const reset = earliestWeeklyReset(a.usage);
  return [
    a.name,
    label,
    fmtPercent(a.usage?.session ?? null),
    fmtPercent(a.usage?.weeklyAll ?? null),
    fmtPercent(a.usage?.weeklyFable ?? null),
    reset ? localTime(Date.parse(reset)) : DASH,
    accountState(a, hasToken),
  ];
}

// --- Sessions table --------------------------------------------------------

export type Walled = "reported" | "unreported" | "";

/**
 * WALLED?: `reported` when the store already has an open recovery for this
 * session (the automatic path saw the wall itself — see src/snapshot.ts's
 * doc comment on `rate_limited`); `unreported` when the pane's OWN screen
 * names a wall kind but neither an open recovery nor a `rate_limited` event
 * for the session's CURRENT generation backs it up — the provider never told
 * us, so nothing will rotate this on its own; manual `ms rotate` territory.
 * Blank otherwise (including: pane gone, screen reads no wall).
 */
export function sessionWalled(s: SessionRow, hasPendingRecovery: boolean, screen: string | null, events: Event[]): Walled {
  if (hasPendingRecovery) return "reported";
  if (screen === null) return "";
  const kind = wallKindFromText(screen);
  if (!kind) return "";
  const alreadyReported = events.some((e) => e.kind === "rate_limited" && e.generation === s.generation);
  return alreadyReported ? "" : "unreported";
}

function sessionRow(s: SessionRow, st: State): string[] {
  const tmux = new Tmux(s.socket || null);
  const hasPane = !!s.pane;
  const exists = hasPane && tmux.paneExists(s.pane);
  // "gone": had a pane, and tmux no longer has it. A session that has never
  // been assigned a pane yet (mid-launch, `pane` still "") is not "gone" —
  // it just isn't there yet — so it keeps reporting its own store state.
  const state = hasPane && !exists ? "gone" : s.state;
  const rec = st.pendingRecovery(s.id);
  // TOCTOU: the pane can die between this paneExists check and the capture
  // below. That's fine — capture-pane on a gone pane never throws (tmux.ts's
  // `run`, not `must`), it just returns "", so wallKindFromText reads no
  // wall and the row simply shows last-known STATE this render; the next
  // render's paneExists catches up and shows "gone".
  const screen = exists ? tmux.capture(s.pane) : null;
  const walled = sessionWalled(s, rec !== null, screen, exists ? readEvents(s.id) : []);
  return [
    s.id,
    s.pane || DASH,
    s.account,
    s.need,
    state,
    String(s.generation),
    rec ? rec.status : DASH,
    s.wakeupAt != null ? localTime(s.wakeupAt * 1000) : DASH,
    walled,
  ];
}

// --- Rendering -------------------------------------------------------------

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cols: string[]) => cols.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

type JsonOutput = { accounts: AccountUsage[]; sessions: SessionRow[]; takenAt: number };

async function render(json: boolean): Promise<string> {
  const { registry, parseError } = loadRegistry();
  const snapshot = await getSnapshot({ maxAgeMs: SNAPSHOT_MAX_AGE_MS });
  const st = openState();
  try {
    const sessions = st.listSessions();
    if (json) {
      const out: JsonOutput = { accounts: snapshot.accounts, sessions, takenAt: snapshot.takenAt };
      return JSON.stringify(out) + "\n";
    }

    const lines: string[] = [];
    // A registry the loader could not read is not silently a pool of zero
    // accounts — say so, first, before either table (which may still show
    // the last known readings, carried forward by src/snapshot.ts).
    if (parseError) lines.push(parseError);
    lines.push(...table(
      ["NAME", "LABEL", "5H", "WEEK", "FABLE", "RESETS", "STATE"],
      snapshot.accounts.map((a) => accountRow(a, registry)),
    ));
    lines.push("");
    lines.push(...table(
      ["SESSION", "PANE", "ACCOUNT", "NEED", "STATE", "GEN", "PENDING", "WAKEUP", "WALLED?"],
      sessions.map((s) => sessionRow(s, st)),
    ));
    return lines.join("\n") + "\n";
  } finally {
    st.close();
  }
}

/** `--watch`: clear + reprint every `MS_WATCH_MS` (default 5 s) until
 *  SIGINT. `MS_WATCH_ITERATIONS`, set, bounds the loop so a test can exercise
 *  exactly one redraw without waiting on a signal. */
async function watchLoop(json: boolean): Promise<number> {
  const intervalMs = Number(process.env.MS_WATCH_MS) || 5_000;
  const raw = process.env.MS_WATCH_ITERATIONS;
  const maxIterations = raw ? Number(raw) : Infinity;
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);
  try {
    let i = 0;
    while (i < maxIterations && !ac.signal.aborted) {
      const out = await render(json);
      process.stdout.write(CLEAR_SCREEN + out);
      i++;
      if (ac.signal.aborted || i >= maxIterations) break;
      try {
        await sleep(intervalMs, undefined, { signal: ac.signal });
      } catch {
        break; // aborted mid-sleep: SIGINT, stop cleanly rather than throw
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  return 0;
}

export const status: Verb = async (argv) => {
  const watch = argv.includes("--watch");
  const json = argv.includes("--json");
  if (watch) return watchLoop(json);
  process.stdout.write(await render(json));
  return 0;
};
