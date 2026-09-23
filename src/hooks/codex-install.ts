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
//  1. **We do not own the file — but we do RENDER it** (0.3.5). `config.toml`
//     also carries the model, the reasoning effort, the MCP servers, and the
//     `[projects."<cwd>"] trust_level` rows a launch pre-writes. Until 0.3.5
//     the first three were simply absent from an `ms` home, because a
//     per-account `CODEX_HOME` reads none of the human's `~/.codex/config.toml`
//     and Codex has no way to layer one over the other. So the file is now
//     composed on every launch from the human's own config, our block, and
//     whatever Codex wrote into the home — see "The base config a home is
//     rendered from" below. Every part is copied as WHOLE TOP-LEVEL SECTIONS,
//     byte for byte: nothing here parses a value or re-serialises one (a
//     0-dependency tool has no TOML writer, and the wall drill's
//     `openai_base_url` overrides are exactly what a re-serialiser would
//     quietly reformat). Our own contribution is still one contiguous block
//     delimited by marker comments, and it still stays where the markers are.
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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { backupThroughLink, resolveTarget, writeAtomicThroughLink } from "../fsx.ts";
// Shared with the launcher's own config.toml writer rather than reimplemented:
// one definition of "where does the TOML end and the comment begin" is the
// only way both writers agree about what a line says.
import { ensureCodexTrust, stripComment } from "../providers/codex-cli.ts";
// The user's own `~/.codex/config.toml` — the base every home is rendered
// from. Named in src/paths.ts beside every other path this tool resolves.
import { codexBaseConfigPath } from "../paths.ts";

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

/** What the installer decided. `problem` is a refusal the caller reports
 * verbatim: a home this tool cannot write without risking the human's own
 * configuration is never written to, and never silently skipped either. */
export type InstallResult = { changed: boolean; backup: string | null; problem?: string };

/**
 * A table header, strictly.
 *
 * `[[hooks.SessionStart]]`, `[hooks.state."…"]`, and the quoted or spaced
 * spellings of each, all mean what they mean whether or not a comment follows
 * them — so the comment comes off first (`stripComment`, shared with the
 * launcher's writer) and the match is made on what is left.
 *
 * Only the two shapes this tool writes are recognised. Everything else under
 * `hooks` is `"unknown"`, which is a REFUSAL rather than a guess, because
 * every one of those spellings can change the matcher index our trust key is
 * built from: `[hooks]` with a `SessionStart = [...]` inside it is the same
 * subscription written another way, and `[hooks.state]` with a quoted key
 * under it is the same trust entry. A wrong index does not fail loudly — it
 * writes a `trusted_hash` for somebody else's hook and leaves ours silently
 * untrusted, or collides with a key the human already has and makes the whole
 * file unparseable to Codex.
 */
type Header =
  | { kind: "event"; table: string }
  | { kind: "state"; key: string }
  | { kind: "unknown" }
  | null;

/** `hooks`, in any legal spelling of one key segment. */
const HOOKS = String.raw`(?:hooks|"hooks"|'hooks')`;
const STATE = String.raw`(?:state|"state"|'state')`;
const BARE = String.raw`[A-Za-z0-9_-]+`;
const EVENT_HEADER = new RegExp(String.raw`^\[\[\s*${HOOKS}\s*\.\s*(?:(${BARE})|"(${BARE})"|'(${BARE})')\s*\]\]$`);
const STATE_HEADER = new RegExp(String.raw`^\[\s*${HOOKS}\s*\.\s*${STATE}\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]$`);
/**
 * A header whose FIRST key segment is `hooks` — `[hooks]`, `[[hooks]]`,
 * `[hooks.state]`, `[[hooks.SessionStart.extra]]`, and the quoted spellings.
 * Those are the only headers that can shift the matcher index our trust key is
 * built from, or collide with one of our keys.
 *
 * It is deliberately NOT the substring `hooks`. `ensureCodexTrust` appends
 * `[projects."<cwd>"]` to this very file on every launch, so a launch from
 * `~/src/webhooks-service` (or `git-hooks`, `pre-commit-hooks`) would
 * otherwise turn a correctly installed home into one the installer refuses to
 * touch and `codexHooksInstalled` reports false — a home the wizard could
 * never repair. A `projects` or `mcp_servers` table that merely carries the
 * word is the human's, and is copied through byte for byte.
 */
