import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";
import type { Account } from "../src/registry.ts";

// Every test gets its own MS_HOME (via tempHome) and, when it cares about
// external binaries, its own stub directory prepended to PATH so its stubs
// are always found first — the convention test/claude-usage.test.ts and
// test/tmux.test.ts already use. Nothing here touches the real tmux, claude,
// keychain, or network: refresh-due account tests stub `globalThis.fetch`
// directly, the way test/claude-usage.test.ts does.

function base(): { home: string; msHome: string } {
  const { home, msHome } = tempHome();
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  return { home, msHome };
}

const HEALTHY_TMUX = `case "$*" in
  -V) echo "tmux 3.4" ;;
  *"list-panes -a"*) echo "%1" ;;
  *) exit 0 ;;
esac
exit 0`;
const HEALTHY_CLAUDE = `case "$1" in --version) echo "1.2.3 (Claude Code)" ;; esac
exit 0`;

function stubHealthyBinaries(): { dir: string } {
  const { dir, stub } = stubDir();
  stub("tmux", HEALTHY_TMUX);
  stub("claude", HEALTHY_CLAUDE);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return { dir };
}

/** Writes a Claude poll credential + launch token for `name`, expiring far in
 *  the future so `checkClaudeAccount` never has to refresh (no network). */
function writeHealthyAccountFiles(msHome: string, name: string): void {
  const dir = path.join(msHome, "claude", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() + 86_400_000 } }),
    { mode: 0o600 },
  );
}

const account = (over: Partial<Account> = {}): Account => ({
  name: "gmail", provider: "claude", label: "Gmail", orgId: null, shared: false, identityVerified: true, ...over,
});

// --- renderLine -----------------------------------------------------------

test("renderLine: ✓/✗ formatting, plus → fixed", async () => {
  const { renderLine } = await import("../src/doctor.ts");
  assert.equal(renderLine({ ok: true, what: "a thing" }), "✓ a thing");
  assert.equal(renderLine({ ok: true, what: "a thing", fixed: true }), "✓ a thing → fixed");
  assert.equal(renderLine({ ok: false, what: "a thing", why: "it broke" }), "✗ a thing — it broke");
});

// --- Node ------------------------------------------------------------------

test("checkNode passes on the Node this suite runs under", async () => {
  const { checkNode } = await import("../src/doctor.ts");
  const r = checkNode();
  assert.equal(r.ok, true);
  assert.equal(typeof process.execve, "function");
});

// --- tmux --------------------------------------------------------------

test("checkTmux: ok at 3.3+, fails below 3.3, fails when tmux is missing", async () => {
  base();
  const { checkTmux } = await import("../src/doctor.ts");

  let d = stubDir();
  d.stub("tmux", 'echo "tmux 3.3a"');
  process.env.PATH = `${d.dir}:${process.env.PATH}`;
  assert.equal(checkTmux().ok, true);

  d = stubDir();
  d.stub("tmux", 'echo "tmux 3.2a"');
  process.env.PATH = `${d.dir}:${process.env.PATH}`;
  const low = checkTmux();
  assert.equal(low.ok, false);
  assert.match(low.why ?? "", /3\.2/);

  process.env.PATH = "/nonexistent-empty-dir";
  assert.equal(checkTmux().ok, false);
});

// --- claude ------------------------------------------------------------

test("checkClaudeBinary: ok when present, fails when missing", async () => {
  base();
  const { checkClaudeBinary } = await import("../src/doctor.ts");
  const { dir, stub } = stubDir();
  stub("claude", 'echo "1.0.0 (Claude Code)"');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  assert.equal(checkClaudeBinary().ok, true);

  process.env.PATH = "/nonexistent-empty-dir";
  assert.equal(checkClaudeBinary().ok, false);
});

// --- hooks -------------------------------------------------------------

