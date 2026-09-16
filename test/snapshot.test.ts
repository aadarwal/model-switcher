// The coalesced usage snapshot. Every test runs against a temp MS_HOME with a
// registry of its own and a stubbed `globalThis.fetch` that counts calls and
// reports which credential each call carried — so "one poll per account" is
// asserted on the wire, not inferred. Nothing here touches the real network,
// the real keychain, or the real ~/.config/model-switcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";
import { CODEX_TOKEN_URL, CODEX_USAGE_URL } from "../src/providers/codex-usage.ts";

// An account with no credentials file falls back to its scoped keychain item,
// so `security` is stubbed on PATH for the whole file: 44 is
// errSecItemNotFound, and nothing here may reach the real keychain.
const keychainStub = stubDir();
keychainStub.stub("security", "exit 44");
process.env.PATH = `${keychainStub.dir}:${process.env.PATH}`;

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const HOUR = 3_600_000;

type Row = { name: string; provider: "claude" | "codex"; shared?: boolean };

function env(rows: Row[] = [{ name: "one", provider: "claude" }, { name: "two", provider: "claude" }]) {
  const { home, msHome } = tempHome();
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: rows.map((r) => ({
        name: r.name, provider: r.provider, label: r.name,
        orgId: null, shared: r.shared === true, identityVerified: true,
      })),
    }),
  );
  return { msHome, snapshot: path.join(msHome, "snapshot.json") };
}

/** A poll grant on disk for `name`, the file form src/providers reads first. */
function grant(msHome: string, name: string, expiresAt = Date.now() + HOUR) {
  const dir = path.join(msHome, "claude", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt } }),
  );
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const codexIdToken = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

/** A Codex `auth.json` fixture for `name` — the shape
 *  src/providers/codex-usage.ts's `readCodexCredentials` reads (mirrors
 *  test/codex-usage.test.ts's own AUTH fixture). `lastRefresh: null` omits
 *  the field entirely, the shape a freshly-`codex login`'d account has.
 *  Returns the file path, for tests that read the write-back. */
/** An access token with a readable `exp`, the shape the refresh trigger looks
 *  at. `tok` rides along so an assertion can name the token without knowing
 *  what second it was minted in (`bearerTok`, below). */
