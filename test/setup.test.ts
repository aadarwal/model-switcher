// `ms setup` — the wizard, end to end, hermetically.
//
// Nothing here touches the network, the real keychain, the operator's own
// `~/.claude` or `~/.codex`, a real `claude`/`codex`/`tmux`, or the real `ms`
// on PATH. Every one of those is a bash stub on a temp PATH (the same shapes
// the accounts tests use, plus two additions the wizard needs), `fetch` is
// stubbed inside the child process by a NODE_OPTIONS preload, and HOME and
// MS_HOME are temp directories.
//
// The wizard runs in a real child process — not in the test runner — for two
// reasons: its steps spawn `claude`/`codex`/`ms`, which must find the stubs on
// a PATH the test controls; and the token-absence assertion has to see ALL of
// stdout and stderr, including whatever a subprocess wrote. A tiny generated
// driver (`driver.mjs`) is what calls `runSetup` in there, with
// `scriptedPrompter` wrapped in a recorder so the test can assert on the
// questions that were ASKED as well as the answers given.
//
// The two stub additions: `claude` and `codex` fire the real `ms _hook <cli>`
// when — and only when — the hook is actually installed in the settings file
// or the home's config.toml they were pointed at. That is what makes the
// wizard's hook check a real check in here: install the hooks and the probe's
// `started` event appears; do not, and it does not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { stubDir, tempHome } from "./helpers.ts";
import { ran } from "../src/setup/steps.ts";

/** The fixture launch token. Asserted ABSENT from every byte the wizard and
 *  its children write; distinctive so the assertion cannot pass by accident. */
const TOKEN = "sk-ant-oat01-SETUPtokenAAAAAAAAAA_-bbbbbbbbbbcccc";
const ORG = "org-setup-1";
const CRED = JSON.stringify({
  claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 },
});
const PROFILE = {
  account: { email: "someone@example.com" },
  organization: { uuid: ORG, name: "Someone's Org", rate_limit_tier: "default_claude_max_20x" },
};

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (accountId: string, email: string) =>
  `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" },
  })}.not-a-real-signature`;
const AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { id_token: idToken("acct-1", "someone@example.com"), access_token: "codex-at-1", refresh_token: "codex-rt-1", account_id: "acct-1" },
  last_refresh: new Date().toISOString(),
});

const CLAUDE_STUB = `
printf '%s\\t%s\\t%s\\t%s\\n' "$*" "$CLAUDE_CONFIG_DIR" "$(pwd -P)" "$ANTHROPIC_API_KEY$CLAUDE_CODE_USE_BEDROCK" >> "$MS_TEST_CLAUDE_LOG"
fire() {
  [ "$MS_TEST_NO_HOOK" = "1" ] && return 0
  # Where Claude Code itself reads its settings: the config dir when one is
  # named, and ~/.claude otherwise. A probe that points the CLI at an empty
  # scratch dir therefore has no hooks to fire, and must fail this check.
  settings="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  grep -q '_hook claude' "$settings" 2>/dev/null || return 0
  printf '%s' '{"hook_event_name":"SessionStart","source":"startup","session_id":"probe-cli-1"}' \\
    | "$MS_BIN" _hook claude >/dev/null 2>&1
}
if [ "$1" = "--version" ]; then echo "2.1.273 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  [ -n "$CLAUDE_CONFIG_DIR" ] || { echo "no CLAUDE_CONFIG_DIR" >&2; exit 9; }
  printf '%s' "$MS_TEST_CRED" > "$CLAUDE_CONFIG_DIR/.credentials.json"
  chmod 600 "$CLAUDE_CONFIG_DIR/.credentials.json"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  # No token in the environment: the login pre-flight asking whether this
  # config dir already holds a usable poll grant. It never does in here.
  [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 1
  printf '{"loggedIn":true,"orgId":"%s","email":"someone@example.com"}\\n' "$MS_TEST_ORG"
  exit 0
fi
if [ "$1" = "setup-token" ]; then
  [ "$MS_TEST_MINT_FAIL" = "1" ] && { echo "the browser flow was refused" >&2; exit 7; }
  printf '%s\\n' "$MS_TEST_TOKEN"
  exit 0
fi
if [ "$1" = "-p" ]; then
  [ "$CLAUDE_CODE_OAUTH_TOKEN" = "$MS_TEST_TOKEN" ] || { echo "probe ran without the token env" >&2; exit 9; }
  # Only a probe carrying an ms identity fires hooks; the account book's own
  # launch-token probe sets none, exactly as the real CLI would see it.
  [ -n "$MS_SESSION" ] && fire
  echo ok
  exit 0
fi
exit 3
`;

