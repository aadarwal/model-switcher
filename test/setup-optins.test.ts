import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome, stubDir, run } from "./helpers.ts";
import { installStatusline, removeStatusline } from "../src/setup/statusline.ts";
import { installAlias, removeAlias, rcPathFor } from "../src/setup/alias.ts";
import { shellQuote } from "../src/fsx.ts";

const MS = "/opt/homebrew/bin/ms";

/** The exact TEXT of one alias line `installAlias` writes: `msBin` quoted as
 *  its own shell word inside the value, then the whole `<bin> <name>`
 *  command quoted again for the rc file — a shell re-parses an alias's body
 *  every time it is USED, after the outer layer has already been stripped
 *  by the rc file's own parse. */
const aliasLine = (name: "claude" | "codex", bin: string) => `alias ${name}=${shellQuote(`${shellQuote(bin)} ${name}`)}`;

/** The exact block `installAlias` writes, as a plain string, so a test can
 *  place it anywhere in a fixture file rather than only where install put it. */
const installBlock = (bin: string) => ["# ms-alias-begin", aliasLine("claude", bin), aliasLine("codex", bin), "# ms-alias-end"].join("\n");

/**
 * A brand-new executable's first-ever exec on this machine can take several
 * seconds — a one-time OS-level check on the file, unrelated to anything
 * this tool does — which would otherwise blow the 3s budgets under test
 * before our own code gets a chance to run. `stub()` writes `name`'s real
 * body, but this pays that one-time tax on a throwaway `true` at the same
 * path FIRST (the check is keyed by path, not content, so it stays paid once
 * the real body is written over it), so the timed assertions below measure
 * `ms _statusline`'s own behaviour, not the filesystem's.
 */
function stubReady(env: { dir: string; stub: (name: string, body: string) => void }, name: string, body: string): string {
  const execPath = path.join(env.dir, name);
  env.stub(name, "true");
  spawnSync(execPath, [], { timeout: 15_000 });
  env.stub(name, body);
  return execPath;
}

// --- installStatusline / removeStatusline ----------------------------------

test("install merges statusLine.command and preserves every other key, with no prior statusLine", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const original = {
    model: "opusplan",
    enabledPlugins: { "anu@anu-marketplace": true },
    permissions: { allow: ["Bash(npm test)"] },
  };
  const text = JSON.stringify(original, null, 2);
  writeFileSync(file, text);

  const first = installStatusline(file, MS);
  assert.equal(first.changed, true);
  assert.ok(first.backup);
  // Milliseconds, plus a `-N` counter when even that name is taken (fix wave
  // B-M2). Unix SECONDS meant three re-points inside one second left ONE
  // backup file — a backup that overwrites the previous backup is not one.
  assert.match(path.basename(first.backup!), /^settings\.json\.bak-ms-\d+(-\d+)?$/);
  assert.equal(readFileSync(first.backup!, "utf8"), text, "the backup is the original, byte for byte");

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.model, "opusplan");
  assert.deepEqual(after.enabledPlugins, original.enabledPlugins);
  assert.deepEqual(after.permissions, original.permissions);
  assert.equal(after.statusLine.command, `'${MS}' _statusline`);
  assert.equal(after.statusLine.type, "command");
  assert.equal(after.statusLine.msOriginal, "", "the marker for 'there was nothing to preserve'");

  // idempotent: a second install for the same binary changes nothing
  const second = installStatusline(file, MS);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(after, null, 2) + "\n");
});

test("install captures an existing statusLine.command into msOriginal and keeps other keys", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const original = {
    model: "opusplan",
    statusLine: { type: "command", command: "~/.claude/statusline.sh", padding: 0 },
  };
  writeFileSync(file, JSON.stringify(original, null, 2));

  const r = installStatusline(file, MS);
  assert.equal(r.changed, true);
  assert.ok(r.backup);

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.statusLine.command, `'${MS}' _statusline`);
  assert.equal(after.statusLine.msOriginal, "~/.claude/statusline.sh", "the human's command is captured verbatim");
  assert.equal(after.statusLine.type, "command", "the pre-existing type is kept, not reset");
  assert.equal(after.statusLine.padding, 0, "other statusLine keys survive");
  assert.equal(after.model, "opusplan");

  // idempotent
  const second = installStatusline(file, MS);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
});

