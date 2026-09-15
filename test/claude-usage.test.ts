// Keychain account form: the poll grant for a custom CLAUDE_CONFIG_DIR keeps
// its credentials under the keychain service "Claude Code-credentials" with a
// dir-specific `acct` value (spec §12, "Claude keychain"). The exact form of
// that account string is NOT probed here: spike S0 (a live `claude auth login`
// against a throwaway config dir) needs a browser login by the human and is
// deferred. It is confirmed instead at `ms accounts login` time (Task 10),
// which reads the account back off the freshly-minted item and records it in
// `claude/<name>/keychain-account`, and again in the live matrix. So this
// module never guesses an account form: the file is tried first, and the
// keychain only when that recorded file exists. These tests stub `security` on
// PATH and `globalThis.fetch`; they never touch the real keychain, `~/.claude`,
// or the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

function env() {
  const { home, msHome } = tempHome();
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const dir = path.join(msHome, "claude", "gmail");
  mkdirSync(dir, { recursive: true });
  return { dir, msHome };
}
const cred = {
  claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 },
};

test("readPollCredentials prefers the credentials file", async () => {
  const { dir } = env();
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(cred));
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail")!.source, "file");
  assert.equal(readPollCredentials("gmail")!.accessToken, "at-1");
});

test("readPollCredentials falls back to the keychain account recorded at login", async () => {
  const { dir } = env();
  writeFileSync(path.join(dir, "keychain-account"), "aadarwal-abc123\n");
  const { stub, dir: bin } = stubDir();
  process.env.PATH = `${bin}:${process.env.PATH}`;
  stub("security", `case "$*" in *"-a aadarwal-abc123"*) printf '%s' '${JSON.stringify(cred)}' ;; *) exit 44 ;; esac`);
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail")!.source, "keychain");
  // Proves it came from the stub, not from anything on the real keychain.
  assert.equal(readPollCredentials("gmail")!.accessToken, "at-1");
});

test("readPollCredentials is null with neither a file nor a recorded keychain account", async () => {
  env();
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail"), null);
});

test("fetchUsage maps the three windows raw and classifies errors", async () => {
  env();
  const { fetchUsage, AuthError } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  globalThis.fetch = (async () => new Response(JSON.stringify({ limits: [
    { kind: "session", used_percent: 99.6, resets_at: "2026-09-15T05:00:00Z" },
    { kind: "weekly_all", used_percent: 40, resets_at: "2026-09-18T00:00:00Z" },
    { kind: "weekly_scoped", display_name: "Fable", used_percent: 100, resets_at: "2026-09-18T00:00:00Z" },
  ] }), { status: 200 })) as typeof fetch;
  const u = await fetchUsage(c, AbortSignal.timeout(1000));
  assert.equal(u.session!.usedPercent, 99.6); assert.equal(u.weeklyFable!.usedPercent, 100);
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  await assert.rejects(fetchUsage(c, AbortSignal.timeout(1000)), AuthError);
});

// The live endpoint (as the author's working dashboard provider reads it)
// names the same fields `percent` and `scope.model.display_name`; the fixture
// above is the brief's. Reading only one of the two shapes would report every
// window as 0 % against the real API, which the chooser would read as "plenty
// of room" — so both are accepted.
test("fetchUsage also reads the live shape: percent and scope.model.display_name", async () => {
  env();
  const { fetchUsage } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  globalThis.fetch = (async () => new Response(JSON.stringify({ limits: [
    { kind: "session", percent: 12.5, resets_at: "2026-09-15T05:00:00Z", is_active: true },
    { kind: "weekly_all", percent: 40, resets_at: "2026-09-18T00:00:00Z" },
    { kind: "weekly_scoped", scope: { model: { display_name: "Claude Fable 4.5" } }, percent: 77, resets_at: null },
    { kind: "weekly_scoped", scope: { model: { display_name: "Claude Opus 4.1" } }, percent: 3, resets_at: null },
  ] }), { status: 200 })) as typeof fetch;
  const u = await fetchUsage(c, AbortSignal.timeout(1000));
  assert.equal(u.session!.usedPercent, 12.5);
  assert.equal(u.weeklyAll!.usedPercent, 40);
  assert.equal(u.weeklyFable!.usedPercent, 77);
  assert.equal(u.weeklyFable!.resetsAt, null);
});

test("fetchProfile reads the account email and the organisation", async () => {
  env();
  const { fetchProfile } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    account: { email: "someone@example.com" },
    organization: { uuid: "org-uuid-1", name: "Someone's Org", rate_limit_tier: "default_claude_max_20x" },
  }), { status: 200 })) as typeof fetch;
  const prof = await fetchProfile(c, AbortSignal.timeout(1000));
  assert.deepEqual(prof, {
    email: "someone@example.com", orgId: "org-uuid-1",
    orgName: "Someone's Org", tier: "default_claude_max_20x",
  });
});

test("429, 5xx, a non-JSON body and a network failure are transient; 403 is auth", async () => {
  env();
  const { fetchUsage, AuthError, TransientError } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  const sig = () => AbortSignal.timeout(1000);

  globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
  await assert.rejects(fetchUsage(c, sig()), TransientError);
  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  await assert.rejects(fetchUsage(c, sig()), TransientError);
  globalThis.fetch = (async () => new Response("<html>captive portal</html>", { status: 200 })) as typeof fetch;
  await assert.rejects(fetchUsage(c, sig()), TransientError);
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(fetchUsage(c, sig()), TransientError);

  globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  await assert.rejects(fetchUsage(c, sig()), AuthError);
  // Anything else is a plain Error — neither retryable nor a reason to re-login.
  globalThis.fetch = (async () => new Response("{}", { status: 418 })) as typeof fetch;
  await assert.rejects(fetchUsage(c, sig()), (e: unknown) =>
    e instanceof Error && !(e instanceof AuthError) && !(e instanceof TransientError));
});

