import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, lstatSync, symlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stubDir, tempHome, run } from "./helpers.ts";
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
  // Every doctor test that reaches the poll-grant check must never touch the
  // real keychain: absent (exit 44) unless a test stubs its own answer.
  stub("security", "exit 44");
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

/** Writes a due (already-expired) poll credential for `name`, with the given
 *  access/refresh token text — so a test can prove that text never leaks. */
function writeDueCredential(msHome: string, name: string, accessToken: string, refreshToken = `${accessToken}-refresh`): void {
  const dir = path.join(msHome, "claude", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() - 1000 } }),
    { mode: 0o600 },
  );
}

const account = (over: Partial<Account> = {}): Account => ({
  name: "gmail", provider: "claude", label: "Gmail", orgId: null, shared: false, identityVerified: true, ...over,
});

// --- renderLine -----------------------------------------------------------

test("renderLine: ✓/✗ formatting, plus → fixed only on the ✓ branch", async () => {
  const { renderLine } = await import("../src/doctor.ts");
  assert.equal(renderLine({ ok: true, what: "a thing" }), "✓ a thing");
  assert.equal(renderLine({ ok: true, what: "a thing", fixed: true }), "✓ a thing → fixed");
  assert.equal(renderLine({ ok: false, what: "a thing", why: "it broke" }), "✗ a thing — it broke");
  // fixed:true on a ✗ result should never occur in practice, but the
  // renderer must not append "→ fixed" to a failing line even if it did.
  assert.equal(renderLine({ ok: false, what: "a thing", why: "it broke", fixed: true }), "✗ a thing — it broke");
});

// --- Node ------------------------------------------------------------------

test("checkNode passes on the Node this suite runs under", async () => {
  const { checkNode } = await import("../src/doctor.ts");
  const r = checkNode();
  assert.equal(r.ok, true);
  assert.equal(typeof process.execve, "function");
});

test("package.json declares the engine floor the tool actually needs", async () => {
  // `ms _exec` and `ms doctor` both require process.execve, which arrived in
  // Node 22.15. A package that says 22.13 installs happily on a runtime where
  // every launch then fails with "Node 22.15+ with process.execve is required".
  const { nodeVersionAtLeast } = await import("../src/doctor.ts");
  const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as { engines?: { node?: string } };
  const declared = pkg.engines?.node ?? "";
  assert.match(declared, /^>=\d+\.\d+$/, `engines.node is ${JSON.stringify(declared)}`);
  const floor = `${declared.slice(2)}.0`;
  assert.equal(nodeVersionAtLeast(floor, [22, 15, 0]), true, `engines.node allows ${floor}, which has no process.execve`);
});

test("nodeVersionAtLeast: a real MAJOR.MINOR.PATCH comparison, not vacuous", async () => {
  const { nodeVersionAtLeast } = await import("../src/doctor.ts");
  const MIN = [22, 15, 0] as const;
  assert.equal(nodeVersionAtLeast("21.9.0", MIN), false);
  assert.equal(nodeVersionAtLeast("22.14.9", MIN), false);
  assert.equal(nodeVersionAtLeast("22.15.0", MIN), true);
  assert.equal(nodeVersionAtLeast("22.15.1", MIN), true);
  assert.equal(nodeVersionAtLeast("23.0.0", MIN), true);
});

// --- tmux --------------------------------------------------------------

test("checkTmux: ok at 3.3+, fails below 3.3, fails when tmux is missing", async (t) => {
  base();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
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

test("checkClaudeBinary: ok when present, fails when missing", async (t) => {
  base();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
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

test("checkStorePermissions: a 0644 ms-owned file (accounts.json) is ✗; --fix chmods it to ✓", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const bad = path.join(msHome, "accounts.json");
  writeFileSync(bad, JSON.stringify({ version: 1, accounts: [] }), { mode: 0o644 });

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

test("checkStorePermissions: an arbitrary unlisted file under MS_HOME is neither reported nor touched", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const stray = path.join(msHome, "not-an-ms-owned-file.json");
  writeFileSync(stray, "{}", { mode: 0o644 });

  const r = checkStorePermissions(true);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.ok, true); // the one aggregate "clean" line — stray is out of scope
  assert.equal(statSync(stray).mode & 0o777, 0o644, "an unlisted file must never be chmodded");
});

test("checkStorePermissions: claude/<name>/ is scoped — only the dir and .credentials.json are checked, never a plugin binary underneath", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const acctDir = path.join(msHome, "claude", "gmail");
  mkdirSync(acctDir, { recursive: true, mode: 0o700 });
  const tool = path.join(acctDir, "plugins", "bin", "tool");
  mkdirSync(path.dirname(tool), { recursive: true }); // Claude Code's own subtree — arbitrary modes, not ms-owned
  writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });

  const before = checkStorePermissions(false);
  assert.ok(!before.some((r) => /tool|plugins/.test(r.what)), JSON.stringify(before));

  checkStorePermissions(true);
  assert.equal(statSync(tool).mode & 0o777, 0o755, "a --fix run must never touch Claude Code's own files");
});

