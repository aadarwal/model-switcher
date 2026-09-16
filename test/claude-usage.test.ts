// The keychain item: a `claude auth login` run with CLAUDE_CONFIG_DIR=<dir>
// stores its OAuth credential as a generic password whose SERVICE is
// "Claude Code-credentials-<first 8 hex of sha256(<dir>)>" and whose ACCOUNT is
// the macOS username — verified live on the author's Mac, 2026-09-15. Both are
// derived, so this module guesses nothing: the credentials file is tried first,
// then that one scoped item. The UNSCOPED service ("Claude Code-credentials")
// is the human's own ordinary login and is never queried, written or deleted —
// the test below asserts that on the recorded argv. These tests stub `security`
// on PATH and `globalThis.fetch`; they never touch the real keychain,
// `~/.claude`, or the network. Every test restores fetch, PATH, HOME and
// MS_HOME in its own teardown, so nothing leaks into the next test or out of
// the file.

import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";

const USER = userInfo().username;
/** The unscoped item: the operator's own Claude Code login. No command may
 *  ever name it on a `security` argv. */
const UNSCOPED = "Claude Code-credentials";
const queriedTheUnscopedItem = (argv: string) => new RegExp(`-s ${UNSCOPED}(?=\\s|$)`, "m").test(argv);

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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, msHome, home };
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

// The one verified pair, pinned. Measured live on macOS, 2026-09-15:
//   printf '%s' "/Users/aadarwal/.config/model-switcher/claude/tulp" \
//     | openssl dgst -sha256   →  4f3610a9…
// (the path exactly as it is handed to CLAUDE_CONFIG_DIR: absolute, no
// trailing slash). If this ever fails, the derivation moved — not the test.
test("keychainServiceFor derives the service Claude Code actually used", async (t) => {
  env(t);
  const { keychainServiceFor } = await import("../src/providers/claude-usage.ts");
  assert.equal(
    keychainServiceFor("/Users/aadarwal/.config/model-switcher/claude/tulp"),
    "Claude Code-credentials-4f3610a9",
  );
  // A different dir is a different item, and neither is the unscoped service.
  assert.notEqual(
    keychainServiceFor("/Users/aadarwal/.config/model-switcher/claude/gmail"),
    "Claude Code-credentials-4f3610a9",
  );
  assert.match(keychainServiceFor("/tmp/x"), /^Claude Code-credentials-[0-9a-f]{8}$/);
});

/** A `security` that answers for exactly one item and logs every argv. */
function securityStub(t: TestContext, service: string, account: string, value: string) {
  const { stub, dir: bin } = stubDir();
  const argv = path.join(mkdtempArgvDir(), "security-argv.log");
  writeFileSync(argv, "");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.MS_TEST_SECURITY_ARGV = argv;
  t.after(() => delete process.env.MS_TEST_SECURITY_ARGV);
  stub(
    "security",
    `printf '%s\\n' "$*" >> "$MS_TEST_SECURITY_ARGV"
case "$*" in *"-s ${service} -a ${account}"*) printf '%s' '${value}' ;; *) exit 44 ;; esac`,
  );
  return { argv: () => readFileSync(argv, "utf8") };
}
const mkdtempArgvDir = () => tempHome().home;

test("readPollCredentials falls back to the scoped keychain item derived from the config dir", async (t) => {
  const { dir } = env(t);
  const { keychainServiceFor, readPollCredentials } = await import("../src/providers/claude-usage.ts");
  const s = securityStub(t, keychainServiceFor(dir), USER, JSON.stringify(cred));
  assert.equal(readPollCredentials("gmail")!.source, "keychain");
  // Proves it came from the stub, not from anything on the real keychain.
  assert.equal(readPollCredentials("gmail")!.accessToken, "at-1");
  assert.equal(queriedTheUnscopedItem(s.argv()), false, s.argv());
});

