// `ms accounts` (Claude). Nothing here touches the network, the real
// keychain, `~/.claude`, or a real `claude` binary: `claude` and `security`
// are bash stubs on a temp PATH, `globalThis.fetch` is stubbed inside the
// `ms` child process (a NODE_OPTIONS preload — the verb runs as a real
// subprocess so every test can grep ALL of its stdout and stderr), and the
// store lives in a temp MS_HOME.
//
// The `security` stub answers by SERVICE, because that is what a poll grant is
// addressed by: `claude auth login` under CLAUDE_CONFIG_DIR=<dir> stores its
// credential under "Claude Code-credentials-<8 hex of sha256(<dir>)>", with the
// macOS username as the account (verified live, 2026-09-15). The operator's own
// login lives under the UNSCOPED service and is never queried — there is a test
// for that on the recorded argv. The `claude` stub touches MS_TEST_MARKER on
// `auth login`, and the `security` stub answers MS_TEST_KEYCHAIN_OK always and
// MS_TEST_KEYCHAIN_AFTER only once that marker exists (both newline-separated:
// a service name contains a space).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  # No token in the environment: this is the login pre-flight, asking whether
  # the poll grant already in THIS config dir is usable.
  if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    logcfg poll-status
    [ "$MS_TEST_POLL_STATUS_OK" = "1" ] || exit 1
    printf '%s\\n' "$MS_TEST_AUTH_STATUS"
    exit 0
  fi
  logcfg status
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
  exit "$MS_TEST_PROBE_EXIT"
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
# The service is whatever follows -s, compared EXACTLY: a substring match
# would let the unscoped service stand in for a scoped one built from it.
prev=""; svc=""; wflag=0
for a in "$@"; do
  [ "$prev" = "-s" ] && svc="$a"
  [ "$a" = "-w" ] && wflag=1
  prev="$a"
done
ok="$MS_TEST_KEYCHAIN_OK"
if [ -f "$MS_TEST_MARKER" ]; then ok="$ok
$MS_TEST_KEYCHAIN_AFTER"; fi
match=0
while IFS= read -r cand; do
  [ -n "$cand" ] || continue
  [ "$svc" = "$cand" ] && match=1
done <<EOF
$ok
EOF
[ "$match" = 1 ] || exit 44
if [ "$1" = "find-generic-password" ] && [ "$wflag" = 1 ]; then printf '%s' "$MS_TEST_CRED"; fi
exit 0
`;

type Opts = {
  profile?: unknown;
  token?: string;
  noCredFile?: boolean;
  keychainOk?: string[];
  keychainAfter?: string[];
  pollStatusOk?: boolean;
  authStatus?: string;
  probeOut?: string;
  probeExit?: number;
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
    MS_TEST_KEYCHAIN_OK: (opts.keychainOk ?? []).join("\n"),
    MS_TEST_KEYCHAIN_AFTER: (opts.keychainAfter ?? []).join("\n"),
    MS_TEST_POLL_STATUS_OK: opts.pollStatusOk ? "1" : "0",
    MS_TEST_AUTH_STATUS: opts.authStatus ?? '{"loggedIn":true,"orgId":"org-1","email":"work@example.com","orgName":"Work"}', // the real top-level shape; one test below keeps the nested fallback
    MS_TEST_PROBE_OUT: opts.probeOut ?? "ok",
    MS_TEST_PROBE_EXIT: String(opts.probeExit ?? 0),
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
    /** The keychain service a `claude auth login` into this account's config
     *  dir writes its credential under. */
    scopedService(n: string) {
      const dir = this.configDir(n);
      return `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
    },
    noteFile: (n: string) => path.join(msHome, "claude", n, "keychain-item.json"),
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
  assert.match(s.ms(["ls"]).stdout, /gmail\s+claude\s+gmail\s+-\s+no\s+no\s+no/);
});

