import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { codexHome, codexLaunchCommand, ensureCodexTrust } = await import("../src/providers/codex-cli.ts");

const tempDir = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));
const configOf = (home: string) => path.join(home, "config.toml");
const read = (home: string) => readFileSync(configOf(home), "utf8");
/** How many times a pattern occurs — the test for "one table, one key". */
const count = (s: string, re: RegExp) => s.match(new RegExp(re.source, `${re.flags.replace("g", "")}g`))?.length ?? 0;
/** A literal path inside a RegExp: a temp dir can hold `.` and `+`. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- the command -------------------------------------------------------

test("codexLaunchCommand is the CLI's own name and nothing else", () => {
  // Codex has no `--session-id`: the session's identity arrives from the
  // hook's SessionStart, so a launch adds no argument of its own.
  assert.deepEqual(codexLaunchCommand([]), ["codex"]);
  assert.deepEqual(codexLaunchCommand(["--model", "gpt-5", "hi"]), ["codex", "--model", "gpt-5", "hi"]);
});

test("codexHome is the account's own CODEX_HOME under MS_HOME", () => {
  const ms = tempDir("ms-codex-home-");
  process.env.MS_HOME = ms;
  try {
    assert.equal(codexHome("work"), path.join(ms, "codex", "work"));
  } finally {
    delete process.env.MS_HOME;
  }
});

// --- directory trust ---------------------------------------------------

test("a home with no config.toml gets one, 0600, naming the cwd as trusted", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  assert.match(text, new RegExp(`^\\[projects\\.${JSON.stringify(real).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]$`, "m"));
  assert.match(text, /^trust_level = "trusted"$/m);
  assert.equal(statSync(configOf(home)).mode & 0o777, 0o600);
});

test("the trust table is written once: a second launch changes nothing", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });
  const first = read(home);
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: false });
  assert.equal(read(home), first, "an idempotent writer leaves the file byte-for-byte");
  assert.equal(count(first, /^\[projects\./m), 1);
  assert.equal(count(first, /^trust_level/m), 1);
});

test("the cwd is symlink-resolved: the link and its target are one project", () => {
  const home = tempDir("ms-codex-trust-");
  const base = tempDir("ms-codex-cwd-");
  const real = path.join(realpathSync(base), "project");
  mkdirSync(real);
  const link = path.join(base, "link");
  symlinkSync(real, link, "dir");

  assert.deepEqual(ensureCodexTrust(home, link), { changed: true });
  const text = read(home);
  assert.ok(text.includes(`[projects.${JSON.stringify(real)}]`), text);
  assert.equal(text.includes(`[projects.${JSON.stringify(link)}]`), false, "the link must not become a second project");
  // Codex records trust against the directory it actually resolved.
  assert.deepEqual(ensureCodexTrust(home, real), { changed: false });
});

test("every other table survives untouched — the hook tables above all", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const hooks = [
    `model = "gpt-5"`,
    ``,
    `[[hooks.SessionStart]]`,
    `matcher = "*"`,
    `hooks = [{ type = "command", command = "/opt/ms _hook codex" }]`,
    ``,
    `[[hooks.Stop]]`,
    `hooks = [{ type = "command", command = "/opt/ms _hook codex" }]`,
    ``,
    `[hooks.state."/x/config.toml:session_start:0:0"]`,
    `trusted_hash = "sha256:abc"`,
    ``,
  ].join("\n");
  writeFileSync(configOf(home), hooks, { mode: 0o600 });

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  assert.ok(text.startsWith(hooks), "existing tables are never rewritten, only added to");
  assert.match(text, /^trust_level = "trusted"$/m);
  assert.equal(count(text, /^trusted_hash = "sha256:abc"$/m), 1);
  assert.equal(count(text, /^\[\[hooks\.SessionStart\]\]$/m), 1);
  assert.equal(count(text, /^\[\[hooks\.Stop\]\]$/m), 1);
});

test("an existing project table is added to, never duplicated", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  writeFileSync(
    configOf(home),
    `[projects.${JSON.stringify(real)}]\napproval_policy = "on-request"\n\n[[hooks.Stop]]\nhooks = []\n`,
    { mode: 0o600 },
  );

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  // A second [projects."…"] header for the same path would make the file
  // invalid TOML, and Codex would then read no config at all.
  assert.equal(count(text, /^\[projects\./m), 1);
  assert.match(text, /^trust_level = "trusted"$/m);
  assert.match(text, /^approval_policy = "on-request"$/m);
  // the key landed inside the project table, not in the hooks table below it
  assert.ok(text.indexOf("trust_level") < text.indexOf("[[hooks.Stop]]"), text);
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: false });
});

test("a project the human marked untrusted is honoured, not overruled", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  const before = `[projects.${JSON.stringify(real)}]\ntrust_level = "untrusted"\n`;
  writeFileSync(configOf(home), before, { mode: 0o600 });

  // A `trust_level` a human set is an ANSWER about their own directory. The
  // tool reports it and launches nothing; it does not quietly promote itself.
  assert.deepEqual(ensureCodexTrust(home, cwd), {
    changed: false,
    problem: `${real} is marked untrusted in ${configOf(home)}; edit it or launch elsewhere`,
  });
  assert.equal(read(home), before, "a refusal writes nothing at all");
});

test("the refusal names the value as written, whatever it is", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  writeFileSync(configOf(home), `[projects.${JSON.stringify(real)}]\ntrust_level = 'ask'  # for now\n`, { mode: 0o600 });

  const r = ensureCodexTrust(home, cwd);
  assert.equal(r.changed, false);
  assert.match(r.problem!, /is marked ask in /);
});

test("a header with a trailing comment is the SAME table, not a second one", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  const real = realpathSync(cwd);
  writeFileSync(
    configOf(home),
    `[projects.${JSON.stringify(real)}]   # trusted by hand, 2026-09-01\ntrust_level = "trusted"\n`,
    { mode: 0o600 },
  );

  // Before the comment was stripped, this header did not match and a SECOND
  // [projects."…"] table was appended — a duplicate table, invalid TOML, and
  // Codex answers an invalid config.toml by dropping the whole file: the hook
  // tables and every trust already granted, gone.
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: false });
  assert.equal(count(read(home), /^\[projects\./m), 1);
});

test("a comment is not stripped out of a path that contains a #", () => {
  const home = tempDir("ms-codex-trust-");
  const base = realpathSync(tempDir("ms-codex-cwd-"));
  const hashed = path.join(base, "a#b");
  mkdirSync(hashed);

  assert.deepEqual(ensureCodexTrust(home, hashed), { changed: true });
  assert.ok(read(home).includes(`[projects.${JSON.stringify(hashed)}]`), read(home));
  assert.deepEqual(ensureCodexTrust(home, hashed), { changed: false });
});

// --- the refusals ------------------------------------------------------
//
// Each of these is a `projects` definition the scanner cannot attribute.
// Appending beside one would define the same table twice; the whole config
// then fails to parse and Codex reads NONE of it.

for (const [what, body] of [
  ["a root-level inline table", `projects = { "/a/b" = { trust_level = "trusted" } }\n`],
  ["a root-level dotted assignment", `projects."/a/b".trust_level = "trusted"\n`],
  ["a bare [projects] super-table", `[projects]\n"/a/b" = { trust_level = "trusted" }\n`],
  ["an array of projects tables", `[[projects."/a/b"]]\ntrust_level = "trusted"\n`],
  ["a header with an unreadable key", `[projects.somebarekey]\ntrust_level = "trusted"\n`],
  ["a header with two key segments", `[projects."/a"."b"]\ntrust_level = "trusted"\n`],
] as const) {
  test(`${what} is refused, and nothing is written`, () => {
    const home = tempDir("ms-codex-trust-");
    const cwd = tempDir("ms-codex-cwd-");
    // The definition comes FIRST: a `projects = { … }` written after a table
    // header would belong to that table, not to the root, and this writer is
    // right to ignore one that does.
    const before = `${body}\n[[hooks.Stop]]\nhooks = []\n`;
    writeFileSync(configOf(home), before, { mode: 0o600 });

    const r = ensureCodexTrust(home, cwd);
    assert.equal(r.changed, false, what);
    assert.match(r.problem!, new RegExp(`^${esc(configOf(home))} already defines 'projects'`), what);
    assert.match(r.problem!, /this tool will not edit/, what);
    assert.equal(read(home), before, `${what}: a refusal writes nothing at all`);
  });
}

test("a hooks table named like a project is not mistaken for one", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  writeFileSync(configOf(home), `[hooks.state."/x/config.toml:session_start:0:0"]\ntrusted_hash = "sha256:abc"\n`, { mode: 0o600 });

  // Only `projects` tables concern this writer; everything else is a boundary.
  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });
  assert.match(read(home), /^trust_level = "trusted"$/m);
});

test("another project's table is not mistaken for this one", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  writeFileSync(configOf(home), `[projects."/somewhere/else"]\ntrust_level = "trusted"\n`, { mode: 0o600 });

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });

  const text = read(home);
  assert.equal(count(text, /^\[projects\./m), 2);
  assert.equal(count(text, /^trust_level = "trusted"$/m), 2);
});

test("a 'projects' key inside somebody else's table is not a projects definition", () => {
  const home = tempDir("ms-codex-trust-");
  const cwd = tempDir("ms-codex-cwd-");
  // `projects` here is `hooks.Stop.projects`, which has nothing to do with
  // the root table this writer adds to — refusing on it would be a launch
  // lost to a word.
  writeFileSync(configOf(home), `[[hooks.Stop]]\nprojects = { x = 1 }\n`, { mode: 0o600 });

  assert.deepEqual(ensureCodexTrust(home, cwd), { changed: true });
  assert.match(read(home), /^trust_level = "trusted"$/m);
});