const CODEX_STUB = `
printf '%s\\t%s\\t%s\\n' "$*" "$CODEX_HOME" "$OPENAI_API_KEY" >> "$MS_TEST_CODEX_LOG"
if [ "$1" = "--version" ]; then echo "codex-cli 0.153.4"; exit 0; fi
if [ "$1" = "login" ]; then
  [ -n "$CODEX_HOME" ] || { echo "no CODEX_HOME" >&2; exit 9; }
  printf '%s' "$MS_TEST_AUTH_JSON" > "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
  exit 0
fi
if [ "$1" = "exec" ]; then
  # What the trust table said the moment the turn started — Codex's trust
  # dialog is a modal, so a turn in an untrusted directory would never return.
  c=$(grep -c 'trust_level = "trusted"' "$CODEX_HOME/config.toml" 2>/dev/null)
  printf '%s\\t%s\\t%s\\n' "$(pwd -P)" "\${c:-0}" "$OPENAI_API_KEY" >> "$MS_TEST_TRUST_LOG"
  if [ "$MS_TEST_NO_HOOK" != "1" ] && grep -q '_hook codex' "$CODEX_HOME/config.toml" 2>/dev/null; then
    printf '%s' '{"hook_event_name":"SessionStart","source":"startup","session_id":"probe-cli-2"}' \\
      | "$MS_BIN" _hook codex >/dev/null 2>&1
  fi
  echo ok
  exit 0
fi
exit 3
`;

const TMUX_STUB = `
if [ "$1" = "-V" ]; then echo "tmux 3.5a"; exit 0; fi
exit 0
`;

/** One `fetch` for three endpoints: the Claude profile the account book reads
 *  to learn an organisation, the Claude usage the status table polls, and the
 *  ChatGPT usage a Codex credential is proved with. */
const FETCH_STUB = `
const PROFILE = ${JSON.stringify(JSON.stringify(PROFILE))};
const json = (body) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/oauth/profile")) return json(PROFILE);
  if (url.includes("/oauth/usage")) return json(JSON.stringify({ limits: [] }));
  if (url.includes("wham/usage")) return json(JSON.stringify({ rate_limit: { primary_window: null, secondary_window: null } }));
  return json("{}");
};
`;

/** The driver: `runSetup` in a child process, with every question recorded. */
const DRIVER = (repo: string) => `
import { scriptedPrompter } from ${JSON.stringify(pathToFileURL(path.join(repo, "src/setup/prompt.ts")).href)};
import { runSetup } from ${JSON.stringify(pathToFileURL(path.join(repo, "src/setup.ts")).href)};
import { writeFileSync } from "node:fs";
const asked = [];
const base = scriptedPrompter(JSON.parse(process.env.MS_TEST_ANSWERS));
const prompter = {
  ask: (q, o) => { asked.push(q); return base.ask(q, o); },
  confirm: (q, d) => { asked.push(q); return base.confirm(q, d); },
};
try {
  process.exitCode = await runSetup(prompter, JSON.parse(process.env.MS_TEST_OPTS));
} catch (e) {
  process.stderr.write("driver: " + (e && e.name) + ": " + (e && e.message) + "\\n");
  process.exitCode = 70;
} finally {
  writeFileSync(process.env.MS_TEST_ASKED, JSON.stringify(asked));
}
`;

type Opts = {
  /** Leave `codex` off PATH entirely (the Claude-only machine). */
  noCodex?: boolean;
  /** Leave `claude` off PATH entirely (the ChatGPT-only machine). */
  noClaude?: boolean;
  /** `claude setup-token` refuses, so every Claude login fails. */
  mintFail?: boolean;
  /** The CLIs never call the hook, so the wizard's probe finds no event. */
  noHook?: boolean;
  /** A different `ms` earlier on PATH than the one `MS_BIN` names. */
  shadowMs?: boolean;
  /** Put an API key (and an alternative backend) in the wizard's own
   *  environment, the way a human who also uses the API has in their shell.
   *  Every real turn the wizard takes must be scrubbed of them. */
  apiKeys?: boolean;
};

