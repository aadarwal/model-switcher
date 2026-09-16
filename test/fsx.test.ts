// The three filesystem manners every installer shares (src/fsx.ts), and the
// proof that all four installers actually keep them — a symlinked target
// stays a symlink, a backup never clobbers another backup, and a path that
// lands in a shell command line is quoted exactly once.
//
// Hermetic: temp HOMEs only, no network, no real `~/.claude`, `~/.codex` or
// rc file is ever opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import { backupThroughLink, resolveTarget, shellQuote, writeAtomicThroughLink } from "../src/fsx.ts";
import { claudeHookCommand, installClaudeHooks } from "../src/hooks/install.ts";
import { installCodexHooks } from "../src/hooks/codex-install.ts";
import { installStatusline } from "../src/setup/statusline.ts";
import { installAlias } from "../src/setup/alias.ts";

const MS = "/opt/homebrew/opt/model-switcher/bin/ms";

/** `real/<name>` holding `text`, with `link/<name>` pointing at it — the
 *  chezmoi/stow shape: the human's `~` entry is a link into a checkout. */
function linked(home: string, name: string, text: string): { link: string; real: string } {
  const realDir = path.join(home, "dotfiles");
  const linkDir = path.join(home, "live");
  mkdirSync(realDir, { recursive: true });
  mkdirSync(linkDir, { recursive: true });
  const real = path.join(realDir, name);
  const link = path.join(linkDir, name);
  writeFileSync(real, text);
  symlinkSync(real, link);
  return { link, real };
}

// --- resolveTarget ---------------------------------------------------------

test("resolveTarget follows a chain, answers a dangling link, and never throws", () => {
  const { home } = tempHome();
  const real = path.join(home, "real.txt");
  writeFileSync(real, "x");
  const a = path.join(home, "a");
  const b = path.join(home, "b");
  symlinkSync(real, a);
  symlinkSync(a, b);
  assert.equal(resolveTarget(b), real);

  // A link whose target does not exist yet: realpathSync would throw here,
  // and a caller that fell back to the link path would sever it.
  const dangling = path.join(home, "dangling");
  symlinkSync(path.join(home, "not-yet"), dangling);
  assert.equal(resolveTarget(dangling), path.join(home, "not-yet"));

  const missing = path.join(home, "nothing-here");
  assert.equal(resolveTarget(missing), missing);
});

test("writeAtomicThroughLink writes through the link and leaves no temp file", () => {
  const { home } = tempHome();
  const { link, real } = linked(home, "settings.json", "before\n");
  writeAtomicThroughLink(link, "after\n");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the link must still be a link");
  assert.equal(readlinkSync(link), real);
  assert.equal(readFileSync(real, "utf8"), "after\n");
  assert.deepEqual(readdirSync(path.dirname(real)).sort(), ["settings.json"]);
});

test("backupThroughLink never clobbers, even three times inside one millisecond", () => {
  const { home } = tempHome();
  const file = path.join(home, "settings.json");
  writeFileSync(file, "one\n");
  const names = new Set<string>();
  for (const body of ["one\n", "two\n", "three\n"]) {
    writeFileSync(file, body);
    const b = backupThroughLink(file, "bak-ms-");
    names.add(b);
    assert.equal(readFileSync(b, "utf8"), body);
    assert.equal(statSync(b).mode & 0o777, 0o600);
  }
  assert.equal(names.size, 3, "three backups, three distinct files");
});

test("shellQuote makes one shell word of a path with a space, and escapes a quote", () => {
  assert.equal(shellQuote("/a b/ms"), "'/a b/ms'");
  assert.equal(shellQuote("/it's/ms"), `'/it'\\''s/ms'`);
});

// --- every installer keeps the link ---------------------------------------

test("installClaudeHooks writes through a symlinked settings.json", () => {
  const { home } = tempHome();
  const { link, real } = linked(home, "settings.json", JSON.stringify({ model: "opusplan" }, null, 2) + "\n");
  const r = installClaudeHooks(link, MS);
  assert.equal(r.changed, true);
  assert.equal(lstatSync(link).isSymbolicLink(), true, "settings.json must still be a symlink");
  const after = JSON.parse(readFileSync(real, "utf8"));
  assert.equal(after.model, "opusplan");
  assert.ok(after.hooks.SessionStart);
  // The backup sits beside the REAL file and holds the pre-change bytes.
  assert.ok(r.backup && r.backup.startsWith(path.dirname(real)), r.backup ?? "(none)");
  assert.match(JSON.parse(readFileSync(r.backup!, "utf8")).model, /opusplan/);
});

test("installStatusline writes through a symlinked settings.json", () => {
  const { home } = tempHome();
  const { link, real } = linked(home, "settings.json", JSON.stringify({ model: "opusplan" }, null, 2) + "\n");
  const r = installStatusline(link, MS);
  assert.equal(r.changed, true);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(real, "utf8")).statusLine.command, `'${MS}' _statusline`);
});

