// src/hooks/codex-install.ts
//
// Installing `ms _hook codex` into ONE Codex home's `config.toml`.
//
// Codex keeps its hooks in the home's `config.toml`, not in a JSON file (spike
// record 2026-09-16, Codex CLI 0.153.4): `hooks.json` and `hooks/hooks.json`
// are read by nothing, and `/settings` showed 0 installed hooks until the TOML
// tables were there. So this is not `installClaudeHooks` with a different path
// — it is a different file format, and hooks are PER HOME, so the caller runs
// it once per account home (`p.codexHome(name)`).
//
// Two things follow from that, and they are the whole design here:
//
//  1. **We do not own the file.** `config.toml` also carries the human's model,
//     approval policy, MCP servers, and — Task 7's business — the
//     `[projects."<cwd>"] trust_level` rows a launch pre-writes. Rewriting it
//     from a parsed model would reformat all of that (and a 0-dependency tool
//     has no TOML serialiser to reformat it WELL). The tool therefore owns one
//     contiguous block delimited by marker comments and copies every other byte
//     through unchanged.
//
//  2. **A new hook does not run until it is trusted.** Codex records trust as
//     `[hooks.state."<config path>:<event_snake>:<matcher idx>:<hook idx>"]`
//     with a `trusted_hash`, and refuses to run a hook whose hash it cannot
//     match ("⚠ 4 hooks need review before they can run"). The recipe was
//     verified against all four hashes Codex itself wrote:
//
//         sha256:<sha256 of the compact, recursively key-sorted JSON of
//                 {"event_name": "<event_snake>",
//                  "hooks": [{"async": false, "command": "<cmd>",
//                             "timeout": <t>, "type": "command"}]}>
//
//     with no trailing newline, `t` = 600 by default and 1 for SessionEnd. So
//     the installer pre-trusts its own hooks rather than walking the human
//     through `/settings` → `t` in five separate homes.
//
// The hash is over the hook's own text, which is exactly the point: change the
// command (a different `ms` path) and the hash no longer matches, so
// `codexHooksInstalled` reads false and the wizard re-installs. Nothing here
// touches a credential; `config.toml` holds none.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** The four lifecycle events the Codex hook subscribes to, with the snake_case
 * spelling Codex uses in a trust key and the timeout it applies by default.
 * SessionEnd's 1 s is Codex's own: the process is on its way out, so a hook
 * that takes longer would hold the exit open. */
const EVENTS: readonly { table: string; snake: string; timeout: number }[] = [
  { table: "SessionStart", snake: "session_start", timeout: 600 },
  { table: "UserPromptSubmit", snake: "user_prompt_submit", timeout: 600 },
  { table: "Stop", snake: "stop", timeout: 600 },
  { table: "SessionEnd", snake: "session_end", timeout: 1 },
];

/** The marker comments around the block this tool owns. Everything between
 * them is ours to rewrite; everything outside is the human's, byte for byte. */
const BEGIN = "# ms-hooks-begin (model-switcher — do not edit between the markers)";
const END = "# ms-hooks-end";
const BEGIN_RE = /^\s*# ms-hooks-begin\b/;
const END_RE = /^\s*# ms-hooks-end\b/;

/** The exact command string an installed entry carries. */
export function codexHookCommand(msBin: string): string { return `${msBin} _hook codex`; }

/** A TOML basic string. Only `"` and `\` need escaping in the values this
 * file writes (absolute paths and a command line); control characters in a
 * path would be pathological, and escaping them here would be dead code. */