test("checkHooks: not installed → ✗; --fix installs and reports fixed", async () => {
  const { home } = base();
  const { checkHooks } = await import("../src/doctor.ts");
  const settingsPath = path.join(home, ".claude", "settings.json");

  const before = checkHooks(false);
  assert.equal(before.ok, false);
  assert.match(before.why ?? "", new RegExp(settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const fixed = checkHooks(true);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.fixed, true);

  const { claudeHooksInstalled } = await import("../src/hooks/install.ts");
  const { msBinary } = await import("../src/paths.ts");
  assert.equal(claudeHooksInstalled(settingsPath, msBinary()), true);

  // Already installed: a plain check (no --fix) now reads ok, not "fixed".
  const again = checkHooks(false);
  assert.equal(again.ok, true);
  assert.equal(again.fixed, undefined);
});

// --- store permissions ---------------------------------------------------

test("checkStorePermissions: a 0644 store file is ✗; --fix chmods it to ✓", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const bad = path.join(msHome, "extra.json");
  writeFileSync(bad, "{}", { mode: 0o644 });

  const before = checkStorePermissions(false);
  assert.equal(before.length, 1);
  assert.equal(before[0]!.ok, false);
  assert.match(before[0]!.why ?? "", /0644.*0600/);

  const after = checkStorePermissions(true);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.ok, true);
  assert.equal(after[0]!.fixed, true);
  assert.equal(statSync(bad).mode & 0o777, 0o600);
});

test("checkStorePermissions: a wrongly-permissioned directory is ✗; --fix chmods it", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const badDir = path.join(msHome, "claude");
  mkdirSync(badDir, { recursive: true });
  chmodSync(badDir, 0o755);

  const before = checkStorePermissions(false);
  assert.ok(before.some((r) => !r.ok && /claude/.test(r.what)));

  checkStorePermissions(true);
  assert.equal(statSync(badDir).mode & 0o777, 0o700);
});

test("checkStorePermissions: a clean store is one ✓ line", async () => {
  base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const r = checkStorePermissions(false);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.ok, true);
});

// --- accounts ------------------------------------------------------------

test("checkClaudeAccount: a fully healthy account reports four ✓ lines", async () => {
  const { msHome } = base();
  writeHealthyAccountFiles(msHome, "gmail");
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");
  const { checkClaudeAccount } = await import("../src/doctor.ts");

  const rs = await checkClaudeAccount(account({ name: "gmail", identityVerified: true }));
  assert.equal(rs.length, 4);
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs));
  assert.ok(rs.some((r) => /poll grant readable/.test(r.what)));
  assert.ok(rs.some((r) => /poll grant refresh not due/.test(r.what)));
  assert.ok(rs.some((r) => /launch token present/.test(r.what)));
  assert.ok(rs.some((r) => /identity verified/.test(r.what)));
});

test("checkClaudeAccount: a grant-less account fails readable, launch token, and identity", async () => {
  base();
  const { checkClaudeAccount } = await import("../src/doctor.ts");
  const rs = await checkClaudeAccount(account({ name: "orphan-acct", identityVerified: false }));
  // No refreshable line at all when the grant cannot even be read.
  assert.equal(rs.length, 3);
  const byWhat = (re: RegExp) => rs.find((r) => re.test(r.what));
  assert.equal(byWhat(/poll grant readable/)!.ok, false);
  assert.equal(byWhat(/launch token present/)!.ok, false);
  assert.equal(byWhat(/identity verified/)!.ok, false);
});

