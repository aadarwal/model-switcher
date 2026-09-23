import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, lstatSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
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
// The tested range (spike record 2026-09-16): reporting a DIFFERENT minor
// must still be a ✓ line (checkCodexBinary never fails on it), so this
// fixture deliberately stays inside 0.153.x rather than proving that by
// accident.
const HEALTHY_CODEX = `case "$1" in --version) echo "codex-cli 0.153.4" ;; esac
exit 0`;

function stubHealthyBinaries(): { dir: string } {
  const { dir, stub } = stubDir();
  stub("tmux", HEALTHY_TMUX);
  stub("claude", HEALTHY_CLAUDE);
  stub("codex", HEALTHY_CODEX);
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

const codexAccount = (over: Partial<Account> = {}): Account => ({
  name: "codexacct", provider: "codex", label: "CodexAcct", orgId: null, shared: false, identityVerified: true, ...over,
});

/** A codex account's home, built the way `ensureCodexHome` itself builds one
 *  (the account dir plus the shared store plus this home's own `sessions`
 *  symlink), with a working `auth.json` (all four token fields, a fresh
 *  `last_refresh` so no poller ever needs to refresh it) and its hooks
 *  already installed — so `checkCodexAccount` reads as fully healthy without
 *  a test having to hand-build a home that could drift from the real one. */
async function writeHealthyCodexAccountFiles(msHome: string, name: string, accessToken = `at-${name}`): Promise<string> {
  process.env.MS_HOME = msHome;
  const { ensureCodexHome } = await import("../src/accounts-codex.ts");
  const { installCodexHooks } = await import("../src/hooks/codex-install.ts");
  const { msBinary } = await import("../src/paths.ts");
  const dir = ensureCodexHome(name);
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: `id-${name}`, access_token: accessToken, refresh_token: `rt-${name}`, account_id: `acct-${name}` },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  installCodexHooks(dir, msBinary());
  return dir;
}

/** A fetch stub answering `wham/usage` with a 200 for every bearer — used by
 *  tests that don't care about the usage READING, only that the call
 *  succeeds so hooks/link checks are exercised without hitting the network. */
function stubCodexUsageOk(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ rate_limit: {} }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

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

// --- codex ---------------------------------------------------------------

test("checkCodexBinary(true): ok, and reports the version, when in the tested 0.153.x range", async (t) => {
  base();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  const { checkCodexBinary } = await import("../src/doctor.ts");
  const { dir, stub } = stubDir();
  stub("codex", 'case "$1" in --version) echo "codex-cli 0.153.4" ;; esac\nexit 0');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const r = checkCodexBinary(true);
  assert.equal(r.ok, true);
  assert.match(r.what, /0\.153\.4/);
  assert.doesNotMatch(r.what, /different minor/);
});

test("checkCodexBinary(true): a different minor is still ok — never a failure — with a note in the line", async (t) => {
  base();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  const { checkCodexBinary } = await import("../src/doctor.ts");
  const { dir, stub } = stubDir();
  stub("codex", 'case "$1" in --version) echo "codex-cli 0.160.2" ;; esac\nexit 0');
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const r = checkCodexBinary(true);
  assert.equal(r.ok, true);
  assert.match(r.what, /0\.160\.2/);
  assert.match(r.what, /different minor/);
});

test("checkCodexBinary(true): ✗ (bounded) when codex is missing", async (t) => {
  base();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  const { checkCodexBinary } = await import("../src/doctor.ts");
  process.env.PATH = "/nonexistent-empty-dir";
  assert.equal(checkCodexBinary(true).ok, false);
});

test("checkCodexBinary(false): ok and never spawns codex at all — a Claude-only machine must never fail on a missing Codex CLI", async (t) => {
  base();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  const { checkCodexBinary } = await import("../src/doctor.ts");
  // No `codex` anywhere on PATH. If this spawned anyway, `runBounded` would
  // report ENOENT and the result would be ✗ — so ok:true here is itself the
  // proof that the spawn never happened.
  process.env.PATH = "/nonexistent-empty-dir";
  const r = checkCodexBinary(false);
  assert.equal(r.ok, true);
  assert.match(r.what, /not needed \(no codex accounts\)/);
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

test("checkHooks: a stale ms entry from an ms that MOVED is a ✗, and --fix prunes it", async () => {
  const { home } = base();
  const { checkHooks } = await import("../src/doctor.ts");
  const { claudeHookCommand, installClaudeHooks } = await import("../src/hooks/install.ts");
  const { msBinary } = await import("../src/paths.ts");
  const settingsPath = path.join(home, ".claude", "settings.json");

  // What a brew upgrade (or an abandoned checkout) leaves behind: our own
  // four for the CURRENT binary, plus four more naming one that is gone.
  installClaudeHooks(settingsPath, msBinary());
  const dead = claudeHookCommand("/opt/homebrew/Cellar/model-switcher/0.1.0/bin/ms");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]) {
    settings.hooks[ev].push({ matcher: "", hooks: [{ type: "command", command: dead }] });
  }
  settings.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command: "anu-session-start" }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const before = checkHooks(false);
  assert.equal(before.ok, false, "a dead hook on every SessionStart is a fault, not a detail");
  assert.match(before.why ?? "", /stale/);

  const fixed = checkHooks(true);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.fixed, true);

  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  const live = claudeHookCommand(msBinary());
  for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]) {
    const ms = (after.hooks[ev] as { hooks: { command: string }[] }[])
      .flatMap((e) => e.hooks.map((h) => h.command))
      .filter((c) => / _hook claude$/.test(c));
    assert.deepEqual(ms, [live], `${ev}: exactly one ms entry, the live one`);
  }
  const start = (after.hooks.SessionStart as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(start.includes("anu-session-start"), "another tool's hook is never pruned");
});