test("accounts login: identityVerified follows the probe, not whether auth status names an org", () => {
  // Verified live (2026-09-15): a setup-token never gets an org from `claude
  // auth status --json` at all, so naming none is the ORDINARY case, not a
  // reason to warn or to sink identityVerified — only the probe (does the
  // token actually run the CLI?) decides it now.
  const ok = scene({ authStatus: "{}" });
  ok.ms(["add", "gmail"]);
  const okRun = ok.ms(["login", "gmail"]);
  assert.equal(okRun.code, 0, okRun.stderr);
  assert.equal(ok.row("gmail").orgId, "org-1");
  assert.equal(ok.row("gmail").identityVerified, true);
  assert.equal(ok.row("gmail").identityMethod, "both-usable");
  assert.equal(/warning/i.test(okRun.stderr), false, okRun.stderr);

  const failing = scene({ authStatus: "{}", probeOut: "I am sorry, I cannot do that." });
  failing.ms(["add", "gmail"]);
  const failRun = failing.ms(["login", "gmail"]);
  assert.equal(failRun.code, 1);
  assert.equal(failing.row("gmail").identityVerified, false);
  assert.equal(failing.row("gmail").identityMethod, undefined);
  assert.equal(/warning/i.test(failRun.stderr), false, failRun.stderr);
});

test("accounts login refuses when the launch token reports a different organisation than the poll grant", () => {
  const s = scene({ authStatus: '{"organization":{"uuid":"org-9"}}' });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the launch token belongs to a different organisation/);
  assert.equal(s.row("gmail").identityVerified, false);
  assert.equal(s.row("gmail").identityMethod, undefined);
  // the mint itself succeeded — a refused identity is not a failed mint
  assert.ok(existsSync(s.tokenFile("gmail")));
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

// --- the scoped keychain item ------------------------------------------

test("accounts login records the scoped keychain item its login wrote", () => {
  const s = scene({ noCredFile: true });
  const service = s.scopedService("gmail");
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: service });
  assert.equal(r.code, 0, r.stderr);
  // The service names this account's own config dir, so an item answering
  // under it can only be this account's: nothing has to be attributed.
  assert.deepEqual(JSON.parse(readFileSync(s.noteFile("gmail"), "utf8")), { service, account: BARE });
  assert.equal(statSync(s.noteFile("gmail")).mode & 0o777, 0o600);
  assert.equal(s.row("gmail").orgId, "org-1");
  // the probe asks whether an item exists, never for its value
  assert.equal(s.securityLog().split("\n")[0].includes("-w"), false);
});

test("accounts login fails loudly, naming the service it expected, when nothing answers", () => {
  const s = scene({ noCredFile: true });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not locate the poll credential for gmail/);
  assert.ok(r.stderr.includes(s.scopedService("gmail")), r.stderr);
  assert.equal(existsSync(s.noteFile("gmail")), false);
  assert.equal(existsSync(s.tokenFile("gmail")), false);
  assert.equal(s.row("gmail").orgId, null);
});

test("a usable poll grant already in the dir spares the human a second browser login", () => {
  // The human logged this account in this morning; the credential is in the
  // keychain under the scoped service and `claude auth status` is happy with
  // it. `login` is still how the LAUNCH token gets minted, so the rest of the
  // verb runs — but the browser flow is not repeated.
  const s = scene({ noCredFile: true, pollStatusOk: true });
  const service = s.scopedService("gmail");
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_OK: service });
  assert.equal(r.code, 0, r.stderr);
  const log = s.argvLog();
  assert.equal(/^auth login$/m.test(log), false, log);
  assert.match(log, /^setup-token$/m);
  assert.match(r.stdout, /skipping claude auth login/);
  assert.equal(s.row("gmail").orgId, "org-1");
  assert.equal(readFileSync(s.tokenFile("gmail"), "utf8").trim(), TOKEN);
  // the pre-flight reads the ACCOUNT's own dir, and carries no launch token
  assert.equal(s.cfgFor("poll-status"), s.configDir("gmail"));
});

test("an unusable credential in the dir still opens the browser", () => {
  // Same item, but `claude auth status` says it is no good: that is a login
  // the human does have to redo, and skipping it would strand the account.
  const s = scene({ noCredFile: true, pollStatusOk: false });
  const service = s.scopedService("gmail");
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_OK: service });
  assert.equal(r.code, 0, r.stderr);
  assert.match(s.argvLog(), /^auth login$/m);
});

