import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome, stubDir, run } from "./helpers.ts";
import { installStatusline, removeStatusline } from "../src/setup/statusline.ts";
import { installAlias, removeAlias, rcPathFor } from "../src/setup/alias.ts";

const MS = "/opt/homebrew/bin/ms";

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
  assert.match(path.basename(first.backup!), /^settings\.json\.bak-ms-\d+$/);
  assert.equal(readFileSync(first.backup!, "utf8"), text, "the backup is the original, byte for byte");

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.model, "opusplan");
  assert.deepEqual(after.enabledPlugins, original.enabledPlugins);
  assert.deepEqual(after.permissions, original.permissions);
  assert.equal(after.statusLine.command, `${MS} _statusline`);
  assert.equal(after.statusLine.type, "command");

  // idempotent: a second install for the same binary changes nothing
  const second = installStatusline(file, MS);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(after, null, 2) + "\n");
});

test("install wraps an existing statusLine.command and keeps its other keys", () => {
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
  assert.equal(after.statusLine.command, `${MS} _statusline -- ~/.claude/statusline.sh`);
  assert.equal(after.statusLine.type, "command", "the pre-existing type is kept, not reset");
  assert.equal(after.statusLine.padding, 0, "other statusLine keys survive");
  assert.equal(after.model, "opusplan");

  // idempotent
  const second = installStatusline(file, MS);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
});

test("removeStatusline restores the wrapped original command and only that key", () => {
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
  assert.match(path.basename(r.backup!), /^settings\.json\.bak-ms-\d+$/);

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after, original, "round trip is exact: every key restored");
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

test("removeStatusline on a file with no wrapper is a no-op", () => {
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
  assert.deepEqual(Object.keys(after), ["statusLine"]);
  assert.equal(after.statusLine.command, `${MS} _statusline`);
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

test("a different ms binary wraps again rather than treating the file as already installed", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(file, JSON.stringify({ model: "opusplan" }, null, 2));
  installStatusline(file, MS);
  const other = "/usr/local/bin/ms";
  const r = installStatusline(file, other);
  assert.equal(r.changed, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.statusLine.command, `${other} _statusline -- ${MS} _statusline`);
});

// --- ms _statusline (the runtime wrapper) -----------------------------------

test("the wrapper prints the badge before the wrapped command's output and passes stdin through", () => {
  const env = stubDir();
  const execPath = stubReady(env, "echoer", `cat`);
  const r = run(["_statusline", "--", execPath], { MS_ACCOUNT: "gmail" }, "hello from claude code\n");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "[gmail] hello from claude code\n");
});

test("no badge when MS_ACCOUNT is unset", () => {
  const env = stubDir();
  const execPath = stubReady(env, "echoer", `cat`);
  const r = run(["_statusline", "--", execPath], {}, "plain output\n");
  assert.equal(r.stdout, "plain output\n");
});

test("with no wrapped command, the wrapper prints only the badge (or nothing) and exits 0", () => {
  const r1 = run(["_statusline"], { MS_ACCOUNT: "work" }, "");
  assert.equal(r1.code, 0);
  assert.equal(r1.stdout, "[work] ");

  const r2 = run(["_statusline"], {}, "");
  assert.equal(r2.code, 0);
  assert.equal(r2.stdout, "");
});

test("exits 0 and still prints whatever the wrapped command wrote, even when it fails", () => {
  const env = stubDir();
  const execPath = stubReady(env, "failer", `echo "partial output"\nexit 3`);
  const r = run(["_statusline", "--", execPath], { MS_ACCOUNT: "gmail" }, "");
  assert.equal(r.code, 0, "a failing wrapped command never breaks the statusline's own exit code");
  assert.equal(r.stdout, "[gmail] partial output\n");
});

test("exits 0 within a few seconds even when the wrapped command hangs", () => {
  const env = stubDir();
  const execPath = stubReady(env, "hanger", `sleep 30`);
  const start = Date.now();
  const r = run(["_statusline", "--", execPath], { MS_ACCOUNT: "gmail" }, "");
  const elapsed = Date.now() - start;
  assert.equal(r.code, 0);
  assert.ok(elapsed < 4_000, `expected the wrapper to give up well before 30s, took ${elapsed}ms`);
  assert.equal(r.stdout, "[gmail] ", "the hung command produced no output before it was killed");
});

test("a wrapped command that cannot be spawned still exits 0 with just the badge", () => {
  const r = run(["_statusline", "--", "/no/such/binary-at-all"], { MS_ACCOUNT: "gmail" }, "");
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
  assert.ok(text.includes(`alias claude='${MS} claude'`));
  assert.ok(text.includes(`alias codex='${MS} codex'`));
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
  assert.match(path.basename(first.backup!), /^\.zshrc\.bak-ms-\d+$/);
  assert.equal(readFileSync(first.backup!, "utf8"), original, "the backup is the original, byte for byte");

  const afterFirst = readFileSync(rc, "utf8");
  assert.ok(afterFirst.includes('export PATH="$HOME/bin:$PATH"'));
  assert.ok(afterFirst.includes('alias ll="ls -la"'));
  assert.ok(afterFirst.includes(`alias claude='${MS} claude'`));

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
  assert.ok(text.includes(`alias claude='${other} claude'`));
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