test("removeStatusline restores the original command and only that key", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const original = {
    model: "opusplan",
    statusLine: { type: "command", command: "~/.claude/statusline.sh", padding: 0 },
    permissions: { allow: ["Bash(npm test)"] },
  };
  const text = JSON.stringify(original, null, 2);
  writeFileSync(file, text);

  installStatusline(file, MS);
  const r = removeStatusline(file);
  assert.equal(r.changed, true);
  assert.ok(r.backup);
  assert.match(path.basename(r.backup!), /^settings\.json\.bak-ms-\d+(-\d+)?$/);

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after, original, "round trip is exact: every key restored, msOriginal dropped");
});

test("removeStatusline deletes statusLine entirely when install had nothing to wrap", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const original = { model: "opusplan", permissions: { allow: ["Bash(npm test)"] } };
  writeFileSync(file, JSON.stringify(original, null, 2));

  installStatusline(file, MS);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).statusLine);

  const r = removeStatusline(file);
  assert.equal(r.changed, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after, original, "statusLine is gone, everything else restored exactly");
});

test("removeStatusline on a file with no msOriginal is a no-op — 'ours' is the key, never the command text", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const original = { model: "opusplan" };
  writeFileSync(file, JSON.stringify(original, null, 2));
  const r = removeStatusline(file);
  assert.equal(r.changed, false);
  assert.equal(r.backup, null);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original);
});

test("a missing settings file is created with just statusLine, and no backup", () => {
  const { home } = tempHome();
  const file = path.join(home, "nested", "settings.json");
  const r = installStatusline(file, MS);
  assert.equal(r.changed, true);
  assert.equal(r.backup, null);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(after).sort(), ["statusLine"]);
  assert.equal(after.statusLine.command, `'${MS}' _statusline`);
  assert.equal(after.statusLine.msOriginal, "");
});

test("a settings.json that cannot be parsed is refused via a problem, never thrown, never overwritten", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(file, "{ not json,");

  const r = installStatusline(file, MS);
  assert.equal(r.changed, false);
  assert.equal(r.backup, null);
  assert.match(r.problem!, /settings/i);
  assert.equal(readFileSync(file, "utf8"), "{ not json,");

  const rr = removeStatusline(file);
  assert.equal(rr.changed, false);
  assert.match(rr.problem!, /settings/i);
});

test("fix round 2: a re-install with a new msBin only rewrites command — msOriginal is untouched, never nested", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(file, JSON.stringify({ statusLine: { command: "~/.claude/statusline.sh" } }, null, 2));

  installStatusline(file, MS);
  const other = "/usr/local/bin/ms";
  const r = installStatusline(file, other);
  assert.equal(r.changed, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  // Short and clean — never `'<other>' _statusline -- '<MS>' _statusline` or
  // any other trace of the intermediate binary.
  assert.equal(after.statusLine.command, `'${other}' _statusline`);
  assert.equal(after.statusLine.msOriginal, "~/.claude/statusline.sh", "still the ORIGINAL human command, from the very first install");

  // A third binary changes nothing about that: still the same msOriginal.
  const third = "/opt/homebrew/bin/ms-new";
  installStatusline(file, third);
  const after2 = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after2.statusLine.command, `'${third}' _statusline`);
  assert.equal(after2.statusLine.msOriginal, "~/.claude/statusline.sh");

  // And removal, however many binaries this ran between, restores the TRUE
  // original — not whatever the second-to-last install happened to write.
  const rr = removeStatusline(file);
  assert.equal(rr.changed, true);
  const restored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(restored.statusLine.command, "~/.claude/statusline.sh");
  assert.equal(restored.statusLine.msOriginal, undefined);
});

test("fix round 2: a human's own command that happens to end in '_statusline' survives byte-identically", () => {
  // The old text-parsing detection would have read this as an already
  // present wrapper (it matches `<something> _statusline` literally) and
  // silently discarded it instead of preserving it. Detection is now purely
  // the `msOriginal` key's presence, so this is an ordinary pre-existing
  // command like any other.
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const humanCommand = "/opt/mytool/mytool _statusline";
  writeFileSync(file, JSON.stringify({ statusLine: { command: humanCommand } }, null, 2));

  const r = installStatusline(file, MS);
  assert.equal(r.changed, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.statusLine.command, `'${MS}' _statusline`);
  assert.equal(after.statusLine.msOriginal, humanCommand, "captured verbatim, not parsed as if it were already ours");

  const rr = removeStatusline(file);
  assert.equal(rr.changed, true);
  const restored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(restored.statusLine.command, humanCommand, "byte-identical to the human's original");
  assert.equal("msOriginal" in restored.statusLine, false);
});

