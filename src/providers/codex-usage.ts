// src/providers/codex-usage.ts
//
// The Codex credential: `codex login` writes `auth.json` straight into
// CODEX_HOME (no keychain indirection like the Claude poll grant), carrying
// both the *launch* material (id_token/access_token/refresh_token) and the
// account id `wham/usage` wants on every request. One file, one credential —
// unlike Claude there is no separate launch-vs-poll split here, so the same
// tokens both run `codex` as the account and read its usage.
//
// Endpoint, token URL, client id, the `wham/usage` response shape and the
// "untouched window" rule are COPIED VERBATIM from the author's working
// poller at data/lib/providers/openai.ts (`fetchOpenAIUsage`) — the version
// proven against these endpoints. Nothing here is invented, and this tool
// carries no OAuth client code of its own (spec §6). The differences from
// that source are deliberate and narrow: the credential file is `auth.json`
// under the caller-supplied dir (not `~/.codex` via CODEX_HOME expansion),
// the refresh body drops the `scope` field, and errors classify through the
// same AuthError/TransientError contract `claude-usage.ts` already defines
// rather than returning an `AccountUsage` error string.
//
// Error contract (identical to claude-usage.ts):
//   AuthError      the credential is dead — re-login
//   TransientError try again later (429, 5xx, timeouts, network, non-JSON);
//                  carries `retryAfterMs` when the response said how long
//   Error          anything else: neither retryable nor a reason to re-login
// No token or credential value ever appears in a message here. The refresh
// token is used only in the refresh POST body — never on a usage request.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
// `Usage` is defined in claude-usage.ts (re-exporting `Window` from pick.ts),
// not in pick.ts itself — imported from where it actually lives.
import { AuthError, TransientError, parseRetryAfter, type Usage } from "./claude-usage.ts";
import type { Window } from "../pick.ts";

// --- Proven constants (data/lib/providers/openai.ts) -------------------
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type CodexAuth = {
  auth_mode?: string;
  tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string };
  last_refresh?: string;
};

const authFile = (dir: string) => path.join(dir, "auth.json");

/** `auth.json` for a Codex account dir. Returns null — never throws — for a
 *  missing dir/file, invalid JSON, or a parsed object missing any of the
 *  four token fields `fetchCodexUsage`/`codexIdentity` depend on. */
export function readCodexCredentials(dir: string): CodexAuth | null {
  try {
    const auth = JSON.parse(readFileSync(authFile(dir), "utf8")) as CodexAuth;
    const t = auth?.tokens;
    if (!t?.access_token || !t.refresh_token || !t.id_token || !t.account_id) return null;
    return auth;
  } catch {
    return null;
  }
}

/** Decodes a JWT's middle segment as base64url JSON. No signature check —
 *  this is identity read from a token we already trust (it came out of our
 *  own auth.json), never a verification step. */
function decodeJwtClaims(jwt: string): Record<string, unknown> {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Identity from the id token's namespaced claims, with `tokens.account_id`
 *  as the fallback when the claim is absent — mirrors the dashboard's
 *  `fetchOpenAIUsage`, which reads identity the same way so an account still
 *  shows who it is even off a token whose claims are sparse. */
export function codexIdentity(auth: CodexAuth): { accountId: string; email: string | null } {
  const claims = decodeJwtClaims(auth.tokens.id_token);
  const authClaims = (claims["https://api.openai.com/auth"] ?? {}) as { chatgpt_account_id?: string };
  return {
    accountId: authClaims.chatgpt_account_id ?? auth.tokens.account_id,
    email: (claims.email as string | undefined) ?? null,
  };
}

/** Classifies a thrown `fetch`. Deadline reached ⇒ TransientError; a network
 *  fault ⇒ TransientError; but a caller-initiated abort is cancellation, not
 *  a transient failure, so its own reason is rethrown — identical logic to
 *  claude-usage.ts's private helper of the same shape. */
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

/** `invalid_grant` anywhere in a token-endpoint body means the refresh token
 *  is spent or revoked — an auth failure whatever the status says. The body
 *  is only ever inspected, never echoed. */
function isInvalidGrant(body: string): boolean {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    return j?.error === "invalid_grant";
  } catch {
    return false;
  }
}

type RawWindow = {
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
};

/** One rate-limit window as `wham/usage` reports it, mapped to this tool's
 *  `Window`. `usedPercent` is carried raw, unrounded — `pick.ts` gates
 *  exactly at 100, and rounding a 99.6 up to 100 would wall an account that
 *  still has room (the same reasoning `claude-usage.ts` documents for its
 *  own Window values).
 *
 *  An untouched window whose reset sits a full window away isn't running:
 *  its `reset_at` is a synthetic "now + window", recomputed every poll. A
 *  null `resetsAt` renders as "not started" instead of a sliding countdown —
 *  copied verbatim from the dashboard's `toWindow`. */
