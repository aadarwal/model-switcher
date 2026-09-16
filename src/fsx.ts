// src/fsx.ts
//
// The three filesystem manners every installer in this tool keeps, in one
// place so they cannot drift apart between the Claude settings writer, the
// Codex `config.toml` writer, the statusline writer and the shell-rc writer.
//
//  1. **A symlinked target stays a symlink.** `~/.claude/settings.json`,
//     `~/.zshrc` and a Codex `config.toml` are routinely links into a
//     chezmoi/stow/dotfiles checkout. `renameSync(tmp, file)` over the LINK
//     replaces the link with a regular file: the dotfiles copy silently goes
//     stale, and the backup — being content only — cannot restore the link.
//     So every write resolves the link chain first and renames over the REAL
//     file, in the real file's own directory (same filesystem, so the rename
//     stays atomic).
//
//  2. **A backup never clobbers another backup.** Names carry a millisecond
//     timestamp, and a counter on the (pathological) chance that name is
//     taken — three re-points inside one second used to leave one file.
//
//  3. **A path that goes into a shell command line is quoted once, here.** A
//     space in the path is the common case (a checkout under "Application
//     Support"); a `'` is the rare one that breaks single-quoting outright.

import { chmodSync, copyFileSync, existsSync, lstatSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** How deep a symlink chain this will follow before giving up. The same
 * order of magnitude as the kernel's own ELOOP limit; a chain longer than
 * this is a loop, and the answer is to write nowhere rather than spin. */
const MAX_LINK_DEPTH = 40;

/**
 * The real file behind `file`, following a symlink chain by hand.
 *
 * Deliberately NOT `realpathSync`: that throws on a DANGLING link (a dotfiles
 * checkout not yet cloned), and the caller would then fall back to writing
 * over the link itself — the exact severing this exists to prevent. Reading
 * the link and resolving it against its own directory answers for a dangling
 * link too. A missing file, an unreadable one, or a loop all answer with the
 * path as given, which is what every caller wants: create it there.
 */
export function resolveTarget(file: string): string {
  let current = file;
  for (let depth = 0; depth < MAX_LINK_DEPTH; depth++) {
    let st;
    try {
      st = lstatSync(current);
    } catch {
      return current; // nothing there (yet) — this is where it goes
    }
    if (!st.isSymbolicLink()) return current;
    let link: string;
    try {
      link = readlinkSync(current);
    } catch {
      return current;
    }
    current = path.resolve(path.dirname(current), link);
  }
  return current;
}

/**
 * Write `text` over `file` atomically, through any symlink.
 *
 * `forceMode` is the mode every write gets, whatever was there before (the
 * Codex `config.toml` writer's 0600). `defaultMode` is the mode only a file
 * that does not exist yet gets; an existing file keeps its own, because a
 * human's `.zshrc` at 0644 is theirs to decide. `chmodSync` after the write
 * because `writeFileSync`'s own `mode` is subject to the umask.
 */
export function writeAtomicThroughLink(file: string, text: string, opts: { defaultMode?: number; forceMode?: number } = {}): void {
  const target = resolveTarget(file);
  const mode = opts.forceMode ?? (existsSync(target) ? statSync(target).mode & 0o777 : (opts.defaultMode ?? 0o600));
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
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
 * Copy `file` aside before it is changed, and return where it went.
 *
 * `suffix` is the family name (`bak-ms-`, `bak-`) the callers already use, so
 * a human who knows one installer's backups recognises them all. The name
 * carries MILLISECONDS, not seconds, plus a counter if even that collides —
 * a backup that overwrites the previous backup is not a backup. Always 0600:
 * a copy of a settings file or an rc file is nobody else's business, however
 * wide the original's own mode happens to be.
 */
export function backupThroughLink(file: string, suffix: string): string {
  const target = resolveTarget(file);
  const base = `${target}.${suffix}${Date.now()}`;
  let candidate = base;
  for (let n = 1; existsSync(candidate); n++) candidate = `${base}-${n}`;
  copyFileSync(target, candidate);
  chmodSync(candidate, 0o600);
  return candidate;
}

/**
 * `s` as ONE word of a POSIX shell command line.
 *
 * Single quotes, because they quote everything — except a single quote
 * itself, which cannot appear inside them at all. The standard escape is to
 * close the quoted run, emit a backslash-escaped quote outside it, and open a
 * new one: `it's` becomes `'it'\''s'`. Every shell string this tool writes —
 * the Claude hook command, the statusline wrapper, the two alias lines —
 * goes through here, so there is one answer to "what happens to a path with a
 * space (or a quote) in it" rather than four.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