test("checkClaudeBinary / checkHooks: not needed when the registry names no Claude account", async () => {
  const { msHome } = base();
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ name: "codex-1", provider: "codex", label: "codex-1", orgId: null, shared: false, identityVerified: true }] }),
    { mode: 0o600 },
  );
  const { dir, stub } = stubDir();
  stub("tmux", HEALTHY_TMUX);
  stub("codex", HEALTHY_CODEX);
  stub("security", "exit 44");
  process.env.PATH = `${dir}:${process.env.PATH}`; // deliberately NO `claude`

  const { runDoctor } = await import("../src/doctor.ts");
  const { results } = await runDoctor(false);
  const claudeLine = results.find((r) => r.what.startsWith("claude --version"));
  assert.ok(claudeLine?.ok, JSON.stringify(claudeLine));
  assert.match(claudeLine!.what, /not needed \(no claude accounts\)/);
  const hooksLine = results.find((r) => r.what.startsWith("Claude hooks installed"));
  assert.ok(hooksLine?.ok, JSON.stringify(hooksLine));
  assert.match(hooksLine!.what, /not needed \(no claude accounts\)/);
});

test("D3: an unparsable registry is not 'not needed' — checkClaudeBinary and checkHooks actually run", async () => {
  const { msHome } = base();
  // Malformed JSON (a trailing comma), NOT an empty/missing file — the case
  // `loadRegistry` reports as a `parseError`, which empties `accounts` the
  // same way a genuinely account-less registry does. Before the fix, that
  // emptiness alone made both checks below claim "not needed", two green
  // lines this run has no basis for.
  writeFileSync(path.join(msHome, "accounts.json"), '{"version":1,"accounts":[{"name":"a",}]}');
  stubHealthyBinaries();

  const { runDoctor } = await import("../src/doctor.ts");
  const { results } = await runDoctor(false);

  const registryLine = results.find((r) => r.what === "accounts.json");
  assert.equal(registryLine?.ok, false, "the parse error itself is still reported — nothing goes silent");
  assert.match(registryLine!.why ?? "", /JSON/);

  const claudeLine = results.find((r) => r.what.startsWith("claude --version"));
  assert.doesNotMatch(claudeLine!.what, /not needed/, "an unparsable registry is not the same thing as no claude accounts");
  assert.equal(claudeLine?.ok, true);
  assert.match(claudeLine!.what, /1\.2\.3/, "the stubbed binary was actually invoked");

  const hooksLine = results.find((r) => r.what.startsWith("Claude hooks installed"));
  assert.doesNotMatch(hooksLine!.what, /not needed/);
  assert.equal(hooksLine?.ok, false, "no hooks are installed in this fresh settings file — the real check found that");
  // The count is the installer's own event table's length (five since `Stop`
  // joined it in 0.3.1), so this pins the wiring and not a literal.
  const { CLAUDE_HOOK_ENTRIES } = await import("../src/hooks/install.ts");
  assert.equal(CLAUDE_HOOK_ENTRIES, 5, "SessionStart, UserPromptSubmit, Stop, StopFailure, SessionEnd");
  assert.match(hooksLine!.why ?? "", new RegExp(`not all ${CLAUDE_HOOK_ENTRIES} present`));
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

// --- store permissions: the codex tree ------------------------------------

test("checkStorePermissions: codex/<name>/auth.json and config.toml are checked (0600); --fix chmods both", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const dir = path.join(msHome, "codex", "codexacct");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "auth.json"), "{}", { mode: 0o644 });
  writeFileSync(path.join(dir, "config.toml"), "", { mode: 0o644 });

  const before = checkStorePermissions(false);
  assert.ok(before.some((r) => !r.ok && r.what.endsWith("auth.json") && /0644.*0600/.test(r.why ?? "")), JSON.stringify(before));
  assert.ok(before.some((r) => !r.ok && r.what.endsWith("config.toml") && /0644.*0600/.test(r.why ?? "")), JSON.stringify(before));

  checkStorePermissions(true);
  assert.equal(statSync(path.join(dir, "auth.json")).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(dir, "config.toml")).mode & 0o777, 0o600);
});

test("checkStorePermissions: a codex account's config.toml.bak-ms-* backups are swept too (fix-A-report.md A-M4's other half); --fix chmods a 0644 one to 0600", async () => {
  // `backupThroughLink` (src/fsx.ts) already chmods every NEW backup 0600 at
  // creation — A-M4's "done" half — but a backup written before that landed,
  // or one some other tool touched afterward, is not fixed by anything. Named
  // by pattern only (`config.toml.bak-ms-*`), never a full `readdirSync` of
  // the account home — an unrelated stray file must still go untouched,
  // proven below alongside it.
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const dir = path.join(msHome, "codex", "codexacct");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "auth.json"), "{}", { mode: 0o600 });
  writeFileSync(path.join(dir, "config.toml"), "", { mode: 0o600 });
  const backup = path.join(dir, "config.toml.bak-ms-1699999999999");
  writeFileSync(backup, "# old config\n", { mode: 0o644 });
  // A stray file that merely starts with "config.toml" but is not one of
  // this tool's own backups — never reported, never touched.
  const stray = path.join(dir, "config.toml.orig");
  writeFileSync(stray, "not ours", { mode: 0o644 });

  const before = checkStorePermissions(false);
  assert.ok(
    before.some((r) => !r.ok && r.what.endsWith("config.toml.bak-ms-1699999999999") && /0644.*0600/.test(r.why ?? "")),
    JSON.stringify(before),
  );
  assert.ok(!before.some((r) => r.what.endsWith("config.toml.orig")), JSON.stringify(before));

  checkStorePermissions(true);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(statSync(stray).mode & 0o777, 0o644, "a file that is not one of our own backups must never be chmodded");
});

