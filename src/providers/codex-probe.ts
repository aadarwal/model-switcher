// src/providers/codex-probe.ts
//
// A SEAM, not the Codex usage provider.
//
// Task 3 of this plan writes the real poller (`src/providers/codex-usage.ts`:
// windows, refresh, backoff, the error contract src/snapshot.ts consumes). The
// account book needs only one question answered — *does this account's
// `auth.json` still work?* — so it is answered here directly, with one bounded
// `fetch`, and Task 4 replaces the BODY of `probeCodexUsage` with a call into
// Task 3's `fetchCodexUsage` without changing its signature.
//
// `auth.json` is written by `codex login` into that account's own CODEX_HOME
// (src/paths.ts's `codexHome`); this module only ever READS it. Nothing here
// logs, prints or returns a token: the probe's whole answer is one of three
// words, and `readCodexAuth`'s access token exists solely to become an
// `Authorization` header in this file.

import { readFileSync } from "node:fs";
import path from "node:path";

/** Where a ChatGPT subscription's usage windows live. Same host and path the
 *  Codex CLI itself reads; the account book only cares about the status. */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** The claim namespace ChatGPT puts its own account id under, inside the
 *  `id_token` a device login mints. */
const AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * ok         the credential answered (200)
 * auth       the credential is absent, unreadable or refused (401/403) — re-login
 * transient  anything else: a 429, a 5xx, a timeout, a dead network. Try later.
 */
export type CodexProbe = "ok" | "auth" | "transient";

export type CodexAuth = {
  /** The bearer for a usage read. Never logged, never printed, never stored. */
  accessToken: string | null;
  /** The ChatGPT account id — the IDENTITY a Codex row is keyed by, exactly as
   *  the organisation id is a Claude row's. */
  accountId: string | null;
  email: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** The middle segment of a JWT, as JSON. The signature is NOT checked and does
 *  not need to be: this token came out of a login this process just ran, into
 *  a directory this process owns, and the claim is read to LABEL the account,
 *  never to authorise anything. A malformed token simply names nobody. */
function idTokenClaims(idToken: unknown): Record<string, unknown> | null {
  const middle = typeof idToken === "string" ? idToken.split(".")[1] : undefined;
  if (!middle) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(middle, "base64url").toString("utf8")));
  } catch {
    return null; // not a JWT, or not JSON inside one
  }
}

/**
 * `<dir>/auth.json`, as the account book needs it: null when the file is
 * absent, unreadable or not JSON — all of which mean the same thing to every
 * caller ("this account has not logged in"), which is why they are not
 * distinguished here.
 *
 * The identity is the id_token's own `chatgpt_account_id` claim, falling back
 * to the sibling `tokens.account_id` field: a login is free to write one, the
 * other, or both, and the claim is the one minted by the identity provider.
 */
export function readCodexAuth(dir: string): CodexAuth | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8"));
  } catch {
    return null;
  }
  const top = asRecord(raw);
  if (!top) return null;
  const tokens = asRecord(top.tokens) ?? {};
  const claims = idTokenClaims(tokens.id_token) ?? {};
  const authClaim = asRecord(claims[AUTH_CLAIM]) ?? {};
  return {
    accessToken: str(tokens.access_token) ?? str(top.access_token),
    accountId: str(authClaim.chatgpt_account_id) ?? str(tokens.account_id) ?? str(top.account_id),
    email: str(claims.email) ?? str(authClaim.chatgpt_user_email),
  };
}

/**
 * One bounded read of the usage endpoint under this account's own credential.
 *
 * The request carries exactly two things: the access token as a bearer, and
 * the account id as `ChatGPT-Account-Id` (a ChatGPT credential can hold more
 * than one workspace, and the header is what says which). The REFRESH token
 * sits in the same file and never leaves it — nothing here has any use for it,
 * and refreshing is Task 3's job, under a lock, not a probe's.
 *
 * `signal` is the caller's bound; an abort reads as `transient`, because a
 * probe we gave up on says nothing about the credential.
 */
export async function probeCodexUsage(dir: string, signal: AbortSignal): Promise<CodexProbe> {
  const auth = readCodexAuth(dir);
  // No credential at all is the SAME answer as a refused one — re-login — and
  // it costs no request, so `ms accounts ls` over a book of un-logged-in codex
  // rows touches the network zero times.
  if (!auth?.accessToken) return "auth";
  let res: Response;
  try {
    res = await fetch(CODEX_USAGE_URL, {
      signal,
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      },
    });
  } catch {
    return "transient"; // network, DNS, TLS, or our own abort
  }
  // The body is never read — only the status is an answer — so it is cancelled
  // rather than left to hold a socket (and the process) open.
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed or never had one */
  }
  if (res.status === 200) return "ok";
  if (res.status === 401 || res.status === 403) return "auth";
  return "transient";
}
