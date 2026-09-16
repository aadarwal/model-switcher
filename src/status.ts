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
 *  phrase for Claude ("no poll grant …") and Codex ("no credentials …");
 *  anything else classified `auth` is a live credential that the provider
 *  itself rejected (a dead refresh token, a revoked grant). */
const NO_GRANT_RE = /no poll grant|credentials missing|no credentials/i;

/**
 * The single STATE word for an account row.
 *
 * `no-token` is checked first and independently of the usage poll: the
 * launch grant and the poll grant are two separate credentials for Claude
 * (spec §6), and a Claude account with no launch token cannot be run with
 * at all, however well its usage reads. Codex has no such second
 * credential — the CLI reads CODEX_HOME directly — so `no-token` can never
 * apply to a codex row, whatever `hasToken` was computed as upstream; a
 * missing or unreadable Codex `auth.json` instead surfaces as `no-grant`
 * below, via the poller's own "no credentials" message.
 *
 * Everything after that is what the last poll found, worst first: a dead
 * credential outranks a slow network, which outranks a reading this round
 * merely didn't refresh.
 */
export function accountState(a: AccountUsage, hasToken: boolean): AccountState {
  if (!hasToken && a.provider !== "codex") return "no-token";
  if (a.errorKind === "auth") return NO_GRANT_RE.test(a.error ?? "") ? "no-grant" : "auth";
  // "other" is not one of the six named states; it is folded into
  // "transient" — not fatal, not a reason to re-login, worth another look
  // later.
  if (a.errorKind === "transient" || a.errorKind === "other") return "transient";
  if (a.stale) return "stale";
  return "ok";
}

/** One decimal only when the value isn't integral (42, not 42.0; 42.5, not
 *  42.50); "—" for a window the account doesn't have.
 *
 *  `Cli`-suffixed on purpose: src/dashboard/client-logic.ts has its own
 *  `fmtPercent`, doing the same job for the dashboard page's <script>, whose
 *  runtime source page.ts embeds by `fn.toString()` under that exact name.
 *  Bundled into the same file (esbuild, scripts/build.mjs), two same-named
 *  top-level functions collide and one gets silently renamed — which is
 *  exactly the class of bug scripts/check-dist.mjs exists to catch (it did,
 *  against this pair, before this rename). Never let this name collide with
 *  client-logic.ts's again. */
function fmtPercentCli(w: Window | null | undefined): string {
  if (!w || !Number.isFinite(w.usedPercent)) return DASH;
  const v = Math.round(w.usedPercent * 10) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}

/** The earliest of the account's WEEKLY resets — session/5h resets far more
 *  often and is not "the" reset a human waiting on this account cares about.
 *  `Cli`-suffixed for the same reason as `fmtPercentCli` above: keeps this
 *  file's own copy from colliding with client-logic.ts's `earliestWeeklyReset`
 *  once both are bundled into dist/ms.js. */
