// src/setup/alias.ts
//
// The shell alias opt-in (Plan 3 Task 3): `alias claude='<msBin> claude'`
// and `alias codex='<msBin> codex'` in the human's rc file, so plain
// `claude`/`codex` on the command line go through this tool without the
// human having to remember to type `ms`.
//
// The rc file is not ours: it is the human's `.zshrc`/`.bash_profile`, full
// of their own exports, prompts and other aliases. So — same discipline as
// `hooks/codex-install.ts`'s `config.toml` writer — this owns exactly one
// block, delimited by marker comments, and copies every other byte through
// unchanged. Unlike that installer there is nothing here to parse or trust:
// two `alias` lines are the whole of it, so install/remove is a straight
// block splice rather than a scan for pre-existing tables.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AliasResult = { changed: boolean; backup: string | null; problem?: string };

const BEGIN = "# ms-alias-begin";
const END = "# ms-alias-end";
const BEGIN_RE = /^\s*# ms-alias-begin\b/;
const END_RE = /^\s*# ms-alias-end\b/;

/** The block this tool owns, markers included, for a given binary. */
function block(msBin: string): string {
  return [BEGIN, `alias claude='${msBin} claude'`, `alias codex='${msBin} codex'`, END].join("\n");
}

/** Lines outside the block this tool owns: everything before `# ms-alias-begin`
 * and everything after `# ms-alias-end`. A file with no markers is all
 * prefix, so a first install appends. A begin with no end is NOT ours to the
 * end of the file — a hand edit could have anything below it — so that is
 * reported as `null` rather than guessed at; the caller turns it into a
 * refusal instead of ever truncating unknown content. */
function split(text: string): { prefix: string[]; suffix: string[] } | null {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => BEGIN_RE.test(l));
  if (begin < 0) return { prefix: lines, suffix: [] };
  const end = lines.findIndex((l, i) => i > begin && END_RE.test(l));
  if (end < 0) return null;
  return { prefix: lines.slice(0, begin), suffix: lines.slice(end + 1) };
}

/** Join non-empty pieces with exactly one blank line between them, and end
 * the file with exactly one trailing newline (none at all for an empty
 * file). This is what makes a second `installAlias` for the SAME binary
 * byte-identical to the first — `changed` stays honest — and what makes
 * `removeAlias` reconstruct the surrounding content exactly. */
function assemble(pieces: string[]): string {
  const nonEmpty = pieces.filter((x) => x !== "");
  return nonEmpty.length ? `${nonEmpty.join("\n\n")}\n` : "";
}

/** The lines BEFORE the block, trailing blank lines trimmed (so a second
 * install produces the same bytes as the first). Leading content is left
 * exactly as found — a file legitimately starting with a blank line keeps
 * it. */
function head(lines: string[]): string {
  return lines.join("\n").replace(/\n+$/, "");
}

/** The lines AFTER the block, blank lines trimmed on both sides — mirrors
 * `hooks/codex-install.ts`'s `tail`, so the one blank line `assemble` adds
 * on either side of the block is the only one, however many the file had. */
function tail(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

function writeAtomic(file: string, text: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

/**
 * Append (or, for a different binary, replace) the `ms` alias block in
 * `rcPath`.
 *
 * The file is backed up (`<rc>.bak-ms-<unix seconds>`) before the first
 * change and created (0644, parents included) when missing. A second call
 * for the SAME binary is a no-op: `changed: false`, no backup, file
 * untouched. A begin marker with no matching end is refused rather than
 * risking the human's own configuration below it.
 */
export function installAlias(rcPath: string, msBin: string): AliasResult {
  const existed = existsSync(rcPath);
  const text = existed ? readFileSync(rcPath, "utf8") : "";
  const parts = split(text);
  if (!parts) {
    return {
      changed: false,
      backup: null,
      problem: `${rcPath}: a '${BEGIN}' marker with no '${END}'; repair or remove that block by hand, refusing to overwrite everything below it`,
    };
  }
  const { prefix, suffix } = parts;
  const next = assemble([head(prefix), block(msBin), tail(suffix)]);
  if (existed && next === text) return { changed: false, backup: null };

  let backup: string | null = null;
  if (existed) {
    backup = `${rcPath}.bak-ms-${Math.floor(Date.now() / 1000)}`;
    copyFileSync(rcPath, backup);
  } else {
    mkdirSync(path.dirname(rcPath), { recursive: true });
  }
  writeAtomic(rcPath, next);
  return { changed: true, backup };
}

/**
 * Undo `installAlias`: remove exactly the `ms-alias` block, leaving every
 * other byte the way `installAlias` found it. A file with no block, or a
 * missing file, is left untouched: `changed: false`, no backup.
 */
export function removeAlias(rcPath: string): AliasResult {
  if (!existsSync(rcPath)) return { changed: false, backup: null };
  const text = readFileSync(rcPath, "utf8");
  if (!text.includes(BEGIN)) return { changed: false, backup: null }; // nothing to remove
  const parts = split(text);
  if (!parts) {
    return {
      changed: false,
      backup: null,
      problem: `${rcPath}: a '${BEGIN}' marker with no '${END}'; repair or remove that block by hand, refusing to touch it`,
    };
  }
  const { prefix, suffix } = parts;
  const next = assemble([head(prefix), tail(suffix)]);
  if (next === text) return { changed: false, backup: null };

  const backup = `${rcPath}.bak-ms-${Math.floor(Date.now() / 1000)}`;
  copyFileSync(rcPath, backup);
  writeAtomic(rcPath, next);
  return { changed: true, backup };
}

/**
 * Where the alias block goes for a given shell, rooted at `home` (so tests
 * never touch the real one). `zsh` always gets `.zshrc`; `bash` prefers an
 * existing `.bash_profile` (what macOS's default Bash reads for a login
 * shell) and falls back to `.bashrc`. Anything else — fish included — has no
 * safe rc-file convention this tool can append shell-agnostic `alias` lines
 * to, so it returns `null` and the wizard prints the two lines for the human
 * to add by hand.
 */
export function rcPathFor(shell: string, home: string): string | null {
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") {
    const bashProfile = path.join(home, ".bash_profile");
    return existsSync(bashProfile) ? bashProfile : path.join(home, ".bashrc");
  }
  return null;
}