function scene(opts: Opts = {}) {
  const repo = process.cwd();
  const { home, msHome } = tempHome();
  const { dir: bin, stub } = stubDir();
  if (!opts.noClaude) stub("claude", CLAUDE_STUB);
  if (!opts.noCodex) stub("codex", CODEX_STUB);
  stub("tmux", TMUX_STUB);
  stub("security", "exit 44");
  // The `ms` the hooks are installed as, and the one `ms doctor` expects to
  // find on PATH. A shell trampoline into this very checkout.
  // `cd` into the checkout first: `--import tsx` is a BARE specifier, which
  // node resolves against the CWD — and a hook fired from a probe turn runs in
  // that turn's own temp directory, where nothing resolves. (Production has no
  // such trampoline: `bin/ms` registers tsx from its own module URL.)
  stub(
    "ms",
    `cd ${JSON.stringify(repo)} || exit 1\nexec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(path.join(repo, "bin/ms"))} "$@"`,
  );
  const msBin = path.join(bin, "ms");

  // A CLOSED PATH: the stub directory and the system directories a bash stub
  // needs, and nothing else. The host's own PATH is deliberately not on it —
  // with it, `noCodex` would only mean "no stub", and a real `codex` in
  // /opt/homebrew/bin would answer the prereqs check for us.
  let pathValue = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  if (opts.shadowMs) {
    const { dir: decoy, stub: decoyStub } = stubDir();
    decoyStub("ms", "exit 0");
    pathValue = `${decoy}:${pathValue}`;
  }

  const fetchStub = path.join(home, "fetch-stub.mjs");
  writeFileSync(fetchStub, FETCH_STUB);
  const driver = path.join(home, "driver.mjs");
  writeFileSync(driver, DRIVER(repo));
  const claudeLog = path.join(home, "claude.log");
  const codexLog = path.join(home, "codex.log");
  const trustLog = path.join(home, "trust.log");
  const asked = path.join(home, "asked.json");
  for (const f of [claudeLog, codexLog, trustLog]) writeFileSync(f, "");
  writeFileSync(asked, "[]");

  const env: Record<string, string> = {
    HOME: home,
    MS_HOME: msHome,
    PATH: pathValue,
    MS_BIN: msBin,
    SHELL: "/bin/zsh",
    NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${pathToFileURL(fetchStub).href}`,
    MS_TEST_CLAUDE_LOG: claudeLog,
    MS_TEST_CODEX_LOG: codexLog,
    MS_TEST_TRUST_LOG: trustLog,
    MS_TEST_ASKED: asked,
    MS_TEST_TOKEN: TOKEN,
    MS_TEST_ORG: ORG,
    MS_TEST_CRED: CRED,
    MS_TEST_AUTH_JSON: AUTH_JSON,
    MS_TEST_MINT_FAIL: opts.mintFail ? "1" : "0",
    MS_TEST_NO_HOOK: opts.noHook ? "1" : "0",
  };
  if (opts.apiKeys) {
    env.ANTHROPIC_API_KEY = "sk-ant-api03-SHOULD-NEVER-REACH-A-TURN";
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    env.OPENAI_API_KEY = "sk-proj-SHOULD-NEVER-REACH-A-TURN";
  }

  return {
    home,
    msHome,
    msBin,
    setupFile: path.join(msHome, "setup.json"),
    settingsFile: path.join(home, ".claude", "settings.json"),
    rcFile: path.join(home, ".zshrc"),
    codexConfig: (n: string) => path.join(msHome, "codex", n, "config.toml"),
    setupState: () => JSON.parse(readFileSync(path.join(msHome, "setup.json"), "utf8")),
    settings: () => JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")),
    accounts: (): Record<string, unknown>[] => {
      const f = path.join(msHome, "accounts.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).accounts : [];
    },
    row(n: string, provider = "claude"): Record<string, unknown> {
      const a = this.accounts().find((x) => x.name === n && x.provider === provider);
      assert.ok(a, `no ${provider} row for ${n}`);
      return a;
    },
    asked: (): string[] => JSON.parse(readFileSync(asked, "utf8")),
    /** Every `claude` invocation, as [argv, CLAUDE_CONFIG_DIR, cwd, the
     *  Anthropic API key + backend flag it saw (empty when scrubbed)]. */
    claudeCalls: (): string[][] => readFileSync(claudeLog, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")),
    /** Every `codex` invocation, as [argv, CODEX_HOME, the OpenAI API key it
     *  saw (empty when scrubbed)]. */
    codexCalls: (): string[][] => readFileSync(codexLog, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")),
    /** Every `codex exec`, as [cwd, how many trusted projects config.toml
     *  held at the moment the turn started]. */
    trustCalls: (): string[][] => readFileSync(trustLog, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")),
    sessionDirs: () => {
      const d = path.join(msHome, "sessions");
      return existsSync(d) ? readdirSync(d) : [];
    },
    run(answers: string[], setupOpts: Partial<{ resume: boolean; reset: boolean; yes: boolean; repair: boolean; remove: string[] }> = {}) {
      const r = spawnSync(process.execPath, ["--import", "tsx", driver], {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          ...env,
          MS_TEST_ANSWERS: JSON.stringify(answers),
          MS_TEST_OPTS: JSON.stringify({ resume: false, reset: false, yes: false, ...setupOpts }),
        },
      });
      return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", all: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

/** The happy path's whole conversation: one Claude account, one ChatGPT
 *  account, a browser redirect rather than a device code, and both opt-ins
 *  declined. */
const FULL = ["1", "1", "", "n", "", "n", "n"];
const ALL_STEPS = ["prereqs", "claude-accounts", "codex-accounts", "hooks", "statusline", "alias", "finish"];

test("a full run with one Claude and one Codex account finishes every step, verified, with no token in the transcript", () => {
  const s = scene();
  const r = s.run(FULL);
  assert.equal(r.code, 0, r.all);

  assert.deepEqual(s.setupState().done, ALL_STEPS);
  assert.deepEqual(s.setupState().claude, ["claude-1"]);
  assert.deepEqual(s.setupState().codex, ["codex-1"]);

  // Both rows exist and both are verified — the wizard ran login AND verify.
  assert.equal(s.row("claude-1").identityVerified, true);
  assert.equal(s.row("claude-1").orgId, ORG);
  assert.equal(s.row("codex-1", "codex").identityVerified, true);

  // Hooks are really in both files, pointing at the binary the wizard used.
  const events = s.settings().hooks;
  for (const e of ["SessionStart", "UserPromptSubmit", "SessionEnd", "StopFailure"]) {
    assert.ok(
      (events[e] as { hooks: { command: string }[] }[]).some((entry) => entry.hooks.some((h) => h.command === `'${s.msBin}' _hook claude`)),
      `no ${e} hook for ${s.msBin}`,
    );
  }
  assert.match(readFileSync(s.codexConfig("codex-1"), "utf8"), /_hook codex/);

  // Three headless `claude -p` turns, which is what login + verify + the hook
  // probe cost: drop the `verify` and this is two.
  const turns = s.claudeCalls().filter((c) => c[0].startsWith("-p "));
  assert.equal(turns.length, 3, JSON.stringify(s.claudeCalls()));

  // The hook probe is the ONE turn with no CLAUDE_CONFIG_DIR: it has to read
  // the settings file the hooks were just installed into, which is the human's
  // own — the account book's two launch-token probes are the scratch-dir ones.
  const hookTurns = turns.filter((c) => c[1] === "");
  assert.equal(hookTurns.length, 1, `expected exactly one probe with no CLAUDE_CONFIG_DIR: ${JSON.stringify(turns)}`);
  assert.match(hookTurns[0][2], /ms-setup-probe-/, "the hook probe did not run in a throwaway cwd");
  assert.equal(turns.filter((c) => c[1] !== "").length, 2, "the account book's own probes lost their scratch config dir");

  // The Codex turn was trusted for its own cwd BEFORE it started.
  const trust = s.trustCalls();
  assert.equal(trust.length, 1, JSON.stringify(trust));
  assert.ok(Number(trust[0][1]) >= 1, `codex exec started in an untrusted directory: ${JSON.stringify(trust)}`);
  assert.match(trust[0][0], /ms-setup-probe-/, "the Codex probe did not run in a throwaway cwd");
  // ...and the row it needed is gone AFTERWARDS (fix wave B-M8). A probe
  // that leaves `[projects."/tmp/ms-setup-probe-…"]` behind is one stale
  // trust row per attempt, for ever, naming a directory deleted seconds
  // later. The hook block and its trust hashes stay, which is the whole
  // point of the step.
  const configAfter = readFileSync(s.codexConfig("codex-1"), "utf8");
  assert.ok(!configAfter.includes(`[projects."${trust[0][0]}"]`), `the probe's trust row survived the probe:\n${configAfter}`);
  assert.ok(!/ms-setup-probe-/.test(configAfter), `something still names a probe directory:\n${configAfter}`);
  assert.ok(configAfter.includes("[[hooks.SessionStart]]"), configAfter);
  assert.ok(/trusted_hash = "sha256:/.test(configAfter), "the hook trust hashes must survive the cleanup");

  // The one line that guards the two-browser-flow login is really printed.
  assert.match(r.stdout, /Sign in as the SAME account in both browser tabs\./);

  // The probes ran, said so, and left nothing behind.
  assert.match(r.stdout, /hooks verified \(claude, codex\)/);
  assert.deepEqual(s.sessionDirs(), [], "the probe session directories are removed");

  // Not one byte of the launch token anywhere, on either stream.
  assert.ok(!r.all.includes(TOKEN), "the launch token appears in the transcript");
  assert.ok(!r.all.includes("sk-ant-oat01-"), "something token-shaped appears in the transcript");
});

test("a run interrupted after claude-accounts resumes at codex-accounts without re-asking the Claude count", () => {
  const s = scene();
  // Enough answers for prereqs and claude-accounts, and not one more: the
  // scripted prompter throws the moment codex-accounts asks its first
  // question, which is what a closed terminal looks like from in here.
  const first = s.run(["1", "1", ""]);
  assert.equal(first.code, 70, first.all);
  assert.deepEqual(s.setupState().done, ["prereqs", "claude-accounts"]);
  assert.deepEqual(s.setupState().claude, ["claude-1"]);

  const second = s.run(["1", "n", "", "n", "n"]);
  assert.equal(second.code, 0, second.all);
  assert.deepEqual(s.setupState().done, ALL_STEPS);
  assert.deepEqual(s.setupState().codex, ["codex-1"]);

  const asked = s.asked();
  assert.ok(!asked.some((q) => /How many Claude accounts/.test(q)), `the resume re-asked the Claude count: ${asked.join(" | ")}`);
  assert.ok(!asked.some((q) => /Name for claude account/.test(q)), "the resume re-asked for a Claude account name");
  assert.match(second.stdout, /Skipping the Claude accounts/);
  // Exactly one Claude row: the resume adopted nothing and duplicated nothing.
  assert.equal(s.accounts().filter((a) => a.provider === "claude").length, 1);
});

test("--reset forgets the progress and keeps every account", () => {
  const s = scene();
  assert.equal(s.run(FULL).code, 0);
  const before = s.accounts();
  assert.equal(before.length, 2);

  const again = s.run(FULL, { reset: true });
  assert.equal(again.code, 0, again.all);
  // It really started over: the questions of step one were asked again.
  assert.ok(s.asked().some((q) => /How many Claude accounts/.test(q)), "the reset run did not re-ask the Claude count");
  // ...and not one account was removed, re-added or unverified by it.
  assert.deepEqual(s.accounts(), before);
  assert.match(again.stdout, /claude-1 is already registered/);
});

test("a login that fails and is skipped leaves the row unverified and the run carries on", () => {
  const s = scene({ mintFail: true });
  const r = s.run(["0", "1", "", "skip", "n", "n"]);

  // The row exists, is not verified, and has no launch token.
  assert.equal(s.row("claude-1").identityVerified, false);
  assert.ok(!existsSync(path.join(s.msHome, "launch", "claude-1.token")));
  assert.deepEqual(s.setupState().claude, [], "a skipped account is not recorded as done");

  // The run continued past the failure: later steps ran and were marked done.
  assert.deepEqual(s.setupState().done, ["prereqs", "claude-accounts", "codex-accounts", "hooks", "statusline", "alias"]);
  assert.match(r.stdout, /stays registered but unverified/);
  // And it ended honestly: the doctor is not green over an unverified account.
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /identity verified/);
});