function toWindow(w: RawWindow): Window {
  const usedPercent = w.used_percent ?? 0;
  const notStarted =
    usedPercent === 0 &&
    w.reset_after_seconds != null &&
    w.limit_window_seconds != null &&
    w.reset_after_seconds >= w.limit_window_seconds;
  return {
    usedPercent,
    resetsAt: !notStarted && w.reset_at != null ? new Date(w.reset_at * 1000).toISOString() : null,
  };
}

/** The two windows `wham/usage` reports, mapped onto this tool's three-window
 *  `Usage`: windows are classified by their DURATION, never by position —
 *  a Pro plan reports only one window (168 h) and it arrives as
 *  `primary_window` (verified live 2026-09-16): under 24 h → session, else
 *  weeklyAll; with two of one class, the shorter is the session.
 *  Codex has no Fable-scoped window, so `weeklyFable` is always null.
 *  Never sends the refresh token — only `access_token` (bearer) and
 *  `account_id` (the `ChatGPT-Account-Id` header) leave this function. */
export async function fetchCodexUsage(auth: CodexAuth, signal: AbortSignal): Promise<Usage> {
  let res: Response;
  try {
    res = await fetch(CODEX_USAGE_URL, {
      signal,
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        "ChatGPT-Account-Id": auth.tokens.account_id,
        "User-Agent": "codex-cli",
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw transientFromFetchError(err, "the usage endpoint", signal);
  }

  if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status} from wham/usage`);
  if (res.status === 429 || res.status >= 500) {
    throw new TransientError(`${res.status} from wham/usage`, parseRetryAfter(res.headers.get("retry-after")));
  }
  if (!res.ok) throw new Error(`${res.status} from wham/usage`);

  const raw = await res.text().catch(() => "");
  let data: { rate_limit?: { primary_window?: RawWindow | null; secondary_window?: RawWindow | null } };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new TransientError("non-JSON body from wham/usage");
  }

  const rl = data.rate_limit;
  return {
    session: classify(rl).session,
    weeklyAll: classify(rl).weeklyAll,
    weeklyFable: null,
  };
}

/** The token endpoint's success body, as far as this file uses it. */
type TokenResponse = { access_token?: string; refresh_token?: string; id_token?: string };

/** Atomic (temp + rename), 0600. `dir` is the account's CODEX_HOME; the
 *  caller holds `withLock("account-codex-<name>")` around this call. */
function writeCodexCredentials(dir: string, auth: CodexAuth): void {
  const file = authFile(dir);
  const tmp = path.join(dir, `auth.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Exchange the refresh token for a fresh access token and write the result
 *  back to `auth.json`, keeping every unrelated key in the file (`auth_mode`
 *  and anything else `codex login` put there). Throws AuthError when the
 *  grant is dead, TransientError when it is worth trying again. Never logs —
 *  neither the refresh token nor the response body is ever printed. */
export async function refreshCodexCredentials(
  dir: string,
  auth: CodexAuth,
  signal: AbortSignal,
): Promise<CodexAuth> {
  let res: Response;
  try {
    res = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: auth.tokens.refresh_token,
        client_id: CODEX_CLIENT_ID,
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
      throw new TransientError(`refresh failed (${res.status})`, parseRetryAfter(res.headers.get("retry-after")));
    }
    throw new Error(`refresh failed (${res.status})`);
  }

  const raw = await res.text().catch(() => "");
  let data: TokenResponse;
  try {
    data = JSON.parse(raw) as TokenResponse;
  } catch {
    throw new TransientError("token endpoint returned non-JSON");
  }
  if (!data.access_token) throw new TransientError("token endpoint returned no access token");

  const next: CodexAuth = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? auth.tokens.refresh_token,
      id_token: data.id_token ?? auth.tokens.id_token,
    },
    last_refresh: new Date().toISOString(),
  };
  writeCodexCredentials(dir, next);
  return next;
}

/** Sort the reported windows into `session` (under a day) and `weeklyAll`
 *  (a day or longer) by `limit_window_seconds`; position is meaningless. */
function classify(rl: { primary_window?: RawWindow | null; secondary_window?: RawWindow | null } | undefined): { session: Window | null; weeklyAll: Window | null } {
  const raws = [rl?.primary_window, rl?.secondary_window].filter((w): w is RawWindow => !!w);
  const short = raws.filter((w) => (w.limit_window_seconds ?? 0) < 86_400).sort((a, b) => (a.limit_window_seconds ?? 0) - (b.limit_window_seconds ?? 0));
  const long = raws.filter((w) => (w.limit_window_seconds ?? 0) >= 86_400).sort((a, b) => (a.limit_window_seconds ?? 0) - (b.limit_window_seconds ?? 0));
  return { session: short[0] ? toWindow(short[0]) : null, weeklyAll: long[0] ? toWindow(long[0]) : null };
}