test("no command ever queries the operator's own unscoped keychain item", () => {
  // The unscoped service is the human's ordinary `~/.claude` login. Reading,
  // binding, writing or deleting it is this tool's one unforgivable move, and
  // the proof is on the argv every `security` call was made with.
  const s = scene({ noCredFile: true, pollStatusOk: true });
  const service = s.scopedService("gmail");
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: service }).code, 0);
  assert.equal(s.ms(["verify", "gmail"], { MS_TEST_KEYCHAIN_OK: service }).code, 0);
  assert.equal(s.ms(["ls"], { MS_TEST_KEYCHAIN_OK: service }).code, 0);
  assert.equal(s.ms(["remove", "gmail"], { MS_TEST_KEYCHAIN_OK: service }).code, 0);
  const log = s.securityLog();
  assert.ok(log.trim().length > 0, "no security call was made at all");
  assert.equal(/-s Claude Code-credentials(\s|$)/m.test(log), false, log);
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

test("accounts verify honours a recorded item this derivation would not have produced", () => {
  // A scoped item, just not the one this config dir derives — Claude Code is
  // free to move where it keeps a credential, and `verify` must not overwrite
  // a note that still answers.
  const s = scene({ noCredFile: true });
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: s.scopedService("gmail") }).code, 0);
  const recorded = "Claude Code-credentials-deadbeef";
  writeFileSync(s.noteFile("gmail"), JSON.stringify({ service: recorded, account: BARE }));
  const r = s.ms(["verify", "gmail"], { MS_TEST_KEYCHAIN_OK: recorded });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(s.noteFile("gmail"), "utf8")).service, recorded);
});

test("accounts verify re-locates the poll credential when the note is lost", () => {
  const s = scene({ noCredFile: true });
  const service = s.scopedService("gmail");
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: service }).code, 0);
  rmSync(s.noteFile("gmail"));
  const r = s.ms(["verify", "gmail"], { MS_TEST_KEYCHAIN_OK: service });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(s.noteFile("gmail"), "utf8")).service, service);
});

test("accounts verify fails, naming the service, when no item answers for the account", () => {
  const s = scene({ noCredFile: true });
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: s.scopedService("gmail") }).code, 0);
  // the item is gone (a `security delete`, a re-minted credential elsewhere)
  const r = s.ms(["verify", "gmail"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /could not locate the poll credential for gmail/);
  assert.ok(r.stderr.includes(s.scopedService("gmail")), r.stderr);
});

test("accounts verify refreshes the poll grant under the account's own credential lock", async () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);

  // A spent access token, so `verify` has to refresh before it can read the
  // profile — and the token endpoint ROTATES the refresh token, so doing that
  // beside a poll (`ms status`, a launch warming grants) spends the same grant
  // twice and the loser reads invalid_grant. src/snapshot.ts names
  // `account-claude-<name>` as the lock that keeps them apart.
  const credFile = path.join(s.configDir("gmail"), ".credentials.json");
  writeFileSync(
    credFile,
    JSON.stringify({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() - 1_000 } }),
    { mode: 0o600 },
  );
  const refreshStub = path.join(s.home, "refresh-stub.mjs");
  writeFileSync(
    refreshStub,
    `const profile = ${JSON.stringify(JSON.stringify(PROFILE))};\n` +
      `globalThis.fetch = async (url) => String(url).includes("/oauth/token")\n` +
      `  ? new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } })\n` +
      `  : new Response(profile, { status: 200, headers: { "content-type": "application/json" } });\n`,
  );
  const withRefresh = { NODE_OPTIONS: `--import=${pathToFileURL(refreshStub).href}`, MS_LOCK_WAIT_MS: "300" };

  // Held by "another process" — here, this one.
  const { acquire } = await import("../src/lock.ts");
  const savedHome = process.env.MS_HOME;
  process.env.MS_HOME = s.msHome;
  const release = acquire("account-claude-gmail");
  assert.ok(release, "the test could not take the lock it means to hold");
  try {
    const blocked = s.ms(["verify", "gmail"], withRefresh);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /account-claude-gmail/, "it refreshed without the lock, or failed for another reason");
    assert.match(JSON.parse(readFileSync(credFile, "utf8")).claudeAiOauth.refreshToken, /^rt-1$/, "nothing was spent");
  } finally {
    release!();
    if (savedHome === undefined) delete process.env.MS_HOME;
    else process.env.MS_HOME = savedHome;
  }

  // With the lock free it takes it, refreshes, and writes the rotated token.
  const ok = s.ms(["verify", "gmail"], withRefresh);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(credFile, "utf8")).claudeAiOauth.refreshToken, "rt-2");
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

