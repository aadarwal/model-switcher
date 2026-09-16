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
// before the CLI starts.

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

/** A line that opens a table: `[x]`, `[[x]]`, or a dotted/quoted form of
 *  either. (A continuation line of a multi-line array value could also start
 *  with `[`; the cost of counting one as a table is that we stop looking for
 *  `trust_level` early and write the key we are about to write into a new
 *  table instead of an old one — never a corrupted file.) */
const opensTable = (line: string): boolean => line.trimStart().startsWith("[");

/**
 * The project a table header names, or null when it names something else.
 *
 * Only the quoted forms can name a path — `[projects."/a/b"]` and its literal
 * `'…'` variant — because an absolute path contains `/` and `.`, neither of
 * which a TOML bare key admits.
 */
function projectOf(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("[") || t.startsWith("[[") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1).trim();
  if (!inner.startsWith("projects.")) return null;
  const key = inner.slice("projects.".length).trim();
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) return unescapeBasic(key.slice(1, -1));
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1); // literal: no escapes
  return null;
}

const TRUST_KEY = /^\s*trust_level\s*=/;
const ALREADY_TRUSTED = /^\s*trust_level\s*=\s*(["'])trusted\1\s*(#.*)?$/;

/** Atomic within the home (temp + rename), 0600 — the file sits beside
 *  `auth.json` in a 0700 directory and is never world-readable. */
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

/**
 * Make `cwd` a directory this account's Codex trusts, and say whether that
 * took a write.
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
 * So exactly one of three things happens:
 *
 *   * no table for this project — append one at the end;
 *   * a table with a `trust_level` — rewrite that ONE line if it is not
 *     already `"trusted"` (a second key in the same table is a TOML error);
 *   * a table without one — insert the key just under its header.
 *
 * Every other byte of the file is left exactly as it was found.
 */
export function ensureCodexTrust(home: string, cwd: string): { changed: boolean } {
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
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (opensTable(line)) {
      const project = projectOf(line);
      inside = project === resolved;
      if (inside && header < 0) header = i;
      continue;
    }
    if (inside && header >= 0 && trust < 0 && TRUST_KEY.test(line)) trust = i;
  }

  if (header < 0) {
    const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    writeConfig(file, `${text}${sep}[projects.${tomlString(resolved)}]\n${TRUSTED}\n`);
    return { changed: true };
  }
  if (trust >= 0) {
    if (ALREADY_TRUSTED.test(lines[trust]!)) return { changed: false };
    lines[trust] = TRUSTED;
  } else {
    lines.splice(header + 1, 0, TRUSTED);
  }
  writeConfig(file, lines.join("\n"));
  return { changed: true };
}
