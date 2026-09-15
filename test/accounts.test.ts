// `ms accounts` (Claude). Nothing here touches the network, the real
// keychain, `~/.claude`, or a real `claude` binary: `claude` and `security`
// are bash stubs on a temp PATH, `globalThis.fetch` is stubbed inside the
// `ms` child process (a NODE_OPTIONS preload — the verb runs as a real
// subprocess so every test can grep ALL of its stdout and stderr), and the
// store lives in a temp MS_HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run, stubDir, tempHome } from "./helpers.ts";

const TOKEN = "sk-ant-oat01-TESTtoken1234567890_-abcdefghijklmnop";
const PROFILE = {
  account: { email: "someone@example.com" },
  organization: { uuid: "org-1", name: "Someone's Org", rate_limit_tier: "default_claude_max_20x" },
};
const CRED = JSON.stringify({
  claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 },
});

// Records argv (so a test can prove no secret ever reached it), then plays
// the four calls `ms accounts` makes.
const CLAUDE_STUB = `
printf '%s\\n' "$*" >> "$MS_TEST_ARGV"
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  [ -n "$CLAUDE_CONFIG_DIR" ] || { echo "no CLAUDE_CONFIG_DIR" >&2; exit 9; }
  if [ "$MS_TEST_NO_CRED_FILE" != "1" ]; then printf '%s' "$MS_TEST_CRED" > "$CLAUDE_CONFIG_DIR/.credentials.json"; fi
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "auth status ran without the token env" >&2; exit 9; }
  printf '%s\\n' "$MS_TEST_AUTH_STATUS"
  exit 0
fi
if [ "$1" = "setup-token" ]; then
  echo "Opening your browser to mint a token..."
  printf '%s\\n' "$MS_TEST_TOKEN"
  exit 0
fi
if [ "$1" = "-p" ]; then
  [ "$CLAUDE_CODE_OAUTH_TOKEN" = "$MS_TEST_TOKEN" ] || { echo "probe ran without the token env" >&2; exit 9; }
  printf '%s\\n' "$MS_TEST_PROBE_OUT"
  exit 0
fi
exit 3
`;

// Answers only for the account names listed in MS_TEST_KEYCHAIN_OK; -w (the
// read) hands back the credential JSON, a bare probe just exits 0.
const SECURITY_STUB = `
printf '%s\\n' "$*" >> "$MS_TEST_SECURITY_ARGV"
match=0
for cand in $MS_TEST_KEYCHAIN_OK; do
  case "$*" in *"-a $cand"*) match=1 ;; esac
done
[ "$match" = 1 ] || exit 44
case "$*" in *-w*) printf '%s' "$MS_TEST_CRED" ;; esac
exit 0
`;

type Opts = {
  profile?: unknown;
  token?: string;
  noCredFile?: boolean;
  keychainOk?: string[];
  authStatus?: string;
  probeOut?: string;
};