test("checkStorePermissions: a wrongly-permissioned directory (claude/) is ✗; --fix chmods it", async () => {
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

test("checkStorePermissions --fix: a directory blocked from reading is repaired, then its own contents are found and fixed in the same run", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  mkdirSync(path.join(msHome, "sessions"), { recursive: true, mode: 0o700 });
  const sessDir = path.join(msHome, "sessions", "s1");
  mkdirSync(sessDir, { mode: 0o700 });
  const childFile = path.join(sessDir, "events.jsonl");
  writeFileSync(childFile, "{}\n", { mode: 0o644 }); // bad mode, written before locking the dir down
  chmodSync(sessDir, 0o300); // no read bit: readdirSync(sessDir) would fail until repaired

  const fixed = checkStorePermissions(true);
  assert.ok(fixed.some((r) => r.ok && r.fixed && r.what.endsWith("sessions/s1")), JSON.stringify(fixed));
  assert.ok(fixed.some((r) => r.ok && r.fixed && /events\.jsonl/.test(r.what)), JSON.stringify(fixed));
  assert.equal(statSync(sessDir).mode & 0o777, 0o700);
  assert.equal(statSync(childFile).mode & 0o777, 0o600);
});

test("checkStorePermissions: a symlink under an ms-owned dir is ✗ and never followed or fixed", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const sessionsDir = path.join(msHome, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const target = path.join(msHome, "outside-target");
  writeFileSync(target, "hello", { mode: 0o644 });
  const link = path.join(sessionsDir, "evil-link");
  symlinkSync(target, link);

  const before = checkStorePermissions(false);
  const issue = before.find((r) => r.what.includes("evil-link"));
  assert.ok(issue, JSON.stringify(before));
  assert.equal(issue!.ok, false);
  assert.match(issue!.why ?? "", /symlink/);

  checkStorePermissions(true);
  assert.equal(statSync(target).mode & 0o777, 0o644, "the symlink's target must never be chmodded");
  assert.ok(lstatSync(link).isSymbolicLink(), "the symlink itself must still be a symlink, never replaced");
});

test("checkStorePermissions: a clean store is one ✓ line", async () => {
  base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const r = checkStorePermissions(false);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.ok, true);
});

// --- the registry itself ---------------------------------------------------

test("runDoctor: a malformed accounts.json is a ✗ line that fails the whole run", async () => {
  const { msHome } = base();
  writeFileSync(path.join(msHome, "accounts.json"), "{ not json", { mode: 0o600 });
  const { runDoctor } = await import("../src/doctor.ts");
  const { results, exitCode } = await runDoctor(false);
  assert.equal(exitCode, 1);
  const line = results.find((r) => r.what === "accounts.json");
  assert.ok(line, JSON.stringify(results));
  assert.equal(line!.ok, false);
  assert.match(line!.why ?? "", /JSON/);
});

test("runDoctor: a registry row validateRegistry skips is a ✗ 'accounts.json entry N' line", async () => {
  const { msHome } = base();
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ name: "ok one", provider: "gemini", label: "bad provider" }] }),
    { mode: 0o600 },
  );
  const { runDoctor } = await import("../src/doctor.ts");
  const { results, exitCode } = await runDoctor(false);
  assert.equal(exitCode, 1);
  assert.ok(results.some((r) => !r.ok && r.what === "accounts.json entry 0" && /provider/.test(r.why ?? "")), JSON.stringify(results));
});

test("runDoctor: a clean, empty registry is one ✓ 'accounts.json' line", async () => {
  base();
  const { runDoctor } = await import("../src/doctor.ts");
  const { results } = await runDoctor(false);
  const line = results.find((r) => r.what === "accounts.json");
  assert.ok(line);
  assert.equal(line!.ok, true);
});