test("checkClaudeAccount: a grant due for refresh calls refreshPollCredentials, bounded", async () => {
  const { msHome } = base();
  const dir = path.join(msHome, "claude", "gmail");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() - 1000 } }),
    { mode: 0o600 },
  );
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
  try {
    const { checkClaudeAccount } = await import("../src/doctor.ts");
    const rs = await checkClaudeAccount(account({ name: "gmail" }));
    const refreshable = rs.find((r) => /poll grant refreshable/.test(r.what));
    assert.ok(refreshable, JSON.stringify(rs));
    assert.equal(refreshable!.ok, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkClaudeAccount: a dead grant due for refresh reports ✗ with the auth reason", async () => {
  const { msHome } = base();
  const dir = path.join(msHome, "claude", "gmail");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() - 1000 } }),
    { mode: 0o600 },
  );
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  try {
    const { checkClaudeAccount } = await import("../src/doctor.ts");
    const rs = await checkClaudeAccount(account({ name: "gmail" }));
    const refreshable = rs.find((r) => /poll grant refreshable/.test(r.what));
    assert.equal(refreshable!.ok, false);
    assert.match(refreshable!.why ?? "", /auth/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// --- orphaned session state ------------------------------------------------

async function makeSession(msHome: string, patch: Record<string, unknown> = {}) {
  process.env.MS_HOME = msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  st.createSession({
    id: "s1", provider: "claude", cliSessionId: "c1", cwd: "/tmp", socket: "/private/tmp/tmux-test/default",
    pane: "%5", serverStart: "1", need: "any", account: "gmail", generation: 1,
    state: "running", desired: "running", flags: [],
    ...patch,
  } as Parameters<typeof st.createSession>[0]);
  st.close();
}

test("checkOrphaned: no sessions is one ✓ line", async () => {
  base();
  const { checkOrphaned } = await import("../src/doctor.ts");
  const rs = await checkOrphaned(false);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.ok, true);
});

test("checkOrphaned: a session whose pane is gone on its socket is ✗", async () => {
  const { msHome } = base();
  const { dir, stub } = stubDir();
  stub("tmux", 'case "$*" in *"list-panes -a"*) echo "%9" ;; esac\nexit 0');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  await makeSession(msHome, { pane: "%5" }); // %5 is not in the stub's pane list
  const { checkOrphaned } = await import("../src/doctor.ts");
  const rs = await checkOrphaned(false);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.ok, false);
  assert.match(rs[0]!.what, /s1/);
});

test("checkOrphaned: a session whose pane exists is not flagged", async () => {
  const { msHome } = base();
  const { dir, stub } = stubDir();
  stub("tmux", 'case "$*" in *"list-panes -a"*) echo "%5" ;; esac\nexit 0');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  await makeSession(msHome, { pane: "%5" });
  const { checkOrphaned } = await import("../src/doctor.ts");
  const rs = await checkOrphaned(false);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.ok, true);
});

test("checkOrphaned: a session already 'stopped' is not flagged even with no pane", async () => {
  const { msHome } = base();
  const { dir, stub } = stubDir();
  stub("tmux", 'case "$*" in *"list-panes -a"*) echo "" ;; esac\nexit 0');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  await makeSession(msHome, { pane: "%5", state: "stopped", desired: "stopped" });
  const { checkOrphaned } = await import("../src/doctor.ts");
  const rs = await checkOrphaned(false);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.ok, true);
});

test("checkOrphaned: --fix without reconcile.ts available still reports ✗ (graceful degrade)", async () => {
  const { msHome } = base();
  const { dir, stub } = stubDir();
  stub("tmux", 'case "$*" in *"list-panes -a"*) echo "%9" ;; esac\nexit 0');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  await makeSession(msHome, { pane: "%5" });
  const { checkOrphaned } = await import("../src/doctor.ts");
  const rs = await checkOrphaned(true);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.ok, false);
});

// --- ms on PATH ----------------------------------------------------------

test("checkPathBinary: ✗ when ms is not on PATH", async () => {
  base();
  process.env.MS_BIN = "/some/where/ms";
  process.env.PATH = "/nonexistent-empty-dir";
  const { checkPathBinary } = await import("../src/doctor.ts");
  const r = checkPathBinary();
  assert.equal(r.ok, false);
  assert.match(r.why ?? "", /not found on PATH/);
  delete process.env.MS_BIN;
});

