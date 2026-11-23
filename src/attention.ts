// src/attention.ts
//
// Accounts that need a human: logged out, unverified, or showing numbers that
// are no longer current.
//
// The pool panel and `ms status` carry each account's LAST SUCCESSFUL reading
// forward when a poll fails (src/snapshot.ts's `observedAt` contract). That is
// right for the chooser, which has its own ten-minute rule, but a human reading
// the dashboard saw October's "100% used" bars under an account whose grant
// had expired weeks earlier and read the pool as maxed out. The STATE chip said
// `auth`, quietly; nothing said "these numbers are 37 days old" or "run this to
// fix it". This module says both, once, for every surface: the `ms status`
// text, its `--json`, and the dashboard's banner and cards.
//
// Pure: no registry read, no network, no clock of its own. Callers pass `now`.

import type { Provider } from "./registry.ts";
import type { Usage } from "./providers/claude-usage.ts";

/** A reading older than this is stale even with no error behind it.
 *  `MS_STALE_AFTER_HOURS` overrides it (a positive number of hours). */
export const DEFAULT_STALE_AFTER_MS = 6 * 3_600_000;

export function staleAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.MS_STALE_AFTER_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : DEFAULT_STALE_AFTER_MS;
}

export type AttentionReason = "no-token" | "auth" | "no-grant" | "unverified" | "never-read" | "stale" | "reset-passed";

/** What the human is told about one account. `lastGoodAt` is the last
 *  SUCCESSFUL reading (epoch ms), null when there has never been one.
 *  `loggedOut` is any credential reason. `stale` says the usage numbers shown
 *  for the account are not current and will not become so on their own —
 *  everything except an unverified identity over a fresh reading. `fix` is
 *  one command to run. */
export type Attention = {
  reasons: AttentionReason[];
  detail: string;
  lastGoodAt: number | null;
  loggedOut: boolean;
  stale: boolean;
  fix: string;
};

type AttentionInput = {
  name: string;
  provider: Provider;
  state: string;
  usage: Usage | null;
  observedAt: number | null;
  error?: string | null;
  errorKind?: string | null;
  /** The registry's own flag; undefined when the row has no registry entry. */
  identityVerified?: boolean;
};

const REASON_TEXT: Record<AttentionReason, string> = {
  "no-token": "logged out: no launch token",
  auth: "logged out: sign-in expired or revoked",
  "no-grant": "logged out: no usage grant",
  unverified: "identity not verified",
  "never-read": "usage never read",
  stale: "usage not refreshed",
  "reset-passed": "reading is from before its window reset",
};

/** Whole units, largest first: `45s`, `12m`, `3h`, `37d`. */
export function attentionAge(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The one command that clears the worst reason. A credential problem is a
 *  sign-in; an unverified identity is a verify; old numbers with a working
 *  credential are a verify too, which re-reads both grants and says which
 *  one is failing. */
export function attentionFix(name: string, provider: Provider, reasons: readonly AttentionReason[]): string {
  if (reasons.some((r) => r === "no-token" || r === "auth" || r === "no-grant")) {
    return provider === "claude" ? `ms accounts login ${name} --provider claude --relogin` : `ms accounts login ${name} --provider codex`;
  }
  return `ms accounts verify ${name} --provider ${provider}`;
}

/** A window whose reset has passed since the reading was taken: the numbers
 *  in it describe a window that no longer exists. */
function resetPassed(u: Usage | null, observedAt: number | null, now: number): boolean {
  if (!u) return false;
  for (const w of [u.session, u.weeklyAll, u.weeklyFable]) {
    const at = Date.parse(w?.resetsAt ?? "");
    if (Number.isFinite(at) && at <= now && (observedAt === null || observedAt < at)) return true;
  }
  return false;
}

/** Null when the account needs nothing. Otherwise every reason that applies,
 *  worst first, a one-line detail, and the fix. A row that is merely
 *  `stale` for this round (a backoff, a scoped poll) is NOT flagged until its
 *  reading is older than `staleMs` — that is ordinary and clears itself. */
export function accountAttention(a: AttentionInput, now: number, staleMs: number = DEFAULT_STALE_AFTER_MS): Attention | null {
  const reasons: AttentionReason[] = [];
  if (a.state === "no-token") reasons.push("no-token");
  if (a.state === "auth") reasons.push("auth");
  if (a.state === "no-grant") reasons.push("no-grant");
  // A Claude row with no launch token can also have no poll grant; the
  // state word names only one, so read the poll's own error too.
  if (a.state === "no-token" && a.errorKind === "auth") reasons.push(/no poll grant|credentials missing|no credentials/i.test(a.error ?? "") ? "no-grant" : "auth");
  if (a.identityVerified === false) reasons.push("unverified");
  if (a.observedAt === null) reasons.push("never-read");
  else if (now - a.observedAt > staleMs) reasons.push("stale");
  if (resetPassed(a.usage, a.observedAt, now)) reasons.push("reset-passed");
  if (!reasons.length) return null;
  const loggedOut = reasons.some((r) => r === "no-token" || r === "auth" || r === "no-grant");
  const words = reasons.map((r) => REASON_TEXT[r]);
  if (a.observedAt !== null && (loggedOut || reasons.includes("stale"))) words.push(`last good reading ${attentionAge(a.observedAt, now)} ago`);
  if (a.error && !loggedOut && reasons.includes("stale")) words.push(`last poll: ${a.error}`);
  const stale = reasons.some((r) => r !== "unverified");
  return { reasons, detail: words.join("; "), lastGoodAt: a.observedAt, loggedOut, stale, fix: attentionFix(a.name, a.provider, reasons) };
}