test("fix round 2: an older wrapper whose msBin path contains a space is REPLACED, not nested", () => {
  // Simulates a `statusLine.command` an OLDER version of this tool left
  // behind (before `msOriginal` existed), whose binary path has a space in
  // it — the exact shape that broke the old regex-based unwrap (`\S+` could
  // not tell the binary's own space from the `-- ` separator). Since
  // ownership is no longer read from the command text at all, this is just
  // an opaque pre-existing string: captured whole into `msOriginal`,
  // replaced whole by the new clean wrapper.
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const staleWrapper = "'/opt/my tool/ms' _statusline -- ~/.claude/statusline.sh";
  writeFileSync(file, JSON.stringify({ statusLine: { command: staleWrapper } }, null, 2));

  const newBin = "/opt/homebrew/bin/ms";
  const r = installStatusline(file, newBin);
  assert.equal(r.changed, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  // Clean and short — not `'<newBin>' _statusline -- '/opt/my tool/ms' _statusline -- ...`
  assert.equal(after.statusLine.command, `'${newBin}' _statusline`);
  assert.equal(after.statusLine.msOriginal, staleWrapper, "the whole stale string, opaque, never re-parsed");
});

// --- ms _statusline (the runtime wrapper) -----------------------------------
//
// Fix round 2 dropped the `-- <cmd>` argv form: the wrapper takes no
// arguments and instead reads `statusLine.msOriginal` back out of the
// settings file at runtime, resolved via `$CLAUDE_CONFIG_DIR` (Claude Code's
// own override) — which is also how these tests point it at a fixture
// without ever touching the real `~/.claude/settings.json`. Every test below
// sets `CLAUDE_CONFIG_DIR` explicitly, even the "nothing to run" ones, so
// none of them can accidentally read (or depend on) whatever the developer
// running this suite actually has installed for real.

/** A fresh `$CLAUDE_CONFIG_DIR` whose `settings.json` carries `msOriginal`
 * (the command the wrapper should run — or `""`/omitted for "nothing"). */
function configDirWith(dir: string, msOriginal?: string): void {
  const statusLine: Record<string, unknown> = { type: "command", command: "irrelevant at runtime — only msOriginal is read" };
  if (msOriginal !== undefined) statusLine.msOriginal = msOriginal;
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ statusLine }, null, 2));
}

/**
 * `ms _statusline` bounds the wrapped command to `MS_STATUSLINE_TIMEOUT_MS`
 * (production default 3s — `src/setup/statusline.ts`'s `wrappedTimeoutMs`).
 * Tests below that are NOT exercising that bound (they run a command that
 * finishes on its own — a fast echo, a shell's instant "command not found")
 * pass this generous override instead of relying on the production default:
 * under a loaded machine, with a thousand-plus other tests each spawning
 * their own processes, even a trivial `echo`'s fork+exec can occasionally
 * take longer than 3s of real wall-clock time to be scheduled and complete
 * — racing the wrapper's own internal kill and truncating output that was
 * never slow, only delayed. The command itself still completes in
 * milliseconds; this just removes the coincidence with an unrelated timer.
 * Only the one test that actually means to prove the kill (`hangs`, below)
 * sets a small bound instead.
 */
const GENEROUS_TIMEOUT_ENV = { MS_STATUSLINE_TIMEOUT_MS: "15000" };

test("the wrapper prints the badge before the wrapped command's output and passes stdin through", () => {
  const env = stubDir();
  const execPath = stubReady(env, "echoer", `cat`);
  configDirWith(env.dir, execPath);
  const r = run(["_statusline"], { MS_ACCOUNT: "gmail", CLAUDE_CONFIG_DIR: env.dir }, "hello from claude code\n");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "[gmail] hello from claude code\n");
});

test("no badge when MS_ACCOUNT is unset", () => {
  const env = stubDir();
  const execPath = stubReady(env, "echoer", `cat`);
  configDirWith(env.dir, execPath);
  const r = run(["_statusline"], { CLAUDE_CONFIG_DIR: env.dir }, "plain output\n");
  assert.equal(r.stdout, "plain output\n");
});