test("checkStorePermissions: the account dir (codex/<name>) is checked (0700); --fix chmods it", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const dir = path.join(msHome, "codex", "codexacct");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);

  const before = checkStorePermissions(false);
  assert.ok(before.some((r) => !r.ok && /codexacct$/.test(r.what)), JSON.stringify(before));

  checkStorePermissions(true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("checkStorePermissions: the shared codex/sessions store is checked (0700) but its CONTENTS are never walked or chmod'ed — Codex owns them", async () => {
  const { msHome } = base();
  const { checkStorePermissions } = await import("../src/doctor.ts");
  const sessionsDir = path.join(msHome, "codex", "sessions");
  const rollout = path.join(sessionsDir, "2026", "09", "16");
  mkdirSync(rollout, { recursive: true, mode: 0o755 });
  const rolloutFile = path.join(rollout, "rollout-1.jsonl");
  writeFileSync(rolloutFile, "{}\n", { mode: 0o644 });
  chmodSync(sessionsDir, 0o755);

  const before = checkStorePermissions(false);
  assert.ok(before.some((r) => !r.ok && r.what.endsWith("codex/sessions") && /0755.*0700/.test(r.why ?? "")), JSON.stringify(before));
  assert.ok(!before.some((r) => /rollout-1\.jsonl|2026|09|16/.test(r.what)), JSON.stringify(before));

  checkStorePermissions(true);
  assert.equal(statSync(sessionsDir).mode & 0o777, 0o700);
  assert.equal(statSync(rolloutFile).mode & 0o777, 0o644, "codex's own rollout files must never be chmodded");
});

test("checkStorePermissions: codex/<name>/ is scoped — only auth.json and config.toml are checked BY NAME; the account home is never listed, so its 'sessions' symlink and any other file underneath are neither reported nor touched", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  const { ensureCodexHome } = await import("../src/accounts-codex.ts");
  const dir = ensureCodexHome("codexacct"); // builds codex/sessions AND codex/codexacct/sessions -> a symlink to it

  const link = path.join(dir, "sessions");
  assert.ok(lstatSync(link).isSymbolicLink(), "fixture sanity: the per-home entry really is a symlink");

  // A stray file that is neither of the two names this check knows about —
  // proof the account home is never `readdirSync`'d, only probed by name.
  const stray = path.join(dir, "notes.txt");
  writeFileSync(stray, "hello", { mode: 0o644 });

  const { checkStorePermissions } = await import("../src/doctor.ts");
  const before = checkStorePermissions(false);
  assert.ok(!before.some((x) => x.what.includes(path.relative(msHome, link))), JSON.stringify(before));
  assert.ok(!before.some((x) => /symlink/i.test(x.why ?? "")), JSON.stringify(before));
  assert.ok(!before.some((x) => /notes\.txt/.test(x.what)), JSON.stringify(before));
  // The store is otherwise clean: one aggregate ✓ line, nothing else to report.
  assert.equal(before.length, 1);
  assert.equal(before[0]!.ok, true);

  checkStorePermissions(true); // --fix must not touch either stray either
  assert.ok(lstatSync(link).isSymbolicLink(), "the symlink must still be a symlink, never replaced");
  assert.equal(statSync(stray).mode & 0o777, 0o644, "an unnamed file under an account home must never be chmodded");
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

test("runDoctor: the codex auto-recovery gate line reflects the stored kv value, on by default and on/off from kv", async () => {
  // Rereview A, Minor 2: only codexAutorotateLine itself (a pure function,
  // test/autorotate.test.ts) was asserted — deleting the doctor.ts:718
  // results.push that prints it left this file 60/60 green. This exercises
  // runDoctor end to end, so that wiring is what is under test, not the line
  // builder alone.
  const { msHome } = base();
  stubHealthyBinaries();
  await writeHealthyCodexAccountFiles(msHome, "codexacct");
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [{ name: "codexacct", provider: "codex", label: "CodexAcct", orgId: null, shared: false, identityVerified: true }],
    }),
    { mode: 0o600 },
  );

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk(); // the per-account checks are not this test's concern
  try {
    const { openState } = await import("../src/state.ts");
    const { codexAutorotateLine } = await import("../src/autorotate.ts");
    const { runDoctor } = await import("../src/doctor.ts");

    // kv absent: ON is the shipped default since 0.2.4, and the line says so
    // along with the export that would turn it off.
    delete process.env.MS_CODEX_AUTOROTATE;
    const absent = await runDoctor(false);
    const absentLine = absent.results.find((r) => r.what === codexAutorotateLine(true));
    assert.ok(absentLine, absent.lines.join("\n"));
    assert.equal(absentLine!.ok, true);
    assert.match(absentLine!.what, /export MS_CODEX_AUTOROTATE=0 to disable/);

    const stOn = openState();
    stOn.setKv("codexAutorotate", "1");
    stOn.close();
    const on = await runDoctor(false);
    const onLine = on.results.find((r) => r.what === codexAutorotateLine(true));
    assert.ok(onLine, on.lines.join("\n"));
    assert.equal(onLine!.ok, true);

    const stOff = openState();
    stOff.setKv("codexAutorotate", "0");
    stOff.close();
    const off = await runDoctor(false);
    const offLine = off.results.find((r) => r.what === codexAutorotateLine(false));
    assert.ok(offLine, off.lines.join("\n"));
    // Off is somebody's deliberate choice, not a fault: still a ✓.
    assert.equal(offLine!.ok, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("runDoctor: the rebalance gate line is printed for every fleet, and ships ON", async () => {
  // Deliberately a Claude-only registry: rebalance is not a Codex feature the
  // way auto-recovery is, so its line must not hide behind a codex account.
  const { msHome } = base();
  stubHealthyBinaries();
  writeHealthyAccountFiles(msHome, "gmail");
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  try {
    const { openState } = await import("../src/state.ts");
    const { rebalanceLine } = await import("../src/autorotate.ts");
    const { runDoctor } = await import("../src/doctor.ts");

    delete process.env.MS_REBALANCE;
    const absent = await runDoctor(false);
    const absentLine = absent.results.find((r) => r.what === rebalanceLine(true));
    assert.ok(absentLine, absent.lines.join("\n"));
    assert.equal(absentLine!.ok, true, "on is the default since 0.3.4");
    assert.match(absentLine!.what, /export MS_REBALANCE=0 to disable/);

    const st = openState();
    st.setKv("rebalance", "0");
    st.close();
    const off = await runDoctor(false);
    assert.ok(off.results.find((r) => r.what === rebalanceLine(false)), off.lines.join("\n"));
  } finally {
    globalThis.fetch = savedFetch;
  }
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

test("checkClaudeAccount: a truncated keychain grant reads `unreadable`, and --fix never refreshes it", async () => {
  // ms 0.2.0's write-back put the refreshed blob through `security`'s
  // interactive prompt, which keeps 128 bytes of ~600. What it left behind is
  // an item that is THERE and holds no parseable credential — a different
  // repair from an account that was never logged in, and a refresh token
  // there is nothing left to send. --fix must not spend a call on it.
  const { msHome } = base();
  const configDir = path.join(msHome, "claude", "gmail");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const service = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
  const whole = JSON.stringify({
    claudeAiOauth: { accessToken: `at-${"A".repeat(260)}`, refreshToken: `rt-${"R".repeat(260)}`, expiresAt: Date.now() },
  });
  const truncated = whole.slice(0, 128);
  const { dir, stub } = stubDir();
  stub("security", `case "$*" in *"-s ${service} -a ${userInfo().username}"*) printf '%s' '${truncated}' ;; *) exit 44 ;; esac\nexit 0`);
  process.env.PATH = `${dir}:${process.env.PATH}`;

  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("--fix must never attempt a refresh on an unreadable grant");
  }) as unknown as typeof fetch;
  try {
    const { checkClaudeAccount, renderLine } = await import("../src/doctor.ts");
    const rs = await checkClaudeAccount(account({ name: "gmail" }), true);
    const grant = rs.find((r) => r.what === "claude account gmail: poll grant");
    assert.ok(grant, JSON.stringify(rs));
    assert.equal(grant!.ok, false);
    assert.equal(
      renderLine(grant!),
      "✗ claude account gmail: poll grant — unreadable (a truncated keychain write from ms 0.2.0); run ms accounts login gmail",
    );
    // Distinct from the genuinely missing case, which is the OTHER line.
    assert.equal(rs.some((r) => /poll grant readable/.test(r.what)), false, JSON.stringify(rs));
    assert.equal(rs.some((r) => r.fixed), false, "nothing was repaired");
    for (const r of rs) assert.equal((r.why ?? "").includes("RRRR"), false, `a credential leaked: ${r.why}`);
  } finally {
    globalThis.fetch = savedFetch;
  }
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

test("checkClaudeAccount: the identity line runs verify's own organisation check, and --fix leaves it", async () => {
  // Live, 2026-09-16: a refused `ms accounts login dirk` left the wrong
  // organisation's grant in dirk's keychain item. `ms accounts verify dirk`
  // failed with "resolves to the same organisation as kratuvak" while
  // `ms doctor` read the registry's stale `identityVerified: true` and printed
  // ✓. A book and a doctor must never disagree about one credential, so the
  // line asks the same question of the same GRANT.
  const { msHome } = base();
  stubHealthyBinaries();
  writeHealthyAccountFiles(msHome, "dirk");
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("dirk", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");

  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ account: { email: "wrong@example.com" }, organization: { uuid: "org-K", name: "Kratuvak" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    const { checkClaudeAccount, renderLine } = await import("../src/doctor.ts");
    const book = [account({ name: "dirk", orgId: "org-D" }), account({ name: "kratuvak", orgId: "org-K" })];

    const rs = await checkClaudeAccount(account({ name: "dirk", orgId: "org-D", identityVerified: true }), false, book);
    const id = rs.find((r) => /identity/.test(r.what));
    assert.ok(id, JSON.stringify(rs));
    assert.equal(
      renderLine(id!),
      "✗ claude account dirk: identity — resolves to the same organisation as kratuvak; run ms accounts login dirk --relogin",
    );
    assert.ok(calls > 0, "the grant itself was never read");

    // --fix never touches an identity: same ✗, nothing repaired.
    const fixed = await checkClaudeAccount(account({ name: "dirk", orgId: "org-D", identityVerified: true }), true, book);
    const fixedId = fixed.find((r) => /identity/.test(r.what))!;
    assert.equal(fixedId.ok, false);
    assert.equal(fixedId.fixed, undefined, "an identity is never auto-repaired");
    assert.equal(readFileSync(path.join(msHome, "claude", "dirk", ".credentials.json"), "utf8").includes("at-dirk"), true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkClaudeAccount: no other account claims an organisation, so nothing is read over the network", async () => {
  // The collision only ever exists against another registered account, so a
  // book with nothing to collide with costs no call at all — exactly what
  // `verify` would conclude, for free.
  const { msHome } = base();
  stubHealthyBinaries();
  writeHealthyAccountFiles(msHome, "gmail");
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ organization: { uuid: "org-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const { checkClaudeAccount } = await import("../src/doctor.ts");
    const rs = await checkClaudeAccount(account({ name: "gmail", identityVerified: true }), false, [
      account({ name: "gmail", orgId: null }),
      account({ name: "other", orgId: null }),
    ]);
    const id = rs.find((r) => /identity/.test(r.what))!;
    assert.equal(id.ok, true);
    assert.equal(calls, 0, "a book with nothing to collide with must cost no network call");
    // And the line says so: nothing was re-checked here, so it must not borrow
    // the authority of a check that never ran.
    assert.equal(id.what, "claude account gmail: identity verified at login (not re-checked)");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// --- codex accounts --------------------------------------------------------

test("checkCodexAccount: a fully healthy account reports four ✓ lines, in order", async () => {
  const { msHome } = base();
  await writeHealthyCodexAccountFiles(msHome, "codexacct", "at-codexacct");
  const savedFetch = globalThis.fetch;
  stubCodexUsageOk();
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const rs = await checkCodexAccount(codexAccount(), false);
    assert.equal(rs.length, 4);
    assert.ok(rs.every((r) => r.ok && !r.fixed), JSON.stringify(rs));
    assert.deepEqual(rs.map((r) => r.what), [
      "codex account codexacct: credentials readable",
      "codex account codexacct: usage fetch ok",
      "codex account codexacct: hooks installed",
      "codex account codexacct: sessions store linked",
    ]);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: no auth.json fails credentials readable + usage fetch ok, with the codex login remedy; hooks/link checks still run independently", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  const { ensureCodexHome } = await import("../src/accounts-codex.ts");
  ensureCodexHome("orphan-codex"); // home + shared store + link, but no auth.json ever written
  const { checkCodexAccount } = await import("../src/doctor.ts");
  const rs = await checkCodexAccount(codexAccount({ name: "orphan-codex" }), false);
  assert.equal(rs.length, 4);
  const byWhat = (re: RegExp) => rs.find((r) => re.test(r.what))!;
  assert.equal(byWhat(/credentials readable/).ok, false);
  assert.match(byWhat(/credentials readable/).why ?? "", /ms accounts login orphan-codex --provider codex/);
  assert.equal(byWhat(/usage fetch ok/).ok, false);
  assert.equal(byWhat(/hooks installed/).ok, false); // ensureCodexHome never installs hooks
  assert.equal(byWhat(/sessions store linked/).ok, true); // ensureCodexHome already links it
});

test("checkCodexAccount: a dead access token fails usage fetch as auth, with the codex login remedy — doctor never refreshes a Codex credential, --fix or not", async () => {
  const { msHome } = base();
  await writeHealthyCodexAccountFiles(msHome, "codexacct", "at-dead");
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const rs = await checkCodexAccount(codexAccount(), true); // --fix: still no refresh call exists here
    const usage = rs.find((r) => /usage fetch ok/.test(r.what))!;
    assert.equal(usage.ok, false);
    assert.match(usage.why ?? "", /auth/);
    assert.match(usage.why ?? "", /ms accounts login codexacct --provider codex/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: a 500 from wham/usage fails usage fetch as transient, not auth", async () => {
  const { msHome } = base();
  await writeHealthyCodexAccountFiles(msHome, "codexacct", "at-codexacct");
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const rs = await checkCodexAccount(codexAccount(), false);
    const usage = rs.find((r) => /usage fetch ok/.test(r.what))!;
    assert.equal(usage.ok, false);
    assert.match(usage.why ?? "", /transient/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: hooks not installed → ✗; --fix installs and reports fixed", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  const { ensureCodexHome } = await import("../src/accounts-codex.ts");
  const dir = ensureCodexHome("codexacct");
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id-codexacct", access_token: "at-codexacct", refresh_token: "rt-codexacct", account_id: "acct-codexacct" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk();
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const before = await checkCodexAccount(codexAccount(), false);
    const hooksBefore = before.find((r) => /hooks installed/.test(r.what))!;
    assert.equal(hooksBefore.ok, false);
    assert.match(hooksBefore.why ?? "", /not installed/);

    const after = await checkCodexAccount(codexAccount(), true);
    const hooksAfter = after.find((r) => /hooks installed/.test(r.what))!;
    assert.equal(hooksAfter.ok, true);
    assert.equal(hooksAfter.fixed, true);

    const { codexHooksInstalled } = await import("../src/hooks/codex-install.ts");
    const { msBinary } = await import("../src/paths.ts");
    assert.equal(codexHooksInstalled(dir, msBinary()), true);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: --fix on a config.toml it cannot safely rewrite surfaces the refusal verbatim, never 'nothing to do'", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  const { ensureCodexHome } = await import("../src/accounts-codex.ts");
  const dir = ensureCodexHome("codexacct");
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id-codexacct", access_token: "at-codexacct", refresh_token: "rt-codexacct", account_id: "acct-codexacct" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  // A 'hooks' table shape this installer cannot classify — a refusal, not a guess.
  writeFileSync(path.join(dir, "config.toml"), `[hooks]\nSessionStart = []\n`, { mode: 0o600 });

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk();
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const rs = await checkCodexAccount(codexAccount(), true);
    const hooks = rs.find((r) => /hooks installed/.test(r.what))!;
    assert.equal(hooks.ok, false);
    assert.match(hooks.why ?? "", /a 'hooks' table this tool cannot read/);
    assert.doesNotMatch(hooks.why ?? "", /nothing to do/i);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: the account's own sessions LINK is missing (the shared store already exists) → ✗; --fix recreates the LINK", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  // The shared store itself (normally created by `loadRegistry`'s own
  // `ensureStore`, ahead of every account check in `runDoctor`) — created
  // here explicitly since this test calls `checkCodexAccount` directly. No
  // ensureCodexHome for the ACCOUNT home, though — build that one by hand,
  // deliberately without its own `sessions` entry, so the "link missing,
  // store present" branch is what gets exercised (distinct from "link
  // present but dangling because the STORE is missing", tested separately).
  const { ensureStore } = await import("../src/paths.ts");
  ensureStore();
  const dir = path.join(msHome, "codex", "codexacct");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id", access_token: "at-codexacct", refresh_token: "rt", account_id: "acct" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk();
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const before = await checkCodexAccount(codexAccount(), false);
    const linkBefore = before.find((r) => /sessions store linked/.test(r.what))!;
    assert.equal(linkBefore.ok, false);
    assert.match(linkBefore.why ?? "", /is missing \(want a symlink/);
    assert.doesNotMatch(linkBefore.why ?? "", /shared store missing/);

    const after = await checkCodexAccount(codexAccount(), true);
    const linkAfter = after.find((r) => /sessions store linked/.test(r.what))!;
    assert.equal(linkAfter.ok, true);
    assert.equal(linkAfter.fixed, true);

    const { p } = await import("../src/paths.ts");
    assert.equal(lstatSync(p.codexSessionsLink("codexacct")).isSymbolicLink(), true);
    assert.equal(realpathSync(p.codexSessionsLink("codexacct")), realpathSync(p.codexSessions()));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: --fix never touches an existing real directory at the sessions path — only a missing entry is ever created", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  const dir = path.join(msHome, "codex", "codexacct");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id", access_token: "at-codexacct", refresh_token: "rt", account_id: "acct" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const realSessions = path.join(dir, "sessions");
  mkdirSync(realSessions, { recursive: true, mode: 0o700 });
  const marker = path.join(realSessions, "keep-me.txt");
  writeFileSync(marker, "real session data");

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk();
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const rs = await checkCodexAccount(codexAccount(), true);
    const link = rs.find((r) => /sessions store linked/.test(r.what))!;
    assert.equal(link.ok, false);
    assert.match(link.why ?? "", /real directory/);
    assert.equal(lstatSync(realSessions).isDirectory(), true);
    assert.equal(lstatSync(realSessions).isSymbolicLink(), false);
    assert.equal(readFileSync(marker, "utf8"), "real session data");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: a symlink correctly pointing at the shared store, when the store itself is missing, reports 'shared store missing'; --fix recreates the STORE, not the link", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  const dir = path.join(msHome, "codex", "codexacct");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id", access_token: "at-codexacct", refresh_token: "rt", account_id: "acct" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const { p } = await import("../src/paths.ts");
  const target = p.codexSessions();
  const link = path.join(dir, "sessions");
  // The link is correct and pre-existing — pointing at the shared store by
  // name — but nothing has ever created that store directory (never call
  // ensureStore/ensureCodexHome in this fixture).
  symlinkSync(target, link, "dir");
  assert.ok(!existsSync(target), "fixture sanity: the shared store must not exist yet");

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk();
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const before = await checkCodexAccount(codexAccount(), false);
    const linkBefore = before.find((r) => /sessions store linked/.test(r.what))!;
    assert.equal(linkBefore.ok, false);
    assert.match(linkBefore.why ?? "", /shared store missing/);
    assert.ok(lstatSync(link).isSymbolicLink(), "the link itself is untouched by a plain check");

    const after = await checkCodexAccount(codexAccount(), true);
    const linkAfter = after.find((r) => /sessions store linked/.test(r.what))!;
    assert.equal(linkAfter.ok, true);
    assert.equal(linkAfter.fixed, true);
    assert.equal(statSync(target).isDirectory(), true);
    assert.equal(statSync(target).mode & 0o777, 0o700);
    // The link itself was never recreated — same inode/target as before.
    assert.equal(realpathSync(link), realpathSync(target));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("checkCodexAccount: a symlink pointing SOMEWHERE ELSE (not the shared store) is reported and left alone — --fix never touches it, even though it is technically 'broken'", async () => {
  const { msHome } = base();
  process.env.MS_HOME = msHome;
  const dir = path.join(msHome, "codex", "codexacct");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id", access_token: "at-codexacct", refresh_token: "rt", account_id: "acct" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const { ensureStore } = await import("../src/paths.ts"); // the shared store DOES exist here
  ensureStore();
  const elsewhere = path.join(msHome, "somewhere-else");
  mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
  const link = path.join(dir, "sessions");
  symlinkSync(elsewhere, link, "dir"); // deliberately the wrong target

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk();
  try {
    const { checkCodexAccount } = await import("../src/doctor.ts");
    const before = await checkCodexAccount(codexAccount(), false);
    const linkBefore = before.find((r) => /sessions store linked/.test(r.what))!;
    assert.equal(linkBefore.ok, false);
    assert.match(linkBefore.why ?? "", /points elsewhere/);
    assert.doesNotMatch(linkBefore.why ?? "", /shared store missing/);

    const after = await checkCodexAccount(codexAccount(), true); // --fix too
    const linkAfter = after.find((r) => /sessions store linked/.test(r.what))!;
    assert.equal(linkAfter.ok, false);
    assert.match(linkAfter.why ?? "", /points elsewhere/);
    assert.equal(realpathSync(link), realpathSync(elsewhere), "never touched, --fix or not");
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

test("B-C2: with MS_BIN set the way the brew shim sets it, ms on PATH resolves to msBinary()", async () => {
  const { home } = base();
  // The keg, exactly as Homebrew lays it out: a VERSIONED prefix, the
  // stable `opt/<formula>` link at it, and `<brew>/bin/ms` linked into the
  // keg. `opt_bin` is the path the shim must export — `#{bin}` during
  // `def install` is the versioned one, which the next `brew upgrade`
  // deletes, taking every hook command and alias with it.
  const brew = path.join(home, "homebrew");
  const keg = path.join(brew, "Cellar", "model-switcher", "0.2.0");
  mkdirSync(path.join(keg, "bin"), { recursive: true });
  mkdirSync(path.join(brew, "bin"), { recursive: true });
  mkdirSync(path.join(brew, "opt"), { recursive: true });
  const kegBin = path.join(keg, "bin", "ms");
  writeFileSync(kegBin, "#!/bin/bash\n");
  chmodSync(kegBin, 0o755);
  symlinkSync(keg, path.join(brew, "opt", "model-switcher"));
  symlinkSync(kegBin, path.join(brew, "bin", "ms"));

  const optBin = path.join(brew, "opt", "model-switcher", "bin", "ms");
  process.env.MS_BIN = optBin;
  process.env.PATH = `${path.join(brew, "bin")}:${process.env.PATH}`;

  const { msBinary } = await import("../src/paths.ts");
  const { checkPathBinary } = await import("../src/doctor.ts");
  assert.equal(msBinary(), optBin, "every hook/alias/wrapper is written with this exact string");
  const r = checkPathBinary();
  assert.equal(r.ok, true, JSON.stringify(r));
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

test("runDoctor: a Claude-only machine (no codex accounts, codex truly absent from PATH — not merely unstubbed) never fails on codex --version", async (t: TestContext) => {
  const { home, msHome } = base();
  // A self-contained PATH — no ambient fallback — with tmux/claude/security/ms
  // stubbed and, deliberately, NO `codex` anywhere: if the fix regresses and
  // this spawns `codex` anyway, it fails with ENOENT and this test catches it
  // instead of silently passing off a real `codex` the host happens to have.
  const { dir, stub } = stubDir();
  stub("tmux", HEALTHY_TMUX);
  stub("claude", HEALTHY_CLAUDE);
  stub("security", "exit 44");
  process.env.MS_BIN = path.join(home, "real-ms");
  writeFileSync(process.env.MS_BIN, "#!/bin/sh\n");
  chmodSync(process.env.MS_BIN, 0o755);
  symlinkSync(process.env.MS_BIN, path.join(dir, "ms"));
  process.env.PATH = dir;
  t.after(() => { delete process.env.MS_BIN; });

  writeHealthyAccountFiles(msHome, "gmail");
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789");
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({ version: 1, accounts: [{ name: "gmail", provider: "claude", label: "Gmail", orgId: null, shared: false, identityVerified: true }] }),
    { mode: 0o600 },
  );

  const { runDoctor } = await import("../src/doctor.ts");
  const before = await runDoctor(false);
  assert.ok(before.results.some((r) => !r.ok && /Claude hooks installed/.test(r.what))); // the one real problem here
  const codexBefore = before.results.find((r) => r.what.startsWith("codex --version"))!;
  assert.equal(codexBefore.ok, true, JSON.stringify(codexBefore));
  assert.match(codexBefore.what, /not needed \(no codex accounts\)/);

  const after = await runDoctor(true);
  assert.equal(after.exitCode, 0, after.lines.join("\n"));
  const codexAfter = after.results.find((r) => r.what.startsWith("codex --version"))!;
  assert.equal(codexAfter.ok, true);
  assert.equal(codexAfter.fixed, undefined, "never 'fixed' — there was never anything to fix");
});

test("runDoctor --fix: Codex hooks land as TOML tables + trusted_hash (a pre-existing [projects.\"…\"] table survives), a missing sessions link is recreated, a 0644 auth.json is fixed to 0600, a hooks refusal is printed verbatim and still fails the run, the sessions symlink is never flagged as stray, and no token ever appears", async (t: TestContext) => {
  const { home, msHome } = base();
  stubHealthyBinaries(); // tmux/claude/codex/security all stubbed healthy
  // ms itself on PATH too (same pattern as the sibling runDoctor tests) —
  // without it, checkPathBinary's own ✗ would join codexbad's hooks line in
  // the failing set and this test's "exactly one failure" assertion below
  // would be proving nothing specific to Codex.
  process.env.MS_BIN = path.join(home, "real-ms");
  writeFileSync(process.env.MS_BIN, "#!/bin/sh\n");
  chmodSync(process.env.MS_BIN, 0o755);
  const { dir: msStubDir } = stubDir();
  symlinkSync(process.env.MS_BIN, path.join(msStubDir, "ms"));
  process.env.PATH = `${msStubDir}:${process.env.PATH}`;
  t.after(() => { delete process.env.MS_BIN; });

  const ACCESS_TOKEN = "SEKRET-CODEX-ACCESS-TOKEN-VALUE";

  // codexok: hooks not yet installed; config.toml already carries a
  // pre-existing [projects."…"] trust row (a launch's own write, Task 7)
  // that the installer must leave untouched; auth.json is 0644 (a
  // permission bug store-permissions should catch and --fix should repair);
  // the account's own sessions symlink does not exist yet.
  const okDir = path.join(msHome, "codex", "codexok");
  mkdirSync(okDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(okDir, "config.toml"), `[projects."/Users/human/work"]\ntrust_level = "trusted"\n`, { mode: 0o600 });
  writeFileSync(
    path.join(okDir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id-codexok", access_token: ACCESS_TOKEN, refresh_token: "rt-codexok", account_id: "acct-codexok" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o644 },
  );

  // codexbad: a 'hooks' table shape the installer refuses to guess about.
  const badDir = path.join(msHome, "codex", "codexbad");
  mkdirSync(badDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(badDir, "config.toml"), `[hooks]\nSessionStart = []\n`, { mode: 0o600 });
  writeFileSync(
    path.join(badDir, "auth.json"),
    JSON.stringify({
      tokens: { id_token: "id-codexbad", access_token: "at-codexbad", refresh_token: "rt-codexbad", account_id: "acct-codexbad" },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );

  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "codexok", provider: "codex", label: "CodexOK", orgId: null, shared: false, identityVerified: true },
        { name: "codexbad", provider: "codex", label: "CodexBad", orgId: null, shared: false, identityVerified: true },
      ],
    }),
    { mode: 0o600 },
  );

  const savedFetch = globalThis.fetch;
  stubCodexUsageOk(); // the usage read itself is not this test's concern
  try {
    const { runDoctor } = await import("../src/doctor.ts");
    const { results, lines, exitCode } = await runDoctor(true);

    // codexbad's refusal keeps the whole run red — and is the ONLY thing
    // wrong: everything else this fixture set up (or --fix repaired) reads
    // ok, so the failing set is exactly that one line, not "1 or more".
    assert.equal(exitCode, 1, lines.join("\n"));
    const failing = results.filter((r) => !r.ok);
    assert.equal(failing.length, 1, JSON.stringify(failing));
    assert.equal(failing[0]!.what, "codex account codexbad: hooks installed");

    // codexok: hooks installed as TOML tables with trusted_hash entries, and
    // the pre-existing [projects."…"] table is untouched.
    const okConfig = readFileSync(path.join(okDir, "config.toml"), "utf8");
    assert.match(okConfig, /\[projects\."\/Users\/human\/work"\]/);
    assert.match(okConfig, /trust_level = "trusted"/);
    for (const table of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      assert.match(okConfig, new RegExp(`\\[\\[hooks\\.${table}\\]\\]`));
    }
    assert.match(okConfig, /trusted_hash = "sha256:[0-9a-f]{64}"/);
    const { codexHooksInstalled } = await import("../src/hooks/codex-install.ts");
    const { msBinary } = await import("../src/paths.ts");
    assert.equal(codexHooksInstalled(okDir, msBinary()), true);
    assert.ok(results.some((r) => r.ok && r.fixed && r.what === "codex account codexok: hooks installed"), JSON.stringify(results));

    // codexok's sessions link was missing and is now recreated, resolving
    // to the shared store.
    const { p } = await import("../src/paths.ts");
    assert.equal(lstatSync(p.codexSessionsLink("codexok")).isSymbolicLink(), true);
    assert.equal(realpathSync(p.codexSessionsLink("codexok")), realpathSync(p.codexSessions()));
    assert.ok(results.some((r) => r.ok && r.fixed && r.what === "codex account codexok: sessions store linked"), JSON.stringify(results));

    // codexok's 0644 auth.json is reported (as a store-permission issue) and
    // fixed to 0600 in the same --fix run.
    assert.equal(statSync(path.join(okDir, "auth.json")).mode & 0o777, 0o600);
    assert.ok(
      results.some((r) => r.ok && r.fixed && r.what === "store permission: codex/codexok/auth.json"),
      JSON.stringify(results),
    );

    // codexbad's refusal is printed VERBATIM — never folded into a generic
    // "nothing to do" — and it is what keeps exitCode at 1.
    const hooksBad = results.find((r) => r.what === "codex account codexbad: hooks installed")!;
    assert.equal(hooksBad.ok, false);
    assert.match(hooksBad.why ?? "", /a 'hooks' table this tool cannot read/);
    assert.ok(lines.some((l) => l.includes("a 'hooks' table this tool cannot read")), lines.join("\n"));

    // Neither account's own `sessions` symlink is ever reported as a stray
    // symlink by the store-permission walk.
    assert.ok(!results.some((r) => r.what.includes("codex/codexok/sessions") || r.what.includes("codex/codexbad/sessions")), JSON.stringify(results));

    // No token text anywhere, in any result or any rendered line.
    const rendered = lines.join("\n");
    assert.ok(!rendered.includes(ACCESS_TOKEN), `token leaked in rendered lines: ${rendered}`);
    for (const r of results) {
      assert.ok(!r.what.includes(ACCESS_TOKEN), `token leaked in what: ${r.what}`);
      assert.ok(!(r.why ?? "").includes(ACCESS_TOKEN), `token leaked in why: ${r.why}`);
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
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
  stub("codex", HEALTHY_CODEX);
  stub("security", "exit 44");

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