test("zero ChatGPT accounts skips the Codex steps and tolerates a missing codex binary", () => {
  const s = scene({ noCodex: true });
  const r = s.run(["0", "1", "", "n", "n"]);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(s.setupState().done, ALL_STEPS);
  assert.deepEqual(s.setupState().codex, []);
  assert.match(r.stdout, /No ChatGPT accounts/);
  assert.match(r.stdout, /hooks verified \(claude\)/);
  assert.equal(s.accounts().filter((a) => a.provider === "codex").length, 0);
});

test("the hooks step fails when the probe turn fires no hook", () => {
  const s = scene({ noHook: true });
  // ...and aborting at that question exits 1 with the hooks step NOT done.
  const r = s.run(["0", "1", "", "abort"]);
  assert.equal(r.code, 1, r.all);
  assert.deepEqual(s.setupState().done, ["prereqs", "claude-accounts", "codex-accounts"]);
  assert.match(r.stdout, /fired no SessionStart hook/);
  assert.deepEqual(s.sessionDirs(), [], "a failed probe still removes its session directory");
});

test("--yes accepts every default, so it asks nothing and installs no opt-ins", () => {
  const s = scene();
  const r = s.run([], { yes: true });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(s.asked(), [], "--yes asked a question");
  assert.deepEqual(s.setupState().done, ALL_STEPS);
  assert.deepEqual(s.setupState().optIns, { statusline: false, alias: false });
  assert.equal(s.settings().statusLine, undefined, "--yes wrapped the statusline");
  assert.ok(!existsSync(s.rcFile), "--yes wrote a shell rc file");
  // The defaults it accepted: one Claude account named claude-1, no ChatGPT.
  assert.deepEqual(s.setupState().claude, ["claude-1"]);
  assert.deepEqual(s.setupState().codex, []);
});