test("reads the original command from the settings file, not from argv — the old '--' form has no effect any more", () => {
  const env = stubDir();
  const execPath = stubReady(env, "echoer", `echo "from the file"`);
  configDirWith(env.dir, execPath);
  // Passing an old-style `-- <cmd>` alongside a real fixture proves argv is
  // simply ignored: the output comes from the FILE's command, never argv's.
  const other = stubDir();
  const otherExec = stubReady(other, "other", `echo "from argv, should never run"`);
  const r = run(["_statusline", "--", otherExec], { MS_ACCOUNT: "gmail", CLAUDE_CONFIG_DIR: env.dir, ...GENEROUS_TIMEOUT_ENV }, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "[gmail] from the file\n");
});

test("with nothing to run (no settings file, or msOriginal is ''), the wrapper prints only the badge and exits 0", () => {
  const empty = stubDir(); // an empty CLAUDE_CONFIG_DIR — no settings.json at all
  const r1 = run(["_statusline"], { MS_ACCOUNT: "work", CLAUDE_CONFIG_DIR: empty.dir }, "");
  assert.equal(r1.code, 0);
  assert.equal(r1.stdout, "[work] ");

  const withEmptyOriginal = stubDir();
  configDirWith(withEmptyOriginal.dir, "");
  const r2 = run(["_statusline"], { CLAUDE_CONFIG_DIR: withEmptyOriginal.dir }, "");
  assert.equal(r2.code, 0);
  assert.equal(r2.stdout, "");
});

test("exits 0 and still prints whatever the wrapped command wrote, even when it fails", () => {
  const env = stubDir();
  const execPath = stubReady(env, "failer", `echo "partial output"\nexit 3`);
  configDirWith(env.dir, execPath);
  const r = run(["_statusline"], { MS_ACCOUNT: "gmail", CLAUDE_CONFIG_DIR: env.dir, ...GENEROUS_TIMEOUT_ENV }, "");
  assert.equal(r.code, 0, "a failing wrapped command never breaks the statusline's own exit code");
  assert.equal(r.stdout, "[gmail] partial output\n");
});

test("exits 0 within a few seconds even when the wrapped command hangs", () => {
  const env = stubDir();
  const execPath = stubReady(env, "hanger", `sleep 30`);
  configDirWith(env.dir, execPath);
  // A tight, injected bound (`MS_STATUSLINE_TIMEOUT_MS`, read by
  // `wrappedTimeoutMs` in src/setup/statusline.ts) rather than production's
  // 3s default: what this test proves is that the wrapper gives up at ITS
  // OWN bound instead of waiting for the full 30s hang, not that it does so
  // within some wall-clock number of seconds picked to comfortably clear a
  // healthy machine's overhead. A loaded machine — 1100 other tests each
  // spawning their own `node`+`tsx` processes — can make `node --import tsx
  // bin/ms` itself take real, if unpredictable, wall-clock time to start and
  // run, on top of whatever the wrapper's own bound adds; a 200ms bound
  // keeps that internal contribution negligible, and the ceiling below
  // leaves generous room for the startup overhead while staying an order of
  // magnitude short of the 30s hang, so this still fails loudly if the kill
  // itself stops working.
  const boundMs = 200;
  const start = Date.now();
  const r = run(["_statusline"], { MS_ACCOUNT: "gmail", CLAUDE_CONFIG_DIR: env.dir, MS_STATUSLINE_TIMEOUT_MS: String(boundMs) }, "");
  const elapsed = Date.now() - start;
  assert.equal(r.code, 0);
  assert.ok(elapsed < 20_000, `expected the wrapper to give up at its ${boundMs}ms bound, well short of the 30s hang, took ${elapsed}ms`);
  assert.equal(r.stdout, "[gmail] ", "the hung command produced no output before it was killed");
});

test("output already written before the bound hits is captured, not lost to the kill that follows it", () => {
  // `MS_STATUSLINE_TIMEOUT_MS` being injectable (above) makes this provable
  // in well under a second — previously exercising the kill path at all
  // meant waiting out the full 3s production bound. `runWrapped` used to
  // `destroy()` the stdout stream in the same tick it sent SIGKILL, which
  // risks dropping bytes the child had already written but Node's event
  // loop had not yet delivered as a `data` event; it now kills first and
  // lets the stream drain through the ordinary `close` path (fast, once
  // every process in the group is dead) before resolving. This asserts the
  // resulting behaviour: legitimate prior output survives a kill for
  // hanging, it is not wiped out along with it.
  const env = stubDir();
  const execPath = stubReady(env, "writer-then-hang", `printf 'wrote this before the kill'; sleep 30`);
  configDirWith(env.dir, execPath);
  const r = run(["_statusline"], { MS_ACCOUNT: "gmail", CLAUDE_CONFIG_DIR: env.dir, MS_STATUSLINE_TIMEOUT_MS: "150" }, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "[gmail] wrote this before the kill");
});

