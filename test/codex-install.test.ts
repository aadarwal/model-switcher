import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { tempHome } from "./helpers.ts";
import { codexHomeConfigCurrent, codexHookTables, codexHooksInstalled, codexTrustedHash, ensureCodexHooks, ensureCodexReady, installCodexHooks } from "../src/hooks/codex-install.ts";

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
  assert.match(path.basename(r.backup!), /^config\.toml\.bak-ms-\d+(-\d+)?$/);
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
  const r = installCodexHooks(d, MS);
  assert.equal(r.changed, false);
  assert.match(r.problem!, /outside the ms-hooks markers/);
  assert.equal(read(d), hand, "and the file is untouched");
  // A hand install for ANOTHER binary is the human's business and installs fine.
  assert.equal(installCodexHooks(d, "/usr/local/bin/ms").changed, true);
  assert.equal(codexHooksInstalled(d, "/usr/local/bin/ms"), true);
});

test("a header wearing a trailing comment is the same header, and still shifts our matcher index", () => {
  // `[[hooks.SessionStart]] # mine` is a legal header. A scanner that could not
  // see it would put our trust entry at index 0 — the human's — leaving OUR
  // hook silently untrusted while `codexHooksInstalled` reported true.
  const d = home();
  writeFileSync(config(d), [
    "[[hooks.SessionStart]] # added by hand, keep",
    'hooks = [{ type = "command", command = "their-own-hook" }] # theirs',
    "",
  ].join("\n"), { mode: 0o600 });

  assert.equal(installCodexHooks(d, MS).changed, true);
  const text = read(d);
  assert.ok(text.includes("# added by hand, keep"), "the comment survives with its line");
  assert.ok(text.includes(`[hooks.state."${config(d)}:session_start:1:0"]`), "ours is the SECOND SessionStart table");
  assert.ok(!text.includes(`[hooks.state."${config(d)}:session_start:0:0"]`));
  assert.equal(codexHooksInstalled(d, MS), true);
  // A `#` inside a quoted key is part of the key, not a comment.
  const q = home();
  writeFileSync(config(q), ['[projects."/Users/a/sr#c/app"]', 'trust_level = "trusted"', ""].join("\n"), { mode: 0o600 });
  assert.equal(installCodexHooks(q, MS).changed, true);
  assert.ok(read(q).includes('[projects."/Users/a/sr#c/app"]'));
});

test("a hooks table this tool cannot classify is refused, not guessed at", () => {
  // Every one of these is a legal way to write something that changes the
  // matcher index our trust key is built from. Guessing wrong writes a
  // trusted_hash for somebody else's hook, or a duplicate key that makes Codex
  // reject the whole file — so none of them is guessed at.
  for (const header of [
    "[hooks]",                       // SessionStart = [...] could follow
    "[hooks.state]",                 // a quoted trust key could follow
    "[[hooks.SessionStart.extra]]",  // three segments, not two
    '[[hooks."Session Start"]]',     // a quoted event this tool cannot spell
    "[[hooks]]",                     // an array of hooks tables
  ]) {
    const d = home();
    const before = `${header}\nsomething = 1\n`;
    writeFileSync(config(d), before, { mode: 0o600 });
    const r = installCodexHooks(d, MS);
    assert.equal(r.changed, false, header);
    assert.match(r.problem!, /cannot read/, header);
    assert.equal(read(d), before, `${header}: untouched`);
    assert.equal(codexHooksInstalled(d, MS), false, `${header}: and never reported installed`);
  }
  // And a home whose block IS fully installed still reads as NOT installed
  // while an unreadable hooks table sits beside it: the tables and hashes all
  // match, but the index they were computed from can no longer be trusted, and
  // a confident `true` here is how our hook ends up silently untrusted.
  const installed = home();
  installCodexHooks(installed, MS);
  assert.equal(codexHooksInstalled(installed, MS), true);
  writeFileSync(config(installed), `[hooks]\nSessionStart = []\n\n${read(installed)}`, { mode: 0o600 });
  assert.equal(codexHooksInstalled(installed, MS), false, "installed, but not readably so");
  assert.match(installCodexHooks(installed, MS).problem!, /cannot read/, "and the installer says why");

  // A table that is not under `hooks` at all is none of our business, and a
  // nested array literal on its own line is not a header.
  const ok = home();
  writeFileSync(config(ok), ['[mcp_servers.anu]', 'matrix = [', '  [1, 2]', ']', ""].join("\n"), { mode: 0o600 });
  assert.equal(installCodexHooks(ok, MS).changed, true);
  assert.ok(read(ok).includes("  [1, 2]"));
});