const HOOKS_SEGMENT = new RegExp(String.raw`^\[\[?\s*${HOOKS}\s*[.\]]`);

/**
 * Whether a line is a table header at all: after its comment is cut and its
 * whitespace trimmed, a header is a line that both opens and closes with
 * brackets. A continuation line of a multi-line array value can start with
 * `[`, but it ends with a comma or nothing — so this does not mistake one for
 * a header, and a header is never mistaken for a value.
 */
const looksLikeHeader = (line: string): boolean => line.startsWith("[") && line.endsWith("]");

function classify(raw: string): Header {
  const line = stripComment(raw).trim();
  if (!looksLikeHeader(line)) return null;
  const ev = EVENT_HEADER.exec(line);
  if (ev) return { kind: "event", table: ev[1] ?? ev[2] ?? ev[3]! };
  const st = STATE_HEADER.exec(line);
  if (st) return { kind: "state", key: unquoteTomlKey(st[1]) };
  // Not one of ours — but is it under `hooks` at all? Only a header whose
  // FIRST key segment is `hooks` can be, whatever else it is; refusing on every
  // unparsed header would refuse on a nested array literal that happens to sit
  // on its own line, and refusing on the mere substring would refuse on the
  // human’s own `[projects."…/webhooks-service"]`. (A key that spells the word
  // with an escape — `["\u0068ooks".SessionStart]` — defeats this; it also defeats every other
  // reader of this file, Codex's own included, and is not a shape any tool
  // writes.)
  return HOOKS_SEGMENT.test(line) ? { kind: "unknown" } : null;
}

/** The inverse of `tomlString` for the one quoted segment `STATE_HEADER`
 * captured: a basic string's `\"` and `\\` unescape, a literal string's
 * contents are taken as they stand. */
