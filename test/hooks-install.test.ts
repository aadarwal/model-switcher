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
  assert.match(path.basename(first.backup!), /^settings\.json\.bak-\d+(-\d+)?$/);
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
  // Fix wave B-I4: installing the other binary REPLACES the first tool's
  // entries rather than adding a second set beside them. Two live ms hooks
  // per event is not "both installed", it is a duplicate `started` event on
  // every session — or a dead hook, once the first binary is gone.
  assert.equal(installClaudeHooks(file, "/usr/local/bin/ms").changed, true);
  assert.equal(claudeHooksInstalled(file, MS), false, "the old binary's entries are gone, not shadowed");
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

// --- B-I4: a re-point REPLACES our entries, never stacks another ------------

const OLD = "/Users/someone/src/model-switcher/bin/ms";
const NEW = "/opt/homebrew/opt/model-switcher/bin/ms";
const cmdFor = (bin: string) => `'${bin}' _hook claude`;
const msEntries = (settings: Record<string, any>, event: string): string[] =>
  commands(settings, event).filter((c) => / _hook claude$/.test(c));

test("two moves leave exactly one ms entry per event, and other tools' hooks untouched", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        permissions: { allow: ["Bash(npm test)"] },
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "anu-session-start" }] }],
          Notification: [{ matcher: "", hooks: [{ type: "command", command: "say hi" }] }],
        },
      },
      null,
      2,
    ),
  );

  // A checkout install, then a move to brew, then a second move (an upgrade
  // that changed the path). Every one of these used to APPEND four entries.
  installClaudeHooks(file, OLD);
  installClaudeHooks(file, "/opt/homebrew/Cellar/model-switcher/0.2.0/bin/ms");
  const last = installClaudeHooks(file, NEW);
  assert.equal(last.changed, true);

  const after = JSON.parse(readFileSync(file, "utf8"));
  for (const ev of EVENTS) {
    assert.deepEqual(msEntries(after, ev), [cmdFor(NEW)], `${ev} carries exactly one ms entry, the current one`);
  }
  assert.ok(commands(after, "SessionStart").includes("anu-session-start"), "another tool's hook survives every move");
  assert.deepEqual(after.hooks.Notification, [{ matcher: "", hooks: [{ type: "command", command: "say hi" }] }]);
  assert.deepEqual(after.permissions, { allow: ["Bash(npm test)"] });

  assert.equal(claudeHooksInstalled(file, NEW), true);
  assert.equal(claudeHooksInstalled(file, OLD), false);
});

test("a stale ms entry beside the current one is not 'installed' — the doctor must see it", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  installClaudeHooks(file, NEW);
  const settings = JSON.parse(readFileSync(file, "utf8"));
  settings.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command: cmdFor(OLD) }] });
  writeFileSync(file, JSON.stringify(settings, null, 2));

  assert.equal(claudeHooksInstalled(file, NEW), false, "a dead ms hook is a problem, not a detail");
  const r = installClaudeHooks(file, NEW);
  assert.equal(r.changed, true);
  assert.deepEqual(msEntries(JSON.parse(readFileSync(file, "utf8")), "SessionStart"), [cmdFor(NEW)]);
  assert.equal(claudeHooksInstalled(file, NEW), true);
});

test("an ms command sharing an entry with another tool's loses only its own line", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [{ type: "command", command: cmdFor(OLD) }, { type: "command", command: "anu-session-start" }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  installClaudeHooks(file, NEW);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(msEntries(after, "SessionStart"), [cmdFor(NEW)]);
  assert.ok(commands(after, "SessionStart").includes("anu-session-start"));
});

test("an ms entry under an event this tool no longer subscribes to is pruned", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(
    file,
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: cmdFor(OLD) }] }] } }, null, 2),
  );
  installClaudeHooks(file, NEW);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("PreToolUse" in after.hooks, false, "an event left with nothing but our own entry is dropped, not left as an empty array");
  assert.equal(claudeHooksInstalled(file, NEW), true);
});

test("D2: pruning an unsubscribed event's last ms entry removes the key, not just the array's contents", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        hooks: {
          // An event we still subscribe to, so pass 2 repopulates it.
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: cmdFor(OLD) }] }],
          // An event we no longer subscribe to, holding only an ms entry —
          // pass 2 never revisits this one, so pass 1 must not leave it as
          // a dangling `"PreToolUse": []`.
          PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: cmdFor(OLD) }] }],
          // An event we no longer subscribe to, but with a non-ms hook
          // alongside ours: the event stays, just without our entry.
          Notification: [
            { matcher: "", hooks: [{ type: "command", command: cmdFor(OLD) }] },
            { matcher: "", hooks: [{ type: "command", command: "say hi" }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  const r = installClaudeHooks(file, NEW);
  assert.equal(r.changed, true);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(msEntries(after, "SessionStart"), [cmdFor(NEW)]);
  assert.equal("PreToolUse" in after.hooks, false, "the only-ours, no-longer-subscribed event is removed entirely");
  assert.deepEqual(after.hooks.Notification, [{ matcher: "", hooks: [{ type: "command", command: "say hi" }] }], "a shared event keeps the other tool's entry");
  assert.equal(claudeHooksInstalled(file, NEW), true);

  // Re-running against the now-clean file is a true no-op.
  const second = installClaudeHooks(file, NEW);
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
});