test("a trust entry already carrying one of OUR keys is refused: a duplicate key breaks the file", () => {
  // Codex rejects a config.toml with two `[hooks.state."same key"]` tables —
  // and it is not only the hooks that stop working, it is the model, the
  // approval policy and every MCP server in the file.
  const d = home();
  const before = [
    `[hooks.state."${config(d)}:stop:0:0"]`,
    'trusted_hash = "sha256:deadbeef"',
    "",
  ].join("\n");
  writeFileSync(config(d), before, { mode: 0o600 });
  const r = installCodexHooks(d, MS);
  assert.equal(r.changed, false);
  assert.match(r.problem!, /already in this file outside the ms-hooks markers/);
  assert.equal(read(d), before, "untouched");
  // The SAME key under a different home is a different key, and installs fine.
  const other = home();
  writeFileSync(config(other), before, { mode: 0o600 });
  assert.equal(installCodexHooks(other, MS).changed, true, "the key names the OTHER home's config path");
});

test("a begin marker with no end is refused, never used to truncate the file", () => {
  // `split` would otherwise return an empty suffix and the write would delete
  // everything below the marker.
  const d = home();
  const before = [
    'model = "gpt-5-codex"',
    "# ms-hooks-begin (model-switcher — do not edit between the markers)",
    "[[hooks.SessionStart]]",
    `hooks = [{ type = "command", command = "${CMD}" }]`,
    "",
    "[mcp_servers.x]",
    'command = "x-mcp"',
    "",
  ].join("\n");
  writeFileSync(config(d), before, { mode: 0o600 });
  const r = installCodexHooks(d, MS);
  assert.equal(r.changed, false);
  assert.match(r.problem!, /no '# ms-hooks-end'/);
  assert.equal(read(d), before, "every byte below the marker survives");
  assert.ok(read(d).includes("[mcp_servers.x]"));
});

test("every write is 0600, not merely the first", () => {
  const d = home();
  writeFileSync(config(d), 'model = "gpt-5-codex"\n', { mode: 0o644 });
  assert.equal(installCodexHooks(d, MS).changed, true);
  assert.equal(statSync(config(d)).mode & 0o777, 0o600, "a world-readable home does not stay world-readable");
  assert.equal(installCodexHooks(d, "/usr/local/bin/ms").changed, true);
  assert.equal(statSync(config(d)).mode & 0o777, 0o600);
});

test("a table that merely CONTAINS the word 'hooks' is the human's, not ours: a webhooks project stays installed and untouched", () => {
  // A-I1. `ensureCodexTrust` appends `[projects."<cwd>"]` to this very file on
  // every launch, so `ms codex` from `~/src/webhooks-service` used to write a
  // header the classifier called `unknown` — which made `codexHooksInstalled`
  // false, `ms doctor` ✗, and `--fix` refuse. Only the FIRST key segment being
  // `hooks` can shift the matcher index or collide with our trust keys; a
  // `projects` or `mcp_servers` table carrying the substring cannot.
  for (const header of [
    '[projects."/Users/a/src/webhooks-service"]',
    '[projects."/Users/a/src/git-hooks"]',
    '[projects."/Users/a/src/pre-commit-hooks"]',
    "[mcp_servers.githooks]",
    '[mcp_servers."hooks-server"]',
  ]) {
    const d = home();
    assert.equal(installCodexHooks(d, MS).changed, true, header);
    assert.equal(codexHooksInstalled(d, MS), true, header);

    // Exactly what a launch's trust writer appends, after our block.
    const withProject = `${read(d)}\n${header}\ntrust_level = "trusted"\n`;
    writeFileSync(config(d), withProject, { mode: 0o600 });
    assert.equal(codexHooksInstalled(d, MS), true, `${header}: still installed`);

    // And `doctor --fix`'s installer is a no-op on it — no refusal, no rewrite.
    const again = installCodexHooks(d, MS);
    assert.equal(again.problem, undefined, header);
    assert.equal(again.changed, false, `${header}: nothing to change`);
    assert.equal(again.backup, null, `${header}: nothing backed up`);
    assert.equal(read(d), withProject, `${header}: byte for byte`);
  }
});