function unquoteTomlKey(quoted: string): string {
  const body = quoted.slice(1, -1);
  return quoted[0] === "'" ? body : body.replace(/\\(["\\])/g, "$1");
}

/** Lines of the file that are not ours: everything before the begin marker and
 * everything after the end marker. A file with no markers is all prefix, so a
 * first install appends.
 *
 * A begin marker with no end is NOT ours to the end of the file: a half-written
 * file or a hand edit would then have everything below it swallowed into our
 * block and replaced. `end < 0` is returned as a refusal instead, because the
 * one thing an installer must never do is delete configuration it did not
 * write. */
function split(text: string): { prefix: string[]; suffix: string[] } | null {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => BEGIN_RE.test(l));
  if (begin < 0) return { prefix: lines, suffix: [] };
  const end = lines.findIndex((l, i) => i > begin && END_RE.test(l));
  if (end < 0) return null;
  return { prefix: lines.slice(0, begin), suffix: lines.slice(end + 1) };
}

// --- The base config a home is rendered from ----------------------------
//
// A home's `config.toml` used to be whatever the human and Codex had put
// there, plus our block. That made every `ms codex` pane run at Codex's
// DEFAULT model and reasoning effort with none of the human's MCP servers —
// because the home is a fresh `CODEX_HOME`, and `~/.codex/config.toml` is
// not read from one.
//
// Codex 0.156.1 has no way to say otherwise. `CODEX_HOME` is the only path
// variable it reads (checked against the shipped binary's own strings), and
// `-p/--profile` layers `$CODEX_HOME/<name>.config.toml` over
// `$CODEX_HOME/config.toml` — both inside the home we gave the account, so
// neither reaches the human's file. There is no include directive. So the
// file is RENDERED instead, on every launch, from three parts:
//
//   (a) the human's own `~/.codex/config.toml` (`codexBaseConfigPath`), with
//       every `hooks` table stripped — their hook trust is keyed on THEIR
//       config path and means nothing here, and a bare `[hooks.state]` (the
//       real file has one) would otherwise be a header this tool refuses on;
//   (b) our block: the four hook tables and their pre-computed trust, the
//       same recipe and the same hashes as before;
//   (c) everything Codex itself wrote into the home — `[projects."…"]`
//       trust, `[tui]`, `[tui.*]`, anything else — that (a) does not already
//       define. Base wins a collision; Codex-written state is never dropped.
//
// Rendering, not merging: the parts are whole top-level sections, copied
// byte for byte, never re-serialised (a zero-dependency tool has no TOML
// writer, and the wall-drill's `openai_base_url` overrides are exactly the
// kind of thing a re-serialiser would quietly reformat). The file is
// therefore idempotent by construction — a second render of what it just
// wrote drops (a) out of (c) again and produces the same bytes.
//
// Nothing here ever writes to `~/.codex/config.toml`. It is opened read-only
// and is missing-is-fine.

/**
 * A top-level table header, as the SECTION splitter sees one: a line whose
 * FIRST character is `[` and which still ends in `]` once its comment is cut.
 *
 * Column zero is the whole point. `matrix = [` / `  [1, 2]` / `]` is a legal
 * multi-line array, and its middle line trims to something that opens and
 * closes with brackets — but it is indented, and every header Codex or this
 * tool writes is not. (`classify` above is stricter still and answers a
 * different question: whether a line is one of the two `hooks` shapes.)
 */
function isSectionHeader(raw: string): boolean {
  if (!/^\[\[?\s*[^\s[\]]/.test(raw)) return false;
  return stripComment(raw).trimEnd().endsWith("]");
}

/** A header whose first key segment is `hooks`, in any spelling — the tables
 *  section (a) drops. */
const isHooksHeader = (raw: string): boolean => HOOKS_SEGMENT.test(stripComment(raw).trim());

/**
 * A dotted TOML key as its unquoted segments, or null when this tool cannot
 * say what key that is.
 *
 * Null is never a guess: it makes the caller fall back to comparing the raw
 * text, so a header or an assignment this parser cannot read can only ever
 * FAIL to match one from the base — never match the wrong one.
 */
function splitKeyPath(text: string): string[] | null {
  const segs: string[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= text.length) return null;
    const quote = text[i]!;
    if (quote === '"' || quote === "'") {
      const start = i++;
      for (;;) {
        if (i >= text.length) return null; // unterminated
        const c = text[i]!;
        if (quote === '"' && c === "\\") { i += 2; continue; }
        i++;
        if (c === quote) break;
      }
      segs.push(unquoteTomlKey(text.slice(start, i)));
    } else {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_-]/.test(text[i]!)) i++;
      if (i === start) return null;
      segs.push(text.slice(start, i));
    }
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= text.length) return segs;
    if (text[i] !== ".") return null;
    i++;
  }
}

/** The identity a base table and a home table are compared on: the key path,
 *  NOT the bracket count. `[x]` in the base and `[[x]]` in the home are a
 *  collision, not two tables — emitting both would be a config Codex drops
 *  whole. */
function headerKey(raw: string): string {
  const line = stripComment(raw).trim();
  const m = /^\[\[?([\s\S]*?)\]\]?$/.exec(line);
  const segs = m ? splitKeyPath(m[1]!) : null;
  return segs ? segs.join("\u0000") : `raw:${line}`;
}

/** The dotted key a preamble line assigns to, or null when the line does not
 *  start an assignment: a blank, a comment, or a continuation line of a
 *  multi-line value (`  [1, 2]`, `  { a = 1 },` — neither parses as a key,
 *  which is what keeps a value from being split in half). */
function rootKey(raw: string): string | null {
  const line = stripComment(raw);
  if (line.trim() === "") return null;
  let eq = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') { i++; while (i < line.length && line[i] !== '"') { if (line[i] === "\\") i++; i++; } continue; }
    if (c === "'") { i++; while (i < line.length && line[i] !== "'") i++; continue; }
    if (c === "=") { eq = i; break; }
  }
  if (eq < 0) return null;
  const segs = splitKeyPath(line.slice(0, eq));
  return segs ? segs.join("\u0000") : null;
}

/** One top-level table with everything under it, kept as written. */
type Section = { key: string; header: string; lines: string[] };
/** One root-level assignment with its own continuation and leading comments. */
type Entry = { key: string; lines: string[] };

/** Pop a trailing run of blank lines, then a trailing run of comment lines,
 *  and return the comments. A comment run at the END of a block documents
 *  what comes NEXT, so it travels with it — otherwise a section the base
 *  already defines would take the next section's comment away with it. An
 *  unterminated value never ends in a comment line (its last line is the
 *  closing bracket), so this cannot cut a value in half. */