export function earliestWeeklyResetCli(u: AccountUsage["usage"]): string | null {
  if (!u) return null;
  const candidates = [u.weeklyAll?.resetsAt, u.weeklyFable?.resetsAt].filter((x): x is string => !!x);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/** Local wall-clock time, `YYYY-MM-DD HH:MM` — never UTC, never an ISO
 *  string a human has to convert in their head. `Cli`-suffixed for the same
 *  reason as `fmtPercentCli` above: keeps this file's own copy from
 *  colliding with client-logic.ts's `localTime`. */
export function localTimeCli(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Everything an account row needs that isn't already on `AccountUsage`
 *  itself — the registry's own LABEL and the table's own STATE word — in
 *  one place, so `accountRow()` (the text table) and `statusJson()` (Plan 4
 *  Task 2's dashboard) compute it identically rather than one of them
 *  copying the other's logic. See review round 1 (P4-T2), findings 1 & 2. */
export type AccountComputed = { label: string; state: AccountState };

function computeAccount(a: AccountUsage, registry: Registry): AccountComputed {
  const label = findAccount(registry, a.name, a.provider)?.label ?? a.name;
  const hasToken = !!readLaunchToken(a.name);
  return { label, state: accountState(a, hasToken) };
}

function accountRow(a: AccountUsage, registry: Registry): string[] {
  const c = computeAccount(a, registry);
  const reset = earliestWeeklyResetCli(a.usage);
  return [
    a.name,
    a.provider,
    c.label,
    fmtPercentCli(a.usage?.session ?? null),
    fmtPercentCli(a.usage?.weeklyAll ?? null),
    fmtPercentCli(a.usage?.weeklyFable ?? null),
    reset ? localTimeCli(Date.parse(reset)) : DASH,
    c.state,
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

/**
 * One session row. Its STATE is the store's own word for the session, with
 * exactly one substitution made here (`gone`, below) — this verb reports, it
 * never repairs.
 *
 * So a Codex row may honestly read `launching` for as long as the human leaves
 * a freshly launched pane idle: Codex 0.153.4's interactive TUI fires its
 * SessionStart hook at the first SUBMITTED PROMPT, not at process start, and
 * `launching → running` is that hook's move to make (src/hooks/codex-hook.ts).
 * The pane is up and fine; nothing has been typed into it yet. Reconciliation
 * adopts such a row as `running` once it is past its stuck threshold with a
 * live pane (src/reconcile.ts), and the same lazy hook is why a `cliSessionId`
 * of null is the NORMAL state of a new Codex session rather than a fault.
 * Nothing here second-guesses either; a status that repaired what it printed
 * would be a different verb.
 */
/** Everything a session row needs that lives outside `SessionRow` itself —
 *  the live "gone" override, the open recovery's own status word, and the
 *  WALLED? reading — computed once so `sessionRow()` (the text table) and
 *  `statusJson()` (Plan 4 Task 2's dashboard) never compute it two
 *  different ways. See review round 1 (P4-T2), finding 1. `pending` is
 *  `null` exactly where the table prints "—" (no open recovery); JSON has
 *  no dash of its own. */
export type SessionComputed = { state: string; pending: string | null; walled: Walled };

function computeSession(s: SessionRow, st: State): SessionComputed {
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
  return { state, pending: rec ? rec.status : null, walled };
}

function sessionRow(s: SessionRow, st: State): string[] {
  const c = computeSession(s, st);
  return [
    s.id,
    s.pane || DASH,
    s.provider,
    s.account,
    s.need,
    c.state,
    String(s.generation),
    c.pending ?? DASH,
    s.wakeupAt != null ? localTimeCli(s.wakeupAt * 1000) : DASH,
    c.walled,
  ];
}

// --- Rendering -------------------------------------------------------------

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cols: string[]) => cols.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** Additive over the raw rows: every existing key of `AccountUsage` /
 *  `SessionRow` is present unchanged, plus the words the text table
 *  computes and this JSON didn't use to carry (review round 1, finding 1:
 *  LABEL/PENDING/WALLED? were rendering as placeholders on the dashboard
 *  page because they simply weren't in this JSON at all).
 *
 *  `state` overrides `SessionRow`'s own (narrower) `SessionState` — it is
 *  `computeSession`'s COMPUTED state (`SessionComputed`, above), which adds
 *  the live `gone` override `SessionState` has no room for, so this is the
 *  same word `ms status`'s text table prints, not the store's raw column
 *  (fix-C-report.md item 1 / fix-R). */
export type StatusAccountRow = AccountUsage & AccountComputed;
export type StatusSessionRow = Omit<SessionRow, "state"> & { state: string; pending: string | null; walled: Walled };
export type StatusJson = { accounts: StatusAccountRow[]; sessions: StatusSessionRow[]; takenAt: number | null };

/**
 * The `--json` shape below, isolated so another caller (the dashboard API,
 * Plan 4 Task 1/2) can get the same numbers without going through stdout —
 * and, since review round 1, the exact same COMPUTED words the text table
 * prints (`computeAccount`/`computeSession` above), not just the raw
 * snapshot/store rows a consumer would otherwise have to re-derive (badly:
 * finding 2's page.ts copy never checked `hasToken`). Extracted without
 * changing what `ms status --json` itself prints beyond that addition —
 * `render`'s json branch below is still just `JSON.stringify` over this.
 */
export async function statusJson(): Promise<StatusJson> {
  const { registry } = loadRegistry();
  const snapshot = await getSnapshot({ maxAgeMs: SNAPSHOT_MAX_AGE_MS });
  const st = openState();
  try {
    const accounts = snapshot.accounts.map((a) => ({ ...a, ...computeAccount(a, registry) }));
    const sessions = st.listSessions().map((s) => {
      const c = computeSession(s, st);
      return { ...s, state: c.state, pending: c.pending, walled: c.walled };
    });
    return { accounts, sessions, takenAt: snapshot.takenAt };
  } finally {
    st.close();
  }
}

async function render(json: boolean): Promise<string> {
  if (json) return JSON.stringify(await statusJson()) + "\n";

  const { registry, parseError } = loadRegistry();
  const snapshot = await getSnapshot({ maxAgeMs: SNAPSHOT_MAX_AGE_MS });
  const st = openState();
  try {
    const sessions = st.listSessions();
    const lines: string[] = [];
    // A registry the loader could not read is not silently a pool of zero
    // accounts — say so, first, before either table (which may still show
    // the last known readings, carried forward by src/snapshot.ts).
    if (parseError) lines.push(parseError);
    lines.push(...table(
      // PROVIDER sits next to NAME for the same reason it sits next to
      // ACCOUNT in the sessions table below: identity in this tool is
      // (provider, name), and an account name is reused across providers
      // (a Claude `tulp` and a Codex `tulp` are two different accounts).
      ["NAME", "PROVIDER", "LABEL", "5H", "WEEK", "FABLE", "RESETS", "STATE"],
      snapshot.accounts.map((a) => accountRow(a, registry)),
    ));
    lines.push("");
    lines.push(...table(
      // PROVIDER sits next to ACCOUNT: identity in this tool is
      // (provider, name), and an account name is only reused across
      // providers, never within one — so a session's own credential is
      // named by both cells together, not ACCOUNT alone.
      ["SESSION", "PANE", "PROVIDER", "ACCOUNT", "NEED", "STATE", "GEN", "PENDING", "WAKEUP", "WALLED?"],
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