test("the process-group kill also reaches a grandchild the wrapped command backgrounded", () => {
  const env = stubDir();
  const marker = path.join(env.dir, "grandchild-pid");
  // `sleep 30` is backgrounded (`&`), so the shell records its pid and moves
  // straight on to `cat`, which returns almost immediately on empty stdin —
  // this whole `sh` exits fast, well inside the 3s budget, via the NORMAL
  // close path, not the timeout. The backgrounded sleep is left running,
  // sharing the same process group `detached: true` gave `sh`, unless the
  // process-group kill on every finish path reaches it too. `msOriginal` is
  // run through a shell already (`/bin/sh -c <msOriginal>`), so this can be
  // the raw shell snippet directly — no need to spell out `/bin/sh -c` here.
  configDirWith(env.dir, `sleep 30 & echo $! > '${marker}'; cat`);
  const r = run(["_statusline"], { MS_ACCOUNT: "gmail", CLAUDE_CONFIG_DIR: env.dir }, "");
  assert.equal(r.code, 0);
  assert.ok(existsSync(marker), "the script had time to record the backgrounded sleep's pid before it exited");
  const pid = Number(readFileSync(marker, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `expected a real pid, got ${JSON.stringify(readFileSync(marker, "utf8"))}`);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the grandchild must be gone, not merely orphaned and still sleeping");
});

test("a wrapped command that does not exist still exits 0 with just the badge (the shell's own error, discarded)", () => {
  const env = stubDir();
  configDirWith(env.dir, "/no/such/binary-at-all");
  const r = run(["_statusline"], { MS_ACCOUNT: "gmail", CLAUDE_CONFIG_DIR: env.dir, ...GENEROUS_TIMEOUT_ENV }, "");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "[gmail] ");
});

// --- installAlias / removeAlias ---------------------------------------------

test("installAlias creates a missing rc file at 0644 with the alias block, no backup", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const r = installAlias(rc, MS);
  assert.equal(r.changed, true);
  assert.equal(r.backup, null);
  assert.equal(statSync(rc).mode & 0o777, 0o644);
  const text = readFileSync(rc, "utf8");
  assert.ok(text.includes("# ms-alias-begin"));
  assert.ok(text.includes(aliasLine("claude", MS)));
  assert.ok(text.includes(aliasLine("codex", MS)));
  assert.ok(text.includes("# ms-alias-end"));
});

test("installAlias appends to existing rc content, backs it up, and is idempotent", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const original = ['export PATH="$HOME/bin:$PATH"', 'alias ll="ls -la"', ""].join("\n");
  writeFileSync(rc, original);

  const first = installAlias(rc, MS);
  assert.equal(first.changed, true);
  assert.ok(first.backup);
  assert.match(path.basename(first.backup!), /^\.zshrc\.bak-ms-\d+(-\d+)?$/);
  assert.equal(readFileSync(first.backup!, "utf8"), original, "the backup is the original, byte for byte");

  const afterFirst = readFileSync(rc, "utf8");
  assert.ok(afterFirst.includes('export PATH="$HOME/bin:$PATH"'));
  assert.ok(afterFirst.includes('alias ll="ls -la"'));
  assert.ok(afterFirst.includes(aliasLine("claude", MS)));

  const backupsAfterFirst = readdirSync(home).filter((f) => f.startsWith(".zshrc.bak-ms-")).length;
  const second = installAlias(rc, MS);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(readFileSync(rc, "utf8"), afterFirst, "an unchanged install never rewrites the file");
  assert.equal(readdirSync(home).filter((f) => f.startsWith(".zshrc.bak-ms-")).length, backupsAfterFirst);
});

test("removeAlias leaves the rest of the file byte-identical to before install", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const original = ['export PATH="$HOME/bin:$PATH"', 'alias ll="ls -la"', ""].join("\n");
  writeFileSync(rc, original);

  installAlias(rc, MS);
  const r = removeAlias(rc);
  assert.equal(r.changed, true);
  assert.ok(r.backup);
  assert.equal(readFileSync(rc, "utf8"), original, "removal restores the original bytes exactly");
});

