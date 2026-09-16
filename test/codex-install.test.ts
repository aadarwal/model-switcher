import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import { codexHookTables, codexHooksInstalled, codexTrustedHash, installCodexHooks } from "../src/hooks/codex-install.ts";

const MS = "/opt/homebrew/bin/ms";
const CMD = `${MS} _hook codex`;
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;
const SNAKE: Record<string, string> = { SessionStart: "session_start", UserPromptSubmit: "user_prompt_submit", Stop: "stop", SessionEnd: "session_end" };
const TIMEOUT: Record<string, number> = { SessionStart: 600, UserPromptSubmit: 600, Stop: 600, SessionEnd: 1 };

function home(): string {
  const { home: h } = tempHome();
  const d = path.join(h, ".codex");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
const config = (d: string) => path.join(d, "config.toml");
const read = (d: string) => readFileSync(config(d), "utf8");

test("codexTrustedHash is the VERIFIED recipe, byte for byte", () => {
  // The spike record's Addendum: sha256 of the compact, recursively key-sorted
  // JSON of the hook, no trailing newline, with a `sha256:` prefix. Written out
  // in full here so a change to the serialisation cannot quietly pass by being
  // compared against itself.
  const canonical = `{"event_name":"session_start","hooks":[{"async":false,"command":"echo ok","timeout":600,"type":"command"}]}`;
  assert.equal(codexTrustedHash("session_start", "echo ok", 600), `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`);
  assert.match(codexTrustedHash("session_start", "echo ok", 600), /^sha256:[0-9a-f]{64}$/);
  // The timeout and the event name are both inside the hash: SessionEnd's 1 s
  // is a different hook from a 600 s one, and Codex would refuse it.
  assert.notEqual(codexTrustedHash("session_end", "echo ok", 1), codexTrustedHash("session_end", "echo ok", 600));
  assert.notEqual(codexTrustedHash("stop", "echo ok", 600), codexTrustedHash("session_start", "echo ok", 600));
});

test("codexHookTables writes the four events as array-of-tables with one command hook each", () => {
  const toml = codexHookTables(MS);
  for (const ev of EVENTS) {
    assert.ok(toml.includes(`[[hooks.${ev}]]`), ev);
  }
  assert.equal(toml.match(/hooks = \[\{ type = "command", command = "\/opt\/homebrew\/bin\/ms _hook codex" \}\]/g)?.length, 4);
  // No `timeout` key: leaving it out is what makes Codex apply the defaults
  // the trusted hash is computed against.
  assert.ok(!toml.includes("timeout"), "the tables carry no timeout of their own");
});

test("a fresh install creates config.toml at 0600 with the tables and a trust entry for each", () => {
  const d = home();
  const r = installCodexHooks(d, MS);
  assert.equal(r.changed, true);
  assert.equal(r.backup, null, "there was nothing to back up");
  assert.equal(statSync(config(d)).mode & 0o777, 0o600);

  const text = read(d);
  for (const ev of EVENTS) {
    assert.ok(text.includes(`[[hooks.${ev}]]`), `${ev} table`);
    const key = `${config(d)}:${SNAKE[ev]}:0:0`;
    assert.ok(text.includes(`[hooks.state."${key}"]`), `${ev} trust key`);
    assert.ok(text.includes(`trusted_hash = "${codexTrustedHash(SNAKE[ev], CMD, TIMEOUT[ev])}"`), `${ev} trusted hash`);
  }
  assert.equal(codexHooksInstalled(d, MS), true);
});

test("an existing config keeps every other table byte for byte, and is backed up first", () => {
  const d = home();
  const original = [
    "model = \"gpt-5-codex\"",
    "approval_policy = \"never\"",
    "",
    "[projects.\"/Users/a/src/app\"]",
    "trust_level = \"trusted\"",
    "",
    "[mcp_servers.anu]",
    "command = \"anu-mcp\"",
    "args = [\"serve\"]",
    "",
  ].join("\n");
  writeFileSync(config(d), original, { mode: 0o600 });

  const r = installCodexHooks(d, MS);
  assert.equal(r.changed, true);
  assert.ok(r.backup);
  assert.match(path.basename(r.backup!), /^config\.toml\.bak-ms-\d+$/);
  assert.equal(readFileSync(r.backup!, "utf8"), original, "the backup is the original, byte for byte");

  const text = read(d);
  // Every original line survives, in order, ahead of our block.
  const ours = text.indexOf("# ms-hooks-begin");
  assert.ok(ours > 0);
  assert.equal(text.slice(0, ours).trimEnd(), original.trimEnd(), "the human's tables are untouched");
  assert.equal(codexHooksInstalled(d, MS), true);
});

test("a second install is a no-op: no change, no second backup, identical bytes", () => {
  const d = home();
  writeFileSync(config(d), "model = \"gpt-5-codex\"\n", { mode: 0o600 });
  assert.equal(installCodexHooks(d, MS).changed, true);
  const snapshot = read(d);
  const backups = readdirSync(d).filter((f) => f.startsWith("config.toml.bak-ms-")).length;
  assert.equal(backups, 1);

  const second = installCodexHooks(d, MS);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(read(d), snapshot, "an unchanged install never rewrites the file");
  assert.equal(readdirSync(d).filter((f) => f.startsWith("config.toml.bak-ms-")).length, backups);
  // exactly one block, exactly one table per event
  assert.equal(snapshot.match(/# ms-hooks-begin/g)?.length, 1);
  for (const ev of EVENTS) assert.equal(snapshot.match(new RegExp(`\\[\\[hooks\\.${ev}\\]\\]`, "g"))?.length, 1, ev);
});

test("re-installing for a different binary replaces the block rather than stacking one", () => {
  const d = home();
  installCodexHooks(d, MS);
  const other = "/usr/local/bin/ms";
  const r = installCodexHooks(d, other);
  assert.equal(r.changed, true);
  const text = read(d);
  assert.equal(text.match(/# ms-hooks-begin/g)?.length, 1, "one block, not two");
  assert.ok(!text.includes(`${MS} _hook codex`), "the old command is gone");
  assert.equal(codexHooksInstalled(d, other), true);
  assert.equal(codexHooksInstalled(d, MS), false, "a different binary is a different install");
});

test("the human's own hook table for the same event is preserved, and ours takes the next matcher index", () => {
  // The trust key is `<path>:<event>:<matcher idx>:<hook idx>` — the index of
  // OUR array-of-tables entry. If the home already has one for that event,
  // hard-coding 0 would trust the human's hook and leave ours untrusted.
  const d = home();
  writeFileSync(config(d), [
    "[[hooks.SessionStart]]",
    "hooks = [{ type = \"command\", command = \"their-own-hook\" }]",
    "",
  ].join("\n"), { mode: 0o600 });

  assert.equal(installCodexHooks(d, MS).changed, true);
  const text = read(d);
  assert.ok(text.includes("their-own-hook"), "the human's hook survives");
  assert.ok(text.includes(`[hooks.state."${config(d)}:session_start:1:0"]`), "ours is the second SessionStart table");
  assert.ok(!text.includes(`[hooks.state."${config(d)}:session_start:0:0"]`), "and we never claim the human's index");
  // the other three events have no competition, so they stay at 0
  assert.ok(text.includes(`[hooks.state."${config(d)}:stop:0:0"]`));
  assert.equal(codexHooksInstalled(d, MS), true);
});

test("codexHooksInstalled is false for a missing file, missing tables, or a STALE trusted hash", () => {
  const d = home();
  assert.equal(codexHooksInstalled(d, MS), false, "no config.toml at all");

  installCodexHooks(d, MS);
  assert.equal(codexHooksInstalled(d, MS), true);

  // tables, no trust: exactly the state the spike found — "4 hooks need review
  // before they can run". The file LOOKS installed and nothing runs.
  writeFileSync(config(d), read(d).split("\n").filter((l) => !l.startsWith("trusted_hash")).join("\n"), { mode: 0o600 });
  assert.equal(codexHooksInstalled(d, MS), false, "untrusted hooks are not installed hooks");
  assert.equal(installCodexHooks(d, MS).changed, true, "and the installer repairs it");
  assert.equal(codexHooksInstalled(d, MS), true);

  // one hash corrupted: the file still LOOKS installed, which is why this is
  // the check that matters.
  const good = codexTrustedHash("stop", CMD, 600);
  writeFileSync(config(d), read(d).replace(good, `sha256:${"0".repeat(64)}`), { mode: 0o600 });
  assert.equal(codexHooksInstalled(d, MS), false, "a stale hash is not trust");
  // and re-installing repairs it
  assert.equal(installCodexHooks(d, MS).changed, true);
  assert.equal(codexHooksInstalled(d, MS), true);

  // one table removed: three of four is not installed
  writeFileSync(config(d), read(d).replace("[[hooks.SessionEnd]]", "[[hooks.Unrelated]]"), { mode: 0o600 });
  assert.equal(codexHooksInstalled(d, MS), false, "one of four missing");
});

test("a missing home directory is created, and the trust key carries that home's own path", () => {
  const { home: h } = tempHome();
  const d = path.join(h, "nested", "codex-home");
  assert.equal(existsSync(d), false);
  assert.equal(installCodexHooks(d, MS).changed, true);
  assert.equal(codexHooksInstalled(d, MS), true);
  // Hooks are per home, and so is trust: the same command in two homes has two
  // different keys, because the config path is inside the key.
  const other = home();
  installCodexHooks(other, MS);
  assert.ok(read(d).includes(`"${config(d)}:stop:0:0"`));
  assert.ok(read(other).includes(`"${config(other)}:stop:0:0"`));
  assert.notEqual(read(d), read(other));
});

test("a hand-installed copy of our own hook outside the markers is refused, never duplicated", () => {
  // Appending our block next to a hand-written copy would run the hook twice
  // per event, and our `…:session_start:0:0` trust entry could collide with one
  // the human already granted through /settings — a duplicate TOML key, and a
  // config Codex can no longer parse.
  const d = home();
  const hand = [
    "[[hooks.SessionStart]]",
    `hooks = [{ type = "command", command = "${CMD}" }]`,
    "",
    `[hooks.state."${config(d)}:session_start:0:0"]`,
    `trusted_hash = "${codexTrustedHash("session_start", CMD, 600)}"`,
    "",
  ].join("\n");
  writeFileSync(config(d), hand, { mode: 0o600 });
  assert.throws(() => installCodexHooks(d, MS), /outside the ms-hooks markers/);
  assert.equal(read(d), hand, "and the file is untouched");
  // A hand install for ANOTHER binary is the human's business and installs fine.
  assert.equal(installCodexHooks(d, "/usr/local/bin/ms").changed, true);
  assert.equal(codexHooksInstalled(d, "/usr/local/bin/ms"), true);
});