test("finish exits 1 when the doctor has a ✗, leaving finish undone so a resume retries it", () => {
  const s = scene({ noCodex: true, shadowMs: true });
  const r = s.run(["0", "1", "", "n", "n"]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /✗ ms on PATH is msBinary\(\)/);
  assert.deepEqual(s.setupState().done, ["prereqs", "claude-accounts", "codex-accounts", "hooks", "statusline", "alias"]);
  assert.match(r.stderr, /ms doctor is not green yet/);
});

test("the opt-ins install when they are accepted", () => {
  const s = scene({ noCodex: true });
  const r = s.run(["0", "1", "", "y", "y"]);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(s.setupState().optIns, { statusline: true, alias: true });
  assert.equal(s.settings().statusLine.command, `'${s.msBin}' _statusline`);
  assert.match(readFileSync(s.rcFile, "utf8"), new RegExp(`alias claude='${s.msBin} claude'`));
});

test("a prerequisite the machine does not have stops the run before anything is installed", () => {
  // One ChatGPT account declared, but this machine has no `codex` at all:
  // the count is what makes the missing binary a fault rather than a shrug.
  const s = scene({ noCodex: true });
  // Both counts are asked before any check runs now (fix wave B-M9): a
  // missing `claude` is only a fault when the Claude count is not zero
  // either, and the wizard cannot know that until the human says so.
  const r = s.run(["1", "1"]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /✗ codex --version/);
  assert.match(r.stderr, /run ms setup again/);
  assert.ok(!existsSync(s.setupFile), "prereqs marked itself done over a ✗");
  assert.ok(!existsSync(s.settingsFile), "a failed prereqs step touched Claude Code's settings");
});