function scene(opts: Opts = {}) {
  const { home, msHome } = tempHome();
  const { dir: bin, stub } = stubDir();
  stub("claude", CLAUDE_STUB);
  stub("security", SECURITY_STUB);
  const fetchStub = path.join(home, "fetch-stub.mjs");
  writeFileSync(
    fetchStub,
    `const body = ${JSON.stringify(JSON.stringify(opts.profile ?? PROFILE))};\n` +
      `globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } });\n`,
  );
  const argv = path.join(home, "claude-argv.log");
  const securityArgv = path.join(home, "security-argv.log");
  writeFileSync(argv, "");
  writeFileSync(securityArgv, "");
  const env: Record<string, string> = {
    HOME: home,
    MS_HOME: msHome,
    PATH: `${bin}:${process.env.PATH}`,
    NODE_OPTIONS: `--import=${pathToFileURL(fetchStub).href}`,
    MS_TEST_ARGV: argv,
    MS_TEST_SECURITY_ARGV: securityArgv,
    MS_TEST_TOKEN: opts.token ?? TOKEN,
    MS_TEST_CRED: CRED,
    MS_TEST_NO_CRED_FILE: opts.noCredFile ? "1" : "0",
    MS_TEST_KEYCHAIN_OK: (opts.keychainOk ?? []).join(" "),
    MS_TEST_AUTH_STATUS: opts.authStatus ?? '{"organization":{"uuid":"org-1"}}',
    MS_TEST_PROBE_OUT: opts.probeOut ?? "ok",
  };
  return {
    home,
    msHome,
    argvLog: () => readFileSync(argv, "utf8"),
    truncateArgv: () => writeFileSync(argv, ""),
    securityLog: () => readFileSync(securityArgv, "utf8"),
    configDir: (n: string) => path.join(msHome, "claude", n),
    tokenFile: (n: string) => path.join(msHome, "launch", `${n}.token`),
    accounts: (): Record<string, unknown>[] => {
      const f = path.join(msHome, "accounts.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).accounts : [];
    },
    row(n: string): Record<string, unknown> {
      const a = this.accounts().find((x) => x.name === n);
      assert.ok(a, `no row for ${n}`);
      return a;
    },
    ms: (args: string[], extra: Record<string, string> = {}) => run(["accounts", ...args], { ...env, ...extra }),
  };
}

// --- add ---------------------------------------------------------------

test("accounts add writes a claude row with the label and the shared flag", () => {
  const s = scene();
  const r = s.ms(["add", "gmail", "--label", "Personal", "--shared"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.accounts(), [
    { name: "gmail", provider: "claude", label: "Personal", orgId: null, shared: true, identityVerified: false },
  ]);
});

test("accounts add defaults the label to the name and shared to false", () => {
  const s = scene();
  assert.equal(s.ms(["add", "gmail"]).code, 0);
  assert.deepEqual(s.row("gmail"), {
    name: "gmail", provider: "claude", label: "gmail", orgId: null, shared: false, identityVerified: false,
  });
});

test("accounts add refuses a duplicate name and a name the registry would not accept", () => {
  const s = scene();
  assert.equal(s.ms(["add", "gmail"]).code, 0);
  const dup = s.ms(["add", "gmail"]);
  assert.notEqual(dup.code, 0);
  assert.match(dup.stderr, /gmail/);
  assert.notEqual(s.ms(["add", "Not A Name"]).code, 0);
  assert.equal(s.accounts().length, 1);
});

// --- login -------------------------------------------------------------

test("accounts login mints both credentials, sets the org and verifies identity", () => {
  const s = scene();
  assert.equal(s.ms(["add", "gmail", "--label", "Personal"]).code, 0);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 0, r.stderr);

  const row = s.row("gmail");
  assert.equal(row.orgId, "org-1");
  assert.equal(row.identityVerified, true);

  const tf = s.tokenFile("gmail");
  assert.equal(readFileSync(tf, "utf8").trim(), TOKEN);
  assert.equal(statSync(tf).mode & 0o777, 0o600);

  const log = s.argvLog();
  assert.match(log, /^auth login$/m);
  assert.match(log, /^setup-token$/m);
  assert.match(log, /^-p Reply with the single word ok\./m);
  assert.match(log, /^auth status --json$/m);
});

test("accounts login never puts the token on any argv", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);
  assert.equal(s.argvLog().includes(TOKEN), false);
  assert.equal(s.securityLog().includes(TOKEN), false);
});

test("accounts login refuses a second account resolving to the same organisation", () => {
  const s = scene();
  s.ms(["add", "work"]);
  assert.equal(s.ms(["login", "work"]).code, 0);
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /gmail resolves to the same organisation as work/);
  assert.equal(s.row("gmail").orgId, null);
  assert.equal(s.row("gmail").identityVerified, false);
  assert.equal(existsSync(s.tokenFile("gmail")), false);
  // nothing saved: the credential this run's browser login wrote is undone,
  // so `ls` cannot report a poll grant for the account it turned away.
  assert.equal(existsSync(s.configDir("gmail")), false);
  assert.match(s.ms(["ls"]).stdout, /gmail\s+gmail\s+-\s+no\s+no\s+no/);
});

test("accounts login records identityVerified false with a warning when auth status names no org", () => {
  const s = scene({ authStatus: "{}" });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.row("gmail").orgId, "org-1");
  assert.equal(s.row("gmail").identityVerified, false);
  assert.match(r.stderr, /warning/i);
});

test("accounts login records identityVerified false with a warning when the orgs disagree", () => {
  const s = scene({ authStatus: '{"organization":{"uuid":"org-9"}}' });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.row("gmail").identityVerified, false);
  assert.match(r.stderr, /warning/i);
});

test("accounts login fails when setup-token prints nothing token-shaped", () => {
  const s = scene({ token: "not-a-token" });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.equal(existsSync(s.tokenFile("gmail")), false);
  assert.equal(s.row("gmail").identityVerified, false);
});