test("a recorded item is what the reader addresses; a note naming the unscoped service is ignored", async (t) => {
  const { dir } = env(t);
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  const recorded = "Claude Code-credentials-deadbeef";
  writeFileSync(path.join(dir, "keychain-item.json"), JSON.stringify({ service: recorded, account: "someone" }));
  const s = securityStub(t, recorded, "someone", JSON.stringify(cred));
  assert.equal(readPollCredentials("gmail")!.accessToken, "at-1");

  // A note pointing at the human's own login is not a note: the reader falls
  // back to the derived scoped item, which this stub does not serve.
  writeFileSync(path.join(dir, "keychain-item.json"), JSON.stringify({ service: UNSCOPED, account: USER }));
  assert.equal(readPollCredentials("gmail"), null);
  assert.equal(queriedTheUnscopedItem(s.argv()), false, s.argv());
});

test("readPollCredentials is null with neither a file nor a keychain item", async (t) => {
  const { dir } = env(t);
  const { keychainServiceFor } = await import("../src/providers/claude-usage.ts");
  const s = securityStub(t, keychainServiceFor(dir), "nobody-at-all", "{}");
  const { readPollCredentials } = await import("../src/providers/claude-usage.ts");
  assert.equal(readPollCredentials("gmail"), null);
  assert.equal(queriedTheUnscopedItem(s.argv()), false, s.argv());
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

/** ~600 bytes of credential — the size the author's real poll grants are, and
 *  the reason `security`'s 128-byte prompt destroys one. */
const LONG_AT = `at-2-${"A".repeat(260)}`;
const LONG_RT = `rt-2-${"R".repeat(260)}`;
/** The token endpoint's answer: a new access token AND a rotated refresh
 *  token. The rotation is what makes a lost write-back fatal. */
const rotating = (async () =>
  new Response(JSON.stringify({ access_token: LONG_AT, refresh_token: LONG_RT, expires_in: 3600 }), {
    status: 200,
  })) as typeof fetch;

/** root writes through a 0500 directory, so denying ourselves one proves
 *  nothing there. */
const CAN_DENY_WRITE = process.getuid?.() !== 0;

/**
 * A keychain that really holds an item — with `security`'s OWN prompt limit
 * modelled, because that limit is the defect.
 *
 * `find -w` serves the vault, `delete-generic-password` removes it, and
 * `add-generic-password` given `-w` as the LAST option with no value is the
 * INTERACTIVE PROMPT path: `security` reads the password off stdin (value,
 * then confirmation) and keeps only the first 128 BYTES of the first line.
 * Measured live on the author's Mac, 2026-09-16: a 300-byte value came back
 * 128 bytes, and `ms doctor --fix` truncated four real ~600-byte poll grants
 * that way. Modelling it here is what makes the fix provable — route a
 * write-back back through the prompt and the grant below reads as garbage.
 *
 * Every argv line is logged, so a test can still prove no secret was ever on
 * one and that the human's own unscoped item was never named.
 */
function keychainScene(t: TestContext) {
  const { dir, home } = env(t);
  const { stub, dir: bin } = stubDir();
  // Outside the config dir on purpose: a test that makes that dir unwritable
  // must not also break the stub's own bookkeeping.
  const vault = path.join(home, "vault.json");
  const argv = path.join(home, "security-argv.log");
  writeFileSync(vault, JSON.stringify({ ...cred, otherThing: { keep: true } }));
  writeFileSync(argv, "");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.MS_TEST_VAULT = vault;
  process.env.MS_TEST_SECURITY_ARGV = argv;
  t.after(() => {
    delete process.env.MS_TEST_VAULT;
    delete process.env.MS_TEST_SECURITY_ARGV;
  });
  // The item this config dir's login would have written, and no other.
  const service = `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
  stub(
    "security",
    `printf '%s\\n' "$*" >> "$MS_TEST_SECURITY_ARGV"
mine() { case "$*" in *"-s ${service} -a ${USER}"*) return 0 ;; *) return 1 ;; esac; }
case "$1" in
  find-generic-password)
    mine "$@" || exit 44
    [ -f "$MS_TEST_VAULT" ] || exit 44
    case "$*" in *" -w") cat "$MS_TEST_VAULT" ;; esac ;;
  delete-generic-password)
    mine "$@" || exit 44
    [ -f "$MS_TEST_VAULT" ] || exit 44
    rm -f "$MS_TEST_VAULT" ;;
  add-generic-password)
    # The interactive prompt: the value arrives on stdin and 128 bytes of it
    # survive. Nothing in this tool may write a secret this way.
    IFS= read -r line
    printf '%s' "\${line:0:128}" > "$MS_TEST_VAULT" ;;
