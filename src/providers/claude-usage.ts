// src/providers/claude-usage.ts
//
// The Claude **poll grant**: the profile-scoped OAuth credential a
// `claude auth login` mints into this tool's own CLAUDE_CONFIG_DIR
// (`claude/<name>/`, see src/paths.ts). It is the only credential that can
// read usage — a `claude setup-token` (the *launch* grant) is inference-scope
// only and 403s `oauth_scope_insufficient` on both endpoints below (verified
// live by the author's dashboard, 2026-09-14). This module reads that
// credential, refreshes it (writing the rotated token back where it came
// from), and reads the account's usage windows and organisation.
//
// Endpoints, token URL, client id and the header set are COPIED VERBATIM from
// the author's working poller at data/lib/providers/claude.ts — the versions
// proven against these endpoints. Nothing here is invented, and this tool
// carries no OAuth client code of its own (spec §6).
//
// Error contract, for the callers that have to decide what to do next:
//   AuthError      the credential is dead — re-login (400/401/403, invalid_grant)
//   TransientError try again later (429, 5xx, timeouts, network, non-JSON);
//                  carries `retryAfterMs` when the response said how long
//   Error          anything else: neither retryable nor a reason to re-login
// No token or credential value ever appears in a message or a log line here;
// error text carries only a status and a URL path.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { p } from "../paths.ts";
import type { Window } from "../pick.ts";