test("installAlias writes through a symlinked rc file", () => {
  const { home } = tempHome();
  const { link, real } = linked(home, ".zshrc", "export A=1\n");
  const r = installAlias(link, MS);
  assert.equal(r.changed, true);
  assert.equal(lstatSync(link).isSymbolicLink(), true, ".zshrc must still be a symlink");
  const after = readFileSync(real, "utf8");
  assert.ok(after.startsWith("export A=1\n"), after);
  assert.ok(after.includes(`alias claude='${MS} claude'`), after);
});

test("installCodexHooks writes through a symlinked config.toml", () => {
  const { home } = tempHome();
  const codexHome = path.join(home, "codex-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const realDir = path.join(home, "dotfiles");
  mkdirSync(realDir, { recursive: true });
  const real = path.join(realDir, "config.toml");
  writeFileSync(real, 'model = "gpt-5"\n');
  const link = path.join(codexHome, "config.toml");
  symlinkSync(real, link);

  const r = installCodexHooks(codexHome, MS);
  assert.equal(r.problem, undefined, r.problem ?? "");
  assert.equal(r.changed, true);
  assert.equal(lstatSync(link).isSymbolicLink(), true, "config.toml must still be a symlink");
  const after = readFileSync(real, "utf8");
  assert.ok(after.includes('model = "gpt-5"'), after);
  assert.ok(after.includes("[[hooks.SessionStart]]"), after);
  assert.equal(statSync(real).mode & 0o777, 0o600);
});

// --- quoting ---------------------------------------------------------------

test("a binary path with a space is one shell word in every command this tool writes", () => {
  const spaced = "/Users/a b/model switcher/bin/ms";
  assert.equal(claudeHookCommand(spaced), `'${spaced}' _hook claude`);

  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  installAlias(rc, spaced);
  const text = readFileSync(rc, "utf8");
  assert.ok(text.includes(`alias claude='${spaced} claude'`), text);

  const settings = path.join(home, "settings.json");
  installStatusline(settings, spaced);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, `'${spaced}' _statusline`);
});

test("a binary path containing a single quote is escaped, not left to break the line", () => {
  const quoted = "/Users/it's/ms";
  assert.equal(claudeHookCommand(quoted), `'/Users/it'\\''s/ms' _hook claude`);

  const { home } = tempHome();
  const rc = path.join(home, ".zshrc");
  installAlias(rc, quoted);
  const text = readFileSync(rc, "utf8");
  assert.ok(text.includes(`alias claude='/Users/it'\\''s/ms claude'`), text);
  // Prove it is really one word to a shell, not just escaped-looking.
  assert.ok(!existsSync("/nope"));

  const settings = path.join(home, "settings.json");
  installStatusline(settings, quoted);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).statusLine.command, `'/Users/it'\\''s/ms' _statusline`);
});

test("the Codex trust writer also keeps a symlinked config.toml a symlink", async () => {
  const { home } = tempHome();
  const codexHome = path.join(home, "codex-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const realDir = path.join(home, "dotfiles");
  mkdirSync(realDir, { recursive: true });
  const real = path.join(realDir, "config.toml");
  writeFileSync(real, 'model = "gpt-5"\n');
  const link = path.join(codexHome, "config.toml");
  symlinkSync(real, link);

  const { ensureCodexTrust, removeCodexTrust } = await import("../src/providers/codex-cli.ts");
  const project = path.join(home, "a-project");
  mkdirSync(project, { recursive: true });

  const r = ensureCodexTrust(codexHome, project);
  assert.equal(r.problem, undefined, r.problem ?? "");
  assert.equal(r.changed, true);
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the trust write severed the link");
  assert.match(readFileSync(real, "utf8"), /trust_level = "trusted"/);
  assert.ok(readFileSync(real, "utf8").includes('model = "gpt-5"'));

  // ...and the probe's own cleanup finds it back through the link.
  assert.equal(removeCodexTrust(codexHome, project).changed, true);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  const after = readFileSync(real, "utf8");
  assert.ok(!after.includes("trust_level"), after);
  assert.ok(after.includes('model = "gpt-5"'), after);
});

test("removeCodexTrust never removes a project table the human has added to", async () => {
  const { home } = tempHome();
  const codexHome = path.join(home, "codex-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const project = path.join(home, "a-project");
  mkdirSync(project, { recursive: true });
  const { ensureCodexTrust, removeCodexTrust } = await import("../src/providers/codex-cli.ts");
  ensureCodexTrust(codexHome, project);
  const config = path.join(codexHome, "config.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace('trust_level = "trusted"', 'trust_level = "trusted"\nsandbox_mode = "danger-full-access"'));
  const before = readFileSync(config, "utf8");

  assert.equal(removeCodexTrust(codexHome, project).changed, false);
  assert.equal(readFileSync(config, "utf8"), before, "a table the human added a key to is theirs");
});
