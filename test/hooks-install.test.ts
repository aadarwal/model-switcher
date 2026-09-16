import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import { claudeHooksInstalled, installClaudeHooks } from "../src/hooks/install.ts";

const MS = "/opt/homebrew/opt/model-switcher/bin/ms";
// The command an entry carries: `msBin` single-quoted, the same way the
// statusline wrapper and the alias block quote it, so a path with a space
// stays one shell word (fix wave B-M5/B-M12).
const CMD = `'${MS}' _hook claude`;
const EVENTS = ["SessionStart", "UserPromptSubmit", "StopFailure", "SessionEnd"] as const;

type Entry = { matcher?: string; hooks: { type: string; command: string }[] };
const commands = (settings: Record<string, any>, event: string): string[] =>
  (settings.hooks?.[event] ?? []).flatMap((e: Entry) => e.hooks.map((h) => h.command));

test("installing merges the four entries and preserves every other key", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  const original = {
    model: "opusplan",
    enabledPlugins: { "anu@anu-marketplace": true },
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      Notification: [{ matcher: "", hooks: [{ type: "command", command: "say hi" }] }],
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "anu-session-start" }] }],
    },
  };
  const text = JSON.stringify(original, null, 2);
  writeFileSync(file, text);

  const first = installClaudeHooks(file, MS);
  assert.equal(first.changed, true);
  assert.ok(first.backup);
  assert.match(path.basename(first.backup!), /^settings\.json\.bak-\d+$/);
  assert.equal(readFileSync(first.backup!, "utf8"), text, "the backup is the original, byte for byte");

  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.model, "opusplan");
  assert.deepEqual(after.enabledPlugins, original.enabledPlugins);
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.hooks.Notification, original.hooks.Notification);
  assert.ok(commands(after, "SessionStart").includes("anu-session-start"), "an existing entry survives");
  for (const ev of EVENTS) assert.deepEqual(commands(after, ev).filter((c) => c === CMD), [CMD], `${ev} carries the command exactly once`);
  const stop = after.hooks.StopFailure.find((e: Entry) => e.hooks.some((h) => h.command === CMD));
  assert.equal(stop.matcher, "rate_limit");
  for (const ev of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
    const e = after.hooks[ev].find((x: Entry) => x.hooks.some((h) => h.command === CMD));
    assert.equal(e.matcher, "");
    assert.deepEqual(e.hooks, [{ type: "command", command: CMD }]);
  }
  assert.equal(claudeHooksInstalled(file, MS), true);
});

test("a second install is a no-op: no change, no backup, still exactly one entry each", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(file, JSON.stringify({ model: "opusplan" }, null, 2));
  assert.equal(installClaudeHooks(file, MS).changed, true);
  const snapshot = readFileSync(file, "utf8");
  const backupsAfterFirst = readdirSync(home).filter((f) => f.startsWith("settings.json.bak-")).length;

  const second = installClaudeHooks(file, MS);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(readFileSync(file, "utf8"), snapshot, "an unchanged install never rewrites the file");
  assert.equal(readdirSync(home).filter((f) => f.startsWith("settings.json.bak-")).length, backupsAfterFirst);
  const after = JSON.parse(snapshot);
  for (const ev of EVENTS) assert.deepEqual(commands(after, ev).filter((c) => c === CMD), [CMD]);
});

test("a missing settings file is created with just hooks, and no backup", () => {
  const { home } = tempHome();
  const file = path.join(home, "nested", "settings.json");
  const r = installClaudeHooks(file, MS);
  assert.equal(r.changed, true);
  assert.equal(r.backup, null);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(after), ["hooks"]);
  assert.deepEqual(Object.keys(after.hooks).sort(), [...EVENTS].sort());
  assert.equal(claudeHooksInstalled(file, MS), true);
});

test("claudeHooksInstalled is false for a missing file, a partial install, or another binary", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  assert.equal(claudeHooksInstalled(file, MS), false);
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: CMD }] }] } }));
  assert.equal(claudeHooksInstalled(file, MS), false, "one of four is not installed");
  installClaudeHooks(file, MS);
  assert.equal(claudeHooksInstalled(file, MS), true);
  assert.equal(claudeHooksInstalled(file, "/usr/local/bin/ms"), false, "a different binary is a different install");
  // installing the other binary adds its own entries without touching the first
  assert.equal(installClaudeHooks(file, "/usr/local/bin/ms").changed, true);
  assert.equal(claudeHooksInstalled(file, MS), true);
  assert.equal(claudeHooksInstalled(file, "/usr/local/bin/ms"), true);
});

test("a settings.json that cannot be parsed is refused, never overwritten", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(file, "{ not json,");
  assert.throws(() => installClaudeHooks(file, MS), /settings/i);
  assert.equal(readFileSync(file, "utf8"), "{ not json,");
  assert.equal(existsSync(file + ".bak"), false);
  assert.equal(claudeHooksInstalled(file, MS), false);
});