test("installAlias/removeAlias round-trip a file with NO trailing newline byte-identically", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const original = 'export FOO="bar"'; // deliberately no trailing \n
  writeFileSync(rc, original);

  installAlias(rc, MS);
  const installed = readFileSync(rc, "utf8");
  assert.ok(installed.includes(aliasLine("claude", MS)));

  const r = removeAlias(rc);
  assert.equal(r.changed, true);
  assert.equal(readFileSync(rc, "utf8"), original, "the missing trailing newline is remembered and restored exactly");

  // Same property with content AFTER the block too (not just before).
  const withSuffix = 'export FOO="bar"\n# a trailing comment, no newline at the very end';
  writeFileSync(rc, withSuffix);
  installAlias(rc, MS);
  removeAlias(rc);
  assert.equal(readFileSync(rc, "utf8"), withSuffix);
});

test("removeAlias refuses a hand-edited block rather than deleting it", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  installAlias(rc, MS);
  const installed = readFileSync(rc, "utf8");

  // A human added a third line inside the markers.
  const handEdited = installed.replace("# ms-alias-end", "alias foo='bar'\n# ms-alias-end");
  writeFileSync(rc, handEdited);
  const r = removeAlias(rc);
  assert.equal(r.changed, false);
  assert.equal(r.backup, null);
  assert.match(r.problem!, /hand-edited/);
  assert.equal(readFileSync(rc, "utf8"), handEdited, "untouched");

  // A human renamed one of the two aliases.
  writeFileSync(rc, installed.replace(aliasLine("codex", MS), aliasLine("codex", MS).replace(/^alias codex=/, "alias c=")));
  const r2 = removeAlias(rc);
  assert.equal(r2.changed, false);
  assert.match(r2.problem!, /hand-edited/);

  // The two alias lines point at DIFFERENT binaries — also not ours to trust.
  writeFileSync(rc, installed.replace(aliasLine("codex", MS), aliasLine("codex", "/usr/local/bin/ms")));
  const r3 = removeAlias(rc);
  assert.equal(r3.changed, false);
  assert.match(r3.problem!, /hand-edited/);

  // Fix wave B-I3: install refuses a hand-edited block too. It used to
  // replace one silently, which is the same destruction removal refuses —
  // "refuses a block it does not recognise as its own" is not a rule that
  // only applies on the way out.
  writeFileSync(rc, handEdited);
  const r4 = installAlias(rc, "/usr/local/bin/ms");
  assert.equal(r4.changed, false);
  assert.equal(r4.backup, null);
  assert.match(r4.problem!, /hand-edited/);
  assert.match(r4.problem!, /# ms-alias-begin/);
  assert.match(r4.problem!, new RegExp(rc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readFileSync(rc, "utf8"), handEdited, "untouched");
});

test("B-I2: removing a block from the MIDDLE of a file keeps exactly one newline where it was", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const original = "export A=1\nsource ~/.fzf.zsh\n";
  writeFileSync(rc, original);
  installAlias(rc, MS);

  // Ordinary rc hygiene: the human moves our block up, above their own
  // sourcing line. `stripSep` used to eat the single newline that separated
  // the two surrounding lines, welding them into `export A=1source …`.
  const moved = ["export A=1", installBlock(MS), "source ~/.fzf.zsh", ""].join("\n");
  writeFileSync(rc, moved);

  const r = removeAlias(rc);
  assert.equal(r.changed, true);
  assert.ok(r.backup);
  assert.equal(readFileSync(rc, "utf8"), original, "byte for byte: one newline where the block was");
});

test("B-I2: a mid-file block is re-pointed in place, and removed from there cleanly", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const other = "/usr/local/bin/ms";
  const original = "export A=1\nexport B=2\n";
  writeFileSync(rc, ["export A=1", installBlock(MS), "export B=2", ""].join("\n"));

  const r = installAlias(rc, other);
  assert.equal(r.changed, true);
  const text = readFileSync(rc, "utf8");
  assert.equal(text, ["export A=1", installBlock(other), "export B=2", ""].join("\n"), text);

  assert.equal(removeAlias(rc).changed, true);
  assert.equal(readFileSync(rc, "utf8"), original);
});