test("a reserved Codex account name is re-asked, not fatal", () => {
  const s = scene();
  // `sessions` is the shared rollout store, not an account home: `add` would
  // refuse it outright, so the wizard must never let it get that far.
  const r = s.run(["1", "1", "", "n", "sessions", "codex-1", "n", "n"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /sessions is reserved/);
  assert.deepEqual(s.setupState().codex, ["codex-1"]);
  assert.equal(s.accounts().filter((a) => a.provider === "codex").length, 1);
  // The name question was asked twice: the first answer was turned down.
  assert.equal(s.asked().filter((q) => /Name for codex account 1/.test(q)).length, 2);
});

test("a registry that cannot be read fails the account with Retry/Skip/Abort rather than crashing the run", () => {
  const s = scene({ noCodex: true });
  // Registering is part of the attempt, so an unreadable accounts.json is a
  // failure the human is offered the same three answers about.
  writeFileSync(path.join(s.msHome, "accounts.json"), "{ this is not json");

  const r = s.run(["0", "1", "", "skip", "n", "n"]);
  assert.match(r.stdout, /setting up claude-1 failed:/);
  assert.deepEqual(s.setupState().claude, []);
  // The run carried on through every later step rather than dying here.
  assert.deepEqual(s.setupState().done, ["prereqs", "claude-accounts", "codex-accounts", "hooks", "statusline", "alias"]);
  // ...and ended honestly: the doctor will not call an unreadable registry green.
  assert.equal(r.code, 1, r.all);
});

test("a hook check the human skips says so, and does not claim nothing was ready", () => {
  const s = scene({ noCodex: true, noHook: true });
  const r = s.run(["0", "1", "", "skip", "n", "n"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /hook check skipped \(claude\)/);
  assert.ok(!/No account was ready/.test(r.stdout), "a skipped check reported itself as nothing being ready");
  assert.deepEqual(s.setupState().done, ALL_STEPS);
});

test("a run interrupted at the statusline resumes straight into the opt-ins, re-running no hook check", () => {
  const s = scene({ noCodex: true });
  const first = s.run(["0", "1", ""]);
  assert.equal(first.code, 70, first.all);
  assert.deepEqual(s.setupState().done, ["prereqs", "claude-accounts", "codex-accounts", "hooks"]);
  const turnsAfterFirst = s.claudeCalls().filter((c) => c[0].startsWith("-p ")).length;
  assert.equal(turnsAfterFirst, 3);

  const second = s.run(["y", "n"]);
  assert.equal(second.code, 0, second.all);
  assert.deepEqual(s.setupState().done, ALL_STEPS);
  assert.deepEqual(s.setupState().optIns, { statusline: true, alias: false });
  assert.match(second.stdout, /Skipping the hooks/);
  // The hooks step really did not run again: no fourth headless turn.
  assert.equal(s.claudeCalls().filter((c) => c[0].startsWith("-p ")).length, turnsAfterFirst);
  assert.ok(!/hooks verified/.test(second.stdout), "the resume re-ran the hook check");
  // The opt-ins were the only thing it asked about.
  assert.deepEqual(s.asked(), ["Show the account name in Claude Code's statusline?", "Add shell aliases so plain claude and codex go through ms?"]);
});

test("a Codex home the hook installer refuses is reported in the installer's own words", () => {
  const s = scene();
  // A begin marker with no end: `installCodexHooks` refuses rather than
  // swallowing everything under it, and that refusal is the human's remedy.
  const home = path.join(s.msHome, "codex", "codex-1");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "config.toml"), "# ms-hooks-begin\n[[hooks.SessionStart]]\n", { mode: 0o600 });

  const r = s.run(["1", "1", "", "n", "", "abort"]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /a '# ms-hooks-begin' marker with no '# ms-hooks-end'/);
  assert.deepEqual(s.setupState().done, ["prereqs", "claude-accounts", "codex-accounts"]);
});