function tomlString(s: string): string { return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

/** Where Codex keeps a home's configuration — and, since the trust key is
 * built from this very path, the string that makes a hash home-specific. */
export function codexConfigPath(homeDir: string): string { return path.join(homeDir, "config.toml"); }

/**
 * The four `[[hooks.<Event>]]` tables, in the form the spike record captured
 * from a working install. `timeout` is deliberately absent: leaving it out is
 * what makes Codex apply the defaults the hash is computed against, and
 * writing `timeout = 600` explicitly would be a second place for that number
 * to drift out of step with `EVENTS`.
 */
export function codexHookTables(msBin: string): string {
  const cmd = tomlString(codexHookCommand(msBin));
  return EVENTS.map((e) => `[[hooks.${e.table}]]\nhooks = [{ type = "command", command = ${cmd} }]`).join("\n\n");
}

/**
 * The `trusted_hash` Codex computes for one hook, as `sha256:<64 hex>`.
 *
 * VERIFIED recipe (spike record Addendum, matched against all four hashes the
 * Codex TUI wrote for itself): the compact JSON of the hook, keys sorted
 * recursively, no trailing newline. `JSON.stringify` on an object literal
 * emits keys in insertion order, so the literals below are WRITTEN in sorted
 * order — `event_name` before `hooks`, and `async`/`command`/`timeout`/`type`
 * within each hook. `async` is always false and `type` always "command"
 * because that is the only hook shape this tool installs; a matcher or a
 * statusMessage would add keys here, and this tool sets neither.
 */
export function codexTrustedHash(eventSnake: string, command: string, timeoutSeconds: number): string {
  const canonical = JSON.stringify({
    event_name: eventSnake,
    hooks: [{ async: false, command, timeout: timeoutSeconds, type: "command" }],
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** The trust key for one hook: `<config path>:<event_snake>:<matcher idx>:<hook idx>`.
 * `hook idx` is always 0 — each table this tool writes carries exactly one
 * hook — while `matcher idx` is the position of OUR `[[hooks.<Event>]]` among
 * the tables for that event, which is only 0 when the home has none of its
 * own. */
function trustKey(configPath: string, snake: string, matcherIndex: number): string {
  return `${configPath}:${snake}:${matcherIndex}:0`;
}

/** Lines of the file that are not ours: everything before the begin marker and
 * everything after the end marker. A file with no markers is all prefix, so a
 * first install appends. An unterminated begin marker (a half-written file, a
 * hand edit) would otherwise swallow the rest of the file into our block, so
 * it is treated as ours to the end and the suffix is empty — which is what the
 * marker literally says. */
function split(text: string): { prefix: string[]; suffix: string[] } {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => BEGIN_RE.test(l));
  if (begin < 0) return { prefix: lines, suffix: [] };
  const end = lines.findIndex((l, i) => i > begin && END_RE.test(l));
  return { prefix: lines.slice(0, begin), suffix: end < 0 ? [] : lines.slice(end + 1) };
}

/** How many `[[hooks.<Event>]]` tables for this event the home already has
 * ahead of ours. A line scan, not a TOML parse: the header of an array-of-
 * tables is a whole line, and the only way to fake one is to put it inside a
 * multi-line string, which no Codex config does. */
function matcherIndexes(prefix: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of EVENTS) {
    out[e.table] = prefix.filter((l) => new RegExp(String.raw`^\s*\[\[hooks\.${e.table}\]\]\s*$`).test(l)).length;
  }
  return out;
}

/** The whole block this tool owns, markers included, for a given file prefix. */
function block(configPath: string, msBin: string, prefix: string[]): string {
  const cmd = codexHookCommand(msBin);
  const idx = matcherIndexes(prefix);
  const tables = codexHookTables(msBin);
  const trust = EVENTS.map((e) => {
    const key = trustKey(configPath, e.snake, idx[e.table]);
    return `[hooks.state.${tomlString(key)}]\ntrusted_hash = ${tomlString(codexTrustedHash(e.snake, cmd, e.timeout))}`;
  }).join("\n\n");
  return [
    BEGIN,
    "# `ms` installs its own hooks here and pre-trusts them; re-run `ms doctor` to refresh.",
    "",
    tables,
    "",
    trust,
    END,
  ].join("\n");
}

/**
 * The file we would write for a given current text.
 *
 * Throws when the home already runs THIS tool's command from a table outside
 * our markers — a hand install, or a copy-paste from another home. Appending
 * our block there would leave Codex running the hook twice for every event
 * and, worse, could make our `[hooks.state."…:<event>:0:0"]` collide with a
 * trust entry the human already has for that index, which is a duplicate TOML
 * key and a config Codex can no longer parse. There is no safe automatic
 * repair — dropping the stray table would silently delete the trust the human
 * granted through `/settings` — so this refuses, names the file and says what
 * to remove. Same discipline as `installClaudeHooks` refusing a settings.json
 * it cannot parse: never overwrite what you did not write.
 */
function compose(configPath: string, msBin: string, text: string): string {
  const { prefix, suffix } = split(text);
  const needle = `command = ${tomlString(codexHookCommand(msBin))}`;
  if ([...prefix, ...suffix].some((l) => l.includes(needle))) {
    throw new Error(`${configPath}: a hook already runs \`${codexHookCommand(msBin)}\` outside the ms-hooks markers; remove that table by hand, refusing to install a duplicate`);
  }
  // Exactly one blank line between the human's last table and ours, and
  // between ours and whatever followed it — so a second install produces the
  // same bytes as the first and `changed` stays honest.
  const head = prefix.join("\n").replace(/\n+$/, "");
  const tail = suffix.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  const parts = [head, block(configPath, msBin, prefix), tail].filter((s) => s !== "");
  return parts.join("\n\n") + "\n";
}

/**
 * Write the four hook tables and their trust entries into `<homeDir>/config.toml`.
 *
 * The file is created when it is missing (0600, parents included) and
 * otherwise backed up to `config.toml.bak-ms-<unix seconds>` before the first
 * change. A run that would produce the bytes already on disk writes nothing
 * and reports `changed: false`, so the installer is idempotent and leaves one
 * backup per real change, not one per invocation.
 */
export function installCodexHooks(homeDir: string, msBin: string): { changed: boolean; backup: string | null } {
  const file = codexConfigPath(homeDir);
  const existed = existsSync(file);
  const text = existed ? readFileSync(file, "utf8") : "";
  const next = compose(file, msBin, text);
  if (existed && next === text) return { changed: false, backup: null };

  let backup: string | null = null;
  if (existed) {
    backup = `${file}.bak-ms-${Math.floor(Date.now() / 1000)}`;
    copyFileSync(file, backup);
  } else {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  writeAtomic(file, next);
  return { changed: true, backup };
}

/** One `[[hooks.<Event>]]` table as the scan below sees it: its position
 * among the tables for that event (the trust key's matcher index) and the
 * `hooks = [...]` line it carried, if any. */
type Table = { index: number; command: string | null };

/**
 * A targeted scan for the two shapes this tool writes — `[[hooks.<Event>]]`
 * with its one-line `hooks = [...]`, and `[hooks.state."<key>"]` with its
 * `trusted_hash` — and nothing else. It is not a TOML parser and does not
 * pretend to be one: a zero-dependency tool that had to parse TOML to answer
 * "are my hooks installed?" would be carrying a parser to read four lines it
 * wrote itself. Anything it does not recognise simply ends the current table,
 * which is the conservative answer (`installed` reads false and the installer
 * rewrites its block).
 */
function scan(text: string): { tables: Map<string, Table[]>; trust: Map<string, string> } {
  const tables = new Map<string, Table[]>();
  const trust = new Map<string, string>();
  let current: Table | null = null;
  let trustKeyNow: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    const arr = line.match(/^\[\[hooks\.(\w+)\]\]$/);
    const state = line.match(/^\[hooks\.state\."(.*)"\]$/);
    if (arr) {
      const list = tables.get(arr[1]) ?? [];
      current = { index: list.length, command: null };
      list.push(current);
      tables.set(arr[1], list);
      trustKeyNow = null;
      continue;
    }
    if (state) {
      current = null;
      trustKeyNow = state[1].replace(/\\(["\\])/g, "$1");
      continue;
    }
    if (line.startsWith("[")) { current = null; trustKeyNow = null; continue; }
    if (current && /^hooks\s*=/.test(line)) { current.command = line; continue; }
    const hash = trustKeyNow ? line.match(/^trusted_hash\s*=\s*"([^"]*)"$/) : null;
    if (hash) trust.set(trustKeyNow!, hash[1]);
  }
  return { tables, trust };
}

/**
 * True when this binary's four hooks are installed AND trusted in `homeDir`.
 *
 * Both halves matter and neither implies the other. Tables without a matching
 * `trusted_hash` are hooks Codex will refuse to run — the exact state the
 * spike record found after writing the tables by hand ("⚠ 4 hooks need review
 * before they can run") — and a stale hash is the same thing with a more
 * confusing symptom, because the file LOOKS installed. A hash goes stale
 * whenever the hook's own text changes, which is what makes this the check
 * that catches an `ms` that moved.
 */
export function codexHooksInstalled(homeDir: string, msBin: string): boolean {
  const file = codexConfigPath(homeDir);
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return false; }
  const { tables, trust } = scan(text);
  const cmd = codexHookCommand(msBin);
  const needle = `command = ${tomlString(cmd)}`;
  return EVENTS.every((e) => {
    const mine = (tables.get(e.table) ?? []).find((t) => (t.command ?? "").includes(needle));
    if (!mine) return false;
    return trust.get(trustKey(file, e.snake, mine.index)) === codexTrustedHash(e.snake, cmd, e.timeout);
  });
}

function writeAtomic(file: string, text: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}