function codexAccessToken(name: string, expiresInSeconds: number): string {
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, tok: `cat-${name}` })}.sig`;
}

/** The `tok` marker inside a Bearer JWT, or the raw token when there is none. */
function bearerTok(authHeader: string): string {
  const jwt = authHeader.replace(/^Bearer /, "");
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { tok?: string };
    return claims.tok ?? jwt;
  } catch {
    return jwt;
  }
}

function codexGrant(
  msHome: string,
  name: string,
  opts: { lastRefresh?: string | null; accessToken?: string; refreshToken?: string; expiresIn?: number } = {},
): string {
  const dir = path.join(msHome, "codex", name);
  mkdirSync(dir, { recursive: true });
  const auth: Record<string, unknown> = {
    auth_mode: "chatgpt",
    tokens: {
      id_token: codexIdToken({
        email: `${name}@example.com`,
        "https://api.openai.com/auth": { chatgpt_account_id: `acct-${name}` },
      }),
      // An hour out by default: nowhere near the 60-second skew, so the
      // ordinary fixture is never refreshed.
      access_token: opts.accessToken ?? codexAccessToken(name, opts.expiresIn ?? 3600),
      refresh_token: opts.refreshToken ?? `crt-${name}`,
      account_id: `acct-${name}`,
    },
  };
  if (opts.lastRefresh !== null) auth.last_refresh = opts.lastRefresh ?? new Date().toISOString();
  const file = path.join(dir, "auth.json");
  writeFileSync(file, JSON.stringify(auth), { mode: 0o600 });
  return file;
}

const codexUsageBody = (session = 42, weekly = 5) =>
  JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: session, reset_at: 1789600000, reset_after_seconds: 3000, limit_window_seconds: 18000 },
      secondary_window: { used_percent: weekly, reset_at: 1790000000, reset_after_seconds: 400000, limit_window_seconds: 604800 },
    },
  });

const codexOk = () => new Response(codexUsageBody(), { status: 200 });

type Call = { url: string; auth: string };

/** Replace fetch with a counting stub; the returned array is the call log. */
function stubFetch(handler: (url: string, auth: string) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: unknown }) => {
    const url = String(input);
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    calls.push({ url, auth });
    return handler(url, auth);
  }) as unknown as typeof fetch;
  return calls;
}

const usageBody = (session = 10, weekly = 20) =>
  JSON.stringify({
    limits: [
      { kind: "session", used_percent: session, resets_at: "2026-09-16T05:00:00Z" },
      { kind: "weekly_all", used_percent: weekly, resets_at: "2026-09-20T00:00:00Z" },
    ],
  });

const ok = () => new Response(usageBody(), { status: 200 });
const load = async () => await import("../src/snapshot.ts");
const byName = <T extends { name: string }>(s: { accounts: T[] }, name: string): T =>
  s.accounts.find((a) => a.name === name)!;

test("two concurrent getSnapshot() calls poll each account exactly once", async () => {
  const { msHome } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();

  const [a, b] = await Promise.all([getSnapshot(), getSnapshot()]);

  assert.equal(calls.length, 2, "one poll per account, not one per caller");
  assert.deepEqual(calls.map((c) => c.auth).sort(), ["Bearer at-one", "Bearer at-two"]);
  // Identity, not equality: the second caller joined the first's in-flight
  // promise rather than taking the lock and re-reading the file behind it.
  assert.ok(Object.is(a, b), "both callers share one in-flight snapshot");
  assert.equal(a.accounts.length, 2);
  assert.equal(byName(a, "one").usage!.session!.usedPercent, 10);
  assert.equal(byName(a, "one").error, null);
  assert.equal(byName(a, "one").stale, false);
  assert.ok((byName(a, "one").observedAt ?? 0) > 0);
});

test("a second call inside the freshness window makes no network call", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();

  const first = await getSnapshot();
  assert.equal(calls.length, 2);
  calls.length = 0;

  const second = await getSnapshot();
  assert.equal(calls.length, 0, "the 20 s cache file answered it");
  assert.equal(second.takenAt, first.takenAt);
  // 0600: the file carries usage for every account on the machine.
  assert.equal(statSync(snapshot).mode & 0o777, 0o600);
});

test("the freshness window is the caller's: maxAgeMs 0 always re-polls", async () => {
  const { msHome } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();

  await getSnapshot();
  calls.length = 0;
  await getSnapshot({ maxAgeMs: 0 });
  assert.equal(calls.length, 2);
});

test("a 429 backs the account off, bounded by the clamp, and is served stale next call", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const { getSnapshot } = await load();

  // A good reading first, so there is something to carry over.
  stubFetch(() => ok());
  const good = await getSnapshot();
  const observedAt = byName(good, "one").observedAt;

  // Now "one" is rate limited, and asks for a day.
  stubFetch((_url, auth) =>
    auth === "Bearer at-one"
      ? new Response("slow down", { status: 429, headers: { "retry-after": "86400" } })
      : ok());
  const hit = await getSnapshot({ maxAgeMs: 0 });
  const one = byName(hit, "one");
  assert.equal(one.errorKind, "transient");
  assert.ok(one.error);
  assert.equal(one.stale, true);
  assert.equal(one.observedAt, observedAt, "observedAt is the last SUCCESSFUL poll");
  assert.equal(one.usage!.session!.usedPercent, 10, "the last reading is carried, not thrown away");

  // The endpoint asked for a day and the header now reaches us, so the clamp
  // is what is actually recorded — not merely something under it.
  const file = JSON.parse(readFileSync(snapshot, "utf8"));
  const until = file.backoff["claude:one"];
  assert.equal(typeof until, "number", "an untilMs was recorded, under the qualified key");
  const waitMs = until - Date.now();
  assert.ok(Math.abs(waitMs - 900_000) <= 2_000, `clamped to 15 min, got ${waitMs} ms`);

  // Inside the window, the account costs no call at all.
  const calls = stubFetch(() => ok());
  const after = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer at-two"], "only the account with room was polled");
  assert.equal(byName(after, "one").stale, true);
  assert.equal(byName(after, "two").stale, false);
});

test("backoffMs clamps to 15 minutes and defaults to a minute", async () => {
  env();
  const { backoffMs, MAX_BACKOFF_MS, DEFAULT_BACKOFF_MS } = await load();
  assert.equal(MAX_BACKOFF_MS, 900_000);
  assert.equal(DEFAULT_BACKOFF_MS, 60_000);
  assert.equal(backoffMs(Object.assign(new Error("429"), { retryAfterMs: 86_400_000 })), 900_000);
  assert.equal(backoffMs(Object.assign(new Error("429"), { retryAfterMs: 5_000 })), 5_000);
  assert.equal(backoffMs(new Error("429 from /api/oauth/usage")), 60_000);
  assert.equal(backoffMs(Object.assign(new Error("x"), { retryAfterMs: -1 })), 60_000);
});

test("an AuthError is auth, is not backed off, and toPickInputs reports it", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  stubFetch((_url, auth) => (auth === "Bearer at-one" ? new Response("{}", { status: 401 }) : ok()));
  const { getSnapshot, toPickInputs } = await load();

  const s = await getSnapshot();
  const one = byName(s, "one");
  assert.equal(one.errorKind, "auth");
  assert.match(one.error!, /401/);
  assert.equal(JSON.parse(readFileSync(snapshot, "utf8")).backoff.one, undefined, "a dead grant is not a retry timer");

  const inputs = toPickInputs(s);
  const pin = inputs.find((i) => i.name === "one")!;
  assert.ok(pin.error, "the chooser must see a reason, not a silent absence");
  assert.equal(inputs.find((i) => i.name === "two")!.error, null);
  assert.equal(inputs.find((i) => i.name === "two")!.session!.usedPercent, 10);
});

test("toPickInputs keeps a recent reading alive through a transient error, and drops a stale one", async () => {
  env();
  const { toPickInputs } = await load();
  const usage = { session: { usedPercent: 5, resetsAt: null }, weeklyAll: { usedPercent: 6, resetsAt: null }, weeklyFable: null };
  const base = { provider: "claude" as const, shared: false, usage, stale: true };
  const transient = { error: "429 from /api/oauth/usage", errorKind: "transient" as const };
  const s = {
    takenAt: Date.now(),
    registryError: null,
    accounts: [
      { ...base, ...transient, name: "recent", observedAt: Date.now() - 60_000 },
      { ...base, ...transient, name: "old", observedAt: Date.now() - 900_000 },
      { ...base, name: "other", error: "no poller yet", errorKind: "other" as const, observedAt: Date.now() },
      { ...base, name: "blank", usage: null, error: null, errorKind: null, observedAt: null },
      // Errorless but nobody refreshed it: current, recently stale, long stale.
      { ...base, name: "current", error: null, errorKind: null, observedAt: Date.now() - 4_000_000, stale: false },
      { ...base, name: "warm", error: null, errorKind: null, observedAt: Date.now() - 60_000 },
      { ...base, name: "cold", error: null, errorKind: null, observedAt: Date.now() - 4 * 3_600_000 },
      { ...base, name: "never", error: null, errorKind: null, observedAt: null },
    ],
  };
  const out = new Map(toPickInputs(s).map((i) => [i.name, i]));
  assert.equal(out.get("recent")!.error, null, "a minute-old reading still chooses");
  assert.equal(out.get("recent")!.session!.usedPercent, 5);
  assert.ok(out.get("old")!.error, "past 10 minutes the reading is no longer evidence");
  assert.ok(out.get("other")!.error, "only transient errors keep an account alive");
  assert.ok(out.get("blank")!.error, "no usage is never alive, error or not");
  // A row this round actually refreshed is current whatever its observedAt says.
  assert.equal(out.get("current")!.error, null, "not stale is not old");
  assert.equal(out.get("warm")!.error, null, "a minute-old stale row is still evidence");
  // The gap the reviewer found: an errorless stale row had no age bound at all.
  assert.match(out.get("cold")!.error ?? "", /^usage stale \(4h\)$/, "and it says how old");
  assert.match(out.get("never")!.error ?? "", /^usage stale \(never read\)$/);
});

test("a poll already under way is not duplicated: the waiter serves what the holder wrote", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const stale = {
    takenAt: Date.now() - 600_000,
    accounts: [
      { name: "one", provider: "claude", shared: false, usage: null, error: null, errorKind: null, observedAt: null, stale: false },
      { name: "two", provider: "claude", shared: false, usage: null, error: null, errorKind: null, observedAt: null, stale: false },
    ],
    backoff: {},
  };
  writeFileSync(snapshot, JSON.stringify(stale));
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");

  const release = acquire("snapshot")!;
  assert.ok(release, "the test itself plays the other process");
  const pending = getSnapshot();
  await sleep(150); // it is now waiting on the lock, not polling
  assert.equal(calls.length, 0);

  const fresh = { ...stale, takenAt: Date.now() };
  writeFileSync(snapshot, JSON.stringify(fresh));
  release();

  const s = await pending;
  assert.equal(calls.length, 0, "the holder's reading answered the waiter");
  assert.equal(s.takenAt, fresh.takenAt);
  // Not stale: it waited for the holder and read what the holder wrote, rather
  // than giving up and serving the file (which marks every row stale).
  assert.equal(byName(s, "one").stale, false);
});

test("a waiter that runs out of patience serves the last file, stale, rather than stampeding", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const last = {
    takenAt: Date.now() - 600_000,
    accounts: [
      { name: "one", provider: "claude", shared: false, usage: { session: { usedPercent: 3, resetsAt: null }, weeklyAll: null, weeklyFable: null }, error: null, errorKind: null, observedAt: Date.now() - 600_000, stale: false },
    ],
    backoff: {},
  };
  writeFileSync(snapshot, JSON.stringify(last));
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");

  const release = acquire("snapshot")!;
  try {
    const s = await getSnapshot({ maxAgeMs: 0, lockWaitMs: 50 });
    assert.equal(calls.length, 0, "a duplicate poll is worse than an old number");
    assert.equal(s.takenAt, last.takenAt);
    assert.equal(byName(s, "one").usage!.session!.usedPercent, 3);
    assert.equal(byName(s, "one").stale, true, "nothing served this way is this moment's reading");
    // An account the file had never heard of still gets a row, with a reason.
    assert.equal(byName(s, "two").usage, null);
    assert.equal(byName(s, "two").errorKind, "transient");
    assert.ok(byName(s, "two").error);
  } finally {
    release();
  }
});

test("a codex account with no auth.json reads as auth, with no network call", async () => {
  const { msHome } = env([{ name: "one", provider: "claude" }, { name: "cdx", provider: "codex" }]);
  grant(msHome, "one"); // "cdx" gets no codex/cdx/auth.json fixture at all
  const calls = stubFetch(() => ok());
  const { getSnapshot, toPickInputs } = await load();

  const s = await getSnapshot();
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer at-one"], "the codex row made no request of its own");
  const cdx = byName(s, "cdx");
  assert.equal(cdx.usage, null);
  assert.equal(cdx.error, "no credentials (ms accounts login cdx)");
  assert.equal(cdx.errorKind, "auth");
  assert.ok(toPickInputs(s).find((i) => i.name === "cdx")!.error);
});

test("a missing poll grant reads as auth without a network call", async () => {
  const { msHome } = env();
  grant(msHome, "one"); // "two" has no credential at all
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();

  const s = await getSnapshot();
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer at-one"]);
  const two = byName(s, "two");
  assert.equal(two.errorKind, "auth");
  assert.match(two.error!, /poll grant/);
});

test("a credential inside the refresh skew is refreshed before the usage read", async () => {
  const { msHome } = env([{ name: "one", provider: "claude" }]);
  grant(msHome, "one", Date.now() + 30_000); // expires inside the 60 s skew
  const calls = stubFetch((url) =>
    url === TOKEN_URL
      ? new Response(JSON.stringify({ access_token: "at-fresh", refresh_token: "rt-fresh", expires_in: 3600 }), { status: 200 })
      : ok());
  const { getSnapshot } = await load();

  const s = await getSnapshot();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, TOKEN_URL);
  assert.equal(calls[1]!.auth, "Bearer at-fresh", "the usage read used the refreshed grant");
  assert.equal(byName(s, "one").error, null);
});

// The token endpoint rotates the refresh token, so two processes refreshing
// one grant spend each other's and the loser reads as a dead account. §9's
// per-account credential lock is what keeps them apart.
test("the refresh happens under the account's credential lock", async () => {
  const { msHome } = env([{ name: "one", provider: "claude" }]);
  grant(msHome, "one", Date.now() + 30_000);
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");

  let heldDuringRefresh: boolean | null = null;
  stubFetch((url) => {
    if (url !== TOKEN_URL) return ok();
    // Probing from inside the refresh: the lock must already be taken.
    const got = acquire("account-claude-one");
    heldDuringRefresh = got === null;
    got?.();
    return new Response(JSON.stringify({ access_token: "at-fresh", expires_in: 3600 }), { status: 200 });
  });

  const s = await getSnapshot();
  assert.equal(heldDuringRefresh, true, "account-claude-one was locked while its grant was rotated");
  assert.equal(byName(s, "one").error, null);
  const after = acquire("account-claude-one");
  assert.ok(after, "and released again when the poll was done");
  after!();
});

test("a refresh another process already did is used, not repeated", async () => {
  const { msHome } = env([{ name: "one", provider: "claude" }]);
  grant(msHome, "one", Date.now() + 30_000);
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");

  // Play the process that got there first: hold the lock, write a refreshed
  // credential where ours sits, then let go.
  const release = acquire("account-claude-one")!;
  const calls = stubFetch(() => ok());
  const pending = getSnapshot();
  await sleep(150);
  grant(msHome, "one", Date.now() + HOUR); // "someone else refreshed it"
  release();

  const s = await pending;
  assert.deepEqual(calls.map((c) => c.url.includes("/oauth/token")), [false], "no second token call");
  assert.equal(calls[0]!.auth, "Bearer at-one", "it re-read the credential the winner left");
  assert.equal(byName(s, "one").error, null);
});

test("only scopes the poll; an account left out keeps its reading, marked stale", async () => {
  const { msHome } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  stubFetch(() => ok());
  const { getSnapshot } = await load();
  await getSnapshot();

  const calls = stubFetch(() => new Response(usageBody(77, 88), { status: 200 }));
  const scoped = await getSnapshot({ maxAgeMs: 0, only: ["one"] });
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer at-one"]);
  assert.deepEqual(scoped.accounts.map((a) => a.name), ["one"]);
  assert.equal(byName(scoped, "one").usage!.session!.usedPercent, 77);

  const all = await getSnapshot();
  assert.equal(byName(all, "two").usage!.session!.usedPercent, 10, "the uncovered account kept its reading");
  assert.equal(byName(all, "two").stale, true, "and says so");
});

test("a fresh file that does not cover a newly registered account is re-polled", async () => {
  const { msHome } = env([{ name: "one", provider: "claude" }]);
  grant(msHome, "one");
  stubFetch(() => ok());
  const { getSnapshot } = await load();
  await getSnapshot();

  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [
      { name: "one", provider: "claude", label: "one", orgId: null, shared: false, identityVerified: true },
      { name: "two", provider: "claude", label: "two", orgId: null, shared: false, identityVerified: true },
    ] }),
  );
  grant(msHome, "two");

  const calls = stubFetch(() => ok());
  const s = await getSnapshot(); // default 20 s window; the file is a moment old
  assert.deepEqual(calls.map((c) => c.auth).sort(), ["Bearer at-one", "Bearer at-two"]);
  assert.equal(s.accounts.length, 2);
});

test("a torn snapshot file is re-polled, not thrown", async () => {
  const { msHome, snapshot } = env([{ name: "one", provider: "claude" }]);
  grant(msHome, "one");
  writeFileSync(snapshot, '{"takenAt": 1, "accou');
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();
  const s = await getSnapshot();
  assert.equal(calls.length, 1);
  assert.equal(byName(s, "one").error, null);
});

// --- Fix round 1 ------------------------------------------------------

// The registry deliberately allows one name under both providers
// (`validateRegistry` dedupes on `provider:name`, not name). Keying the
// snapshot's maps on the bare name let the Codex "no poller yet" row land on
// top of the Claude reading, and the live account fell out of the pool.
test("a name registered under both providers keeps two independent rows", async () => {
  const { msHome, snapshot } = env([
    { name: "work", provider: "claude" },
    { name: "work", provider: "codex" },
  ]);
  grant(msHome, "work");
  const calls = stubFetch(() => ok());
  const { getSnapshot, toPickInputs } = await load();

  const s = await getSnapshot();
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer at-work"], "the Claude row was polled once");
  assert.equal(s.accounts.length, 2, "both rows survive");

  const claude = s.accounts.find((a) => a.provider === "claude")!;
  const codex = s.accounts.find((a) => a.provider === "codex")!;
  assert.equal(claude.usage!.session!.usedPercent, 10, "the Claude reading was not overwritten");
  assert.equal(claude.error, null);
  assert.equal(codex.usage, null);
  assert.equal(codex.error, "no credentials (ms accounts login work)");
  assert.equal(codex.errorKind, "auth");
  assert.equal(codex.observedAt, null, "nothing was ever read for it");

  const inputs = toPickInputs(s);
  assert.equal(inputs.filter((i) => i.provider === "claude" && i.error === null).length, 1,
    "the Claude account is still choosable");
  assert.ok(inputs.find((i) => i.provider === "codex")!.error);

  // And the file keys them apart too, so the next round's backoff cannot cross.
  const keys = JSON.parse(readFileSync(snapshot, "utf8")).accounts.map(
    (a: { provider: string; name: string }) => `${a.provider}:${a.name}`);
  assert.deepEqual(keys.sort(), ["claude:work", "codex:work"]);
});

test("a 429 backs off only its own provider's row", async () => {
  const { msHome, snapshot } = env([
    { name: "work", provider: "claude" },
    { name: "work", provider: "codex" },
  ]);
  grant(msHome, "work");
  stubFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "86400" } }));
  const { getSnapshot } = await load();
  await getSnapshot();
  const backoff = JSON.parse(readFileSync(snapshot, "utf8")).backoff;
  assert.deepEqual(Object.keys(backoff), ["claude:work"], "the codex row has no timer of its own");
});

// --- Codex polling -----------------------------------------------------

test("a codex row polls through the codex provider: session maps, weeklyFable is null", async () => {
  const { msHome } = env([{ name: "work", provider: "codex" }]);
  codexGrant(msHome, "work"); // an access token an hour from expiry: nowhere near due
  const calls = stubFetch((url) => (url === CODEX_USAGE_URL ? codexOk() : new Response("unexpected", { status: 500 })));
  const { getSnapshot, toPickInputs } = await load();

  const s = await getSnapshot({ maxAgeMs: 0 });
  const work = byName(s, "work");
  assert.equal(work.usage!.session!.usedPercent, 42);
  assert.equal(work.usage!.weeklyFable, null);
  assert.equal(work.error, null);
  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL], "a fresh credential is not refreshed");

  // A null weeklyFable is out for need=fable and in for need=any (the
  // pick.test.ts-level assertion covers pickAccounts directly; this is the
  // same rule proven end to end through the snapshot).
  const { pickAccounts } = await import("../src/pick.ts");
  const inputs = toPickInputs(s);
  const fable = pickAccounts(inputs, "fable");
  assert.ok(fable.out.find((o) => o.name === "work" && /fable/.test(o.why)), "excluded for need=fable");
  assert.equal(fable.picks.find((p) => p.name === "work"), undefined);
  const any = pickAccounts(inputs, "any");
  assert.ok(any.picks.find((p) => p.name === "work"), "included for need=any");
});

test("the refresh trigger is the access token's own exp, never how long ago it was refreshed", async () => {
  // A-I3, the rule ported verbatim from the proven poller
  // (data/lib/providers/openai.ts): refresh only when `exp` is within 60 s.
  // The 55-minute age test it replaced refreshed every idle account on the
  // first poll after 55 minutes — from `status --watch`, every launch, every
  // recovery — for a token valid for days, and every one of those rotates
  // the refresh token under every other copy of the same `auth.json`.
  const hour = env([{ name: "work", provider: "codex" }]);
  codexGrant(hour.msHome, "work", { expiresIn: 3600, lastRefresh: new Date(Date.now() - 6 * HOUR).toISOString() });
  let calls = stubFetch(() => codexOk());
  let { getSnapshot } = await load();
  let s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL], "an hour of validity left is not refreshed, however old last_refresh is");
  assert.equal(byName(s, "work").error, null);

  // Thirty seconds left: inside the skew, so the poll pays for a refresh.
  const soon = env([{ name: "work", provider: "codex" }]);
  codexGrant(soon.msHome, "work", { expiresIn: 30, lastRefresh: new Date().toISOString() });
  calls = stubFetch((url) =>
    url === CODEX_TOKEN_URL
      ? new Response(JSON.stringify({ access_token: "cat-work-2", refresh_token: "crt-work-2" }), { status: 200 })
      : codexOk());
  ({ getSnapshot } = await load());
  s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_TOKEN_URL, CODEX_USAGE_URL], "a token about to expire is refreshed first");
  assert.equal(byName(s, "work").error, null);

  // A token that carries no readable `exp` says nothing, and a clock is not
  // allowed to answer for it: it is polled as it stands and a 401 speaks.
  const opaque = env([{ name: "work", provider: "codex" }]);
  codexGrant(opaque.msHome, "work", { accessToken: "opaque-not-a-jwt", lastRefresh: null });
  calls = stubFetch(() => codexOk());
  ({ getSnapshot } = await load());
  s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL], "no exp is not 'overdue'");
  assert.equal(byName(s, "work").error, null);
});

test("a codex refresh is skipped while a managed session for that account is alive", async () => {
  const { msHome } = env([{ name: "work", provider: "codex" }]);
  codexGrant(msHome, "work", { expiresIn: 30 }); // inside the 60 s skew: due for refresh
  const { openState } = await import("../src/state.ts");
  const state = openState();
  state.createSession({
    id: "sess-1", provider: "codex", cliSessionId: null, cwd: "/tmp", socket: "s", pane: "%1",
    serverStart: "1", need: "any", account: "work", generation: 1, state: "running",
    desired: "running", flags: [],
  });
  state.close();

  const calls = stubFetch((url) => (url === CODEX_USAGE_URL ? codexOk() : new Response("must not be called", { status: 500 })));
  const { getSnapshot } = await load();

  const s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL], "no token-endpoint call while a codex session is alive");
  assert.equal(bearerTok(calls[0]!.auth), "cat-work", "polled with the stored, unrefreshed access token");
  assert.equal(byName(s, "work").usage!.session!.usedPercent, 42);
  assert.equal(byName(s, "work").error, null);
});

// A "stopped" session no longer holds the grant, so an overdue credential
// still refreshes.
test("a codex refresh proceeds when the only session for that account has stopped", async () => {
  const { msHome } = env([{ name: "work", provider: "codex" }]);
  codexGrant(msHome, "work", { expiresIn: 30 });
  const { openState } = await import("../src/state.ts");
  const state = openState();
  state.createSession({
    id: "sess-1", provider: "codex", cliSessionId: null, cwd: "/tmp", socket: "s", pane: "%1",
    serverStart: "1", need: "any", account: "work", generation: 1, state: "stopped",
    desired: "stopped", flags: [],
  });
  state.close();

  const calls = stubFetch((url) =>
    url === CODEX_TOKEN_URL
      ? new Response(JSON.stringify({ access_token: "cat-work-2" }), { status: 200 })
      : codexOk());
  const { getSnapshot } = await load();
  await getSnapshot({ maxAgeMs: 0 });
  assert.ok(calls.some((c) => c.url === CODEX_TOKEN_URL), "a stopped session does not block the refresh");
});

test("a codex refresh happens when due and nothing is alive, and writes back atomically", async () => {
  const { msHome } = env([{ name: "work", provider: "codex" }]);
  const authPath = codexGrant(msHome, "work", { expiresIn: 30 }); // inside the 60 s skew

  const calls = stubFetch((url) => {
    if (url === CODEX_TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: "cat-work-2", refresh_token: "crt-work-2" }), { status: 200 });
    }
    return codexOk();
  });
  const { getSnapshot } = await load();

  const s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_TOKEN_URL, CODEX_USAGE_URL], "refreshed once, then polled with the fresh token");
  assert.equal(bearerTok(calls[1]!.auth), "cat-work-2", "the usage read used the refreshed access token");
  assert.equal(byName(s, "work").error, null);

  const onDisk = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(onDisk.tokens.access_token, "cat-work-2");
  assert.equal(onDisk.tokens.refresh_token, "crt-work-2");
  assert.equal(statSync(authPath).mode & 0o777, 0o600);
  assert.match(onDisk.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
});

test("the codex refresh happens under the account's own credential lock", async () => {
  const { msHome } = env([{ name: "work", provider: "codex" }]);
  codexGrant(msHome, "work", { expiresIn: 30 });
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");

  let heldDuringRefresh: boolean | null = null;
  stubFetch((url) => {
    if (url !== CODEX_TOKEN_URL) return codexOk();
    const got = acquire("account-codex-work");
    heldDuringRefresh = got === null;
    got?.();
    return new Response(JSON.stringify({ access_token: "cat-fresh" }), { status: 200 });
  });

  const s = await getSnapshot({ maxAgeMs: 0 });
  assert.equal(heldDuringRefresh, true, "account-codex-work was locked while its grant was rotated");
  assert.equal(byName(s, "work").error, null);
  const after = acquire("account-codex-work");
  assert.ok(after, "and released again when the poll was done");
  after!();
});

test("a codex 401 triggers exactly one refresh and one retry", async () => {
  // The proven poller's second trigger: a token the endpoint refuses is worth
  // one refresh, and the retry is what turns a rotated grant into a reading
  // rather than a red row. The live-session guard deliberately does not apply
  // — a live session is holding the same rejected token.
  const { msHome } = env([{ name: "work", provider: "codex" }]);
  const authPath = codexGrant(msHome, "work", { expiresIn: 3600 }); // no clock-driven refresh
  const { openState } = await import("../src/state.ts");
  const state = openState();
  state.createSession({
    id: "sess-1", provider: "codex", cliSessionId: null, cwd: "/tmp", socket: "s", pane: "%1",
    serverStart: "1", need: "any", account: "work", generation: 1, state: "running",
    desired: "running", flags: [],
  });
  state.close();

  const calls = stubFetch((url, auth) => {
    if (url === CODEX_TOKEN_URL) return new Response(JSON.stringify({ access_token: "cat-work-2" }), { status: 200 });
    return bearerTok(auth) === "cat-work" ? new Response("no", { status: 401 }) : codexOk();
  });
  const { getSnapshot } = await load();

  const s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL, CODEX_TOKEN_URL, CODEX_USAGE_URL],
    "poll, one refresh, one retry — and no more");
  assert.equal(bearerTok(calls[2]!.auth), "cat-work-2");
  assert.equal(byName(s, "work").usage!.session!.usedPercent, 42);
  assert.equal(byName(s, "work").error, null);
  assert.equal(JSON.parse(readFileSync(authPath, "utf8")).tokens.access_token, "cat-work-2");
});

test("a 401 that survives the retry is auth, and a 403 is never refreshed at all", async () => {
  const dead = env([{ name: "work", provider: "codex" }]);
  codexGrant(dead.msHome, "work", { expiresIn: 3600 });
  let calls = stubFetch((url) =>
    url === CODEX_TOKEN_URL
      ? new Response(JSON.stringify({ access_token: "cat-work-2" }), { status: 200 })
      : new Response("no", { status: 401 }));
  let { getSnapshot } = await load();
  let s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL, CODEX_TOKEN_URL, CODEX_USAGE_URL], "one retry, not a loop");
  assert.equal(byName(s, "work").errorKind, "auth");
  assert.match(byName(s, "work").error!, /401/);

  // A 403 is a scope answer. No refresh changes it, so none is spent.
  const scoped = env([{ name: "work", provider: "codex" }]);
  codexGrant(scoped.msHome, "work", { expiresIn: 3600 });
  calls = stubFetch(() => new Response("nope", { status: 403 }));
  ({ getSnapshot } = await load());
  s = await getSnapshot({ maxAgeMs: 0 });
  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL], "no token-endpoint call for a 403");
  assert.equal(byName(s, "work").errorKind, "auth");
  assert.match(byName(s, "work").error!, /403/);
});

test("a parked or waiting codex session does not block a refresh a poll needs", async () => {
  // Both are sessions with nothing running. Counting them as live is how one
  // lingering parked row used to hold an account's refresh off until its token
  // died and the account read `auth`.
  for (const state of ["parked", "waiting"] as const) {
    const { msHome } = env([{ name: "work", provider: "codex" }]);
    codexGrant(msHome, "work", { expiresIn: 30 });
    const { openState } = await import("../src/state.ts");
    const st = openState();
    st.createSession({
      id: `sess-${state}`, provider: "codex", cliSessionId: null, cwd: "/tmp", socket: "s", pane: "%1",
      serverStart: "1", need: "any", account: "work", generation: 1, state,
      desired: "running", flags: [],
    });
    st.close();

    const calls = stubFetch((url) =>
      url === CODEX_TOKEN_URL
        ? new Response(JSON.stringify({ access_token: "cat-work-2" }), { status: 200 })
        : codexOk());
    const { getSnapshot } = await load();
    const s = await getSnapshot({ maxAgeMs: 0 });
    assert.deepEqual(calls.map((c) => c.url), [CODEX_TOKEN_URL, CODEX_USAGE_URL], state);
    assert.equal(byName(s, "work").error, null, state);
  }
});

// The outside `codexRefreshDue && codexRefreshAllowed` check runs BEFORE the
// credential lock is even requested — it is a cheap pre-filter, not the
// decision. A session can start in the gap between that check and actually
// holding the lock, and only a re-check made INSIDE the lock body can see it.
test("a session that starts while waiting for the lock still stops the refresh", async () => {
  const { msHome } = env([{ name: "work", provider: "codex" }]);
  // Due (the access token expires inside the skew) and, at the moment of the
  // outside check, no session — the pre-filter passes and pollCodexUsage goes
  // to take the lock.
  codexGrant(msHome, "work", { expiresIn: 30 });
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");
  const { openState } = await import("../src/state.ts");

  // Play the other process: hold the credential lock so pollCodexUsage's
  // withLock call has to wait, the same as a real race would force it to.
  const release = acquire("account-codex-work")!;
  assert.ok(release, "the test itself plays the other process");

  const calls = stubFetch((url) =>
    url === CODEX_TOKEN_URL
      ? new Response(JSON.stringify({ access_token: "cat-should-not-be-used" }), { status: 200 })
      : codexOk());
  const pending = getSnapshot({ maxAgeMs: 0 });
  await sleep(150); // it is now waiting on the lock, not refreshing

  // NOW a codex session starts for "work" — exactly the race window the
  // outside check, taken before the lock was even requested, could not see.
  const state = openState();
  state.createSession({
    id: "sess-race", provider: "codex", cliSessionId: null, cwd: "/tmp", socket: "s", pane: "%1",
    serverStart: "1", need: "any", account: "work", generation: 1, state: "running",
    desired: "running", flags: [],
  });
  state.close();

  release();
  const s = await pending;

  assert.deepEqual(calls.map((c) => c.url), [CODEX_USAGE_URL],
    "no token-endpoint call: the lock body re-checked and saw the new session");
  assert.equal(bearerTok(calls[0]!.auth), "cat-work", "polled with the stored, unrefreshed access token");
  assert.equal(byName(s, "work").usage!.session!.usedPercent, 42);
  assert.equal(byName(s, "work").error, null);
});

test("a real 429 through fetchCodexUsage backs off only codex:work, leaving claude:work untouched", async () => {
  const { msHome, snapshot } = env([
    { name: "work", provider: "claude" },
    { name: "work", provider: "codex" },
  ]);
  grant(msHome, "work");
  codexGrant(msHome, "work"); // an hour from expiry: no refresh call to interfere
  stubFetch((url) =>
    url === CODEX_USAGE_URL
      ? new Response("slow down", { status: 429, headers: { "retry-after": "86400" } })
      : ok());
  const { getSnapshot } = await load();

  const s = await getSnapshot({ maxAgeMs: 0 });
  const claude = s.accounts.find((a) => a.provider === "claude")!;
  const codex = s.accounts.find((a) => a.provider === "codex")!;
  assert.equal(claude.error, null, "the Claude row's own 200 was untouched by the Codex row's 429");
  assert.equal(claude.usage!.session!.usedPercent, 10);
  assert.equal(codex.errorKind, "transient");
  assert.match(codex.error!, /429/);
  assert.equal(codex.stale, true);

  const backoff = JSON.parse(readFileSync(snapshot, "utf8")).backoff;
  assert.deepEqual(Object.keys(backoff), ["codex:work"],
    "only the codex row got a retry timer, from a REAL 429 through fetchCodexUsage");
  const waitMs = backoff["codex:work"] - Date.now();
  assert.ok(Math.abs(waitMs - 900_000) <= 2_000, `clamped to 15 min, got ${waitMs} ms`);
});

test("a codex refresh rejection classifies invalid_grant as auth, with no backoff", async () => {
  const { msHome, snapshot } = env([{ name: "work", provider: "codex" }]);
  codexGrant(msHome, "work", { expiresIn: 30 }); // due; no session, so refresh is attempted
  stubFetch((url) =>
    url === CODEX_TOKEN_URL
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : codexOk());
  const { getSnapshot } = await load();

  const s = await getSnapshot({ maxAgeMs: 0 });
  const work = byName(s, "work");
  assert.equal(work.errorKind, "auth");
  assert.match(work.error!, /invalid_grant|refresh rejected/);
  assert.equal(JSON.parse(readFileSync(snapshot, "utf8")).backoff["codex:work"], undefined,
    "a dead refresh grant is not a retry timer");
});

test("a codex refresh rejection classifies a 5xx as transient, backs off, and keeps the last reading alive while recent", async () => {
  const { msHome, snapshot } = env([{ name: "work", provider: "codex" }]);
  codexGrant(msHome, "work"); // an hour from expiry: the first poll is a plain read, no refresh
  stubFetch(() => codexOk());
  const { getSnapshot, toPickInputs } = await load();
  const good = await getSnapshot();
  const observedAt = byName(good, "work").observedAt;

  // Move the on-disk access token to inside the 60-second skew, so the next
  // poll (no session running) attempts a refresh — and the token endpoint
  // is down.
  codexGrant(msHome, "work", { expiresIn: 30 });
  stubFetch((url) => (url === CODEX_TOKEN_URL ? new Response("down", { status: 502 }) : codexOk()));

  const hit = await getSnapshot({ maxAgeMs: 0 });
  const work = byName(hit, "work");
  assert.equal(work.errorKind, "transient");
  assert.ok(work.error);
  assert.equal(work.stale, true);
  assert.equal(work.observedAt, observedAt, "observedAt is the last SUCCESSFUL poll");
  assert.equal(work.usage!.session!.usedPercent, 42, "the last reading is carried, not thrown away");

  const backoffUntil = JSON.parse(readFileSync(snapshot, "utf8")).backoff["codex:work"];
  assert.equal(typeof backoffUntil, "number");
  const waitMs = backoffUntil - Date.now();
  assert.ok(Math.abs(waitMs - 60_000) <= 2_000, `no retry-after on a 502: defaults to 1 min, got ${waitMs} ms`);

  // The chooser still sees it: a recent reading survives a transient
  // refresh failure, per the same age rule a transient usage-read failure
  // gets.
  const inputs = toPickInputs(hit);
  const pin = inputs.find((i) => i.name === "work")!;
  assert.equal(pin.error, null, "a recent reading survives a transient refresh failure");
});

// An errorless row that nothing refreshed used to have no age bound at all: a
// busy fallback or a scoped poll could feed hours-old percentages to the
// chooser, which is how a walled account gets picked.
test("the busy fallback retires readings that have gone cold, and dates them", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const old = Date.now() - 4 * 3_600_000;
  writeFileSync(snapshot, JSON.stringify({
    takenAt: old,
    accounts: [
      { name: "one", provider: "claude", shared: false, usage: { session: { usedPercent: 3, resetsAt: null }, weeklyAll: { usedPercent: 4, resetsAt: null }, weeklyFable: null }, error: null, errorKind: null, observedAt: old, stale: false },
      { name: "two", provider: "claude", shared: false, usage: { session: { usedPercent: 5, resetsAt: null }, weeklyAll: { usedPercent: 6, resetsAt: null }, weeklyFable: null }, error: null, errorKind: null, observedAt: Date.now() - 30_000, stale: false },
    ],
    backoff: {},
  }));
  const calls = stubFetch(() => ok());
  const { getSnapshot, toPickInputs } = await load();
  const { acquire } = await import("../src/lock.ts");

  const release = acquire("snapshot")!;
  try {
    const s = await getSnapshot({ maxAgeMs: 0, lockWaitMs: 50 });
    assert.equal(calls.length, 0);
    assert.equal(byName(s, "one").stale, true);
    const out = new Map(toPickInputs(s).map((i) => [i.name, i]));
    assert.match(out.get("one")!.error ?? "", /^usage stale \(4h\)$/, "four hours old is not a usable number");
    assert.equal(out.get("two")!.error, null, "half a minute old still chooses");
  } finally {
    release();
  }
});

test("a scoped poll's carried rows age out of the chooser too", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  stubFetch(() => ok());
  const { getSnapshot, toPickInputs } = await load();
  await getSnapshot();

  // Age "two"'s reading in the file, then poll only "one".
  const file = JSON.parse(readFileSync(snapshot, "utf8"));
  const old = Date.now() - 20 * 60_000;
  for (const a of file.accounts) if (a.name === "two") a.observedAt = old;
  writeFileSync(snapshot, JSON.stringify(file));

  const scoped = await getSnapshot({ maxAgeMs: 0, only: ["one"] });
  assert.equal(scoped.accounts.length, 1);
  const all = await getSnapshot({ maxAgeMs: 60_000 });
  assert.equal(byName(all, "two").stale, true);
  assert.equal(byName(all, "two").error, null, "the row itself records no failure");
  const out = new Map(toPickInputs(all).map((i) => [i.name, i]));
  assert.match(out.get("two")!.error ?? "", /^usage stale \(20m\)$/, "but the chooser is told its age");
  assert.equal(out.get("one")!.error, null);
});

test("a caller's lockWaitMs is its own: a short wait is not joined to a long one", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  writeFileSync(snapshot, JSON.stringify({ takenAt: Date.now() - 600_000, accounts: [], backoff: {} }));
  const calls = stubFetch(() => ok());
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");

  const release = acquire("snapshot")!;
  try {
    // A patient caller is still waiting; an impatient one must not inherit it.
    const patient = getSnapshot({ maxAgeMs: 0, lockWaitMs: 10_000 });
    const started = Date.now();
    const hurried = await getSnapshot({ maxAgeMs: 0, lockWaitMs: 50 });
    const waited = Date.now() - started;
    assert.ok(waited < 2_000, `the 50 ms caller returned in ${waited} ms`);
    assert.equal(hurried.accounts.length, 2, "served from the registry, with reasons");
    assert.ok(hurried.accounts.every((a) => a.stale));
    assert.equal(calls.length, 0, "and nothing was polled behind the holder's back");
    release();
    await patient; // the patient one still gets its turn
  } finally {
    release();
  }
});

test("an unreadable registry is reported, not mistaken for an empty fleet", async () => {
  const { msHome } = env();
  grant(msHome, "one");
  writeFileSync(path.join(msHome, "accounts.json"), "{ not json");
  const calls = stubFetch(() => ok());
  const { getSnapshot, toPickInputs } = await load();

  const s = await getSnapshot();
  assert.equal(calls.length, 0, "there is nobody to poll");
  assert.ok(s.registryError, "the reason is on the snapshot");
  assert.match(s.registryError!, /accounts\.json/);
  assert.deepEqual(toPickInputs(s), [], "and the chooser is given nothing rather than a wrong nothing");
});

test("toPickInputs offers nothing at all while the registry is unreadable", async () => {
  env();
  const { toPickInputs } = await load();
  // Rows can outlive the registry that named them: the cache file keeps every
  // account when accounts.json stops parsing, precisely so nothing is lost.
  // They must still not be chosen from — `shared`, `orgId` and the very
  // membership of the fleet are unknown until the file parses again.
  const usage = { session: { usedPercent: 1, resetsAt: null }, weeklyAll: { usedPercent: 2, resetsAt: null }, weeklyFable: null };
  const healthy = {
    name: "one", provider: "claude" as const, shared: false, usage,
    error: null, errorKind: null, observedAt: Date.now(), stale: false,
  };
  assert.equal(toPickInputs({ takenAt: Date.now(), registryError: null, accounts: [healthy] }).length, 1);
  assert.deepEqual(
    toPickInputs({ takenAt: Date.now(), registryError: "accounts.json: Unexpected token (JSON)", accounts: [healthy] }),
    [],
  );
});

test("a healthy registry reports no registryError", async () => {
  const { msHome } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  stubFetch(() => ok());
  const { getSnapshot, toPickInputs } = await load();
  const s = await getSnapshot();
  assert.equal(s.registryError, null);
  assert.equal(toPickInputs(s).length, 2);
});

test("no credential of any kind reaches the cache file", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one", Date.now() + 30_000); // forces a refresh too
  grant(msHome, "two");
  stubFetch((url) =>
    url === TOKEN_URL
      ? new Response(JSON.stringify({ access_token: "at-secret", refresh_token: "rt-secret", expires_in: 3600 }), { status: 200 })
      : ok());
  const { getSnapshot } = await load();
  await getSnapshot();

  const raw = readFileSync(snapshot, "utf8");
  for (const needle of ["accessToken", "refreshToken", "at-secret", "rt-secret", "at-one", "rt-one", "Bearer"]) {
    assert.equal(raw.includes(needle), false, `the snapshot file must not contain ${needle}`);
  }
});

test("takenAt is null when nothing has ever been written, and stamped at poll end", async () => {
  const { msHome } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const { getSnapshot } = await load();
  const { acquire } = await import("../src/lock.ts");

  const release = acquire("snapshot")!;
  try {
    const empty = await getSnapshot({ maxAgeMs: 0, lockWaitMs: 50 });
    assert.equal(empty.takenAt, null, "no file, no reading, no time to claim");
  } finally {
    release();
  }

  // Stamped when the readings are in, not when the poll set off — so the poll
  // has to actually span some time for the difference to be visible.
  let finishedAt = 0;
  const startedAt = Date.now();
  globalThis.fetch = (async () => {
    await sleep(25);
    finishedAt = Date.now();
    return ok();
  }) as unknown as typeof fetch;
  const s = await getSnapshot({ maxAgeMs: 0 });
  assert.ok(finishedAt - startedAt >= 20, "the poll really did take time");
  assert.ok(s.takenAt !== null && s.takenAt >= finishedAt,
    `takenAt (${s.takenAt}) is stamped at the end of the poll, not the start (${startedAt})`);
});
