// `ms accounts` (Claude). Nothing here touches the network, the real
// keychain, `~/.claude`, or a real `claude` binary: `claude` and `security`
// are bash stubs on a temp PATH, `globalThis.fetch` is stubbed inside the
// `ms` child process (a NODE_OPTIONS preload — the verb runs as a real
// subprocess so every test can grep ALL of its stdout and stderr), and the
// store lives in a temp MS_HOME.
//
// The `security` stub models the one thing that makes this verb delicate: an
// account string can answer BEFORE a login (the operator's own default Claude
// Code credential) or only AFTER it (the one this login just minted). The
// `claude` stub touches MS_TEST_MARKER on `auth login`, and the `security`
// stub answers MS_TEST_KEYCHAIN_OK always and MS_TEST_KEYCHAIN_AFTER only
// once that marker exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { run, stubDir, tempHome } from "./helpers.ts";

/** `run` (spawnSync) only hands back the output at exit, which cannot answer
 *  "did the human see the prompt WHILE the mint was waiting?". This runs `ms`
 *  asynchronously and timestamps the moment `marker` first lands on stderr. */
function msStreaming(
  args: string[],
  env: Record<string, string>,
  marker: string,
): Promise<{ code: number; stdout: string; stderr: string; markerAt: number | null; exitAt: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("bin/ms"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let markerAt: number | null = null;
    // A stub that never exits must not hang the whole suite, and a spawn that
    // fails must fail the test rather than reject out of this promise.
    const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const done = (code: number) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr, markerAt, exitAt: Date.now() });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => {
      stderr += c;
      if (markerAt === null && stderr.includes(marker)) markerAt = Date.now();
    });
    child.on("error", (e) => {
      stderr += `\nspawn failed: ${e.message}\n`;
      done(-1);
    });
    child.on("close", (code) => done(code ?? -1));
  });
}

const TOKEN = "sk-ant-oat01-TESTtoken1234567890_-abcdefghijklmnop";
const BANNER = "Opening your browser to mint a token...";
const PROFILE = {
  account: { email: "someone@example.com" },
  organization: { uuid: "org-1", name: "Someone's Org", rate_limit_tier: "default_claude_max_20x" },
};
const CRED = JSON.stringify({
  claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 },
});