test("checkPathBinary: ✗ with both paths when PATH resolves elsewhere", async () => {
  const { home } = base();
  const wanted = path.join(home, "real-ms");
  writeFileSync(wanted, "#!/bin/sh\n");
  process.env.MS_BIN = wanted;

  const { dir, stub } = stubDir();
  stub("ms", "#!/bin/sh\n");
  process.env.PATH = `${dir}:${process.env.PATH}`;

  const { checkPathBinary } = await import("../src/doctor.ts");
  const r = checkPathBinary();
  assert.equal(r.ok, false);
  assert.match(r.why ?? "", /PATH gives/);
  assert.match(r.why ?? "", new RegExp(path.join(dir, "ms").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(r.why ?? "", new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  delete process.env.MS_BIN;
});

test("checkPathBinary: ✓ when PATH resolves to the same file as msBinary()", async () => {
  const { home } = base();
  const wanted = path.join(home, "real-ms");
  writeFileSync(wanted, "#!/bin/sh\n");
  chmodSync(wanted, 0o755);
  process.env.MS_BIN = wanted;

  const { dir } = stubDir();
  const { symlinkSync } = await import("node:fs");
  symlinkSync(wanted, path.join(dir, "ms"));
  process.env.PATH = `${dir}:${process.env.PATH}`;

  const { checkPathBinary } = await import("../src/doctor.ts");
  assert.equal(checkPathBinary().ok, true);
  delete process.env.MS_BIN;
});

// --- runDoctor: the two brief-mandated scenarios --------------------------

test("runDoctor: hooks missing + a grant-less account among a healthy one → report lines and exit 1", async (t: TestContext) => {
  const { home, msHome } = base();
  stubHealthyBinaries();
  process.env.MS_BIN = path.join(home, "real-ms");
  writeFileSync(process.env.MS_BIN, "#!/bin/sh\n");
  chmodSync(process.env.MS_BIN, 0o755);
  const { dir } = stubDir();
  const { symlinkSync } = await import("node:fs");
  symlinkSync(process.env.MS_BIN, path.join(dir, "ms"));
  process.env.PATH = `${dir}:${process.env.PATH}`;

  writeHealthyAccountFiles(msHome, "gmail");
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "gmail", provider: "claude", label: "Gmail", orgId: null, shared: false, identityVerified: true },
        { name: "orphan-acct", provider: "claude", label: "Orphan", orgId: null, shared: false, identityVerified: false },
      ],
    }),
    { mode: 0o600 },
  );

  t.after(() => { delete process.env.MS_BIN; });

  const { runDoctor } = await import("../src/doctor.ts");
  const { results, lines, exitCode } = await runDoctor(false);
  assert.equal(exitCode, 1);
  assert.ok(lines.some((l) => l.startsWith("✗") && /Claude hooks installed/.test(l)), lines.join("\n"));
  assert.ok(results.some((r) => !r.ok && /orphan-acct.*poll grant readable/.test(r.what)));
  assert.ok(results.some((r) => r.ok && /gmail.*poll grant readable/.test(r.what)));
});

test("runDoctor --fix: installs hooks and exits 0 on the healthy subset", async (t: TestContext) => {
  const { home, msHome } = base();
  stubHealthyBinaries();
  process.env.MS_BIN = path.join(home, "real-ms");
  writeFileSync(process.env.MS_BIN, "#!/bin/sh\n");
  chmodSync(process.env.MS_BIN, 0o755);
  const { dir } = stubDir();
  const { symlinkSync } = await import("node:fs");
  symlinkSync(process.env.MS_BIN, path.join(dir, "ms"));
  process.env.PATH = `${dir}:${process.env.PATH}`;

  // Only the healthy account — the grant-less one is deliberately excluded
  // so this fixture's only problem is the missing hooks.
  writeHealthyAccountFiles(msHome, "gmail");
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ name: "gmail", provider: "claude", label: "Gmail", orgId: null, shared: false, identityVerified: true }] }),
    { mode: 0o600 },
  );

  t.after(() => { delete process.env.MS_BIN; });

  const { runDoctor } = await import("../src/doctor.ts");
  const before = await runDoctor(false);
  assert.equal(before.exitCode, 1);
  assert.ok(before.results.some((r) => !r.ok && /Claude hooks installed/.test(r.what)));

  const after = await runDoctor(true);
  assert.equal(after.exitCode, 0, after.lines.join("\n"));
  assert.ok(after.results.some((r) => r.ok && r.fixed && /Claude hooks installed/.test(r.what)));
});

// --- CLI wiring ------------------------------------------------------------

test("ms doctor is registered on the CLI and runs the real checks", async () => {
  const { home, msHome } = tempHome();
  const { run } = await import("./helpers.ts");
  const r = run(["doctor"], { HOME: home, MS_HOME: msHome, PATH: "/nonexistent-empty-dir" });
  // tmux/claude are unreachable via the empty PATH, so at least one check
  // fails; the point of this test is that "doctor" is a known verb (not the
  // "unknown verb" exit-2 path) and it prints its checklist.
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Node ≥ 22\.15/);
  assert.match(r.stdout, /tmux ≥ 3\.3/);
});
