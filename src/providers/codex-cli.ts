// src/providers/codex-cli.ts
//
// The pure parts of running the `codex` CLI as one of this tool's accounts:
// what the command line is, where the account's home is, and the one thing
// that home must say before a launch can start without a human in front of it.
//
// Nothing here touches the network, tmux, or the store. `src/launch.ts` calls
// it before a launch and `src/exec.ts` reads `codexHome` inside the pane.
//
// TRUST IS PER HOME, not per machine. Verified live on Codex 0.153.4: the
// first launch in a directory a home has not seen shows the modal "Do you
// trust the contents of this directory?", and answering it writes
// `[projects."<cwd>"] trust_level = "trusted"` into that home's
// `config.toml`. A tool that gives every account its OWN home therefore meets
// that modal once per (account, directory) pair — a modal no unattended
// launch and no rotation can answer. So the launcher writes the table itself,
// before the CLI starts — or REFUSES, and launches nothing, when the file
// already says something about `projects` that this writer cannot add to
// without risking the whole config (see `ensureCodexTrust`). It never writes
// blind, because an invalid config.toml is not a stray line: Codex drops the
// entire file, hook tables and previously granted trust included.
//
// The file is written 0600. These homes are the tool's own, one per account,
// sitting beside that account's `auth.json` in a 0700 directory — a config
// this tool creates is never wider than the credential it sits next to. A
// home the human keeps themselves is theirs, and nothing here widens it.

import { mkdirSync, readFileSync, renameSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { p } from "../paths.ts";

/** This account's CODEX_HOME. Re-exported from src/paths.ts so everything
 *  Codex-CLI-shaped is reachable from one module. */
export const codexHome = (name: string): string => p.codexHome(name);

/**
 * The argv tmux is told to run, as a launch records it.
 *
 * Codex has no `--session-id`: unlike Claude Code there is no way to name a
 * session at launch, so the flags are the user's own and nothing else. The
 * session's `cliSessionId` stays null until the hook's SessionStart reports
 * the id Codex chose.
 */
export function codexLaunchCommand(flags: string[]): string[] {
  return ["codex", ...flags];
}

/**
 * The argv that picks an existing Codex conversation back up, with the
 * continuation submitted as its first turn.
 *
 * Verified live on 0.153.4 (spike G1): `codex resume <id> "<prompt>"` resumes
 * the conversation — the prior turns re-render, SessionStart reports
 * `source: resume` under the SAME session id — and the prompt argument is
 * submitted automatically. So the continuation travels as an ARGUMENT here
 * exactly as it does for Claude Code, and nothing is ever typed into a
 * composer (Codex's own paste detection swallows a `send-keys` prompt that
 * arrives too fast, which is the other reason never to type one).
 *
 * `continuation` is null for a move the human asked for without one; the
 * session is then merely resumed, with no turn of ours at all.
 *
 * The id crosses accounts because every home of this tool links its
 * `sessions` at ONE rollout store (`p.codexSessions`), which is what makes a
 * rotation to another account able to resume the conversation at all.
 */
export function codexResumeCommand(cliSessionId: string, continuation: string | null, flags: string[]): string[] {
  return ["codex", "resume", cliSessionId, ...(continuation ? [continuation] : []), ...flags];
}

/** How a Codex pane is asked to leave: the keys, and how long the TUI is
 *  given to act on them before it is signalled instead. */
export type CodexExit = { keys: string[][]; settleMs: number };

/**
 * Ctrl-C, twice.
 *
 * Verified live (spike G1, Codex 0.153.4): `/exit` and `/quit` did nothing at
 * all in ~10 s — they are not commands this TUI knows — while Ctrl-C twice
 * ended it in about two seconds and fired its SessionEnd hook on the way out.
 * So a rotation asks a Codex pane to leave with the only thing that works,
 * and `settleMs` is the observed two seconds: past it the pane is signalled
 * (SIGTERM, then SIGKILL) by the caller's own bounded fallback.
 *
 * Unlike Claude Code's `/exit`, neither key is text: a Ctrl-C lands on a
 * modal as an interrupt, never as an answer to the question the human was
 * asked, which is why this sequence has no "a dialog is on screen" detour.
 */
export function codexExitSequence(): CodexExit {
  return { keys: [["C-c"], ["C-c"]], settleMs: 2_000 };
}

// --- The home's config.toml --------------------------------------------

const TRUSTED = `trust_level = "trusted"`;

/** A path as a TOML basic string. Paths with a quote or a backslash in them
 *  are legal on this platform and would otherwise produce a file Codex
 *  cannot parse — at which point it reads NO config, hooks included. */
function tomlString(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/** The inverse, for the few escapes `tomlString` can produce plus the `\uXXXX`
 *  form a human or another writer might. Anything unrecognised is kept as
 *  written, so an exotic escape can only ever fail to MATCH — never match the
 *  wrong project. */
function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, esc: string) => {
    switch (esc) {
      case "\\": return "\\";
      case '"': return '"';
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      default:
        if (esc[0] === "u" || esc[0] === "U") return String.fromCodePoint(parseInt(esc.slice(1), 16));
        return `\\${esc}`;
    }
  });
}
/**
 * Everything to the right of an unquoted `#` is a TOML comment. It is cut
 * before anything on a line is matched, because a header that ends in one —
 * `[projects."/a/b"] # added by hand` — is the SAME table as one that does
 * not, and a scanner that could not see that would append a second table for
 * a project the file already has. A `#` inside a quoted key is part of the
 * path and is left alone, which is why this walks the line instead of
 * splitting it.
 */