// --- accounts ------------------------------------------------------------

test("checkClaudeAccount: a fully healthy account reports four ✓ lines", async () => {
  const { msHome } = base();
  writeHealthyAccountFiles(msHome, "gmail");
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");
  const { checkClaudeAccount } = await import("../src/doctor.ts");

  const rs = await checkClaudeAccount(account({ name: "gmail", identityVerified: true }), false);
  assert.equal(rs.length, 4);
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs));
  assert.ok(rs.some((r) => /poll grant readable/.test(r.what)));
  assert.ok(rs.some((r) => /poll grant refresh not due/.test(r.what)));
  assert.ok(rs.some((r) => /launch token present/.test(r.what)));
  assert.ok(rs.some((r) => /identity verified/.test(r.what)));
});

test("checkClaudeAccount: a grant-less account fails readable, launch token, and identity", async () => {
  base();
  stubHealthyBinaries(); // stubs security too: the real keychain is never consulted
  const { checkClaudeAccount } = await import("../src/doctor.ts");
  const rs = await checkClaudeAccount(account({ name: "orphan-acct", identityVerified: false }), false);
  // No refreshable line at all when the grant cannot even be read.
  assert.equal(rs.length, 3);
  const byWhat = (re: RegExp) => rs.find((r) => re.test(r.what));
  assert.equal(byWhat(/poll grant readable/)!.ok, false);
  assert.equal(byWhat(/launch token present/)!.ok, false);
  assert.equal(byWhat(/identity verified/)!.ok, false);
});

/** root reads a 0000 file, so denying ourselves a read proves nothing there. */
const CAN_DENY_READ = process.getuid?.() !== 0;