esac
exit 0`,
  );
  return { dir, home, vault, service, argv: () => readFileSync(argv, "utf8") };
}

test("a refreshed keychain-sourced grant is written WHOLE to the credentials file, never through security's prompt", async (t) => {
  // The defect, verified live 2026-09-16: ms 0.2.0 wrote the refreshed blob
  // back into the keychain through `security`'s interactive prompt, to keep
  // the secret off argv. That prompt stops at 128 bytes and a poll grant is
  // ~600, so every refreshed grant was truncated on write-back — and because
  // the token endpoint ROTATES the refresh token, the one it replaced was
  // already spent. The account was dead until a re-login.
  const scene = keychainScene(t);
  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  globalThis.fetch = rotating;

  const c = readPollCredentials("gmail")!;
  assert.equal(c.source, "keychain");
  const c2 = await refreshPollCredentials("gmail", c, AbortSignal.timeout(1000));
  assert.equal(c2.accessToken, LONG_AT);
  assert.equal(c2.refreshToken, LONG_RT);

  const seen = readPollCredentials("gmail");
  assert.ok(seen, "the refreshed grant is unreadable — the write-back truncated it");
  assert.equal(seen!.source, "file", "the file is what readPollCredentials prefers, so that is where it goes");
  assert.equal(seen!.refreshToken, LONG_RT, "the ROTATED refresh token, whole");
  assert.equal(seen!.accessToken, LONG_AT);

  const file = path.join(scene.dir, ".credentials.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const argv = scene.argv();
  assert.equal(/add-generic-password/.test(argv), false, `a secret was routed through security's prompt: ${argv}`);
  assert.equal(argv.includes(LONG_RT), false, argv);
  assert.equal(argv.includes(LONG_AT), false, argv);
  assert.equal(queriedTheUnscopedItem(argv), false, argv);
});

test("the spent keychain item is deleted once the file write lands", async (t) => {
  // Nothing reads it again on purpose — the file wins — but a spent grant that
  // can still be read is a spent grant that can still be handed to the token
  // endpoint. It is addressed by service and account only: no secret on argv.
  const scene = keychainScene(t);
  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  globalThis.fetch = rotating;
  await refreshPollCredentials("gmail", readPollCredentials("gmail")!, AbortSignal.timeout(1000));

  assert.equal(existsSync(scene.vault), false, "the spent grant is gone from the keychain");
  const argv = scene.argv();
  assert.match(argv, new RegExp(`^delete-generic-password -s ${scene.service} -a ${USER}$`, "m"), argv);
  assert.equal(argv.includes(LONG_RT), false, argv);
  assert.equal(queriedTheUnscopedItem(argv), false, argv);
  // ...and the grant still reads, out of the file it moved to.
  assert.equal(readPollCredentials("gmail")!.refreshToken, LONG_RT);
});