// --- Proven constants (data/lib/providers/claude.ts) -------------------
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** The usage endpoint expects Claude Code's UA; other UAs land in an
 *  aggressively rate-limited bucket (anthropics/claude-code#31637) — copied
 *  from the dashboard provider along with the value. */
const USER_AGENT = "claude-code/2.1.220";
/** The OAuth beta header both endpoints and the token endpoint require. */
const OAUTH_BETA = "oauth-2025-04-20";
/** The keychain service Claude Code stores its OAuth credentials under
 *  (data/lib/keychain.ts; spec §12). */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** `security` can block forever on a locked keychain — a GUI prompt nobody
 *  will answer. Bounded exactly as data/lib/keychain.ts bounds it: a call that
 *  has not answered in time reads as "no keychain credential". */
const KEYCHAIN_TIMEOUT_MS = 3_000;

export class AuthError extends Error {
  override name = "AuthError";
}
export class TransientError extends Error {
  override name = "TransientError";
  /** What the endpoint asked us to wait, in milliseconds, when it said so
   *  (`retry-after` on a 429 or a 503). Advisory and unbounded-by-us beyond a
   *  day: a caller decides how long it is actually willing to sit out, and
   *  src/snapshot.ts clamps it to 15 minutes. Absent when the response carried
   *  no usable advice. */
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Nothing past this is advice worth carrying; `retry-after` is attacker- and
 *  accident-reachable, and a header must never be able to park an account for
 *  longer than the caller's own clamp would. */
const RETRY_AFTER_MAX_MS = 86_400_000;

/** `retry-after`, per RFC 9110 §10.2.3: either delta-seconds or an HTTP-date.
 *  Bounded parse — absent, malformed, non-positive or absurd all read as "no
 *  advice" (undefined) rather than as zero, so a caller can tell "wait this
 *  long" from "it did not say". */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  let ms: number;
  if (/^\d{1,9}$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return undefined;
    ms = at - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

const retryAfterOf = (res: Response): number | undefined => parseRetryAfter(res.headers.get("retry-after"));

export type PollCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  source: "file" | "keychain";
};
export type Usage = { session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null };
export type Profile = { email: string; orgId: string; orgName: string; tier: string | null };

// --- Reading the credential -------------------------------------------

function parseCredFile(txt: string): PollCredentials | null {
  const j = JSON.parse(txt) as {
    claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number };
  };
  const o = j.claudeAiOauth;
  if (!o?.accessToken || !o.refreshToken) return null;
  return { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: o.expiresAt ?? 0, source: "file" };
}

const credFile = (name: string) => path.join(p.claudeConfigDir(name), ".credentials.json");

/** The poll grant for `name`: the credentials file first, then the keychain.
 *
 *  On macOS a custom CLAUDE_CONFIG_DIR keeps its credentials in a keychain
 *  item keyed to that dir (spec §12), so there is no account string to guess:
 *  `ms accounts login` (Task 10) records the real one in
 *  `claude/<name>/keychain-account` when it mints the grant. No such file ⇒
 *  the keychain is not tried at all. Returns null — never throws — when there
 *  is nothing usable; a present-but-unusable file is "no credential", not a
 *  reason to go looking elsewhere (the tool owns that dir). */
export function readPollCredentials(name: string): PollCredentials | null {
  const dir = p.claudeConfigDir(name);
  const f = path.join(dir, ".credentials.json");
  if (existsSync(f)) {
    try {
      return parseCredFile(readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  }
  const accFile = path.join(dir, "keychain-account");
  if (!existsSync(accFile)) return null;
  let acct: string;
  try {
    acct = readFileSync(accFile, "utf8").trim();
  } catch {
    return null;
  }
  if (!acct) return null;
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", acct, "-w"],
    { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS },
  );
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  try {
    const c = parseCredFile(r.stdout.trim());
    return c ? { ...c, source: "keychain" } : null;
  } catch {
    return null;
  }
}

// --- Refresh, with write-back -----------------------------------------

/** Atomic, best-effort, never throws: a refresh that landed must not be lost
 *  to a write problem, and the write-back signal is a note, not an error (the
 *  dashboard learned this — an errored account drops out of the pool). The
 *  caller holds the fresh credential in memory either way. */
function writeBack(name: string, c: PollCredentials): boolean {
  // A keychain write-back would put the secret on `security`'s argv, where
  // every process on the box can read it; Claude Code's own refresh keeps that
  // copy fresh, so we simply re-read it next time.
  if (c.source !== "file") return true;
  const f = credFile(name);
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    // Keep every other key in the file (Claude Code owns the rest of it).
    let j: Record<string, unknown> = {};
    if (existsSync(f)) {
      const parsed: unknown = JSON.parse(readFileSync(f, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
    }
    const prev = (j.claudeAiOauth ?? {}) as Record<string, unknown>;
    j.claudeAiOauth = { ...prev, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt };
    writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
    renameSync(tmp, f);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* nothing more to do */
    }
    // The path is the operator's own machine, not a secret; the token is never
    // named. One line on stderr so a stranded refresh token is not silent.
    console.error(
      `ms: could not write refreshed Claude credentials back to ${f} — ` +
        `using them in memory for this run only. (No token value is ever logged.)`,
    );
    return false;
  }
}

/** The token endpoint's success body, as far as this file uses it. */
type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

/** `invalid_grant` anywhere in a token-endpoint body means the refresh token is
 *  spent or revoked — an auth failure whatever the status says. The body is
 *  only ever inspected, never echoed. */
function isInvalidGrant(body: string): boolean {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    return j?.error === "invalid_grant";
  } catch {
    return false;
  }
}

/** Classifies a thrown `fetch`. Deadline reached ⇒ TransientError; a network
 *  fault ⇒ TransientError; but a caller-initiated abort is **cancellation**,
 *  not a transient failure, so its own reason is rethrown here (returning a
 *  TransientError would tell the caller "try again" about a call it cancelled
 *  itself, and would hide its reason). */
function transientFromFetchError(err: unknown, what: string, signal: AbortSignal): TransientError {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    const reasonName = reason instanceof Error ? reason.name : "";
    if (reasonName !== "TimeoutError") throw reason ?? err;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new TransientError(`${what} timed out`);
  return new TransientError(`${what} could not be reached`);
}

/** Exchange the refresh token for a fresh access token and write the result
 *  back to wherever the credential came from (file only — see writeBack).
 *  Throws AuthError when the grant is dead, TransientError when it is worth
 *  trying again. */
export async function refreshPollCredentials(
  name: string,
  c: PollCredentials,
  signal: AbortSignal,
): Promise<PollCredentials> {
  let res: Response;
  try {
    res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      signal,
      // Header set copied from data/lib/providers/claude.ts.
      headers: { "Content-Type": "application/json", "anthropic-beta": OAUTH_BETA },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: c.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw transientFromFetchError(err, "the token endpoint", signal);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (isInvalidGrant(body)) throw new AuthError("refresh rejected: invalid_grant");
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AuthError(`refresh rejected (${res.status})`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`refresh failed (${res.status})`, retryAfterOf(res));
    }
    throw new Error(`refresh failed (${res.status})`);
  }

  // A 200 whose body isn't JSON (a captive portal, a proxy's error page) is a
  // transient network condition, not a dead grant. The body is never surfaced.
  const raw = await res.text().catch(() => "");
  let j: TokenResponse;
  try {
    j = JSON.parse(raw) as TokenResponse;
  } catch {
    throw new TransientError("token endpoint returned non-JSON");
  }
  if (j.error === "invalid_grant") throw new AuthError("refresh rejected: invalid_grant");
  // A 200 with no access_token would mint a credential the next usage call
  // rejects with a 401 — which is exactly what happened before the dashboard
  // named this shape.
  if (!j.access_token) throw new TransientError("token endpoint returned no access token");

  const next: PollCredentials = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? c.refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    source: c.source,
  };
  writeBack(name, next);
  return next;
}

