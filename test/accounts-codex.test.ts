// `ms accounts` (Codex/ChatGPT). Nothing here touches the network, a real
// `codex` binary, or the operator's own `~/.codex`: `codex` is a bash stub on
// a temp PATH that writes a fixture `auth.json` into whatever `$CODEX_HOME` it
// was handed and logs its argv, `globalThis.fetch` is stubbed inside the `ms`
// child process (a NODE_OPTIONS preload, so the verb still runs as a real
// subprocess and every test can grep ALL of its output), and the store lives
// in a temp MS_HOME.
//
// `security` is stubbed too, answering "no such item" to everything: a mixed
// `ls` reads the Claude POLL column, and that column must never reach the
// real keychain from a test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, stubDir, tempHome } from "./helpers.ts";

const ACCESS = "codex-at-1";
/** The refresh token lives in the same file as the access token; no request
 *  this tool makes may ever carry it. Distinctive on purpose. */
const REFRESH = "codex-rt-DO-NOT-SEND";
const DEVICE_LINE = "Open https://auth.openai.com/device and enter code WXYZ-1234";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A JWT-shaped id_token: only the middle segment is ever read. */
const idToken = (accountId: string, email: string) =>
  `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" },
  })}.not-a-real-signature`;

/** What `codex login` leaves behind, in the real shape (tokens nested). */
function authFixture(accountId = "acct-1", email = "someone@example.com", opts: { idToken?: boolean } = {}) {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      ...(opts.idToken === false ? {} : { id_token: idToken(accountId, email) }),
      access_token: ACCESS,
      refresh_token: REFRESH,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  });
}

const CODEX_STUB = `
printf '%s\\t%s\\n' "$*" "$CODEX_HOME" >> "$MS_TEST_CODEX_LOG"
if [ "$1" = "login" ]; then
  [ -n "$CODEX_HOME" ] || { echo "no CODEX_HOME" >&2; exit 9; }
  [ -n "$MS_TEST_LOGIN_STDOUT" ] && printf '%s\\n' "$MS_TEST_LOGIN_STDOUT"
  [ -n "$MS_TEST_LOGIN_STDERR" ] && printf '%s\\n' "$MS_TEST_LOGIN_STDERR" >&2
  if [ "$MS_TEST_LOGIN_EXIT" != "0" ]; then exit "$MS_TEST_LOGIN_EXIT"; fi
  if [ "$MS_TEST_NO_AUTH_JSON" != "1" ]; then printf '%s' "$MS_TEST_AUTH_JSON" > "$CODEX_HOME/auth.json"; fi
  exit 0
fi
exit 3
`;

const FETCH_STUB = `import { appendFileSync } from "node:fs";
const log = process.env.MS_TEST_FETCH_LOG;
const status = Number(process.env.MS_TEST_FETCH_STATUS || "200");
globalThis.fetch = async (input, init = {}) => {
  const headers = {};
  new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
  appendFileSync(log, JSON.stringify({ url: String(input), headers }) + "\\n");
  if (status === 0) throw new TypeError("fetch failed");
  return new Response(JSON.stringify({ usage: {} }), { status, headers: { "content-type": "application/json" } });
};
`;

type Opts = {
  authJson?: string;
  noAuthJson?: boolean;
  loginExit?: number;
  loginStdout?: string;
  loginStderr?: string;
  /** 0 makes `fetch` itself throw, the network-is-down case. */
  fetchStatus?: number;
};

type CodexCall = { argv: string[]; env: { CODEX_HOME: string } };