function detachTrailingComments(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const moved: string[] = [];
  while (lines.length > 0 && lines[lines.length - 1]!.trimStart().startsWith("#")) moved.unshift(lines.pop()!);
  return moved;
}

/** Split a file's lines into its header-less preamble and its top-level
 *  sections, in order, byte for byte. */
function splitSections(lines: string[]): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const raw of lines) {
    if (isSectionHeader(raw)) sections.push({ key: headerKey(raw), header: raw, lines: [raw] });
    else if (sections.length === 0) preamble.push(raw);
    else sections[sections.length - 1]!.lines.push(raw);
  }
  for (let i = sections.length - 1; i >= 0; i--) {
    sections[i]!.lines.unshift(...detachTrailingComments(i === 0 ? preamble : sections[i - 1]!.lines));
  }
  return { preamble, sections };
}

/** Split a preamble into its assignments. Lines before the first one are
 *  comments, and travel with the assignment they document; anything left
 *  over is dropped, because the rendered preamble is the base's and a
 *  free-floating comment copied back in would double on every render. */
function splitEntries(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  const lead: string[] = [];
  for (const raw of lines) {
    const key = rootKey(raw);
    if (key !== null) { entries.push({ key, lines: [raw] }); continue; }
    if (entries.length === 0) { lead.push(raw); continue; }
    entries[entries.length - 1]!.lines.push(raw);
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    entries[i]!.lines.unshift(...detachTrailingComments(i === 0 ? lead : entries[i - 1]!.lines));
  }
  return entries;
}

/** A block of lines with its blank edges trimmed; "" when there is nothing
 *  in it. Every piece of the rendered file goes through this, which is what
 *  makes the spacing between pieces exactly one blank line however the
 *  source was spaced — and therefore what makes a second render byte-identical. */