const CLAUDE_STUB = `
printf '%s\\n' "$*" >> "$MS_TEST_ARGV"
printf 'claude %s\\n' "$*" >> "$MS_TEST_TIMELINE"
logcfg() { printf '%s\\t%s\\n' "$1" "$CLAUDE_CONFIG_DIR" >> "$MS_TEST_CFGDIR"; }
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  logcfg login
  [ -n "$CLAUDE_CONFIG_DIR" ] || { echo "no CLAUDE_CONFIG_DIR" >&2; exit 9; }
  : > "$MS_TEST_MARKER"
  if [ "$MS_TEST_NO_CRED_FILE" != "1" ]; then printf '%s' "$MS_TEST_CRED" > "$CLAUDE_CONFIG_DIR/.credentials.json"; fi
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  logcfg status
  [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "auth status ran without the token env" >&2; exit 9; }
  printf '%s\\n' "$MS_TEST_AUTH_STATUS"
  exit 0
fi
if [ "$1" = "setup-token" ]; then
  logcfg setup-token
  if [ "$MS_TEST_TOKEN_SPLIT" = "prefix" ]; then
    # Two writes that straddle the token prefix exactly: the first chunk ends
    # with "sk-ant-oat01-" and carries no secret, the second carries the body.
    printf 'Your token is sk-ant-oat01-'
    sleep 0.2
    printf '%s - copy it.\\n' "\${MS_TEST_TOKEN#sk-ant-oat01-}"
    printf '%s\\n' "$MS_TEST_TOKEN"
    exit 0
  fi
  if [ "$MS_TEST_TOKEN_SPLIT" = "partial" ]; then
    # The first chunk ends PART WAY through the prefix, so there is nothing in
    # it for a redaction to match and nothing to recognise but "sk-ant-".
    printf 'Your token is sk-ant-'
    sleep 0.2
    printf 'oat01-%s - copy it.\\n' "\${MS_TEST_TOKEN#sk-ant-oat01-}"
    printf '%s\\n' "$MS_TEST_TOKEN"
    exit 0
  fi
  if [ "$MS_TEST_TOKEN_ONLINE" = "one" ]; then
    # Prose and the token on a single line, in a single write, and NO bare
    # token line anywhere: the only copy of the token is inside that line.
    printf 'Paste code: %s\\n' "$MS_TEST_TOKEN"
    exit 0
  fi
  if [ "$MS_TEST_TOKEN_ONLINE" = "two" ]; then
    # The same bytes, split MID-TOKEN: the first chunk carries the prose and
    # the token prefix plus three body characters, the second the rest.
    printf 'Paste code: %s' "$(printf %s "$MS_TEST_TOKEN" | cut -c1-16)"
    sleep 0.2
    printf '%s\\n' "$(printf %s "$MS_TEST_TOKEN" | cut -c17-)"
    exit 0
  fi
  if [ -n "$MS_TEST_PROMPT_HOLD" ]; then
    # A prompt with no newline, then a long wait: the human must see it while
    # the mint is still running, not when it finally exits.
    printf 'Paste code: '
    sleep "$MS_TEST_PROMPT_HOLD"
    printf '\\n%s\\n' "$MS_TEST_TOKEN"
    exit 0
  fi
  if [ "$MS_TEST_TOKEN_STREAM" = "stderr" ]; then
    printf '%s\\n' "$MS_TEST_BANNER" >&2
    [ "$MS_TEST_TOKEN_INLINE" = "1" ] && printf 'Your token is %s - copy it.\\n' "$MS_TEST_TOKEN" >&2
    printf '%s\\n' "$MS_TEST_TOKEN" >&2
  else
    printf '%s\\n' "$MS_TEST_BANNER"
    [ "$MS_TEST_TOKEN_INLINE" = "1" ] && printf 'Your token is %s - copy it.\\n' "$MS_TEST_TOKEN"
    printf '%s\\n' "$MS_TEST_TOKEN"
  fi
  exit 0
fi
if [ "$1" = "-p" ]; then
  logcfg probe
  [ "$CLAUDE_CODE_OAUTH_TOKEN" = "$MS_TEST_TOKEN" ] || { echo "probe ran without the token env" >&2; exit 9; }
  printf '%s\\n' "$MS_TEST_PROBE_OUT"
  exit 0
fi
exit 3
`;

const SECURITY_STUB = `
printf '%s\\n' "$*" >> "$MS_TEST_SECURITY_ARGV"
printf 'security %s\\n' "$*" >> "$MS_TEST_TIMELINE"
# An indeterminate probe: hangs past the caller's bound until a login has run.
if [ "$MS_TEST_KEYCHAIN_HANG_BEFORE" = "1" ] && [ ! -f "$MS_TEST_MARKER" ]; then sleep 5; fi
# ...and one that fails with a status that is NOT security's errSecItemNotFound.
if [ -n "$MS_TEST_KEYCHAIN_ERR_BEFORE" ] && [ ! -f "$MS_TEST_MARKER" ]; then exit "$MS_TEST_KEYCHAIN_ERR_BEFORE"; fi
# The account is whatever follows -a, compared EXACTLY: a substring match
# would let the bare username stand in for the dir-scoped form built from it.
prev=""; acct=""; wflag=0
for a in "$@"; do
  [ "$prev" = "-a" ] && acct="$a"
  [ "$a" = "-w" ] && wflag=1
  prev="$a"
done
ok="$MS_TEST_KEYCHAIN_OK"
if [ -f "$MS_TEST_MARKER" ]; then ok="$ok $MS_TEST_KEYCHAIN_AFTER"; fi
match=0
for cand in $ok; do
  [ "$acct" = "$cand" ] && match=1
done
[ "$match" = 1 ] || exit 44
[ "$wflag" = 1 ] && printf '%s' "$MS_TEST_CRED"
exit 0
`;