function scene(opts: Opts = {}) {
  const { home, msHome } = tempHome();
  const { dir: bin, stub } = stubDir();
  stub("codex", CODEX_STUB);
  stub("security", "exit 44");
  const fetchStub = path.join(home, "fetch-stub.mjs");
  writeFileSync(fetchStub, FETCH_STUB);
  const codexLog = path.join(home, "codex.log");
  const fetchLog = path.join(home, "fetch.log");
  for (const f of [codexLog, fetchLog]) writeFileSync(f, "");
  const env: Record<string, string> = {
    HOME: home,
    MS_HOME: msHome,
    PATH: `${bin}:${process.env.PATH}`,
    NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${pathToFileURL(fetchStub).href}`,
    MS_TEST_CODEX_LOG: codexLog,
    MS_TEST_FETCH_LOG: fetchLog,
    MS_TEST_FETCH_STATUS: String(opts.fetchStatus ?? 200),
    MS_TEST_AUTH_JSON: opts.authJson ?? authFixture(),
    MS_TEST_NO_AUTH_JSON: opts.noAuthJson ? "1" : "0",
    MS_TEST_LOGIN_EXIT: String(opts.loginExit ?? 0),
    MS_TEST_LOGIN_STDOUT: opts.loginStdout ?? DEVICE_LINE,
    MS_TEST_LOGIN_STDERR: opts.loginStderr ?? "",
  };
  return {
    home,
    msHome,
    sharedSessions: path.join(msHome, "codex", "sessions"),
    codexHome: (n: string) => path.join(msHome, "codex", n),
    codexCalls: (): CodexCall[] =>
      readFileSync(codexLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [argv, CODEX_HOME] = l.split("\t");
          return { argv: argv.split(" ").filter(Boolean), env: { CODEX_HOME } };
        }),
    fetchCalls: (): { url: string; headers: Record<string, string> }[] =>
      readFileSync(fetchLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    accounts: (): Record<string, unknown>[] => {
      const f = path.join(msHome, "accounts.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).accounts : [];
    },
    row(n: string, provider = "codex"): Record<string, unknown> {
      const a = this.accounts().find((x) => x.name === n && x.provider === provider);
      assert.ok(a, `no ${provider} row for ${n}`);
      return a;
    },
    ms: (args: string[], extra: Record<string, string> = {}) => run(["accounts", ...args], { ...env, ...extra }),
  };
}

// --- add ---------------------------------------------------------------

test("add --provider codex creates the home with a shared sessions link", () => {
  const s = scene();
  const r = s.ms(["add", "work", "--provider", "codex"]);
  assert.equal(r.code, 0, r.stderr);
  const home = s.codexHome("work");
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.ok(lstatSync(path.join(home, "sessions")).isSymbolicLink());
  assert.equal(readlinkSync(path.join(home, "sessions")), s.sharedSessions);
  assert.equal(statSync(s.sharedSessions).mode & 0o777, 0o700);
  assert.deepEqual(s.row("work"), {
    name: "work", provider: "codex", label: "work", orgId: null, shared: false, identityVerified: false,
  });
});

test("add --provider codex carries the label and the shared flag, and rejects an unknown provider", () => {
  const s = scene();
  assert.equal(s.ms(["add", "work", "--provider=codex", "--label", "Work ChatGPT", "--shared"]).code, 0);
  assert.equal(s.row("work").label, "Work ChatGPT");
  assert.equal(s.row("work").shared, true);
  const bad = s.ms(["add", "other", "--provider", "openai"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /claude\|codex/);
});

test("add --provider codex refuses the name the shared rollout store already owns", () => {
  // `codex/sessions` IS the shared store; an account of that name would have
  // it as its home, and `remove` would take every rollout with it.
  const s = scene();
  const r = s.ms(["add", "sessions", "--provider", "codex"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /sessions/);
  assert.deepEqual(s.accounts(), []);
});

test("a Codex name may equal a Claude name (per-provider uniqueness)", () => {
  const s = scene();
  assert.equal(s.ms(["add", "gmail"]).code, 0);
  assert.equal(s.ms(["add", "gmail", "--provider", "codex"]).code, 0);
  assert.deepEqual(s.accounts().map((a) => `${a.provider}:${a.name}`), ["claude:gmail", "codex:gmail"]);
  // ...and a second codex `gmail` is still a duplicate.
  assert.equal(s.ms(["add", "gmail", "--provider", "codex"]).code, 2);
  assert.equal(s.accounts().length, 2);
});

// --- login -------------------------------------------------------------

test("login runs codex login under the account's CODEX_HOME, records identity, refuses a duplicate account id", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  const r = s.ms(["login", "work"]);
  assert.equal(r.code, 0, r.stderr);
  const call = s.codexCalls()[0];
  assert.deepEqual(call.argv.slice(0, 2), ["login", "--device-auth"]); // stdin is not a TTY in tests
  assert.equal(call.env.CODEX_HOME, s.codexHome("work"));
  assert.equal(s.row("work").orgId, "acct-1");
  assert.equal(s.row("work").identityVerified, true);
  assert.equal(s.row("work").identityMethod, "codex-login");

  s.ms(["add", "work2", "--provider", "codex"]);
  const dup = s.ms(["login", "work2"]);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already registered as work/);
  // the refused row stays unverified, and its home is left in place
  assert.equal(s.row("work2").identityVerified, false);
  assert.equal(s.row("work2").orgId, null);
  assert.ok(existsSync(s.codexHome("work2")));
});

test("login forwards the device code and URL to the human", () => {
  const s = scene({ loginStderr: "waiting for the browser..." });
  s.ms(["add", "work", "--provider", "codex"]);
  const r = s.ms(["login", "work"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stderr.includes(DEVICE_LINE), r.stderr);
  assert.ok(r.stderr.includes("waiting for the browser..."), r.stderr);
});

test("login never lets a token-shaped string through, wherever codex printed it", () => {
  const leak = "sk-ant-oat01-NOTREALLYATOKENbutshaped_-123456";
  const s = scene({ loginStdout: `here is a token ${leak} oops` });
  s.ms(["add", "work", "--provider", "codex"]);
  const r = s.ms(["login", "work"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal((r.stdout + r.stderr).includes(leak), false, r.stderr);
  assert.match(r.stderr, /sk-ant-oat01-<redacted>/);
});

test("login fails when codex login leaves no auth.json, and when it exits non-zero", () => {
  const missing = scene({ noAuthJson: true });
  missing.ms(["add", "work", "--provider", "codex"]);
  const r = missing.ms(["login", "work"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /left no auth\.json/);
  assert.ok(r.stderr.includes(missing.codexHome("work")), r.stderr);
  assert.equal(missing.row("work").identityVerified, false);

  const failing = scene({ loginExit: 7 });
  failing.ms(["add", "work", "--provider", "codex"]);
  const f = failing.ms(["login", "work"]);
  assert.equal(f.code, 1);
  assert.match(f.stderr, /codex login exited 7/);
});

test("login takes the account id from the id_token, falling back to tokens.account_id", () => {
  // The id_token's own claim wins over the sibling field...
  const s = scene({ authJson: JSON.stringify({
    tokens: { id_token: idToken("acct-from-claims", "who@example.com"), access_token: ACCESS, refresh_token: REFRESH, account_id: "acct-from-field" },
  }) });
  s.ms(["add", "work", "--provider", "codex"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  assert.equal(s.row("work").orgId, "acct-from-claims");

  // ...and with no id_token at all, the sibling field is the identity.
  const bare = scene({ authJson: authFixture("acct-field-only", "x@example.com", { idToken: false }) });
  bare.ms(["add", "work", "--provider", "codex"]);
  assert.equal(bare.ms(["login", "work"]).code, 0);
  assert.equal(bare.row("work").orgId, "acct-field-only");
});

test("login proves the credential with one bounded usage fetch: 401 fails it, a 500 only warns", () => {
  const dead = scene({ fetchStatus: 401 });
  dead.ms(["add", "work", "--provider", "codex"]);
  const d = dead.ms(["login", "work"]);
  assert.equal(d.code, 1);
  assert.match(d.stderr, /ms accounts login work --provider codex/);

  const flaky = scene({ fetchStatus: 500 });
  flaky.ms(["add", "work", "--provider", "codex"]);
  const f = flaky.ms(["login", "work"]);
  assert.equal(f.code, 0, f.stderr);
  assert.match(f.stderr, /warning/i);
  assert.equal(flaky.row("work").identityVerified, true);
});

test("the usage fetch carries the access token and the account id, never the refresh token", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  const calls = s.fetchCalls();
  assert.ok(calls.length > 0, "the credential was never proven");
  for (const c of calls) {
    assert.equal(c.url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(c.headers.authorization, `Bearer ${ACCESS}`);
    assert.equal(c.headers["chatgpt-account-id"], "acct-1");
    assert.equal(JSON.stringify(c).includes(REFRESH), false, JSON.stringify(c));
  }
});

// --- verify ------------------------------------------------------------

test("verify re-reads auth.json, re-proves the credential, and never logs in", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  const before = s.codexCalls().length;
  const r = s.ms(["verify", "work"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.codexCalls().length, before, "verify ran the codex CLI");
  assert.equal(s.row("work").identityVerified, true);
  assert.ok(s.fetchCalls().length > 1, "verify did not re-prove the credential");
});

test("verify fails when the account has never logged in", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  const r = s.ms(["verify", "work"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /auth\.json/);
});

// --- token, ls, remove -------------------------------------------------

test("token on a codex row says there is none, and never touches the claude token store", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  const r = s.ms(["token", "work"]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /codex accounts have no launch token; the CLI reads CODEX_HOME/);
});

test("ls shows POLL yes / TOKEN n/a for a Codex row, beside the Claude rows", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  s.ms(["add", "work", "--provider", "codex", "--label", "Work"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NAME\s+PROVIDER\s+LABEL\s+ORG\s+POLL\s+TOKEN\s+VERIFIED/);
  assert.match(r.stdout, /gmail\s+claude\s+gmail\s+-\s+no\s+no\s+no/);
  assert.match(r.stdout, /work\s+codex\s+Work\s+acct-1\s+yes\s+n\/a\s+yes/);
  assert.equal(r.stdout.includes(ACCESS), false);
  assert.equal(r.stdout.includes(REFRESH), false);
});

test("ls calls a codex row with no credential `no`, without a single request", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /work\s+codex\s+work\s+-\s+no\s+n\/a\s+no/);
  assert.deepEqual(s.fetchCalls(), []);
});

test("ls says `unknown`, not `no`, when the usage endpoint could not be reached", () => {
  // A network that is down is not a missing credential, and the account book
  // must not say it is — the same honesty the TOKEN column's `unreadable` buys.
  const s = scene({ fetchStatus: 500 });
  s.ms(["add", "work", "--provider", "codex"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /work\s+codex\s+work\s+acct-1\s+unknown\s+n\/a\s+yes/);
});

test("remove deletes the home but not the shared sessions store", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  const rollout = path.join(s.sharedSessions, "rollout-2026-09-16.jsonl");
  writeFileSync(rollout, '{"session":"kept"}\n');
  const r = s.ms(["remove", "work", "--provider", "codex"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.accounts(), []);
  assert.equal(existsSync(s.codexHome("work")), false);
  assert.ok(existsSync(rollout), "the shared rollout store was followed and deleted");
  assert.equal(readFileSync(rollout, "utf8"), '{"session":"kept"}\n');
});

test("remove of a codex row leaves the claude row of the same name alone", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  s.ms(["add", "gmail", "--provider", "codex"]);
  assert.equal(s.ms(["remove", "gmail", "--provider", "codex"]).code, 0);
  assert.deepEqual(s.accounts().map((a) => `${a.provider}:${a.name}`), ["claude:gmail"]);
  assert.equal(existsSync(s.codexHome("gmail")), false);
});

// --- disambiguation ----------------------------------------------------

test("a name held by both providers needs --provider, and says so", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  s.ms(["add", "gmail", "--provider", "codex"]);
  for (const verb of ["login", "verify", "remove"]) {
    const r = s.ms([verb, "gmail"]);
    assert.equal(r.code, 2, `${verb}: ${r.stderr}`);
    assert.match(r.stderr, /--provider/);
  }
  // named, it resolves
  assert.equal(s.ms(["login", "gmail", "--provider", "codex"]).code, 0);
  assert.equal(s.row("gmail").identityVerified, true);
});

test("a codex row is reached by name alone when no claude row shares it", () => {
  const s = scene();
  s.ms(["add", "work", "--provider", "codex"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  assert.equal(s.ms(["verify", "work"]).code, 0);
  assert.equal(s.ms(["remove", "work"]).code, 0);
  assert.deepEqual(s.accounts(), []);
});

test("--provider names an account that does not exist under that provider", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail", "--provider", "codex"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no such codex account: gmail/);
});
