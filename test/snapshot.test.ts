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
import { tempHome } from "./helpers.ts";

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
  assert.ok(byName(a, "one").observedAt > 0);
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

  const file = JSON.parse(readFileSync(snapshot, "utf8"));
  const until = file.backoff.one;
  assert.ok(typeof until === "number" && until > Date.now(), "an untilMs was recorded");
  assert.ok(until - Date.now() <= 900_000, "never a day, whatever the endpoint asks for");

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
  const s = {
    takenAt: Date.now(),
    accounts: [
      { ...base, name: "recent", error: "429 from /api/oauth/usage", errorKind: "transient" as const, observedAt: Date.now() - 60_000 },
      { ...base, name: "old", error: "429 from /api/oauth/usage", errorKind: "transient" as const, observedAt: Date.now() - 900_000 },
      { ...base, name: "other", error: "no poller yet", errorKind: "other" as const, observedAt: Date.now() },
      { ...base, name: "blank", usage: null, error: null, errorKind: null, observedAt: 0 },
    ],
  };
  const out = new Map(toPickInputs(s).map((i) => [i.name, i]));
  assert.equal(out.get("recent")!.error, null, "a minute-old reading still chooses");
  assert.equal(out.get("recent")!.session!.usedPercent, 5);
  assert.ok(out.get("old")!.error, "past 10 minutes the reading is no longer evidence");
  assert.ok(out.get("other")!.error, "only transient errors keep an account alive");
  assert.ok(out.get("blank")!.error, "no usage is never alive, error or not");
});

test("a poll already under way is not duplicated: the waiter serves what the holder wrote", async () => {
  const { msHome, snapshot } = env();
  grant(msHome, "one");
  grant(msHome, "two");
  const stale = {
    takenAt: Date.now() - 600_000,
    accounts: [
      { name: "one", provider: "claude", shared: false, usage: null, error: null, errorKind: null, observedAt: 0, stale: false },
      { name: "two", provider: "claude", shared: false, usage: null, error: null, errorKind: null, observedAt: 0, stale: false },
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

test("a codex account is reported as unpollable and is never polled", async () => {
  const { msHome } = env([{ name: "one", provider: "claude" }, { name: "cdx", provider: "codex" }]);
  grant(msHome, "one");
  const calls = stubFetch(() => ok());
  const { getSnapshot, toPickInputs } = await load();

  const s = await getSnapshot();
  assert.deepEqual(calls.map((c) => c.auth), ["Bearer at-one"]);
  const cdx = byName(s, "cdx");
  assert.equal(cdx.usage, null);
  assert.equal(cdx.error, "no poller yet");
  assert.equal(cdx.errorKind, "other");
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
    const got = acquire("account-one");
    heldDuringRefresh = got === null;
    got?.();
    return new Response(JSON.stringify({ access_token: "at-fresh", expires_in: 3600 }), { status: 200 });
  });

  const s = await getSnapshot();
  assert.equal(heldDuringRefresh, true, "account-one was locked while its grant was rotated");
  assert.equal(byName(s, "one").error, null);
  const after = acquire("account-one");
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
  const release = acquire("account-one")!;
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