test("B-M4: two ms blocks are refused by BOTH install and removal, naming the file", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const doubled = ["export A=1", installBlock(MS), "export B=2", installBlock("/usr/local/bin/ms"), ""].join("\n");
  writeFileSync(rc, doubled);

  const r = installAlias(rc, MS);
  assert.equal(r.changed, false);
  assert.equal(r.backup, null);
  assert.match(r.problem!, /more than one/);
  assert.match(r.problem!, new RegExp(rc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(readFileSync(rc, "utf8"), doubled, "untouched");

  const rr = removeAlias(rc);
  assert.equal(rr.changed, false);
  assert.equal(rr.backup, null);
  assert.match(rr.problem!, /more than one/);
  assert.equal(readFileSync(rc, "utf8"), doubled, "untouched — never manage only the first");
});

test("B-M3: removeStatusline keeps the human's other statusLine keys when there was no command to restore", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  // A statusLine the human configured with no `command` of their own.
  writeFileSync(file, JSON.stringify({ model: "opusplan", statusLine: { type: "command", padding: 0 } }, null, 2));

  const i = installStatusline(file, MS);
  assert.equal(i.changed, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).statusLine.msOriginal, "");

  const r = removeStatusline(file);
  assert.equal(r.changed, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.model, "opusplan");
  assert.deepEqual(after.statusLine, { type: "command", padding: 0 }, "their own keys survive; only ours are removed");
});

test("removeAlias on a file with no block is a no-op", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const original = 'export FOO="bar"\n';
  writeFileSync(rc, original);
  const r = removeAlias(rc);
  assert.equal(r.changed, false);
  assert.equal(r.backup, null);
  assert.equal(readFileSync(rc, "utf8"), original);
});

test("removeAlias on a missing file is a no-op", () => {
  const { home } = tempHome();
  const r = removeAlias(path.join(home, ".zshrc"));
  assert.equal(r.changed, false);
  assert.equal(r.backup, null);
});

test("re-installing for a different binary replaces the block rather than stacking one", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  installAlias(rc, MS);
  const other = "/usr/local/bin/ms";
  const r = installAlias(rc, other);
  assert.equal(r.changed, true);
  const text = readFileSync(rc, "utf8");
  assert.equal(text.match(/# ms-alias-begin/g)?.length, 1, "one block, not two");
  assert.ok(!text.includes(MS), "the old binary's alias lines are gone");
  assert.ok(text.includes(aliasLine("claude", other)));
});

test("an alias begin marker with no end is refused, never used to truncate the file", () => {
  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  const before = ["export FOO=bar", "# ms-alias-begin", "alias claude='stale claude'", "", "export BAR=baz", ""].join("\n");
  writeFileSync(rc, before);

  const r = installAlias(rc, MS);
  assert.equal(r.changed, false);
  assert.match(r.problem!, /no '# ms-alias-end'/);
  assert.equal(readFileSync(rc, "utf8"), before, "untouched");

  const rr = removeAlias(rc);
  assert.equal(rr.changed, false);
  assert.match(rr.problem!, /no '# ms-alias-end'/);
  assert.equal(readFileSync(rc, "utf8"), before);
});

// --- rcPathFor ----------------------------------------------------------------

test("rcPathFor: zsh always gets .zshrc", () => {
  const { home } = tempHome();
  assert.equal(rcPathFor("zsh", home), path.join(home, ".zshrc"));
});

test("rcPathFor: bash prefers an existing .bash_profile, else falls back to .bashrc", () => {
  const { home } = tempHome();
  assert.equal(rcPathFor("bash", home), path.join(home, ".bashrc"), "no .bash_profile yet");
  writeFileSync(path.join(home, ".bash_profile"), "");
  assert.equal(rcPathFor("bash", home), path.join(home, ".bash_profile"), "now it exists, and wins");
});

test("rcPathFor: an unknown shell (e.g. fish) is refused with null", () => {
  const { home } = tempHome();
  assert.equal(rcPathFor("fish", home), null);
  assert.equal(rcPathFor("tcsh", home), null);
});

test("rcPathFor: accepts a full $SHELL path, not just the bare name", () => {
  const { home } = tempHome();
  assert.equal(rcPathFor("/bin/zsh", home), path.join(home, ".zshrc"));
  assert.equal(rcPathFor("/bin/bash", home), path.join(home, ".bashrc"), "no .bash_profile yet");
  writeFileSync(path.join(home, ".bash_profile"), "");
  assert.equal(rcPathFor("/bin/bash", home), path.join(home, ".bash_profile"));
  assert.equal(rcPathFor("/opt/homebrew/bin/fish", home), null);
});