test("a first install into a config that already carries a webhooks project is allowed, and keeps it verbatim", () => {
  const d = home();
  const before = ['[projects."/Users/a/src/webhooks-service"]', 'trust_level = "trusted"', ""].join("\n");
  writeFileSync(config(d), before, { mode: 0o600 });
  const r = installCodexHooks(d, MS);
  assert.equal(r.problem, undefined);
  assert.equal(r.changed, true);
  assert.ok(read(d).includes('[projects."/Users/a/src/webhooks-service"]'));
  assert.ok(read(d).includes('trust_level = "trusted"'));
  assert.equal(codexHooksInstalled(d, MS), true);
  // The project table is NOT counted as a matcher: our trust keys stay at index 0.
  assert.ok(read(d).includes(`[hooks.state."${config(d)}:session_start:0:0"]`));
});

test("a backup is 0600 even when the config it copied was not", () => {
  // A-M4. `copyFileSync` gives the copy the SOURCE's mode (libuv fchmods to
  // `st_mode`), and Codex's own writes — the modal trust prompt, `/settings`
  // → t — are 0644. A backup is a full copy of a file naming every project
  // this account is trusted in, so it is 0600 like the file this tool writes.
  const d = home();
  writeFileSync(config(d), 'model = "gpt-5-codex"\n', { mode: 0o644 });
  chmodSync(config(d), 0o644); // writeFileSync's mode is subject to umask
  assert.equal(statSync(config(d)).mode & 0o777, 0o644, "the fixture really is world-readable");

  const r = installCodexHooks(d, MS);
  assert.equal(r.changed, true);
  assert.ok(r.backup, "a backup was taken");
  assert.equal(statSync(r.backup!).mode & 0o777, 0o600, "the backup is not world-readable");
  assert.equal(statSync(config(d)).mode & 0o777, 0o600, "and neither is the file it replaced");
  assert.equal(readFileSync(r.backup!, "utf8"), 'model = "gpt-5-codex"\n', "with the original bytes");
});

test("ensureCodexHooks is the one idempotent call: installs once, then does nothing, and reports a refusal", () => {
  const d = home();
  const first = ensureCodexHooks(d, MS);
  assert.equal(first.problem, undefined);
  assert.equal(first.changed, true);
  assert.equal(codexHooksInstalled(d, MS), true);

  const second = ensureCodexHooks(d, MS);
  assert.deepEqual([second.changed, second.backup, second.problem], [false, null, undefined], "nothing to do, nothing written");

  const bad = home();
  writeFileSync(config(bad), "[hooks]\nSessionStart = []\n", { mode: 0o600 });
  const refused = ensureCodexHooks(bad, MS);
  assert.match(refused.problem!, /cannot read/);
  assert.equal(refused.changed, false);
});

/**
 * The account preparation must not overwrite a key a HUMAN put in this file.
 *
 * The case that made this worth pinning is the wall drill
 * (docs/superpowers/plans/2026-09-16-codex-wall-mock.md): a scratch account's
 * `config.toml` carries `openai_base_url` / `chatgpt_base_url` /
 * `model_provider` / `[model_providers.mock]` pointing the CLI at a local
 * mock, and `ms` then writes directory trust and its hook block into that very
 * file on every launch. Those four keys are on Codex's project-local denylist
 * (`codex-rs/config/src/loader/mod.rs:72-89`, test at
 * `core/src/config/config_loader_tests.rs:3721-3812`), so a repo's
 * `.codex/config.toml` CANNOT hold them — `$CODEX_HOME/config.toml` is the
 * only place they work, which is the same file ms writes. If either writer
 * re-serialised the file, the drill would silently talk to the real backend
 * and spend the human's quota, which is exactly what it exists to avoid.
 *
 * Neither writer parses TOML, by design (see the doc comments on
 * `ensureCodexTrust` and on `split`/`compose` here), so this holds — but it
 * holds by construction, not by contract, and that is what a test is for.
 */