// --- locating the poll credential --------------------------------------

test("accounts login records the keychain account when there is no credentials file", () => {
  const s = scene({ noCredFile: true });
  const dir = s.configDir("gmail");
  const sha8 = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  const cand = `${userInfo().username}-${sha8}`;
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_OK: cand });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, "keychain-account"), "utf8").trim(), cand);
  // the bare username is tried first, then the dir-scoped form
  const log = s.securityLog();
  const bare = log.indexOf(`-a ${userInfo().username}\n`);
  const scoped = log.indexOf(`-a ${cand}`);
  assert.ok(bare >= 0 && scoped > bare, `probe order: ${JSON.stringify(log)}`);
  // the probe asks whether the item exists, never for its value
  assert.equal(log.split("\n")[0].includes("-w"), false);
  assert.equal(s.row("gmail").orgId, "org-1");
});

test("accounts login fails loudly when no candidate keychain account answers", () => {
  const s = scene({ noCredFile: true });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not locate the poll credential for gmail/);
  assert.equal(existsSync(s.tokenFile("gmail")), false);
});

// --- verify ------------------------------------------------------------

test("accounts verify re-runs the checks without logging in", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);
  s.truncateArgv();
  const r = s.ms(["verify", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  const log = s.argvLog();
  assert.equal(/auth login/.test(log), false);
  assert.equal(/setup-token/.test(log), false);
  assert.match(log, /^-p Reply with the single word ok\./m);
  assert.match(log, /^auth status --json$/m);
  assert.equal(s.row("gmail").identityVerified, true);
});

test("accounts verify re-locates the poll credential and repairs a lost keychain note", () => {
  const s = scene({ noCredFile: true });
  const dir = s.configDir("gmail");
  const sha8 = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  const cand = `${userInfo().username}-${sha8}`;
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_OK: cand }).code, 0);
  rmSync(path.join(dir, "keychain-account"));
  const r = s.ms(["verify", "gmail"], { MS_TEST_KEYCHAIN_OK: cand });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, "keychain-account"), "utf8").trim(), cand);
});

test("accounts verify fails when there is no launch token yet", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  const r = s.ms(["verify", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /gmail/);
});

// --- token, ls, remove -------------------------------------------------

test("accounts token prints the token and nothing else does", () => {
  const s = scene();
  s.ms(["add", "gmail", "--label", "Personal"]);
  const noisy = [s.ms(["login", "gmail"]), s.ms(["verify", "gmail"]), s.ms(["ls"])];
  for (const r of noisy) assert.equal((r.stdout + r.stderr).includes(TOKEN), false);
  const t = s.ms(["token", "gmail"]);
  assert.equal(t.code, 0);
  assert.equal(t.stdout, `${TOKEN}\n`);
  const rm = s.ms(["remove", "gmail"]);
  assert.equal((rm.stdout + rm.stderr).includes(TOKEN), false);
});

test("accounts token fails when the account has no launch token", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  const r = s.ms(["token", "gmail"]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
});

test("accounts ls prints the six columns", () => {
  const s = scene();
  s.ms(["add", "gmail", "--label", "Personal"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);
  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NAME\s+LABEL\s+ORG\s+POLL\s+TOKEN\s+VERIFIED/);
  assert.match(r.stdout, /gmail\s+Personal\s+org-1\s+yes\s+yes\s+yes/);
});

test("accounts ls shows a registered-but-uncredentialed account as no/no/no", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gmail\s+gmail\s+-\s+no\s+no\s+no/);
});

test("accounts remove deletes the row, the token file and the config dir", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);
  assert.ok(existsSync(s.configDir("gmail")));
  const r = s.ms(["remove", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.accounts(), []);
  assert.equal(existsSync(s.tokenFile("gmail")), false);
  assert.equal(existsSync(s.configDir("gmail")), false);
});

test("accounts with no subcommand, an unknown one, or a missing name exits 2 with usage", () => {
  const s = scene();
  assert.equal(s.ms([]).code, 2);
  const r = s.ms(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: ms accounts/);
  for (const v of ["add", "login", "verify", "remove", "token"]) {
    const m = s.ms([v]);
    assert.equal(m.code, 2, `${v} with no name`);
    assert.match(m.stderr, /usage: ms accounts/);
  }
});
