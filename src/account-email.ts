// src/account-email.ts
//
// The e-mail behind an account, filled in on its own.
//
// Since 0.2.6 the registry keeps the login's e-mail — but only an
// `ms accounts login`/`verify` ever wrote it, so every account signed in
// before that read `-` until somebody ran a verify by hand, and a book of
// `claude-1`…`claude-5` could not say which row was which login.
//
// So wherever `ms` already talks to a provider for an account whose row has
// no e-mail — the poll cycle (src/snapshot.ts: `ms status`, the dashboard,
// launches, the hook-driven polls) and `ms doctor` — it asks for the e-mail
// once, the same way `login`/`verify` do:
//
//   claude  `/api/oauth/profile`, under the poll grant the caller has just
//           used (it carries `user:profile`); no refresh of its own.
//   codex   the identity in the account's own `auth.json` — the id_token
//           `accounts-codex.ts` reads at login. Local; no request at all.
//
// Rules: at most ONE attempt per account per process (a dashboard or a
// `status --watch` that polls every few seconds asks once, not every poll);
// only for a row with no e-mail; every failure is silent — the e-mail simply
// stays absent; and an e-mail is recorded only when the identity it came with
// is the one the row already records (or the row records none), because a
// display fact that named another login would be worse than a dash. The value
// is the e-mail and nothing else: no token is ever logged or stored here.

import { findAccount, loadRegistry, saveRegistry, type Account, type Provider } from "./registry.ts";
import { msHome, p } from "./paths.ts";
import { fetchProfile, type PollCredentials, type Profile } from "./providers/claude-usage.ts";
import { readCodexAuth } from "./providers/codex-probe.ts";

/** The accounts this process has already asked, keyed by store as well as
 *  (provider, name): an account is only unique within one MS_HOME. */
const asked = new Set<string>();
const keyOf = (a: { provider: Provider; name: string }): string => `${msHome()}\0${a.provider}:${a.name}`;

/** Would a backfill for this row do anything — no e-mail yet, and not asked
 *  in this process? Side-effect free. */
export function emailWanted(a: Account): boolean {
  return !a.email && !asked.has(keyOf(a));
}

/** Take this process's one attempt for the row, or say it is spent. */
function claim(a: Account): boolean {
  if (!emailWanted(a)) return false;
  asked.add(keyOf(a));
  return true;
}

/** An e-mail found for a row, to be written by `recordEmails`. */
export type FoundEmail = { provider: Provider; name: string; email: string };

/** The same shape `validateRegistry` keeps, so nothing is written that the
 *  next read would drop. */
function usable(email: string | null | undefined): email is string {
  return typeof email === "string" && email.length <= 254 && !/[\x00-\x1f\x7f]/.test(email) && /^[^\s@]+@[^\s@]+$/.test(email);
}

/** The profile's e-mail, when it belongs to this row's identity. */
export function emailFromProfile(a: Account, profile: Profile | null): FoundEmail | null {
  if (!profile || !usable(profile.email)) return null;
  if (a.orgId && profile.orgId !== a.orgId) return null;
  return { provider: a.provider, name: a.name, email: profile.email };
}

/** Claude: one profile read under a credential the caller already holds.
 *  Never throws, never refreshes. */
export async function claudeEmail(a: Account, cred: PollCredentials, signal: AbortSignal): Promise<FoundEmail | null> {
  if (a.provider !== "claude" || !claim(a)) return null;
  try {
    return emailFromProfile(a, await fetchProfile(cred, signal));
  } catch {
    return null; // could not tell: the e-mail stays absent
  }
}

/** For a caller that has ALREADY read the profile for its own reasons (the
 *  doctor's identity line): spend the attempt on that read, not on a second. */
export function claudeEmailFrom(a: Account, profile: Profile | null): FoundEmail | null {
  if (a.provider !== "claude" || !claim(a)) return null;
  return emailFromProfile(a, profile);
}

/** Codex: the identity in the account's own auth.json. Local, never throws. */
export function codexEmail(a: Account): FoundEmail | null {
  if (a.provider !== "codex" || !claim(a)) return null;
  const auth = readCodexAuth(p.codexHome(a.name));
  if (!auth || !usable(auth.email)) return null;
  if (a.orgId && auth.accountId !== a.orgId) return null;
  return { provider: a.provider, name: a.name, email: auth.email };
}

/**
 * Write what was found: re-read the registry, set the e-mail on each row that
 * is still there and still has none, and save atomically (temp + rename) —
 * only when something changed. The re-read and the write are one synchronous
 * stretch, as `ms accounts`' own `update` does it. Silent: an unreadable
 * registry (or one with a skipped row) is never written over, and a write
 * that fails leaves the e-mails absent. Returns how many rows were written.
 */
export function recordEmails(found: (FoundEmail | null)[]): number {
  const todo = found.filter((f): f is FoundEmail => f !== null);
  if (!todo.length) return 0;
  try {
    const r = loadRegistry();
    // A row `validateRegistry` skipped would be dropped by the rewrite, and a
    // background write must never cost the human a row they could still fix.
    if (r.parseError || r.problems.length) return 0;
    let n = 0;
    for (const f of todo) {
      const row = findAccount(r.registry, f.name, f.provider);
      if (!row || row.email) continue;
      row.email = f.email;
      n++;
    }
    if (n) saveRegistry(r.registry, r);
    return n;
  } catch {
    return 0;
  }
}

/** Test seam: forget which accounts this process has asked. */
export function resetEmailBackfill(): void {
  asked.clear();
}