test("refreshPollCredentials writes the rotated refresh token back to the file", async () => {
  const { dir } = env();
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(cred));
  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
  const c2 = await refreshPollCredentials("gmail", readPollCredentials("gmail")!, AbortSignal.timeout(1000));
  assert.equal(c2.refreshToken, "rt-2");
  assert.equal(JSON.parse(readFileSync(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken, "rt-2");
});

test("refreshPollCredentials keeps unrelated keys in the credentials file", async () => {
  const { dir } = env();
  const file = path.join(dir, ".credentials.json");
  writeFileSync(file, JSON.stringify({ ...cred, otherThing: { keep: true } }));
  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "at-2", expires_in: 60 }), { status: 200 })) as typeof fetch;
  const c2 = await refreshPollCredentials("gmail", readPollCredentials("gmail")!, AbortSignal.timeout(1000));
  // No rotated refresh token in the response: the existing one stays.
  assert.equal(c2.refreshToken, "rt-1");
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(written.otherThing, { keep: true });
  assert.equal(written.claudeAiOauth.accessToken, "at-2");
  assert.ok(written.claudeAiOauth.expiresAt > Date.now());
});

test("refreshPollCredentials never writes back a keychain-sourced credential", async () => {
  const { dir } = env();
  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  writeFileSync(path.join(dir, "keychain-account"), "aadarwal-abc123\n");
  const { stub, dir: bin } = stubDir();
  process.env.PATH = `${bin}:${process.env.PATH}`;
  stub("security", `case "$*" in *"-a aadarwal-abc123"*) printf '%s' '${JSON.stringify(cred)}' ;; *) exit 44 ;; esac`);
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
  const c = readPollCredentials("gmail")!;
  assert.equal(c.source, "keychain");
  const c2 = await refreshPollCredentials("gmail", c, AbortSignal.timeout(1000));
  assert.equal(c2.accessToken, "at-2");
  assert.equal(c2.source, "keychain");
  // Writing it would put the secret on `security`'s argv; the CLI owns that copy.
  assert.equal(readPollCredentials("gmail")!.source, "keychain");
});

test("refresh rejections: invalid_grant and 400/401 are auth, 5xx is transient", async () => {
  env();
  const { refreshPollCredentials, AuthError, TransientError } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  const sig = () => AbortSignal.timeout(1000);

  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  await assert.rejects(refreshPollCredentials("gmail", c, sig()), AuthError);
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  await assert.rejects(refreshPollCredentials("gmail", c, sig()), AuthError);
  globalThis.fetch = (async () => new Response("{}", { status: 502 })) as typeof fetch;
  await assert.rejects(refreshPollCredentials("gmail", c, sig()), TransientError);
  // A 200 that is not JSON, and a 200 with no access token, are both transient.
  globalThis.fetch = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
  await assert.rejects(refreshPollCredentials("gmail", c, sig()), TransientError);
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  await assert.rejects(refreshPollCredentials("gmail", c, sig()), TransientError);
});

test("no token or credential value ever appears in an error message", async () => {
  env();
  const { fetchUsage, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  const secret = "SEKRET-TOKEN-VALUE";
  const c = { accessToken: secret, refreshToken: `${secret}-refresh`, expiresAt: 0, source: "file" as const };
  const messages: string[] = [];
  for (const [status, body] of [[401, "{}"], [429, secret], [500, secret], [418, "{}"]] as const) {
    globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
    await fetchUsage(c, AbortSignal.timeout(1000)).catch((e: Error) => messages.push(`${e.name}: ${e.message}`));
    await refreshPollCredentials("gmail", c, AbortSignal.timeout(1000)).catch((e: Error) => messages.push(`${e.name}: ${e.message}`));
  }
  assert.equal(messages.length, 8);
  for (const m of messages) assert.ok(!m.includes(secret), `leaked a credential: ${m}`);
});

test("the proven endpoints, token URL and client id are the dashboard's", async () => {
  const m = await import("../src/providers/claude-usage.ts");
  assert.equal(m.CLAUDE_USAGE_URL, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(m.CLAUDE_PROFILE_URL, "https://api.anthropic.com/api/oauth/profile");
  assert.equal(m.CLAUDE_TOKEN_URL, "https://platform.claude.com/v1/oauth/token");
  assert.equal(m.CLAUDE_CLIENT_ID, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
});

test("the usage and profile calls carry Claude Code's proven header set", async () => {
  env();
  const { fetchUsage, CLAUDE_USAGE_URL } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at-9", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  let seen: { url: string; headers: Headers } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), headers: new Headers(init.headers) };
    return new Response(JSON.stringify({ limits: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  await fetchUsage(c, AbortSignal.timeout(1000));
  const got = seen as unknown as { url: string; headers: Headers };
  assert.equal(got.url, CLAUDE_USAGE_URL);
  assert.equal(got.headers.get("authorization"), "Bearer at-9");
  assert.equal(got.headers.get("anthropic-beta"), "oauth-2025-04-20");
  // Other UAs land in an aggressively rate-limited bucket (see the provider).
  assert.match(got.headers.get("user-agent") ?? "", /^claude-code\//);
});