function stripComment(line: string): string {
  let basic = false;
  let literal = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (basic) {
      if (c === "\\") i++; // an escaped character, whatever it is
      else if (c === '"') basic = false;
      continue;
    }
    if (literal) {
      if (c === "'") literal = false; // a literal string has no escapes
      continue;
    }
    if (c === '"') basic = true;
    else if (c === "'") literal = true;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** A line that opens a table: `[x]`, `[[x]]`, or a dotted/quoted form of
 *  either. (A continuation line of a multi-line array value could also start
 *  with `[`; the cost of counting one as a table is that we stop looking for
 *  `trust_level` early, which at worst turns a launch into a refusal — never
 *  a corrupted file.) */
const opensTable = (line: string): boolean => line.trimStart().startsWith("[");

/** ONE quoted key segment, unquoted — or null for anything else: a bare key,
 *  a dotted pair like `"a"."b"`, an unterminated quote. Null always means
 *  "this tool cannot say which path that is", which is a refusal, never a
 *  reason to write. */
function unquoteKey(key: string): string | null {
  const k = key.trim();
  if (k.length >= 2 && k.startsWith('"') && k.endsWith('"')) {
    const body = k.slice(1, -1);
    // An UNescaped quote inside means the segment ended before the line did.
    if (/(?:^|[^\\])(?:\\\\)*"/.test(body)) return null;
    return unescapeBasic(body);
  }
  if (k.length >= 2 && k.startsWith("'") && k.endsWith("'")) {
    const body = k.slice(1, -1);
    if (body.includes("'")) return null; // literal strings cannot contain one
    return body;
  }
  return null;
}

/**
 * What a table header is, to this writer:
 *
 *   ours    `[projects."<our cwd>"]` — the table to add the key to
 *   theirs  `[projects."<some other path>"]` — read, and left alone
 *   opaque  a `projects` table this tool cannot attribute: `[projects]`,
 *           `[[projects…]]`, a bare or malformed key. Appending beside one
 *           risks defining the same table twice, which is not "a stray line"
 *           — an invalid config.toml makes Codex drop the WHOLE file, hook
 *           tables and existing trust with it. So it is a refusal.
 *   other   any other table; only its boundary matters
 */
type HeaderKind = "ours" | "theirs" | "opaque" | "other";

function classifyHeader(line: string, resolved: string): HeaderKind {
  const t = line.trim();
  const array = t.startsWith("[[");
  const [open, close] = array ? ["[[", "]]"] : ["[", "]"];
  // A header we cannot even delimit. It only concerns us if it is about
  // `projects`; anything else is just a boundary.
  if (t.length < open.length + close.length || !t.endsWith(close)) {
    return /^\[\[?\s*(?:projects|["']projects["'])\s*[.\]]?/.test(t) ? "opaque" : "other";
  }
  const inner = t.slice(open.length, t.length - close.length).trim();
  const m = /^(?:projects|"projects"|'projects')\s*(?:\.\s*([\s\S]*))?$/.exec(inner);
  if (!m) return "other";
  if (array) return "opaque"; // `[[projects…]]` is an array of tables, not ours
  const key = m[1];
  if (key === undefined) return "opaque"; // bare `[projects]`: its keys are inside it
  const named = unquoteKey(key);
  if (named === null) return "opaque";
  return named === resolved ? "ours" : "theirs";
}

/** A root-level `projects` of any shape — `projects = { … }`, or a dotted
 *  assignment like `projects."/a".trust_level = "trusted"`. Both define the
 *  same table this writer wants to add to, in a form it does not edit. */
const ROOT_PROJECTS = /^\s*(?:projects|"projects"|'projects')\s*[.=]/;

const TRUST_KEY = /^\s*trust_level\s*=([\s\S]*)$/;

/** The value as written, for a message a human has to act on: the inside of
 *  the quotes when it is a string, the raw text when it is anything else. */
function trustValue(rhs: string): string {
  const v = rhs.trim();
  const q = /^(["'])([\s\S]*)\1$/.exec(v);
  return q ? q[2]! : v;
}

/** Atomic within the home (temp + rename), 0600 — the file sits beside
 *  `auth.json` in a 0700 directory this tool owns, and is never wider than
 *  the credential it sits next to. */
function writeConfig(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** What `ensureCodexTrust` decided. `problem` is a refusal the caller reports
 *  verbatim and acts on by NOT launching: the file was left exactly as found
 *  and a human has to look at it. */
export type TrustResult = { changed: boolean; problem?: string };

/**
 * Make `cwd` a directory this account's Codex trusts, and say what that took.
 *
 * The cwd is resolved through symlinks first, because Codex records the
 * directory it actually resolved: a link and its target are ONE project, and
 * trusting the link would leave the modal waiting behind it.
 *
 * The file is edited by line scan, never re-serialised. This module is not a
 * TOML library and must not behave like one — `config.toml` also holds the
 * hook tables (`[[hooks.<Event>]]`) and their trust hashes
 * (`[hooks.state."…"]`), and a round trip through a parser-and-printer would
 * quietly reformat the hashes' own keys and cost the human their hook trust.
 * So exactly one of four things happens:
 *
 *   * no table for this project — append one at the end;
 *   * a table without a `trust_level` — insert the key just under its header;
 *   * a table whose `trust_level` is already `"trusted"` — nothing at all;
 *   * anything else — REFUSE, with a `problem` and not one byte written.
 *
 * The refusals are the point of the scan, and there are two of them. A
 * `trust_level` the human set to something else is an ANSWER, and this tool
 * does not overrule a human's answer about their own directory. And a
 * `projects` definition this scanner cannot attribute — an inline table, a
 * bare `[projects]`, a malformed header — must never be appended beside,
 * because two definitions of one table is invalid TOML and Codex responds to
 * an invalid config.toml by dropping the WHOLE of it: the hook tables, the
 * hook trust hashes and every directory the human has already trusted.
 * Refusing costs one launch; appending blind costs all of that silently.
 *
 * Every other byte of the file is left exactly as it was found.
 */
export function ensureCodexTrust(home: string, cwd: string): TrustResult {
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    // A cwd that no longer exists is the caller's problem, not this writer's:
    // record the absolute form and let the launch fail (or not) on its own.
    resolved = path.resolve(cwd);
  }

  const file = path.join(home, "config.toml");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeConfig(file, `[projects.${tomlString(resolved)}]\n${TRUSTED}\n`);
    return { changed: true };
  }

  const lines = text.split("\n");
  let header = -1; // this project's table header
  let trust = -1; // its `trust_level` key, if it has one
  let scope: HeaderKind = "other"; // "other" stands in for the root table too
  let root = true;
  let opaque = ""; // the first `projects` definition we cannot attribute
  for (let i = 0; i < lines.length && !opaque; i++) {
    const line = stripComment(lines[i]!);
    if (opensTable(line)) {
      scope = classifyHeader(line, resolved);
      root = false;
      if (scope === "opaque") opaque = `the table on line ${i + 1}`;
      else if (scope === "ours" && header < 0) header = i;
      continue;
    }
    if (root && ROOT_PROJECTS.test(line)) {
      opaque = `the inline 'projects' on line ${i + 1}`;
      continue;
    }
    if (scope === "ours" && header >= 0 && trust < 0 && TRUST_KEY.test(line)) trust = i;
  }

  if (opaque) {
    return {
      changed: false,
      problem:
        `${file} already defines 'projects' in a form this tool will not edit (${opaque}); ` +
        `add [projects.${tomlString(resolved)}] ${TRUSTED} to it yourself`,
    };
  }

  if (header >= 0 && trust >= 0) {
    const rhs = TRUST_KEY.exec(stripComment(lines[trust]!))![1]!;
    const value = trustValue(rhs);
    if (value === "trusted") return { changed: false };
    // The human said otherwise about their own directory. That is an answer,
    // not a stale entry, and this tool does not overrule it.
    return { changed: false, problem: `${resolved} is marked ${value} in ${file}; edit it or launch elsewhere` };
  }

  if (header < 0) {
    const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    writeConfig(file, `${text}${sep}[projects.${tomlString(resolved)}]\n${TRUSTED}\n`);
    return { changed: true };
  }
  lines.splice(header + 1, 0, TRUSTED);
  writeConfig(file, lines.join("\n"));
  return { changed: true };
}
