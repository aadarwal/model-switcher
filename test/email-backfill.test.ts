// The e-mail backfill (src/account-email.ts): a row with no e-mail gets one
// from the provider ms is already talking to — the poll cycle and `ms doctor`
// — once per account per process, only when missing, silently when it fails.
// Every call goes to a stubbed `globalThis.fetch`; nothing here reaches the
// network, the keychain or the real ~/.config/model-switcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

const keychain = stubDir();
keychain.stub("security", "exit 44"); // errSecItemNotFound: never the real keychain
process.env.PATH = `${keychain.dir}:${process.env.PATH}`;

type Row = { name: string; provider: "claude" | "codex"; orgId?: string | null; email?: string };

function world(rows: Row[]): { msHome: string } {
  const { home, msHome } = tempHome();
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: rows.map((r) => ({
        name: r.name, provider: r.provider, label: r.name, orgId: r.orgId ?? null, shared: false, identityVerified: true,
        ...(r.email ? { email: r.email } : {}),
      })),
    }),
    { mode: 0o600 },
  );
  return { msHome };
}

function grant(msHome: string, name: string): void {
  const dir = path.join(msHome, "claude", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() + 3_600_000 } }),
    { mode: 0o600 },
  );
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function codexGrant(msHome: string, name: string, email: string, accountId = `acct-${name}`): void {
  const dir = path.join(msHome, "codex", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const idToken = `${b64({ alg: "none" })}.${b64({ email, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
  const access = `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken, access_token: access, refresh_token: `crt-${name}`, account_id: accountId } }),
    { mode: 0o600 },
  );
}

const USAGE = JSON.stringify({ limits: [{ kind: "session", used_percent: 10, resets_at: null }, { kind: "weekly_all", used_percent: 20, resets_at: null }] });
const CODEX_USAGE = JSON.stringify({ rate_limit: { secondary_window: { used_percent: 5, reset_at: 1790000000, reset_after_seconds: 400000, limit_window_seconds: 604800 } } });
const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const profileOf = (email: string, org = "org-1") => JSON.stringify({ account: { email }, organization: { uuid: org, name: "Org" } });