test("a human's base-URL overrides survive trust, a hook install, and a repair", () => {
  const d = home();
  const OVERRIDES =
    'openai_base_url = "http://127.0.0.1:8899/backend-api/codex"\n' +
    'chatgpt_base_url = "http://127.0.0.1:8899/backend-api"\n' +
    'model_provider = "mock"\n' +
    "\n" +
    "[model_providers.mock]\n" +
    'name = "mock"\n' +
    'base_url = "http://127.0.0.1:8899/v1"\n' +
    'wire_api = "responses"\n';
  writeFileSync(config(d), OVERRIDES, { mode: 0o600 });

  const cwd = mkdtempSync(path.join(tmpdir(), "ms-wall-cwd-"));
  const survives = (why: string) => {
    const text = read(d);
    for (const line of OVERRIDES.split("\n").filter((l) => l !== "")) {
      assert.ok(text.includes(line), `${why}: lost \`${line}\``);
    }
    // The keys must still be ROOT keys. A line that survived textually but now
    // sits under a table header belongs to that table, and Codex would never
    // read it as the override the human meant.
    const head = text.split(/^\[/m)[0];
    assert.ok(head.includes("openai_base_url = "), `${why}: openai_base_url fell under a table`);
    assert.ok(head.includes("chatgpt_base_url = "), `${why}: chatgpt_base_url fell under a table`);
  };

  // 1. Trust + hooks, the one call every launch and every rotation makes.
  assert.equal(ensureCodexReady(d, cwd, MS), null);
  assert.equal(codexHooksInstalled(d, MS), true);
  assert.ok(read(d).includes(`[projects."${realpathSync(cwd)}"]`), "trust was recorded");
  survives("after ensureCodexReady");

  // 2. A repair: the same home, a different ms binary, so the hook block and
  //    every trust hash inside it are rewritten rather than left alone.
  const OTHER = "/usr/local/bin/ms";
  const repaired = ensureCodexHooks(d, OTHER);
  assert.equal(repaired.problem, undefined);
  assert.equal(repaired.changed, true, "the block really was rewritten");
  assert.equal(codexHooksInstalled(d, OTHER), true);
  survives("after a repair");

  // 3. And the file is still one Codex can read: exactly one `[projects.…]`
  //    table and one ms-hooks block, never two of either.
  const text = read(d);
  assert.equal(text.match(/^\[projects\./gm)?.length, 1);
  assert.equal(text.match(/# ms-hooks-begin/g)?.length, 1);
  assert.equal(text.match(/# ms-hooks-end/g)?.length, 1);
});

// --- Rendering a home from the human's own ~/.codex/config.toml ----------
//
// 0.3.5. A per-account CODEX_HOME carries none of `~/.codex/config.toml`, and
// Codex 0.156.1 has no way to layer one over the other (`CODEX_HOME` is its
// only path variable; `-p/--profile` layers `$CODEX_HOME/<name>.config.toml`
// over `$CODEX_HOME/config.toml`, both inside the home we made). So every
// `ms codex` pane ran at Codex's default model and reasoning effort with none
// of the human's MCP servers. The file is rendered from that base instead.
//
// `MS_CODEX_BASE_CONFIG` names the base; the suite pins it at a path that does
// not exist (test/setup-env.mjs), so every test above renders against an
// absent base — which is exactly why they all still pass unchanged.

/** Run `fn` with a base config of `text`, or with none at all for `null`.
 *  Restores the suite's own pinned-absent base afterwards, always. */
function withBase<T>(text: string | null, fn: (basePath: string) => T): T {
  const saved = process.env.MS_CODEX_BASE_CONFIG;
  const dir = mkdtempSync(path.join(tmpdir(), "ms-base-"));
  const file = path.join(dir, "config.toml");
  if (text !== null) writeFileSync(file, text, { mode: 0o600 });
  process.env.MS_CODEX_BASE_CONFIG = file;
  try {
    return fn(file);
  } finally {
    if (saved === undefined) delete process.env.MS_CODEX_BASE_CONFIG;
    else process.env.MS_CODEX_BASE_CONFIG = saved;
  }
}

/** A base with the three shapes that matter: a header-less preamble (the
 *  model and the reasoning effort — the whole reason this exists), tables the
 *  home must inherit (`[features]`, an MCP server), and `hooks` tables that
 *  must NOT travel. The real `~/.codex/config.toml` has all of them, bare
 *  `[hooks.state]` included. */
const BASE = [
  'model = "gpt-6-astra"',
  'model_reasoning_effort = "max"',
  "",
  "[features]",
  "js_repl = false",
  "",
  "[mcp_servers.anu]",
  'command = "python3"',
  'args = ["/Users/a/.local/share/anu/mcp/server.py"]',
  "",
  "[hooks.state]",
  "",
  '[hooks.state."/Users/a/.codex/config.toml:session_start:0:0"]',
  'trusted_hash = "sha256:theirs"',
  "",
  "[[hooks.SessionStart]]",
  'hooks = [{ type = "command", command = "their-own-hook" }]',
  "",
  "# the status line is the human's",
  "[tui]",
  'status_line = ["model-with-reasoning"]',
  "",
].join("\n");

test("a home is rendered from the human's own config: preamble, tables and all — and its hooks are left behind", () => {
  withBase(BASE, () => {
    const d = home();
    assert.equal(installCodexHooks(d, MS).changed, true);
    const text = read(d);

    // The point of the whole change: the model and the reasoning effort are
    // root keys of the home, ahead of every table, where Codex reads them.
    const head = text.split(/^\[/m)[0]!;
    assert.ok(head.includes('model = "gpt-6-astra"'), "the model is a root key");
    assert.ok(head.includes('model_reasoning_effort = "max"'), "and so is the reasoning effort");
    // The tables travel verbatim, comments included.
    assert.ok(text.includes("[features]\njs_repl = false"), "[features]");
    assert.ok(text.includes('[mcp_servers.anu]\ncommand = "python3"'), "the MCP server");
    assert.ok(text.includes("# the status line is the human's\n[tui]"), "a table's own comment travels with it");

    // The base's HOOKS do not travel. Their trust is keyed on THEIR config
    // path and means nothing here; a bare `[hooks.state]` is a header this
    // tool refuses on; and a stray `[[hooks.SessionStart]]` would push our
    // own matcher index to 1 for a hook that is not in this file at all.
    assert.ok(!text.includes("their-own-hook"), "the base's own hook is not installed here");
    assert.ok(!text.includes("sha256:theirs"), "nor its trust");
    assert.ok(!text.includes("/Users/a/.codex/config.toml:"), "nor a trust key naming another config");
    assert.ok(text.includes(`[hooks.state."${config(d)}:session_start:0:0"]`), "ours stays at matcher index 0");
    assert.equal(codexHooksInstalled(d, MS), true);
  });
});

test("the render is the same four hooks and the same VERIFIED hashes — the recipe does not move", () => {
  // A home rendered with a base and a home rendered without one must carry
  // byte-identical hook tables and trust: the base changes what is AROUND the
  // block, never the block, and a hash that drifted would leave every hook
  // untrusted ("⚠ 4 hooks need review before they can run").
  const blockOf = (text: string): string =>
    text.slice(text.indexOf("# ms-hooks-begin"), text.indexOf("# ms-hooks-end") + "# ms-hooks-end".length);
  const bare = home();
  installCodexHooks(bare, MS);
  withBase(BASE, () => {
    const d = home();
    installCodexHooks(d, MS);
    // The trust key names the home's own config path, so compare the block
    // with that one difference normalised away.
    assert.equal(blockOf(read(d)).split(config(d)).join("<home>"), blockOf(read(bare)).split(config(bare)).join("<home>"));
    for (const ev of EVENTS) {
      assert.ok(read(d).includes(`trusted_hash = "${codexTrustedHash(SNAKE[ev]!, CMD, TIMEOUT[ev]!)}"`), ev);
    }
  });
});

test("an absent base is an empty base: the home renders to exactly what it held before", () => {
  const before = ['[projects."/Users/a/src/app"]', 'trust_level = "trusted"', ""].join("\n");
  // The trust key names the home's own path, so normalise that away.
  const render = (base: string | null): string =>
    withBase(base, () => {
      const d = home();
      writeFileSync(config(d), before, { mode: 0o600 });
      installCodexHooks(d, MS);
      return read(d).split(config(d)).join("<home>/config.toml");
    });
  const withAbsent = render(null);
  // ...and a base that is an empty FILE is the same thing.
  assert.equal(withAbsent, render(""), "an empty base file renders like no base at all");
  assert.ok(withAbsent.startsWith(before.trimEnd()), "the home's own table still leads the file");
  assert.ok(withAbsent.includes("# ms-hooks-begin"));
});

test("everything Codex wrote into the home survives a render — directory trust, [tui] and [tui.*]", () => {
  withBase(BASE, () => {
    const d = home();
    installCodexHooks(d, MS);
    // Exactly what Codex appends on its own: a trust row for a directory the
    // human answered the modal for, and the TUI's state.
    const codexWrote = [
      "",
      '[projects."/Users/a/src/other"]',
      'trust_level = "trusted"',
      "",
      "[tui.model_availability_nux]",
      '"gpt-6-astra" = 4',
      "",
    ].join("\n");
    writeFileSync(config(d), read(d) + codexWrote, { mode: 0o600 });

    assert.equal(installCodexHooks(d, MS).changed, false, "nothing to re-render");
    const text = read(d);
    assert.ok(text.includes('[projects."/Users/a/src/other"]'), "the trust row is kept");
    assert.ok(text.includes('[tui.model_availability_nux]\n"gpt-6-astra" = 4'), "and so is the TUI's own state");
    assert.ok(text.includes('status_line = ["model-with-reasoning"]'), "beside the base's [tui]");
    assert.equal(codexHooksInstalled(d, MS), true);
  });
});

test("the base wins a collision, and the home keeps only what the base does not name", () => {
  withBase(BASE, () => {
    const d = home();
    // The home holds its OWN answer for three things the base also answers
    // (a root key, a table, a sub-table's parent) plus one it does not.
    writeFileSync(config(d), [
      'model = "gpt-5-codex"',
      'approval_policy = "never"',
      "",
      "[features]",
      "js_repl = true",
      "",
      "[tui]",
      "screen_reader_detection_done = true",
      "",
      "[tui.model_availability_nux]",
      '"gpt-6-astra" = 1',
      "",
    ].join("\n"), { mode: 0o600 });
    installCodexHooks(d, MS);
    const text = read(d);

    assert.ok(text.includes('model = "gpt-6-astra"'), "the base's model wins");
    assert.ok(!text.includes('model = "gpt-5-codex"'), "the home's is gone, not duplicated");
    assert.equal(text.match(/^model = /gm)?.length, 1, "exactly one model key");
    assert.ok(text.includes("js_repl = false"), "the base's [features] wins");
    assert.ok(!text.includes("js_repl = true"));
    assert.equal(text.match(/^\[features\]$/gm)?.length, 1, "never two [features] tables");
    assert.equal(text.match(/^\[tui\]$/gm)?.length, 1, "never two [tui] tables");
    assert.ok(!text.includes("screen_reader_detection_done"), "the home's colliding [tui] is dropped whole");

    // What the base does NOT name is kept, root key and sub-table alike.
    assert.ok(text.includes('approval_policy = "never"'), "a root key the base never mentions");
    assert.ok(text.includes('[tui.model_availability_nux]'), "a sub-table of a colliding table is its own table");
  });
});

test("a render is idempotent: the same bytes, no second backup, before AND after Codex appends to it", () => {
  withBase(BASE, () => {
    const d = home();
    writeFileSync(config(d), 'approval_policy = "never"\n', { mode: 0o600 });
    assert.equal(installCodexHooks(d, MS).changed, true);
    const first = read(d);
    const backups = () => readdirSync(d).filter((f) => f.startsWith("config.toml.bak-ms-")).length;
    assert.equal(backups(), 1);

    const second = installCodexHooks(d, MS);
    assert.deepEqual([second.changed, second.backup], [false, null]);
    assert.equal(read(d), first, "byte for byte");
    assert.equal(backups(), 1, "no second backup");

    // And after Codex has appended its own tables below our block.
    writeFileSync(config(d), `${first}\n[projects."/Users/a/src/x"]\ntrust_level = "trusted"\n`, { mode: 0o600 });
    const snapshot = read(d);
    assert.equal(installCodexHooks(d, MS).changed, false, "an appended trust row is already what we would write");
    assert.equal(read(d), snapshot);
    assert.equal(backups(), 1);
  });
});

test("a render is 0600, and the base config is only ever READ", () => {
  withBase(BASE, (basePath) => {
    const before = readFileSync(basePath, "utf8");
    const beforeStat = statSync(basePath);
    const d = home();
    writeFileSync(config(d), 'approval_policy = "never"\n', { mode: 0o644 });
    chmodSync(config(d), 0o644);
    assert.equal(installCodexHooks(d, MS).changed, true);
    assert.equal(statSync(config(d)).mode & 0o777, 0o600, "a world-readable home does not stay world-readable");
    assert.equal(readFileSync(basePath, "utf8"), before, "the human's own config is untouched");
    assert.equal(statSync(basePath).mtimeMs, beforeStat.mtimeMs, "not even its mtime moved");
    assert.equal(readdirSync(path.dirname(basePath)).filter((f) => f !== "config.toml").length, 0, "and nothing was written beside it");
  });
});

test("a home that predates an edit to the base is STALE: codexHomeConfigCurrent says so, and a render repairs it", () => {
  const d = home();
  withBase(BASE, () => {
    installCodexHooks(d, MS);
    assert.equal(codexHooksInstalled(d, MS), true);
    assert.equal(codexHomeConfigCurrent(d, MS), true);
  });
  // The human adds an MCP server. The hooks are still installed and trusted —
  // that check cannot see this at all — but the home is a launch behind.
  withBase(`${BASE}\n[mcp_servers.proxyman]\ncommand = "mcp-server"\n`, () => {
    assert.equal(codexHooksInstalled(d, MS), true, "the hooks never went stale");
    assert.equal(codexHomeConfigCurrent(d, MS), false, "but the config did");
    const res = ensureCodexHooks(d, MS);
    assert.equal(res.problem, undefined);
    assert.equal(res.changed, true, "ensureCodexHooks re-renders a stale home");
    assert.ok(read(d).includes("[mcp_servers.proxyman]"), "the new server landed");
    assert.equal(codexHomeConfigCurrent(d, MS), true);
    assert.deepEqual([ensureCodexHooks(d, MS).changed, ensureCodexHooks(d, MS).problem], [false, undefined]);
  });
});

test("a render still refuses everything the installer refused, and writes nothing when it does", () => {
  // The base cannot buy its way past a refusal: a home this tool cannot
  // rewrite safely is not rewritten, base or no base.
  withBase(BASE, () => {
    for (const before of [
      "[hooks]\nSessionStart = []\n",
      `[hooks.state."${"<HOME>"}:stop:0:0"]\ntrusted_hash = "sha256:x"\n`,
      "# ms-hooks-begin (model-switcher — do not edit between the markers)\n[[hooks.Stop]]\n",
    ]) {
      const d = home();
      const text = before.replace("<HOME>", config(d));
      writeFileSync(config(d), text, { mode: 0o600 });
      const r = installCodexHooks(d, MS);
      assert.equal(r.changed, false, text);
      assert.ok(r.problem, text);
      assert.equal(read(d), text, `${text}: untouched — the base was never rendered over it`);
      assert.equal(codexHomeConfigCurrent(d, MS), false, `${text}: and a refusal is never "current"`);
    }
  });
});