test("a verb that answers with a non-zero exit code is a failure, not a success", async () => {
  // Every account verb the wizard calls returns 0 or throws today. This is
  // what keeps that true from the wizard's side, so a verb that ever starts
  // reporting failure by exit code cannot be read as a step that worked.
  await ran("ms accounts login work", 0);
  await ran("ms accounts verify work", Promise.resolve(0));
  await assert.rejects(() => ran("ms accounts login work", 3), /ms accounts login work exited 3/);
  await assert.rejects(() => ran("ms accounts verify work", Promise.resolve(2)), /ms accounts verify work exited 2/);
});

test("the verb rejects an option it does not have", () => {
  const s = scene();
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(process.cwd(), "bin/ms"), "setup", "--force"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: s.home, MS_HOME: s.msHome, MS_BIN: s.msBin, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr ?? "", /unknown option --force/);
});

// --- B-M7: no API key ever reaches a probe turn ---------------------------

test("the wizard's own ANTHROPIC_API_KEY / OPENAI_API_KEY never reach a probe turn", () => {
  const s = scene({ apiKeys: true });
  const r = s.run(FULL);
  assert.equal(r.code, 0, r.all);

  // The hook probe is the turn with no CLAUDE_CONFIG_DIR (it must read the
  // human's own settings file). It is a REAL model call under a REAL
  // subscription token: an API key left in the environment would bill that
  // key instead, and prove the hooks of an account nobody chose.
  const hookTurn = s.claudeCalls().filter((c) => c[0].startsWith("-p ") && c[1] === "");
  assert.equal(hookTurn.length, 1, JSON.stringify(s.claudeCalls()));
  assert.equal(hookTurn[0][3], "", `the Claude probe saw a key/backend: ${JSON.stringify(hookTurn[0])}`);

  const codexProbe = s.codexCalls().filter((c) => c[0].startsWith("exec "));
  assert.equal(codexProbe.length, 1, JSON.stringify(s.codexCalls()));
  assert.equal(codexProbe[0][2], "", `the Codex probe saw OPENAI_API_KEY: ${JSON.stringify(codexProbe[0])}`);

  // And nothing token-shaped leaked either way.
  assert.ok(!r.all.includes("SHOULD-NEVER-REACH-A-TURN"), "a key was printed");
});

// --- B-M9: a ChatGPT-only machine is not stopped for a `claude` it will never run

test("zero Claude accounts: a missing claude is not a fault, and settings.json is left alone", () => {
  const s = scene({ noClaude: true });
  // codex count 1, claude count 0, codex name default, no device code, no opt-ins.
  const r = s.run(["1", "0", "n", "", "n", "n"]);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(s.setupState().done, ALL_STEPS);
  assert.ok(!/✗ claude --version/.test(r.stdout), r.stdout);
  assert.match(r.stdout, /claude --version — not needed \(no claude accounts\)/);
  assert.ok(!existsSync(s.settingsFile), "the wizard wrote Claude hooks for a human with no Claude accounts");
  assert.match(r.stdout, /is left alone/);
  assert.match(r.stdout, /hooks verified \(codex\)/);
});

// --- B-I6: --repair -------------------------------------------------------