test("a credentials file that cannot be written leaves the keychain item alone", { skip: !CAN_DENY_WRITE }, async (t) => {
  // The write-back is best-effort by contract: a refresh that landed must not
  // be lost to a write problem. So the stale item stays — a grant the human
  // can re-login over beats no grant at all — and this run uses the fresh
  // credential from memory.
  const scene = keychainScene(t);
  chmodSync(scene.dir, 0o500);
  t.after(() => chmodSync(scene.dir, 0o700));
  process.env.MS_VERBOSE = "1";
  t.after(() => delete process.env.MS_VERBOSE);
  const said: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void said.push(args.join(" "));
  t.after(() => {
    console.error = originalError;
  });

  const { readPollCredentials, refreshPollCredentials } = await import("../src/providers/claude-usage.ts");
  globalThis.fetch = rotating;
  const c2 = await refreshPollCredentials("gmail", readPollCredentials("gmail")!, AbortSignal.timeout(1000));

  assert.equal(c2.refreshToken, LONG_RT, "the caller still holds the fresh credential for this run");
  assert.ok(existsSync(scene.vault), "the keychain item is untouched");
  assert.equal(/delete-generic-password/.test(scene.argv()), false, scene.argv());
  assert.ok(said.length > 0, "a stranded refresh token is never silent");
  assert.ok(
    said.some((l) => /could not write refreshed Claude credentials back to/.test(l)),
    said.join("\n"),
  );
  for (const l of said) {
    assert.equal(l.includes(LONG_RT), false, "no token value is ever logged");
    assert.equal(l.includes(LONG_AT), false, "no token value is ever logged");
  }
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

// `retry-after` is the only thing the endpoint ever tells us about WHEN to
// come back. Dropping it (as this module did until now) left every caller
// guessing, so the header is parsed here, at the only place that can see it,
// and carried on the error. Bounded, because a header is not a promise: the
// caller (src/snapshot.ts) clamps whatever it is told.
test("parseRetryAfter reads delta-seconds and HTTP-dates, and refuses the rest", async (t) => {
  env(t);
  const { parseRetryAfter } = await import("../src/providers/claude-usage.ts");
  const now = Date.parse("2026-09-15T12:00:00Z");

  assert.equal(parseRetryAfter("120", now), 120_000);
  assert.equal(parseRetryAfter(" 86400 ", now), 86_400_000);
  assert.equal(parseRetryAfter("Tue, 15 Sep 2026 12:02:00 GMT", now), 120_000);
  // Bounded: a year of delta-seconds is still only a day of advice.
  assert.equal(parseRetryAfter("31536000", now), 86_400_000);
  // "No advice" is undefined, never 0 — a caller must be able to tell them apart.
  assert.equal(parseRetryAfter(null, now), undefined);
  assert.equal(parseRetryAfter("", now), undefined);
  assert.equal(parseRetryAfter("soon", now), undefined);
  assert.equal(parseRetryAfter("-5", now), undefined);
  assert.equal(parseRetryAfter("0", now), undefined);
  // A date already past is not a wait.
  assert.equal(parseRetryAfter("Tue, 15 Sep 2026 11:59:00 GMT", now), undefined);
});

test("a 429 carries its retry-after to the caller, on both endpoints", async (t) => {
  env(t);
  const { fetchUsage, refreshPollCredentials, TransientError } =
    await import("../src/providers/claude-usage.ts");
  const c = { accessToken: "at", refreshToken: "rt", expiresAt: 0, source: "file" as const };

  globalThis.fetch = (async () =>
    new Response("slow down", { status: 429, headers: { "retry-after": "86400" } })) as typeof fetch;
  const usageErr = await fetchUsage(c, AbortSignal.timeout(1000)).then(() => null, (e: unknown) => e);
  assert.ok(usageErr instanceof TransientError);
  assert.equal((usageErr as InstanceType<typeof TransientError>).retryAfterMs, 86_400_000);

  const refreshErr = await refreshPollCredentials("gmail", c, AbortSignal.timeout(1000))
    .then(() => null, (e: unknown) => e);
  assert.ok(refreshErr instanceof TransientError);
  assert.equal((refreshErr as InstanceType<typeof TransientError>).retryAfterMs, 86_400_000);

  // A 503 that says nothing leaves the field absent, not zero.
  globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
  const quiet = await fetchUsage(c, AbortSignal.timeout(1000)).then(() => null, (e: unknown) => e);
  assert.ok(quiet instanceof TransientError);
  assert.equal((quiet as InstanceType<typeof TransientError>).retryAfterMs, undefined);
});