function textOf(lines: string[]): string {
  const out = [...lines];
  while (out.length > 0 && out[0]!.trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out.join("\n");
}

/** The human's own config, as the parts a home inherits. Missing, or
 *  unreadable, is an empty base — a home renders to exactly what it rendered
 *  to before this existed. */
function baseDoc(): { entries: Entry[]; sections: Section[] } {
  let text: string;
  try { text = readFileSync(codexBaseConfigPath(), "utf8"); } catch { return { entries: [], sections: [] }; }
  // A base that carries an ms block of its own (somebody pointed this tool at
  // their own `~/.codex` once) contributes neither its tables nor its markers.
  const parts = split(text);
  const lines = parts
    ? [...parts.prefix, ...parts.suffix]
    : text.split("\n").filter((l) => !BEGIN_RE.test(l) && !END_RE.test(l));
  const doc = splitSections(lines);
  return {
    entries: splitEntries(doc.preamble).filter((e) => e.key !== "hooks" && !e.key.startsWith("hooks\u0000")),
    sections: doc.sections.filter((s) => !isHooksHeader(s.header)),
  };
}

/** How many `[[hooks.<Event>]]` tables for this event the home already has
 * ahead of ours — the matcher index our trust key is built from. */
function matcherIndexes(prefix: string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(EVENTS.map((e) => [e.table, 0]));
  for (const line of prefix) {
    const h = classify(line);
    if (h?.kind === "event" && h.table in out) out[h.table]++;
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
 * Everything that makes this home unsafe to write, or null.
 *
 * Three refusals, all the same principle: never overwrite, duplicate or
 * invalidate what somebody else put in this file.
 *
 *  * a `hooks` header this tool cannot classify — it may or may not shift the
 *    matcher index, and neither answer can be guessed;
 *  * a table already running THIS tool's command outside our markers (a hand
 *    install, a copy-paste from another home) — appending would run the hook
 *    twice for every event, and dropping the stray table would silently delete
 *    the trust the human granted through `/settings`;
 *  * a `[hooks.state."<one of our keys>"]` already in the file outside our
 *    block — writing ours would be a DUPLICATE TOML key, and Codex refuses the
 *    whole file, hooks and model and MCP servers with it.
 */
function unsafe(configPath: string, msBin: string, prefix: string[], suffix: string[]): string | null {
  const outside = [...prefix, ...suffix];
  for (const line of outside) {
    if (classify(line)?.kind === "unknown") {
      return `${configPath}: a 'hooks' table this tool cannot read (${stripComment(line).trim()}); install the hooks by hand or simplify that table, refusing to guess`;
    }
  }
  const needle = `command = ${tomlString(codexHookCommand(msBin))}`;
  if (outside.some((l) => l.includes(needle))) {
    return `${configPath}: a hook already runs \`${codexHookCommand(msBin)}\` outside the ms-hooks markers; remove that table by hand, refusing to install a duplicate`;
  }
  const idx = matcherIndexes(prefix);
  const ours = new Set(EVENTS.map((e) => trustKey(configPath, e.snake, idx[e.table])));
  for (const line of outside) {
    const h = classify(line);
    if (h?.kind === "state" && ours.has(h.key)) {
      return `${configPath}: the trust entry [hooks.state."${h.key}"] is already in this file outside the ms-hooks markers; remove it by hand, refusing to write a duplicate key`;
    }
  }
  return null;
}

/**
 * The file we would write for a given current text, or the reason not to.
 *
 * The render, end to end. `split` first, because the ONE thing this must
 * never do is lose configuration: a begin marker with no end is a refusal,
 * not a licence to rebuild the file from the half of it we can read.
 *
 * Then the three parts, in order — the base (hooks stripped), our block, and
 * whatever the home has that the base does not define — with our block left
 * exactly where the markers already were. That last detail is what keeps a
 * home Codex has appended to (`[projects."<cwd>"]`, `[tui]`) rendering to
 * byte-identical output rather than shuffling the block to the end on every
 * launch.
 *
 * The safety checks run on the REBUILT prefix and suffix, not the original:
 * the matcher index our trust key is built from is an index into the file we
 * are about to write, and the base can no more collide with our keys than it
 * can shift that index, because its `hooks` tables are gone by then.
 */
function compose(configPath: string, msBin: string, text: string): { next: string } | { problem: string } {
  const parts = split(text);
  if (!parts) {
    return { problem: `${configPath}: a '# ms-hooks-begin' marker with no '# ms-hooks-end'; repair or remove that block by hand, refusing to overwrite everything below it` };
  }
  const base = baseDoc();
  const baseKeys = new Set(base.sections.map((s) => s.key));
  const baseRoots = new Set(base.entries.map((e) => e.key));
  const mine = (s: Section): boolean => !baseKeys.has(s.key);

  const head = splitSections(parts.prefix);
  const tail = splitSections(parts.suffix);

  // (a) the base's preamble, then the home's own root keys the base does not
  //     claim — both ahead of every table, where root keys must be.
  const prefixPieces = [
    base.entries.map((e) => textOf(e.lines)).filter((t) => t !== "").join("\n"),
    splitEntries(head.preamble).filter((e) => !baseRoots.has(e.key)).map((e) => textOf(e.lines)).filter((t) => t !== "").join("\n"),
    ...base.sections.map((s) => textOf(s.lines)),
    ...head.sections.filter(mine).map((s) => textOf(s.lines)),
  ].filter((t) => t !== "");
  // Anything after our block: its own leading lines (in practice blank —
  // `ensureCodexTrust` appends a table) kept as they stand, then the sections.
  const suffixPieces = [
    textOf(tail.preamble),
    ...tail.sections.filter(mine).map((s) => textOf(s.lines)),
  ].filter((t) => t !== "");

  const headText = prefixPieces.join("\n\n");
  const tailText = suffixPieces.join("\n\n");
  const problem = unsafe(configPath, msBin, headText.split("\n"), tailText.split("\n"));
  if (problem) return { problem };

  // Exactly one blank line between the base's last table and ours, and
  // between ours and whatever followed it — so a second render produces the
  // same bytes as the first and `changed` stays honest.
  const pieces = [headText, block(configPath, msBin, headText.split("\n")), tailText].filter((x) => x !== "");
  return { next: pieces.join("\n\n") + "\n" };
}

/**
 * Render `<homeDir>/config.toml`: the human's own `~/.codex/config.toml`, the
 * four hook tables with their trust entries, and whatever Codex wrote into
 * this home that the base does not already define.
 *
 * The file is created when it is missing (0600, parents included) and
 * otherwise backed up to `config.toml.bak-ms-<unix seconds>` before the first
 * change. A run that would produce the bytes already on disk writes nothing
 * and reports `changed: false`, so the installer is idempotent and leaves one
 * backup per real change, not one per invocation.
 */
export function installCodexHooks(homeDir: string, msBin: string): InstallResult {
  const file = codexConfigPath(homeDir);
  const existed = existsSync(file);
  const text = existed ? readFileSync(file, "utf8") : "";
  const composed = compose(file, msBin, text);
  if ("problem" in composed) return { changed: false, backup: null, problem: composed.problem };
  const next = composed.next;
  if (existed && next === text) return { changed: false, backup: null };

  let backup: string | null = null;
  if (existed) {
    backup = backupThroughLink(file, "bak-ms-");
  } else {
    mkdirSync(path.dirname(resolveTarget(file)), { recursive: true, mode: 0o700 });
  }
  writeAtomic(file, next);
  return { changed: true, backup };
}

/**
 * Make sure this home's hooks are installed AND trusted, or say why not.
 *
 * The one call both the account wizard and a launch make, because a Codex home
 * with no hooks is the worst kind of broken: nothing fails. No SessionStart
 * ever fires, so the row's `cliSessionId` and `transcriptPath` stay null;
 * reconcile adopts the row as `running` after five minutes, so `ms status`
 * reads healthy; the watchdog never arms, so no wall is ever noticed — and
 * the first `ms rotate` finds no conversation to resume and respawns a plain
 * `codex`, replacing the human's conversation with an empty one.
 *
 * Idempotent, and cheap when there is nothing to do: an already-correct home
 * writes nothing and backs nothing up. `problem` is the installer's own
 * refusal, verbatim, plus the case where a write that claimed to succeed did
 * not produce an installed home — which is a refusal too, not a shrug.
 *
 * "Correct" is BOTH halves of what the renderer writes: the hooks installed
 * and trusted, AND the file still the one the base would render to. A home
 * whose hooks are fine but whose config predates a change to
 * `~/.codex/config.toml` is stale, not healthy — leaving it alone is how a
 * pane ends up running at default reasoning effort with no MCP servers, the
 * exact failure this renderer exists to end.
 */
export function ensureCodexHooks(homeDir: string, msBin: string): InstallResult {
  if (codexHooksInstalled(homeDir, msBin) && codexHomeConfigCurrent(homeDir, msBin)) return { changed: false, backup: null };
  const res = installCodexHooks(homeDir, msBin);
  if (res.problem) return res;
  if (!codexHooksInstalled(homeDir, msBin)) {
    return { ...res, problem: `${codexConfigPath(homeDir)}: the hooks are still not installed after writing them` };
  }
  return res;
}

/**
 * Make a codex home ready to receive a pane: trusted for `cwd`, and carrying
 * this binary's hooks. Trust first, because its dialog is the modal one — an
 * unattended pane that met it would sit in front of it forever with nobody to
 * answer — and the hooks second, for a subtler reason but the same shape: a
 * home with no hooks starts fine and reports NOTHING (see `ensureCodexHooks`
 * above), so the bill is deferred to the next rotation rather than refused
 * up front.
 *
 * The ONE call every path that is about to put a pane in this home makes —
 * `launchCodex`'s own `prepare` for a fresh launch, and a rotation's
 * `prepareCandidate` for a relaunch target — so the two can never drift: a
 * home good enough to launch into is good enough to rotate into, and a home
 * neither installer will touch is a candidate refusal in both places, not
 * just one.
 */
export function ensureCodexReady(homeDir: string, cwd: string, msBin: string): { problem: string } | null {
  try {
    const { problem } = ensureCodexTrust(homeDir, cwd);
    if (problem) return { problem };
  } catch (e) {
    return { problem: `cannot record directory trust in ${homeDir}: ${(e as Error).message}` };
  }
  try {
    const { problem } = ensureCodexHooks(homeDir, msBin);
    if (problem) return { problem: `${problem} — then run: ms doctor --fix` };
  } catch (e) {
    return { problem: `cannot install the codex hooks in ${homeDir}: ${(e as Error).message} (run: ms doctor --fix)` };
  }
  return null;
}

/** One `[[hooks.<Event>]]` table as the scan below sees it: its position
 * among the tables for that event (the trust key's matcher index) and the
 * `hooks = [...]` line it carried, if any. */
type Table = { index: number; command: string | null };

/**
 * A targeted scan for the two shapes this tool writes — `[[hooks.<Event>]]`
 * with its one-line `hooks = [...]`, and `[hooks.state."<key>"]` with its
 * `trusted_hash` — over the SAME strict classifier the installer uses, so the
 * two can never disagree about what a line says. It is not a TOML parser and
 * does not pretend to be one; a zero-dependency tool that had to parse TOML to
 * answer "are my hooks installed?" would be carrying a parser to read four
 * lines it wrote itself.
 *
 * `blocked` is set by a `hooks` header the classifier could not read. It makes
 * `codexHooksInstalled` answer false, which sends the caller to the installer,
 * which refuses with a message naming the line — rather than this reporting a
 * confident `true` about an index it could not compute.
 */
function scan(text: string): { tables: Map<string, Table[]>; trust: Map<string, string>; blocked: boolean } {
  const tables = new Map<string, Table[]>();
  const trust = new Map<string, string>();
  let blocked = false;
  let current: Table | null = null;
  let trustKeyNow: string | null = null;
  for (const raw of text.split("\n")) {
    const header = classify(raw);
    if (header) {
      current = null;
      trustKeyNow = null;
      if (header.kind === "event") {
        const list = tables.get(header.table) ?? [];
        current = { index: list.length, command: null };
        list.push(current);
        tables.set(header.table, list);
      } else if (header.kind === "state") {
        trustKeyNow = header.key;
      } else {
        blocked = true;
      }
      continue;
    }
    const line = stripComment(raw).trim();
    if (line === "") continue;
    if (line.startsWith("[")) { current = null; trustKeyNow = null; continue; }
    if (current && /^hooks\s*=/.test(line)) { current.command = line; continue; }
    const hash = trustKeyNow ? line.match(/^trusted_hash\s*=\s*"([^"]*)"$/) : null;
    if (hash) trust.set(trustKeyNow!, hash[1]);
  }
  return { tables, trust, blocked };
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
  const { tables, trust, blocked } = scan(text);
  if (blocked) return false;
  const cmd = codexHookCommand(msBin);
  const needle = `command = ${tomlString(cmd)}`;
  return EVENTS.every((e) => {
    const mine = (tables.get(e.table) ?? []).find((t) => (t.command ?? "").includes(needle));
    if (!mine) return false;
    return trust.get(trustKey(file, e.snake, mine.index)) === codexTrustedHash(e.snake, cmd, e.timeout);
  });
}

/**
 * True when `<homeDir>/config.toml` is already, byte for byte, what a render
 * would write: the base's configuration, our hooks, and the home's own
 * Codex-written state, in that order.
 *
 * This is the staleness question `codexHooksInstalled` cannot answer — it
 * reads four tables and four hashes and is blind to the model, the reasoning
 * effort and the MCP servers around them. A home that fails this has drifted
 * from `~/.codex/config.toml` (the human edited it, or added an MCP server)
 * and is one render away from correct, which is why `ms doctor` reports it as
 * a fixable problem rather than a state anybody has to reason about.
 *
 * A home the renderer REFUSES reads false, the same way a blocked home reads
 * false above: the caller goes to the installer, which states the refusal.
 */
export function codexHomeConfigCurrent(homeDir: string, msBin: string): boolean {
  const file = codexConfigPath(homeDir);
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return false; }
  const composed = compose(file, msBin, text);
  return "next" in composed && composed.next === text;
}

/** Always 0600, on every write and not only on the first. `config.toml` is
 * not a secret, but it names every project this account is trusted in and is
 * the file whose hooks decide what runs unattended; inheriting a mode a
 * previous writer chose (or a umask allowed) would mean a home that is
 * world-readable stays world-readable for ever. */
function writeAtomic(file: string, text: string): void {
  // Through any symlink (a dotfiles-managed config.toml stays a link), and
  // always 0600 — `writeAtomicThroughLink` re-chmods after the write because
  // writeFileSync's own `mode` is subject to the umask.
  writeAtomicThroughLink(file, text, { forceMode: 0o600 });
}
