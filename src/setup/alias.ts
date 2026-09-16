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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The EXACT shape `block()` produces, for validating a block found on disk
 * before `removeAlias` ever deletes it — a hand edit (an extra line, a
 * renamed alias, a different binary in one line than the other) must refuse,
 * never be guessed at and silently dropped. Each alias's VALUE is `<bin>
 * claude`/`<bin> codex` (the whole command, not just the binary), so the
 * captures strip that fixed suffix to get at `<bin>` itself — that is what
 * the caller compares between the two lines, not the raw captured text
 * (which is never equal to itself between the two lines even when the block
 * is exactly what `installAlias` writes). */
const EXPECTED_BLOCK_RE = new RegExp(`^${escapeRegExp(BEGIN)}\\nalias claude='(.*) claude'\\nalias codex='(.*) codex'\\n${escapeRegExp(END)}$`);

/**
 * Finds the marker block using LINE boundaries only (never trimmed), so
 * `rawBefore`/`rawAfter` are the exact bytes immediately outside the block —
 * whatever they are. `null` when there is no `# ms-alias-begin` at all
 * (nothing installed yet); `undefined` when one is there with no matching
 * `# ms-alias-end` — a state this tool refuses to touch rather than
 * guessing where "ours" stops.
 */
type Located = { rawBefore: string; blockText: string; rawAfter: string };
function locate(text: string): Located | null | undefined {
  const lines = text.split("\n");
  const beginIdx = lines.findIndex((l) => BEGIN_RE.test(l));
  if (beginIdx < 0) return null;
  const endIdx = lines.findIndex((l, i) => i > beginIdx && END_RE.test(l));
  if (endIdx < 0) return undefined;

  const offsets: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") offsets.push(i + 1);
  const blockStart = offsets[beginIdx]!;
  const blockEnd = offsets[endIdx]! + lines[endIdx]!.length; // right after END's own text, before its "\n"
  return { rawBefore: text.slice(0, blockStart), blockText: text.slice(blockStart, blockEnd), rawAfter: text.slice(blockEnd) };
}

/**
 * `rawBefore`/`rawAfter` (from `locate`) always carry exactly one MORE
 * newline than the content that was there before a block existed, because a
 * marker line is by definition preceded/followed by a "\n" (or nothing, at
 * the very start/end of the file) — `text.split("\n")` guarantees it
 * structurally, whatever the file's own conventions are. Stripping that one
 * guaranteed byte (only when non-empty; an empty side never had one added)
 * recovers the surrounding content exactly as it stood before any block was
 * spliced in — the exact inverse of `spliceIn` below, independent of
 * whether the file originally ended in a newline at all.
 */
function stripSep(rawBefore: string, rawAfter: string): { pre: string; post: string } {
  return {
    pre: rawBefore.length === 0 ? "" : rawBefore.slice(0, -1),
    post: rawAfter.length === 0 ? "" : rawAfter.slice(1),
  };
}

/** The exact inverse of `stripSep`: reinsert `blockText` between `pre` and
 * `post`, adding exactly one newline of separation on each side that has any
 * content — never two, never none — so splicing in and then locating +
 * stripping right back out reproduces `pre + post` byte for byte, whatever
 * `pre`/`post` themselves end or start with. */
function spliceIn(pre: string, blockText: string, post: string): string {
  const before = pre.length === 0 ? "" : `${pre}\n`;
  const after = post.length === 0 ? "" : `\n${post}`;
  return before + blockText + after;
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
  const located = locate(text);
  if (located === undefined) {
    return {
      changed: false,
      backup: null,
      problem: `${rcPath}: a '${BEGIN}' marker with no '${END}'; repair or remove that block by hand, refusing to overwrite everything below it`,
    };
  }
  // No block yet: the whole file is "pre", appended to as is — nothing to
  // strip a separator from, because no separator has ever been added. A
  // block already there (any binary, any content — install always replaces
  // rather than validating) recovers the true surrounding bytes first, so
  // re-pointing at a new binary never nests one wrapper's block inside
  // another's separator.
  const { pre, post } = located === null ? { pre: text, post: "" } : stripSep(located.rawBefore, located.rawAfter);
  const next = spliceIn(pre, block(msBin), post);
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
 * Undo `installAlias`: remove exactly the `ms-alias` block, restoring every
 * other byte — including the file's own trailing-newline convention — the
 * way `installAlias` found it. A file with no block, or a missing file, is
 * left untouched: `changed: false`, no backup. A block whose content does
 * not match exactly what `installAlias` writes (a hand edit — an extra line,
 * a renamed alias, mismatched binaries between the two lines) is refused
 * rather than deleted: this tool cannot tell a human's edit from something
 * safe to discard, so it never guesses.
 */
export function removeAlias(rcPath: string): AliasResult {
  if (!existsSync(rcPath)) return { changed: false, backup: null };
  const text = readFileSync(rcPath, "utf8");
  const located = locate(text);
  if (located === null) return { changed: false, backup: null }; // nothing installed
  if (located === undefined) {
    return {
      changed: false,
      backup: null,
      problem: `${rcPath}: a '${BEGIN}' marker with no '${END}'; repair or remove that block by hand, refusing to touch it`,
    };
  }
  const m = EXPECTED_BLOCK_RE.exec(located.blockText);
  if (!m || m[1] !== m[2]) {
    return {
      changed: false,
      backup: null,
      problem: `${rcPath}: the '${BEGIN}' … '${END}' block does not match what this tool writes (hand-edited?); remove it by hand, refusing to guess`,
    };
  }

  const { pre, post } = stripSep(located.rawBefore, located.rawAfter);
  const next = pre + post;

  const backup = `${rcPath}.bak-ms-${Math.floor(Date.now() / 1000)}`;
  copyFileSync(rcPath, backup);
  writeAtomic(rcPath, next);
  return { changed: true, backup };
}

/**
 * Where the alias block goes for a given shell, rooted at `home` (so tests
 * never touch the real one). `shell` is matched on its basename, so a full
 * `$SHELL` value (`/bin/zsh`, `/opt/homebrew/bin/fish`) works exactly like
 * the bare name — the wizard reads `$SHELL`, and that is always a path, never
 * a name. `zsh` always gets `.zshrc`; `bash` prefers an existing
 * `.bash_profile` (what macOS's default Bash reads for a login shell) and
 * falls back to `.bashrc`. Anything else — fish included — has no safe
 * rc-file convention this tool can append shell-agnostic `alias` lines to, so
 * it returns `null` and the wizard prints the two lines for the human to add
 * by hand.
 */
export function rcPathFor(shell: string, home: string): string | null {
  const name = path.basename(shell);
  if (name === "zsh") return path.join(home, ".zshrc");
  if (name === "bash") {
    const bashProfile = path.join(home, ".bash_profile");
    return existsSync(bashProfile) ? bashProfile : path.join(home, ".bashrc");
  }
  return null;
}