// --- The two authenticated reads --------------------------------------

async function authed(url: string, c: PollCredentials, signal: AbortSignal): Promise<unknown> {
  const where = new URL(url).pathname;
  let res: Response;
  try {
    // Header set copied from data/lib/providers/claude.ts, per endpoint: there
    // the usage call alone also carries Content-Type. Both sets are the proven
    // ones, so neither is "tidied" here.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${c.accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
    };
    if (url === CLAUDE_USAGE_URL) headers["Content-Type"] = "application/json";
    res = await fetch(url, { signal, headers });
  } catch (err) {
    throw transientFromFetchError(err, where, signal);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new AuthError(`${res.status} from ${where}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new TransientError(`${res.status} from ${where}`, retryAfterOf(res));
  }
  if (!res.ok) throw new Error(`${res.status} from ${where}`);
  const raw = await res.text().catch(() => "");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TransientError(`non-JSON body from ${where}`);
  }
}

/** One limit as the endpoint reports it. The live API names the fields
 *  `percent` and `scope.model.display_name` (what the author's dashboard
 *  reads); `used_percent`/`display_name` are the flatter form. Both are
 *  accepted — reading only one would report every window as 0 %, which the
 *  chooser reads as "plenty of room". */
type RawLimit = {
  kind?: string;
  percent?: number;
  used_percent?: number;
  display_name?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
  resets_at?: string | null;
};

// The attested names come first: `percent` and `scope.model.display_name` are
// what the author's working poller reads off the live endpoint today.
// `used_percent`/`display_name` are unattested aliases (the brief's flatter
// form) and are only consulted when the attested field is absent.
const limitPercent = (l: RawLimit): number => Number(l.percent ?? l.used_percent ?? NaN);
const limitDisplayName = (l: RawLimit): string => l.scope?.model?.display_name ?? l.display_name ?? "";

/** The three windows the chooser needs, raw: `usedPercent` is never rounded
 *  (99.6 is not 100 — src/pick.ts gates on exactly 100). A window the account
 *  does not have stays null; pick.ts has its own reasons for that. */
export async function fetchUsage(c: PollCredentials, signal: AbortSignal): Promise<Usage> {
  const j = (await authed(CLAUDE_USAGE_URL, c, signal)) as { limits?: RawLimit[] };
  const u: Usage = { session: null, weeklyAll: null, weeklyFable: null };
  // A `limits` that is not an array (an older or unexpected shape) is "no
  // windows", never a crash: pick.ts already has reasons for a missing window.
  const limits = Array.isArray(j?.limits) ? j.limits : [];
  for (const l of limits) {
    const w: Window = { usedPercent: limitPercent(l), resetsAt: l.resets_at ?? null };
    if (l.kind === "session") u.session = w;
    else if (l.kind === "weekly_all") u.weeklyAll = w;
    else if (l.kind === "weekly_scoped" && /fable/i.test(limitDisplayName(l))) u.weeklyFable = w;
  }
  return u;
}

/** The account behind this grant. `orgId` is the identity the registry keys on
 *  (spec §6: "identity is the organisation id"); an email can span orgs. */
export async function fetchProfile(c: PollCredentials, signal: AbortSignal): Promise<Profile> {
  const j = (await authed(CLAUDE_PROFILE_URL, c, signal)) as {
    account?: { email?: string };
    organization?: { uuid?: string; name?: string; rate_limit_tier?: string };
  };
  return {
    email: j?.account?.email ?? "",
    orgId: j?.organization?.uuid ?? "",
    orgName: j?.organization?.name ?? "",
    tier: j?.organization?.rate_limit_tier ?? null,
  };
}