test("checkClaudeAccount: a launch token that is there but unreadable asks for a chmod, not a login", { skip: !CAN_DENY_READ }, async (t) => {
  // `readLaunchToken` reports an unreadable file as null, exactly as it reports
  // an absent one — the two need different repairs, so the doctor asks whether
  // the file is there rather than inferring it from the null.
  base();
  stubHealthyBinaries();
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  const { p } = await import("../src/paths.ts");
  saveLaunchToken("gmail", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");
  chmodSync(p.launchToken("gmail"), 0o000);
  t.after(() => chmodSync(p.launchToken("gmail"), 0o600));

  const { checkClaudeAccount } = await import("../src/doctor.ts");
  const rs = await checkClaudeAccount(account({ name: "gmail" }), false);
  const token = rs.find((r) => /launch token present/.test(r.what))!;
  assert.equal(token.ok, false);
  assert.match(token.why!, /^unreadable \(chmod 600 .*gmail\.token\)$/);
  assert.doesNotMatch(token.why!, /accounts login/, "a permission is not a login to redo");
});

test("checkClaudeAccount: a due grant WITHOUT --fix is reported, never refreshed (no network call)", async () => {
  const { msHome } = base();
  writeDueCredential(msHome, "gmail", "at-1", "rt-1");
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("refreshPollCredentials must never be called without --fix");
  }) as unknown as typeof fetch;
  try {
    const { checkClaudeAccount } = await import("../src/doctor.ts");
    const rs = await checkClaudeAccount(account({ name: "gmail" }), false);
    const grant = rs.find((r) => r.what === "claude account gmail: poll grant");
    assert.ok(grant, JSON.stringify(rs));
    assert.equal(grant!.ok, false);
    assert.match(grant!.why ?? "", /refresh due/);
    assert.match(grant!.why ?? "", /--fix/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkClaudeAccount: --fix refreshes a due grant and reports it fixed", async () => {
  const { msHome } = base();
  writeDueCredential(msHome, "gmail", "at-1", "rt-1");
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 })) as typeof fetch;
  try {
    const { checkClaudeAccount } = await import("../src/doctor.ts");
    const rs = await checkClaudeAccount(account({ name: "gmail" }), true);
    const grant = rs.find((r) => r.what === "claude account gmail: poll grant");
    assert.ok(grant, JSON.stringify(rs));
    assert.equal(grant!.ok, true);
    assert.equal(grant!.fixed, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkClaudeAccount: --fix on a dead grant reports ✗ with the auth reason and never prints the token", async () => {
  const { msHome } = base();
  const TOKEN = "SEKRET-ACCESS-TOKEN-VALUE";
  writeDueCredential(msHome, "gmail", TOKEN);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  try {
    const { checkClaudeAccount } = await import("../src/doctor.ts");
    const rs = await checkClaudeAccount(account({ name: "gmail" }), true);
    const grant = rs.find((r) => r.what === "claude account gmail: poll grant");
    assert.ok(grant, JSON.stringify(rs));
    assert.equal(grant!.ok, false);
    assert.match(grant!.why ?? "", /auth/);
    for (const r of rs) {
      assert.ok(!r.what.includes(TOKEN), `token leaked in what: ${r.what}`);
      assert.ok(!(r.why ?? "").includes(TOKEN), `token leaked in why: ${r.why}`);
    }
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

test("checkOrphaned: list-panes is memoized per socket — one tmux call for two sessions on the same socket", async () => {
  const { msHome } = base();
  const { dir, stub } = stubDir();
  const log = path.join(dir, "calls.log");
  stub("tmux", `case "$*" in *"list-panes -a"*) printf 'call\\n' >> "${log}"; echo "%5" ;; esac\nexit 0`);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.MS_HOME = msHome;
  const { openState } = await import("../src/state.ts");
  const st = openState();
  const shared = { provider: "claude" as const, cliSessionId: "c1", cwd: "/tmp", socket: "/private/tmp/tmux-test/default",
    serverStart: "1", need: "any" as const, account: "gmail", generation: 1, state: "running" as const, desired: "running" as const, flags: [] };
  st.createSession({ id: "s1", ...shared, pane: "%5" });
  st.createSession({ id: "s2", ...shared, pane: "%6" });
  st.close();

  const { checkOrphaned } = await import("../src/doctor.ts");
  const rs = await checkOrphaned(false);
  assert.equal(rs.length, 1); // s1's pane exists, s2's does not — one ✗ line
  assert.equal(rs[0]!.ok, false);
  const { readFileSync } = await import("node:fs");
  const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(calls.length, 1, "two sessions on the same socket must share one list-panes call");
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
  const r = run(["doctor"], { HOME: home, MS_HOME: msHome, PATH: "/nonexistent-empty-dir" });
  // tmux/claude are unreachable via the empty PATH, so at least one check
  // fails; the point of this test is that "doctor" is a known verb (not the
  // "unknown verb" exit-2 path) and it prints its checklist.
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Node ≥ 22\.15/);
  assert.match(r.stdout, /tmux ≥ 3\.3/);
});

test("ms doctor --fix: a due grant that fails to refresh never prints the poll grant or launch token, even on stdout/stderr", async () => {
  const { home, msHome } = tempHome();
  const ACCESS_TOKEN = "SEKRET-POLL-TOKEN-VALUE";
  const LAUNCH_TOKEN = "sk-ant-oat01-SEKRETLAUNCHTOKEN1234567890123456";

  writeDueCredential(msHome, "gmail", ACCESS_TOKEN);
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", LAUNCH_TOKEN);
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ name: "gmail", provider: "claude", label: "Gmail", orgId: null, shared: false, identityVerified: true }] }),
    { mode: 0o600 },
  );

  const { dir: stubBin, stub } = stubDir();
  stub("tmux", HEALTHY_TMUX);
  stub("claude", HEALTHY_CLAUDE);

  // Loaded into the subprocess via --import: always fails the refresh, so
  // this proves a rejected credential is reported without ever echoing the
  // token that failed.
  const stubModule = path.join(stubBin, "fail-fetch.mjs");
  writeFileSync(stubModule, `globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });\n`);

  const r = run(["doctor", "--fix"], {
    HOME: home, MS_HOME: msHome,
    PATH: `${stubBin}:${process.env.PATH}`,
    NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import ${pathToFileURL(stubModule).href}`,
  });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /poll grant.*refresh failed: auth/);
  assert.ok(!r.stdout.includes(ACCESS_TOKEN), `access token leaked to stdout: ${r.stdout}`);
  assert.ok(!r.stderr.includes(ACCESS_TOKEN), `access token leaked to stderr: ${r.stderr}`);
  assert.ok(!r.stdout.includes(LAUNCH_TOKEN), `launch token leaked to stdout: ${r.stdout}`);
  assert.ok(!r.stderr.includes(LAUNCH_TOKEN), `launch token leaked to stderr: ${r.stderr}`);
});