type Opts = {
  profile?: unknown;
  token?: string;
  noCredFile?: boolean;
  keychainOk?: string[];
  keychainAfter?: string[];
  authStatus?: string;
  probeOut?: string;
  tokenStream?: "stdout" | "stderr";
  tokenInline?: boolean;
  tokenSplit?: "prefix" | "partial";
  promptHold?: string;
  tokenOnline?: "one" | "two";
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
  const timeline = path.join(home, "timeline.log");
  const cfgdir = path.join(home, "cfgdir.log");
  for (const f of [argv, securityArgv, timeline, cfgdir]) writeFileSync(f, "");
  const env: Record<string, string> = {
    HOME: home,
    MS_HOME: msHome,
    PATH: `${bin}:${process.env.PATH}`,
    NODE_OPTIONS: `--import=${pathToFileURL(fetchStub).href}`,
    MS_TEST_ARGV: argv,
    MS_TEST_SECURITY_ARGV: securityArgv,
    MS_TEST_TIMELINE: timeline,
    MS_TEST_CFGDIR: cfgdir,
    MS_TEST_MARKER: path.join(home, "logged-in.marker"),
    MS_TEST_TOKEN: opts.token ?? TOKEN,
    MS_TEST_BANNER: BANNER,
    MS_TEST_TOKEN_STREAM: opts.tokenStream ?? "stdout",
    MS_TEST_TOKEN_INLINE: opts.tokenInline ? "1" : "0",
    MS_TEST_TOKEN_SPLIT: opts.tokenSplit ?? "",
    MS_TEST_PROMPT_HOLD: opts.promptHold ?? "",
    MS_TEST_TOKEN_ONLINE: opts.tokenOnline ?? "",
    MS_TEST_CRED: CRED,
    MS_TEST_NO_CRED_FILE: opts.noCredFile ? "1" : "0",
    MS_TEST_KEYCHAIN_OK: (opts.keychainOk ?? []).join(" "),
    MS_TEST_KEYCHAIN_AFTER: (opts.keychainAfter ?? []).join(" "),
    MS_TEST_AUTH_STATUS: opts.authStatus ?? '{"organization":{"uuid":"org-1"}}',
    MS_TEST_PROBE_OUT: opts.probeOut ?? "ok",
  };
  return {
    home,
    msHome,
    argvLog: () => readFileSync(argv, "utf8"),
    truncateArgv: () => writeFileSync(argv, ""),
    securityLog: () => readFileSync(securityArgv, "utf8"),
    truncateSecurity: () => writeFileSync(securityArgv, ""),
    timeline: () => readFileSync(timeline, "utf8"),
    /** [tag, CLAUDE_CONFIG_DIR] for each `claude` call. */
    cfgFor: (tag: string): string | undefined =>
      readFileSync(cfgdir, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"))
        .find(([t]) => t === tag)?.[1],
    configDir: (n: string) => path.join(msHome, "claude", n),
    scopedAccount(n: string) {
      const dir = this.configDir(n);
      return `${userInfo().username}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
    },
    tokenFile: (n: string) => path.join(msHome, "launch", `${n}.token`),
    registryFile: path.join(msHome, "accounts.json"),
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
    msStream: (args: string[], marker: string, extra: Record<string, string> = {}) =>
      msStreaming(["accounts", ...args], { ...env, ...extra }, marker),
  };
}

const BARE = userInfo().username;

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
  assert.match(log, /^-p Reply with the single word ok\. --model haiku$/m);
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

// --- setup-token streaming ---------------------------------------------

test("setup-token's chatter reaches the human on stderr, from either stream, and the token never does", () => {
  for (const tokenStream of ["stdout", "stderr"] as const) {
    const s = scene({ tokenStream });
    s.ms(["add", "gmail"]);
    const r = s.ms(["login", "gmail"]);
    assert.equal(r.code, 0, `${tokenStream}: ${r.stderr}`);
    assert.ok(r.stderr.includes(BANNER), `${tokenStream}: banner not forwarded`);
    assert.equal(r.stdout.includes(BANNER), false, `${tokenStream}: banner must not be on stdout`);
    assert.equal((r.stdout + r.stderr).includes(TOKEN), false, `${tokenStream}: token leaked`);
    // a token LINE is dropped outright, not echoed as a redaction
    assert.equal(r.stderr.includes("<redacted>"), false, `${tokenStream}: token line was forwarded`);
    assert.equal(readFileSync(s.tokenFile("gmail"), "utf8").trim(), TOKEN);
  }
});

test("a token sharing a line with other text is redacted before that line is forwarded", () => {
  for (const tokenStream of ["stdout", "stderr"] as const) {
    const s = scene({ tokenStream, tokenInline: true });
    s.ms(["add", "gmail"]);
    const r = s.ms(["login", "gmail"]);
    assert.equal(r.code, 0, `${tokenStream}: ${r.stderr}`);
    assert.equal((r.stdout + r.stderr).includes(TOKEN), false, `${tokenStream}: token leaked`);
    assert.match(r.stderr, /Your token is sk-ant-oat01-<redacted> - copy it\./);
    assert.equal(readFileSync(s.tokenFile("gmail"), "utf8").trim(), TOKEN);
  }
});

test("a token split across two writes at the prefix boundary never reaches stderr", () => {
  const s = scene({ tokenSplit: "prefix" });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  const all = r.stdout + r.stderr;
  assert.equal(all.includes(TOKEN), false, "the whole token reached the human");
  // the body alone is just as bad: the prefix is public, the rest is the secret
  assert.equal(all.includes(TOKEN.slice("sk-ant-oat01-".length)), false, "the token body reached the human");
  // the line IS forwarded, once its newline arrives, with the token scrubbed
  assert.match(r.stderr, /Your token is sk-ant-oat01-<redacted> - copy it\./);
  assert.equal(readFileSync(s.tokenFile("gmail"), "utf8").trim(), TOKEN);
});

test("a token split part way through the prefix never reaches stderr either", () => {
  const s = scene({ tokenSplit: "partial" });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  const all = r.stdout + r.stderr;
  assert.equal(all.includes(TOKEN), false, "the whole token reached the human");
  assert.equal(all.includes(TOKEN.slice("sk-ant-oat01-".length)), false, "the token body reached the human");
  // held until its newline, then forwarded once, redacted
  assert.match(r.stderr, /Your token is sk-ant-oat01-<redacted> - copy it\./);
  assert.equal(readFileSync(s.tokenFile("gmail"), "utf8").trim(), TOKEN);
});

test("a token sharing a line with prose is captured however the chunks fall", () => {
  // The only copy of the token is inside `Paste code: <token>`. Whether that
  // line arrives whole or split, the mint must end with the token on disk and
  // no token text anywhere the human can see — capture cannot be left to pipe
  // scheduling.
  for (const tokenOnline of ["one", "two"] as const) {
    const s = scene({ tokenOnline });
    s.ms(["add", "gmail"]);
    const r = s.ms(["login", "gmail"]);
    assert.equal(r.code, 0, `${tokenOnline}: ${r.stderr}`);
    assert.equal(readFileSync(s.tokenFile("gmail"), "utf8").trim(), TOKEN, `${tokenOnline}: token not captured`);
    const all = r.stdout + r.stderr;
    assert.equal(all.includes(TOKEN), false, `${tokenOnline}: token leaked`);
    assert.equal(all.includes(TOKEN.slice("sk-ant-oat01-".length)), false, `${tokenOnline}: token body leaked`);
    assert.match(r.stderr, /Paste code: /);
  }
});

test("an unterminated prompt reaches the human while the mint is still waiting", async () => {
  const s = scene({ promptHold: "1" });
  s.ms(["add", "gmail"]);
  const r = await s.msStream(["login", "gmail"], "Paste code: ");
  assert.equal(r.code, 0, r.stderr);
  assert.notEqual(r.markerAt, null, "the prompt never reached stderr at all");
  // the stub waits a second after writing it; seeing it only at exit is the bug
  assert.ok(
    r.exitAt - r.markerAt! > 500,
    `the prompt was held until exit (${r.exitAt - r.markerAt!}ms before exit)`,
  );
  assert.equal((r.stdout + r.stderr).includes(TOKEN), false);
});

// --- the launch-token probe --------------------------------------------

test("a launch token that cannot answer the headless check is an error, recorded unverified", () => {
  const s = scene({ probeOut: "I am sorry, I cannot do that." });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not answer the headless check/);
  assert.equal(s.row("gmail").orgId, "org-1");
  assert.equal(s.row("gmail").identityVerified, false);
  assert.ok(existsSync(s.tokenFile("gmail")), "the token is kept, so `ls` can say what is on disk");
});

test("the probe wants the word ok, not the letters", () => {
  const s = scene({ probeOut: "the connection is broken" });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not answer the headless check/);
});

test("the probe and the identity read run under an empty config dir, not an ambient login", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);
  const probeDir = s.cfgFor("probe");
  const statusDir = s.cfgFor("status");
  assert.ok(probeDir && statusDir, "both calls must carry a CLAUDE_CONFIG_DIR");
  assert.equal(probeDir, statusDir, "one scratch dir for one check");
  for (const d of [probeDir!, statusDir!]) {
    assert.notEqual(d, s.configDir("gmail"));
    assert.notEqual(d, path.join(s.home, ".claude"));
    assert.match(d, /ms-probe-/);
  }
  // the login itself, by contrast, uses the account's own dir
  assert.equal(s.cfgFor("login"), s.configDir("gmail"));
  assert.equal(s.cfgFor("setup-token"), s.configDir("gmail"));
  // and the scratch dir does not outlive the check
  assert.equal(existsSync(probeDir!), false);
});

// --- attributing the keychain credential -------------------------------

test("accounts login records a dir-scoped keychain account that answers only after the login", () => {
  const s = scene({ noCredFile: true });
  const dir = s.configDir("gmail");
  const scoped = s.scopedAccount("gmail");
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: scoped });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, "keychain-account"), "utf8").trim(), scoped);
  assert.equal(s.row("gmail").orgId, "org-1");
  // the unattributable form is snapshotted BEFORE the login, or "new" means nothing
  const tl = s.timeline();
  assert.ok(tl.indexOf(`-a ${BARE}\n`) >= 0 && tl.indexOf(`-a ${BARE}\n`) < tl.indexOf("claude auth login"));
  // the probe asks whether an item exists, never for its value
  assert.equal(s.securityLog().split("\n")[0].includes("-w"), false);
});

test("accounts login accepts the bare-username form only when this login created it", () => {
  const s = scene({ noCredFile: true });
  assert.equal(s.ms(["add", "gmail"]).code, 0);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: BARE });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(s.configDir("gmail"), "keychain-account"), "utf8").trim(), BARE);
});

test("a bare-username item that pre-dates the login is never bound to the account", () => {
  const s = scene({ noCredFile: true, keychainOk: [BARE] });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not locate the poll credential for gmail/);
  assert.match(r.stderr, /cannot be attributed to/);
  assert.match(r.stderr, new RegExp(`account ${BARE}`));
  assert.equal(existsSync(path.join(s.configDir("gmail"), "keychain-account")), false);
  assert.equal(existsSync(s.tokenFile("gmail")), false);
  assert.equal(s.row("gmail").orgId, null);
});

test("an indeterminate pre-login probe counts as present, so the bare form stays refused", () => {
  // The snapshot probe times out; the same account answers after the login.
  // Reading that as "newly created" would bind gmail to whatever was already
  // there, so an unreadable probe must fail SHUT, not open.
  const s = scene({ noCredFile: true, keychainAfter: [BARE] });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_HANG_BEFORE: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not locate the poll credential for gmail/);
  assert.match(r.stderr, /cannot be attributed to/);
  assert.equal(existsSync(path.join(s.configDir("gmail"), "keychain-account")), false);
  assert.equal(existsSync(s.tokenFile("gmail")), false);
});

test("a pre-login probe that fails with anything but 'not found' also counts as present", () => {
  // 44 is security's errSecItemNotFound, and it is the ONLY status that means
  // absent. Any other failure is "could not tell", which must not read as no.
  const s = scene({ noCredFile: true, keychainAfter: [BARE] });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_ERR_BEFORE: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not locate the poll credential for gmail/);
  assert.match(r.stderr, /cannot be attributed to/);
  assert.equal(existsSync(path.join(s.configDir("gmail"), "keychain-account")), false);
});

test("a keychain item that is genuinely absent before the login is attributable after it", () => {
  // The other side of the same rule: exit 44 really does mean absent, so a
  // form that appears afterwards is this login's and must be accepted.
  const s = scene({ noCredFile: true, keychainAfter: [BARE] });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_ERR_BEFORE: "44" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(s.configDir("gmail"), "keychain-account"), "utf8").trim(), BARE);
});

test("when both forms are equally new, the dir-scoped one wins", () => {
  // Neither answers before the login and BOTH answer after, so both are
  // "newly created" and the attribution rule alone cannot choose. The winner
  // is then decided by candidate ORDER, and it must be the form that names
  // this account's own config dir — the one that is attributable outright.
  const s = scene({ noCredFile: true });
  const scoped = s.scopedAccount("gmail");
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: `${BARE} ${scoped}` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(s.configDir("gmail"), "keychain-account"), "utf8").trim(), scoped);
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

test("accounts verify honours an existing keychain note this tool would never have guessed", () => {
  const s = scene({ noCredFile: true });
  const dir = s.configDir("gmail");
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: s.scopedAccount("gmail") }).code, 0);
  writeFileSync(path.join(dir, "keychain-account"), "hand-written-acct\n");
  const r = s.ms(["verify", "gmail"], { MS_TEST_KEYCHAIN_OK: "hand-written-acct" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, "keychain-account"), "utf8").trim(), "hand-written-acct");
});

test("accounts verify re-locates the poll credential when the keychain note is lost", () => {
  const s = scene({ noCredFile: true });
  const dir = s.configDir("gmail");
  const scoped = s.scopedAccount("gmail");
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: scoped }).code, 0);
  rmSync(path.join(dir, "keychain-account"));
  const r = s.ms(["verify", "gmail"], { MS_TEST_KEYCHAIN_OK: scoped });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, "keychain-account"), "utf8").trim(), scoped);
});

test("accounts verify will not adopt an unattributable keychain item", () => {
  const s = scene({ noCredFile: true, keychainOk: [BARE] });
  s.ms(["add", "gmail"]);
  // no login has ever run for this account, so there is no snapshot to make
  // "new" meaningful — the bare form must stay refused
  const r = s.ms(["verify", "gmail"]);
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(path.join(s.configDir("gmail"), "keychain-account")), false);
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

test("accounts ls fills the POLL column without reading any secret", () => {
  const s = scene({ noCredFile: true });
  const scoped = s.scopedAccount("gmail");
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: scoped }).code, 0);
  s.truncateSecurity();
  const r = s.ms(["ls"], { MS_TEST_KEYCHAIN_OK: scoped });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gmail\s+gmail\s+org-1\s+yes\s+yes\s+yes/);
  const probes = s.securityLog().split("\n").filter(Boolean);
  assert.ok(probes.length > 0, "ls did check the keychain");
  for (const line of probes) assert.equal(line.includes("-w"), false, `ls asked for a secret: ${line}`);
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

// --- exits and warnings ------------------------------------------------

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

test("usage-shaped problems exit 2, not 1", () => {
  const s = scene();
  assert.equal(s.ms(["login", "nobody"]).code, 2, "unknown account");
  assert.equal(s.ms(["token", "nobody"]).code, 2, "unknown account");
  assert.equal(s.ms(["remove", "nobody"]).code, 2, "unknown account");
  assert.equal(s.ms(["add", "Not A Name"]).code, 2, "unusable name");
  assert.equal(s.ms(["add", "gmail"]).code, 0);
  assert.equal(s.ms(["add", "gmail"]).code, 2, "already registered");
  assert.equal(s.ms(["add", "gmail2", "--nope"]).code, 2, "unknown option");
  assert.equal(s.ms(["add", "gmail2", "--label"]).code, 2, "--label with no value");
});

test("a row the registry skips is named once per command, not once per read", () => {
  const s = scene();
  writeFileSync(
    s.registryFile,
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "gmail", provider: "claude", label: "gmail", orgId: null, shared: false, identityVerified: false },
        { name: "weird", provider: "nope" },
      ],
    }),
  );
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  const warnings = r.stderr.split("\n").filter((l) => l.includes("accounts.json"));
  assert.equal(warnings.length, 1, `expected one warning, got: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /unknown provider/);
});