test("--repair re-installs the hooks for the registered accounts, without a single login", () => {
  const s = scene();
  assert.equal(s.run(FULL).code, 0);

  // What a CLI upgrade, a dotfiles restore or a hand edit does: the ms hook
  // entries go from settings.json, and the whole ms block from config.toml.
  const settings = s.settings();
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = (settings.hooks[ev] as { hooks: { command: string }[] }[]).filter(
      (e) => !e.hooks.some((h) => / _hook claude$/.test(h.command)),
    );
  }
  writeFileSync(s.settingsFile, JSON.stringify(settings, null, 2));
  const codexConfig = s.codexConfig("codex-1");
  writeFileSync(codexConfig, readFileSync(codexConfig, "utf8").replace(/# ms-hooks-begin[\s\S]*# ms-hooks-end\n?/, ""));
  assert.ok(!/_hook codex/.test(readFileSync(codexConfig, "utf8")));

  const loginsBefore = s.claudeCalls().filter((c) => /^(auth login|setup-token)/.test(c[0])).length;
  const codexLoginsBefore = s.codexCalls().filter((c) => c[0].startsWith("login")).length;
  assert.ok(loginsBefore > 0 && codexLoginsBefore > 0, "the first run should have logged in");

  // `--resume` cannot do this: every step is already in `done`. `--reset`
  // would re-run a full browser login for every account.
  const r = s.run([], { repair: true });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(s.asked(), [], "--repair asked the human nothing");

  const live = `'${s.msBin}' _hook claude`;
  const after = s.settings();
  for (const ev of ["SessionStart", "UserPromptSubmit", "StopFailure", "SessionEnd"]) {
    const cmds = (after.hooks[ev] as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks.map((h) => h.command));
    assert.deepEqual(cmds.filter((c) => / _hook claude$/.test(c)), [live], `${ev} was not repaired`);
  }
  assert.match(readFileSync(codexConfig, "utf8"), /_hook codex/);
  assert.match(readFileSync(codexConfig, "utf8"), /trusted_hash = "sha256:/);

  assert.equal(s.claudeCalls().filter((c) => /^(auth login|setup-token)/.test(c[0])).length, loginsBefore, "--repair logged in again");
  assert.equal(s.codexCalls().filter((c) => c[0].startsWith("login")).length, codexLoginsBefore, "--repair logged in to Codex again");

  // Repair is not progress through the wizard: the resume point is untouched.
  assert.deepEqual(s.setupState().done, ALL_STEPS);
});

test("--repair with nothing registered says so and does not pretend to have repaired anything", () => {
  const s = scene({ noCodex: true });
  const r = s.run([], { repair: true });
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /No accounts are registered yet/);
  assert.ok(!existsSync(s.settingsFile), "it wrote hooks for nobody");
});

// --- B-I5: --remove -------------------------------------------------------

function msSetup(s: ReturnType<typeof scene>, args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(process.cwd(), "bin/ms"), "setup", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: s.home,
      MS_HOME: s.msHome,
      MS_BIN: s.msBin,
      SHELL: "/bin/zsh",
      NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", all: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

test("--remove statusline and --remove alias undo both opt-ins, naming the backup", () => {
  const s = scene({ noCodex: true });
  assert.equal(s.run(["0", "1", "", "y", "y"]).code, 0);
  assert.deepEqual(s.setupState().optIns, { statusline: true, alias: true });
  const rcBefore = readFileSync(s.rcFile, "utf8");
  assert.match(rcBefore, /# ms-alias-begin/);

  const r = msSetup(s, ["--remove", "statusline", "--remove", "alias"]);
  assert.equal(r.code, 0, r.all);

  assert.equal(s.settings().statusLine, undefined, "the statusline block is gone");
  assert.ok(!/# ms-alias-begin/.test(readFileSync(s.rcFile, "utf8")), "the alias block is gone");
  assert.match(r.stdout, new RegExp(`no longer in Claude Code's statusline`));
  assert.match(r.stdout, /aliases are gone from/);
  // Each removal names the backup it left, which is the whole point of an
  // undo a human can trust.
  assert.equal(r.stdout.match(/kept as /g)?.length, 2, r.stdout);
  for (const m of r.stdout.matchAll(/kept as (\S+)\./g)) assert.ok(existsSync(m[1]), `${m[1]} does not exist`);

  // The wizard no longer believes an opt-in is installed.
  assert.deepEqual(s.setupState().optIns, { statusline: false, alias: false });
});

test("--remove refuses a hand-edited alias block, exits 1, and leaves the file alone", () => {
  const s = scene({ noCodex: true });
  assert.equal(s.run(["0", "1", "", "n", "y"]).code, 0);
  const handEdited = readFileSync(s.rcFile, "utf8").replace("# ms-alias-end", "alias foo='bar'\n# ms-alias-end");
  writeFileSync(s.rcFile, handEdited);

  const r = msSetup(s, ["--remove", "alias"]);
  assert.equal(r.code, 1, r.all);
  assert.match(r.stdout, /hand-edited/);
  assert.equal(readFileSync(s.rcFile, "utf8"), handEdited, "untouched");
});

test("--remove rejects a name it does not have", () => {
  const s = scene({ noCodex: true });
  assert.equal(msSetup(s, ["--remove", "hooks"]).code, 2);
  assert.match(msSetup(s, ["--remove"]).stderr, /statusline. or .alias/);
  assert.equal(msSetup(s, ["--remove", "alias", "--reset"]).code, 2);
});