type Call = { url: string; auth: string };
function stubFetch(profile: (auth: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const auth = String(init?.headers?.Authorization ?? init?.headers?.authorization ?? "");
    calls.push({ url, auth });
    if (url.includes("/api/oauth/profile")) return profile(auth);
    if (url.includes("/api/oauth/usage")) return json(USAGE);
    if (url.includes("wham/usage")) return json(CODEX_USAGE);
    throw new Error(`test: unexpected network call to ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

const profileCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("/api/oauth/profile"));
const emailOf = (msHome: string, name: string): string | undefined =>
  (JSON.parse(readFileSync(path.join(msHome, "accounts.json"), "utf8")) as { accounts: { name: string; email?: string }[] }).accounts.find((a) => a.name === name)?.email;

test("poll: a claude row with no e-mail gets one profile read, under its own poll grant, and keeps the e-mail; the next poll asks nothing", async () => {
  const { msHome } = world([{ name: "claude-1", provider: "claude" }, { name: "claude-2", provider: "claude", email: "known@example.com" }]);
  grant(msHome, "claude-1");
  grant(msHome, "claude-2");
  const calls = stubFetch(() => json(profileOf("dirk@example.edu")));
  const { getSnapshot } = await import("../src/snapshot.ts");

  await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(profileCalls(calls).map((c) => c.auth), ["Bearer at-claude-1"], "only the row without an e-mail is asked");
  assert.equal(emailOf(msHome, "claude-1"), "dirk@example.edu");
  assert.equal(emailOf(msHome, "claude-2"), "known@example.com", "a recorded e-mail is never replaced");

  calls.length = 0;
  await getSnapshot({ maxAgeMs: 0 });
  assert.equal(profileCalls(calls).length, 0, "never on every poll");
  assert.equal(calls.filter((c) => c.url.includes("/api/oauth/usage")).length, 2, "the polls themselves still ran");
});

test("poll: a failing profile read leaves the e-mail absent, and is not retried in the same process", async () => {
  const { msHome } = world([{ name: "claude-1", provider: "claude" }]);
  grant(msHome, "claude-1");
  const calls = stubFetch(() => json("boom", 500));
  const { getSnapshot } = await import("../src/snapshot.ts");
  const { resetEmailBackfill } = await import("../src/account-email.ts");

  const first = await getSnapshot({ maxAgeMs: 0 });
  assert.equal(first.accounts[0]!.error, null, "the e-mail's failure is not the poll's");
  assert.equal(emailOf(msHome, "claude-1"), undefined);
  await getSnapshot({ maxAgeMs: 0 });
  assert.equal(profileCalls(calls).length, 1, "at most one profile call per account per process");

  resetEmailBackfill(); // a new process tries again
  stubFetch(() => json(profileOf("dirk@example.edu")));
  await getSnapshot({ maxAgeMs: 0 });
  assert.equal(emailOf(msHome, "claude-1"), "dirk@example.edu");
});

test("poll: a profile naming another organisation than the row records is not written", async () => {
  const { msHome } = world([{ name: "claude-1", provider: "claude", orgId: "org-mine" }]);
  grant(msHome, "claude-1");
  stubFetch(() => json(profileOf("someone-else@example.com", "org-other")));
  const { getSnapshot } = await import("../src/snapshot.ts");
  await getSnapshot({ maxAgeMs: 0 });
  assert.equal(emailOf(msHome, "claude-1"), undefined);
});

test("poll: a codex row takes the e-mail from its own auth.json — no request beyond the usage read", async () => {
  const { msHome } = world([{ name: "work", provider: "codex", orgId: "acct-work" }]);
  codexGrant(msHome, "work", "work@example.com");
  const calls = stubFetch(() => json("no", 500));
  const { getSnapshot } = await import("../src/snapshot.ts");
  await getSnapshot({ maxAgeMs: 0 });
  assert.equal(emailOf(msHome, "work"), "work@example.com");
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ["/backend-api/wham/usage"]);
  const snapshotFile = readFileSync(path.join(msHome, "snapshot.json"), "utf8");
  assert.ok(!snapshotFile.includes("crt-work") && !readFileSync(path.join(msHome, "accounts.json"), "utf8").includes("crt-work"), "no token reaches a file");
});

test("doctor: plain `ms doctor` records a missing claude e-mail with one profile read, prints no extra line, and a present one costs nothing", async () => {
  const { msHome } = world([{ name: "claude-1", provider: "claude" }]);
  grant(msHome, "claude-1");
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("claude-1", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");
  const calls = stubFetch(() => json(profileOf("dirk@example.edu")));
  const { checkClaudeAccount } = await import("../src/doctor.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  const row = () => loadRegistry().registry.accounts[0]!;

  const rs = await checkClaudeAccount(row(), false, [row()]);
  assert.equal(rs.length, 4, JSON.stringify(rs));
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs));
  assert.equal(profileCalls(calls).length, 1);
  assert.equal(emailOf(msHome, "claude-1"), "dirk@example.edu");

  calls.length = 0;
  await checkClaudeAccount(row(), false, [row()]);
  assert.equal(calls.length, 0, "a row that knows its e-mail costs no call");
});

test("doctor: a failing profile read leaves the e-mail absent and every line as it was", async () => {
  const { msHome } = world([{ name: "claude-1", provider: "claude" }]);
  grant(msHome, "claude-1");
  const calls = stubFetch(() => json("nope", 503));
  const { checkClaudeAccount } = await import("../src/doctor.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  const rs = await checkClaudeAccount(loadRegistry().registry.accounts[0]!, false);
  assert.equal(profileCalls(calls).length, 1);
  assert.equal(emailOf(msHome, "claude-1"), undefined);
  assert.ok(rs.some((r) => r.what === "claude account claude-1: identity verified at login (not re-checked)"), JSON.stringify(rs));
});

test("doctor: a codex row's e-mail comes from its auth.json", async () => {
  const { msHome } = world([{ name: "work", provider: "codex" }]);
  codexGrant(msHome, "work", "work@example.com");
  stubFetch(() => json("no", 500));
  const { checkCodexAccount } = await import("../src/doctor.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  await checkCodexAccount(loadRegistry().registry.accounts[0]!, false);
  assert.equal(emailOf(msHome, "work"), "work@example.com");
});
