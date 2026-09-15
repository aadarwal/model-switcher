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
// or the network. Every test restores fetch, PATH, HOME and MS_HOME in its own
// teardown, so nothing leaks into the next test or out of the file.

import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

type Saved = { fetch: typeof globalThis.fetch; HOME?: string; MS_HOME?: string; PATH?: string };
const save = (): Saved => ({
  fetch: globalThis.fetch,
  HOME: process.env.HOME,
  MS_HOME: process.env.MS_HOME,
  PATH: process.env.PATH,
});
function restore(s: Saved): void {
  globalThis.fetch = s.fetch;
  for (const k of ["HOME", "MS_HOME", "PATH"] as const) {
    const v = s[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const pristine = save();
after(() => restore(pristine));

function env(t: TestContext) {
  const before = save();
  t.after(() => restore(before));
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

test("readPollCredentials prefers the credentials file", async (t) => {
  const { dir } = env(t);
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(cred));
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail")!.source, "file");
  assert.equal(readPollCredentials("gmail")!.accessToken, "at-1");
});

test("readPollCredentials falls back to the keychain account recorded at login", async (t) => {
  const { dir } = env(t);
  writeFileSync(path.join(dir, "keychain-account"), "aadarwal-abc123\n");
  const { stub, dir: bin } = stubDir();
  process.env.PATH = `${bin}:${process.env.PATH}`;
  stub("security", `case "$*" in *"-a aadarwal-abc123"*) printf '%s' '${JSON.stringify(cred)}' ;; *) exit 44 ;; esac`);
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail")!.source, "keychain");
  // Proves it came from the stub, not from anything on the real keychain.
  assert.equal(readPollCredentials("gmail")!.accessToken, "at-1");
});

test("readPollCredentials is null with neither a file nor a recorded keychain account", async (t) => {
  env(t);
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail"), null);
});

test("fetchUsage maps the three windows raw and classifies errors", async (t) => {
  env(t);
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

// The attested shape: the live endpoint, as the author's working dashboard
// provider reads it, names these fields `percent` and `scope.model.display_name`
// and they take precedence. The brief's flatter `used_percent`/`display_name`
// (the test above) are unattested aliases, read only when the attested field is
// absent — reading neither form would report every window as 0 %, which the
// chooser takes for "plenty of room".
test("fetchUsage reads the attested shape: percent and scope.model.display_name", async (t) => {
  env(t);
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

test("fetchUsage survives a missing or non-array limits field", async (t) => {
  env(t);
  const { fetchUsage } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  const empty = { session: null, weeklyAll: null, weeklyFable: null };
  for (const body of ["{}", JSON.stringify({ limits: null }), JSON.stringify({ limits: "soon" })]) {
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    assert.deepEqual(await fetchUsage(c, AbortSignal.timeout(1000)), empty);
  }
});

test("fetchProfile reads the account email and the organisation", async (t) => {
  env(t);
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

test("429, 5xx, a non-JSON body and a network failure are transient; 403 is auth", async (t) => {
  env(t);
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

test("a caller's abort propagates; a deadline is transient", async (t) => {
  env(t);
  const { fetchUsage, refreshPollCredentials, TransientError } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };

  // Cancellation is the caller's own doing: its reason must survive, not be
  // relabelled "try again later".
  const cancelled = new Error("caller cancelled");
  cancelled.name = "AbortError";
  const ac = new AbortController();
  ac.abort(cancelled);
  globalThis.fetch = (async () => { throw cancelled; }) as unknown as typeof fetch;
  await assert.rejects(fetchUsage(c, ac.signal), (e: unknown) => e === cancelled);
  await assert.rejects(refreshPollCredentials("gmail", c, ac.signal), (e: unknown) => e === cancelled);

  // A deadline reached is a transient condition.
  const timedOut = new DOMException("timed out", "TimeoutError");
  const to = new AbortController();
  to.abort(timedOut);
  globalThis.fetch = (async () => { throw timedOut; }) as unknown as typeof fetch;
  await assert.rejects(fetchUsage(c, to.signal), TransientError);
  await assert.rejects(refreshPollCredentials("gmail", c, to.signal), TransientError);
});

test("refreshPollCredentials writes the rotated refresh token back to the file", async (t) => {
  const { dir } = env(t);
  writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(cred));
  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
  const c2 = await refreshPollCredentials("gmail", readPollCredentials("gmail")!, AbortSignal.timeout(1000));
  assert.equal(c2.refreshToken, "rt-2");
  assert.equal(JSON.parse(readFileSync(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken, "rt-2");
});

test("refreshPollCredentials keeps unrelated keys in the credentials file", async (t) => {
  const { dir } = env(t);
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

test("refreshPollCredentials never writes back a keychain-sourced credential", async (t) => {
  const { dir } = env(t);
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

test("refresh rejections: invalid_grant and 400/401 are auth, 5xx is transient", async (t) => {
  env(t);
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

test("no token or credential value ever appears in an error message", async (t) => {
  env(t);
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

/** Records the one request the stubbed fetch saw. */
function recorder(body: string, status = 200) {
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return () => {
    assert.equal(seen.length, 1);
    const { url, init } = seen[0]!;
    return { url, init, headers: new Headers(init.headers) };
  };
}

test("the usage call carries Claude Code's proven header set", async (t) => {
  env(t);
  const { fetchUsage, CLAUDE_USAGE_URL } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at-9", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  const seen = recorder(JSON.stringify({ limits: [] }));
  await fetchUsage(c, AbortSignal.timeout(1000));
  const { url, headers } = seen();
  assert.equal(url, CLAUDE_USAGE_URL);
  assert.equal(headers.get("authorization"), "Bearer at-9");
  assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  // Other UAs land in an aggressively rate-limited bucket (see the provider).
  assert.match(headers.get("user-agent") ?? "", /^claude-code\//);
  assert.equal(headers.get("content-type"), "application/json");
});

test("the profile call carries the same headers and no content-type", async (t) => {
  env(t);
  const { fetchProfile, CLAUDE_PROFILE_URL } = await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at-9", refreshToken: "rt", expiresAt: 0, source: "file" as const };
  const seen = recorder("{}");
  await fetchProfile(c, AbortSignal.timeout(1000));
  const { url, headers } = seen();
  assert.equal(url, CLAUDE_PROFILE_URL);
  assert.equal(headers.get("authorization"), "Bearer at-9");
  assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  assert.match(headers.get("user-agent") ?? "", /^claude-code\//);
  // The dashboard's profile call sends no Content-Type; neither does this one.
  assert.equal(headers.get("content-type"), null);
});

test("the refresh posts the proven grant, client id and headers to the token URL", async (t) => {
  env(t);
  const { refreshPollCredentials, CLAUDE_TOKEN_URL, CLAUDE_CLIENT_ID } =
    await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at-9", refreshToken: "rt-9", expiresAt: 0, source: "file" as const };
  const seen = recorder(JSON.stringify({ access_token: "at-10", expires_in: 3600 }));
  await refreshPollCredentials("gmail", c, AbortSignal.timeout(1000));
  const { url, init, headers } = seen();
  assert.equal(url, CLAUDE_TOKEN_URL);
  assert.equal(init.method, "POST");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.client_id, CLAUDE_CLIENT_ID);
  assert.equal(body.refresh_token, "rt-9");
  // The refresh sends no bearer: the grant IS the refresh token.
  assert.equal(headers.get("authorization"), null);
});