test("accounts ls prints the seven columns, provider among them", () => {
  const s = scene();
  s.ms(["add", "gmail", "--label", "Personal"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);
  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /NAME\s+PROVIDER\s+LABEL\s+ORG\s+POLL\s+TOKEN\s+VERIFIED/);
  assert.match(r.stdout, /gmail\s+claude\s+Personal\s+org-1\s+yes\s+yes\s+yes/);
});

test("accounts ls shows a registered-but-uncredentialed account as no/no/no", () => {
  const s = scene();
  s.ms(["add", "gmail"]);
  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gmail\s+claude\s+gmail\s+-\s+no\s+no\s+no/);
});

/** root reads a 0000 file, so denying ourselves a read proves nothing there. */
const CAN_DENY_READ = process.getuid?.() !== 0;

test("accounts ls calls a token it cannot read `unreadable`, not `yes`", { skip: !CAN_DENY_READ }, (t) => {
  // The book and the doctor must not disagree about the same file. `existsSync`
  // said `yes` for a `chmod 000` token while every other reader of it — the
  // doctor, the status line, the recovery worker, all through
  // `readLaunchToken` — treated it as absent.
  const s = scene();
  s.ms(["add", "gmail", "--label", "Personal"]);
  assert.equal(s.ms(["login", "gmail"]).code, 0);
  chmodSync(s.tokenFile("gmail"), 0o000);
  t.after(() => chmodSync(s.tokenFile("gmail"), 0o600));

  const r = s.ms(["ls"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gmail\s+claude\s+Personal\s+org-1\s+yes\s+unreadable\s+yes/);
  assert.equal(r.stdout.includes(TOKEN), false, "the account book never prints a credential");
});

test("accounts ls fills the POLL column without reading any secret", () => {
  const s = scene({ noCredFile: true });
  const scoped = s.scopedService("gmail");
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: scoped }).code, 0);
  s.truncateSecurity();
  const r = s.ms(["ls"], { MS_TEST_KEYCHAIN_OK: scoped });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gmail\s+claude\s+gmail\s+org-1\s+yes\s+yes\s+yes/);
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

test("accounts remove deletes the account's own scoped keychain item", () => {
  const s = scene({ noCredFile: true });
  const service = s.scopedService("gmail");
  s.ms(["add", "gmail"]);
  assert.equal(s.ms(["login", "gmail"], { MS_TEST_KEYCHAIN_AFTER: service }).code, 0);
  s.truncateSecurity();
  assert.equal(s.ms(["remove", "gmail"], { MS_TEST_KEYCHAIN_OK: service }).code, 0);
  const log = s.securityLog();
  assert.match(log, new RegExp(`^delete-generic-password -s ${service} -a ${BARE}$`, "m"), log);
  assert.equal(/-s Claude Code-credentials(\s|$)/m.test(log), false, log);
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

test("a launch token that answers the probe with a usage wall is proven, not broken (seen live)", () => {
  // dirk on 2026-09-15: `claude -p` exited 1 printing
  // "You've hit your session limit · resets 10:10pm" — an authenticated answer.
  const s = scene({ probeOut: "You've hit your session limit · resets 10:10pm (America/New_York)", probeExit: 1 });
  s.ms(["add", "gmail"]);
  const r = s.ms(["login", "gmail"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.row("gmail").identityVerified, true);
  assert.doesNotMatch(r.stderr, /headless check/);
});
