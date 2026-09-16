import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { readCodexCredentials, refreshCodexCredentials, fetchCodexUsage, codexIdentity, CODEX_USAGE_URL, CODEX_TOKEN_URL } from "../src/providers/codex-usage.ts";
import { AuthError, TransientError } from "../src/providers/claude-usage.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
function home(auth: object): string {
  const d = mkdtempSync(path.join(tmpdir(), "ms-codex-"));
  writeFileSync(path.join(d, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return d;
}
const AUTH = { auth_mode: "chatgpt", tokens: { id_token: idToken({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }), access_token: "at-1", refresh_token: "rt-1", account_id: "acct-1" }, last_refresh: "2026-09-15T00:00:00Z" };

test("readCodexCredentials reads auth.json and null when absent or malformed", () => {
  assert.deepEqual(readCodexCredentials(home(AUTH))?.tokens.account_id, "acct-1");
  assert.equal(readCodexCredentials(mkdtempSync(path.join(tmpdir(), "ms-none-"))), null);
  const d = home(AUTH); writeFileSync(path.join(d, "auth.json"), "{ nope");
  assert.equal(readCodexCredentials(d), null);
});

test("codexIdentity comes from the id token claims", () => {
  assert.deepEqual(codexIdentity(readCodexCredentials(home(AUTH))!), { accountId: "acct-1", email: "a@b.c" });
});

test("fetchCodexUsage maps primary/secondary windows and never sends the refresh token", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 42, reset_at: 1789600000, reset_after_seconds: 3000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 7, reset_at: 1790000000, reset_after_seconds: 400000, limit_window_seconds: 604800 } } }), { status: 200 });
  }) as typeof fetch;
  const u = await fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000));
  assert.equal(seen[0].url, CODEX_USAGE_URL);
  assert.equal(seen[0].headers["chatgpt-account-id"], "acct-1");
  assert.equal(seen[0].headers["authorization"], "Bearer at-1");
  assert.equal(JSON.stringify(seen).includes("rt-1"), false);
  assert.equal(u.session?.usedPercent, 42);
  assert.equal(u.weeklyAll?.usedPercent, 7);
  assert.equal(u.weeklyFable, null);
  assert.equal(u.session?.resetsAt, new Date(1789600000 * 1000).toISOString());
});

test("an untouched window (reset a full window away) has a null reset", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 0, reset_at: 1789600000, reset_after_seconds: 18000, limit_window_seconds: 18000 } } }), { status: 200 })) as typeof fetch;
  const u = await fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000));
  assert.equal(u.session?.resetsAt, null);
});

test("401/403 are auth, 429/5xx/network are transient with retry-after", async () => {
  for (const [status, cls] of [[401, AuthError], [403, AuthError], [429, TransientError], [503, TransientError]] as const) {
    globalThis.fetch = (async () => new Response("no", { status, headers: status === 429 ? { "retry-after": "7" } : {} })) as typeof fetch;
    await assert.rejects(fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000)), (e: Error) => e instanceof cls && (status !== 429 || (e as TransientError).retryAfterMs === 7000));
  }
});

test("refreshCodexCredentials posts the refresh grant, writes back atomically at 0600, keeps unrelated keys", async () => {
  const d = home({ ...AUTH, extra: "keep" });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, CODEX_TOKEN_URL);
    const body = JSON.parse(String(init.body));
    assert.equal(body.grant_type, "refresh_token"); assert.equal(body.refresh_token, "rt-1");
    return new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", id_token: AUTH.tokens.id_token }), { status: 200 });
  }) as typeof fetch;
  const next = await refreshCodexCredentials(d, readCodexCredentials(d)!, AbortSignal.timeout(5000));
  assert.equal(next.tokens.access_token, "at-2");
  const onDisk = JSON.parse(readFileSync(path.join(d, "auth.json"), "utf8"));
  assert.equal(onDisk.tokens.refresh_token, "rt-2"); assert.equal(onDisk.extra, "keep");
  assert.equal(statSync(path.join(d, "auth.json")).mode & 0o777, 0o600);
  assert.match(onDisk.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
});

test("a refresh rejection is auth for invalid_grant/400/401 and transient for 5xx", async () => {
  const d = home(AUTH);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  await assert.rejects(refreshCodexCredentials(d, readCodexCredentials(d)!, AbortSignal.timeout(5000)), AuthError);
  globalThis.fetch = (async () => new Response("down", { status: 502 })) as typeof fetch;
  await assert.rejects(refreshCodexCredentials(d, readCodexCredentials(d)!, AbortSignal.timeout(5000)), TransientError);
});

test("windows are classified by duration: a Pro plan's single 168 h primary window is the weekly one", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 27, reset_at: 1790000000, reset_after_seconds: 400000, limit_window_seconds: 604800 } } }), { status: 200 })) as typeof fetch;
  const u = await fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000));
  assert.equal(u.session, null);
  assert.equal(u.weeklyAll?.usedPercent, 27);
  // And the reverse order of a two-window plan still lands each in its class.
  globalThis.fetch = (async () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 7, reset_at: 1790000000, reset_after_seconds: 400000, limit_window_seconds: 604800 }, secondary_window: { used_percent: 42, reset_at: 1789600000, reset_after_seconds: 3000, limit_window_seconds: 18000 } } }), { status: 200 })) as typeof fetch;
  const v = await fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000));
  assert.equal(v.session?.usedPercent, 42);
  assert.equal(v.weeklyAll?.usedPercent, 7);
});
