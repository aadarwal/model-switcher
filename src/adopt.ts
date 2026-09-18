// src/adopt.ts
//
// `ms adopt <rollout-id>`: take over a Codex conversation this tool did not
// start.
//
// The rescue this automates happened by hand on 2026-09-17. Two `codex --yolo`
// panes, started outside `ms` in the default `~/.codex` home, hit a real weekly
// wall. `ms` could not move them: it manages the sessions it launched, and
// these had no row, no account of ours and — the part that actually blocks —
// no rollout in the store every `ms` Codex home shares (`p.codexSessions`).
// Resuming a conversation whose rollout Codex cannot find is not a rotation
// that fails, it is a conversation that is simply not there.
//
// So this verb is three steps, and the middle one is the whole reason it
// exists:
//
//   1. find the rollout under the caller's OWN Codex home (`$CODEX_HOME`, else
//      `~/.codex`), by id or by path;
//   2. copy it AND ITS LINEAGE into the shared store, keeping Codex's own
//      `YYYY/MM/DD` layout — because a COMPACTED conversation's rollout does
//      not contain its own history. It carries `history_base`, a pointer at
//      the rollout holding the prefix, and Codex walks that chain on resume
//      (`codex-rs/thread-store/src/local/rollout_lineage.rs`,
//      `resolve_rollout_lineage`). Copy only the leaf and the resume dies with
//      `invalid paginated history lineage for <id>: missing source rollout` —
//      which is exactly what the hand-rescue hit, and exactly the error that
//      names the field;
//   3. launch it, in this pane, as `ms codex [--as] -- <args> resume <id>`.
//
// Nothing here writes to the source. The files are COPIED — never moved, never
// modified, never overwritten in the destination — so a rescue that goes wrong
// leaves the human's own `~/.codex` exactly as it was, and a second `ms adopt`
// of the same conversation is a no-op rather than a file swap under a running
// CLI.

import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { launchWith } from "./launch.ts";
import { ensureStore, p } from "./paths.ts";
import { Tmux, currentPane, tmuxFromEnv } from "./tmux.ts";

const EXIT_REFUSED = 1;
const EXIT_USAGE_ERROR = 2;

const USAGE = `usage: ms adopt <rollout-id|path> [--as <account>] [--continue] [-- <codex args>]
  Codex only in this release. Run it in the pane whose codex you have just exited.`;

const say = (msg: string, detail: string[] = []): void => {
  process.stderr.write(`ms adopt: ${msg}\n${detail.map((l) => `  ${l}\n`).join("")}`);
};

// --- The caller's own Codex home ---------------------------------------

/**
 * Where the conversation being rescued lives NOW: the human's own Codex home,
 * not ours. `CODEX_HOME` is Codex's own override and is read from the caller's
 * environment on purpose — a human who runs Codex out of a non-default home is
 * the one person for whom `~/.codex` is the wrong answer.
 */
export function sourceSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : path.join(env.HOME || homedir(), ".codex");
  return path.join(home, "sessions");
}

// --- Rollout filenames --------------------------------------------------

/**
 * The two ids a rollout filename carries, per Codex's own parser
 * (`codex-rs/rollout/src/rollout_file_name.rs`): `rollout-<19-char
 * timestamp>-<thread-id>.jsonl`, where thread id and rollout id are the same —
 * except for a reverted thread, whose name is
 * `rollout-<ts>-<thread-id>_<rollout-id>.jsonl` and whose ROLLOUT id is the
 * one after the underscore.
 *
 * Both are matched when the human names an id, because both are ids a human
 * legitimately has: `codex resume` is given a thread id, while the lineage
 * pointers this module follows are rollout ids.
 */
export function rolloutIdsFromName(name: string): { threadId: string; rolloutId: string } | null {
  const core = name.startsWith("rollout-") && name.endsWith(".jsonl") ? name.slice("rollout-".length, -".jsonl".length) : null;
  if (!core || core.length < 21 || core[19] !== "-") return null;
  const ids = core.slice(20);
  if (!ids) return null;
  const i = ids.indexOf("_");
  return i < 0 ? { threadId: ids, rolloutId: ids } : { threadId: ids.slice(0, i), rolloutId: ids.slice(i + 1) };
}

/** `YYYY/MM/DD` from the filename's own timestamp — Codex's `rollout_date_parts`.
 *  Null when the name is not canonical, which is a file we will not invent a
 *  place for. */
export function datePartsFromName(name: string): string[] | null {
  if (!name.startsWith("rollout-")) return null;
  const date = name.slice("rollout-".length, "rollout-".length + 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return [date.slice(0, 4), date.slice(5, 7), date.slice(8, 10)];
}

/** Every `rollout-*.jsonl` under a sessions root, depth-first. A directory we
 *  cannot read is skipped rather than fatal: the store is the human's, and one
 *  unreadable day must not make the whole rescue impossible. */
export function listRollouts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * The rollout a given id names, under one sessions root.
 *
 * A rollout id is exact and wins; a thread id can in principle name more than
 * one file (a reverted thread keeps its thread id across a new rollout), and
 * there the NEWEST is the live one — the same choice Codex's own
 * `find_thread_path_by_id_str` makes.
 */
export function findRollout(root: string, id: string): string | null {
  const files = listRollouts(root);
  const byThread: string[] = [];
  for (const f of files) {
    const ids = rolloutIdsFromName(path.basename(f));
    if (!ids) continue;
    if (ids.rolloutId === id) return f;
    if (ids.threadId === id) byThread.push(f);
  }
  if (!byThread.length) return null;
  return byThread.sort()[byThread.length - 1]!;
}

// --- The lineage --------------------------------------------------------

/**
 * Every rollout id this file names as a source of its own history.
 *
 * The field is `history_base` on the rollout's `session_meta` payload — a
 * `HistoryPosition { thread_id, end_ordinal_exclusive, end_byte_offset }`,
 * where `thread_id` is documented in Codex's own protocol as "Rollout ID for
 * the immutable prefix file … Treat its value as a rollout_id"
 * (`codex-rs/protocol/src/protocol.rs`, `HistoryPosition`). `resolve_rollout_lineage`
 * follows exactly that pointer, file to file, until one has none.
 *
 * Read line by line rather than by parsing the meta record's exact shape: a
 * rollout is append-only JSONL written by a CLI that adds records between
 * releases, and the one thing this has to be right about is which OTHER files
 * are needed. Any line carrying a `history_base` with a `thread_id` is such a
 * pointer, wherever the format later puts it. A line we cannot parse is
 * skipped — a torn last line is normal in a file a live CLI is appending to.
 */
export function lineageIds(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes("history_base")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    const visit = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      const o = v as Record<string, unknown>;
      const base = o.history_base;
      if (base && typeof base === "object" && !Array.isArray(base)) {
        const id = (base as Record<string, unknown>).thread_id;
        if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
      }
      for (const x of Object.values(o)) visit(x);
    };
    visit(parsed);
  }
  return ids;
}

export type AdoptCopy = {
  /** Files written into the store by this run. */
  copied: string[];
  /** Files already in the store, byte for byte, and left exactly as they were. */
  kept: string[];
  /** A destination that exists and is NOT the source. Never silently kept: the
   *  store's copy is what Codex will read, so a rollout that disagrees with the
   *  conversation it claims to be is the one thing a rescue must not resume
   *  over. Named, and refused by the verb. */
  mismatched: { dest: string; from: string }[];
  /** Lineage ids this chain names with no file to copy for them. Codex refuses
   *  such a resume outright, so nothing is copied and nothing is launched. */
  missing: string[];
};

/** Content identity, for a destination that already exists. Size first because
 *  it settles almost every case without reading a byte; the digest is what
 *  makes "already there" a fact rather than a filename coincidence — and it is
 *  what catches the file a killed `ms adopt` left half-written. */
function sameFile(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    const digest = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    return digest(a) === digest(b);
  } catch {
    return false; // unreadable is not "the same"
  }
}

/**
 * The whole chain of rollout FILES one rollout needs, leaf first.
 *
 * Resolving before copying is the point: a lineage Codex cannot complete is a
 * resume it refuses, so the verb has to know that BEFORE it writes anything
 * into the store or touches a pane. `seen` bounds the walk — a cycle is
 * malformed (Codex's own `resolve_rollout_lineage` errors "cycle detected")
 * and here it simply terminates.
 */
export function resolveLineage(sourceRoot: string, leaf: string): { files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [path.resolve(leaf)];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const id of lineageIds(file)) {
      const found = findRollout(sourceRoot, id);
      if (found) queue.push(path.resolve(found));
      else if (!missing.includes(id)) missing.push(id);
    }
  }
  return { files, missing };
}

/**
 * Put resolved rollouts into the store, in Codex's own `YYYY/MM/DD` layout.
 *
 * Two rules, and they are the ones a rescue is judged on:
 *
 *   * **Never overwrite.** A destination that already exists is compared, not
 *     replaced — identical is `kept`, anything else is `mismatched` and the
 *     run refuses. The store's copy may be a file a live CLI is appending to.
 *   * **Never leave a partial file.** The bytes land on a temp name in the
 *     DESTINATION directory (same filesystem, so the rename is atomic) and are
 *     renamed into place only once the whole copy has succeeded. A run killed
 *     mid-copy leaves a `.tmp` nobody reads, never a truncated rollout under a
 *     real conversation's name — which the first version of this did, and
 *     which the next run then reported as "already there".
 *
 *     That second rule is deliberately untested, because on this platform it
 *     is untestable: every way `copyFileSync` can FAIL (a missing source, a
 *     directory, an unreadable file) errors before the destination is created
 *     at all, a FIFO source returns immediately rather than blocking, and APFS
 *     clones rather than streams — so no test here can hold a copy open long
 *     enough to kill it. The hazard is real anyway (a large rollout, a slower
 *     volume, a SIGKILL), and costs one rename to remove. The rule that IS
 *     tested is the one above it.
 */
export function copyResolved(store: string, files: string[]): AdoptCopy {
  const out: AdoptCopy = { copied: [], kept: [], mismatched: [], missing: [] };
  // Classify every destination BEFORE writing any of them, so one rollout the
  // store disagrees with stops the whole rescue rather than being reported
  // beside files this run had already added.
  const todo: { file: string; dest: string; dir: string }[] = [];
  for (const file of files) {
    const name = path.basename(file);
    const parts = datePartsFromName(name);
    const dir = parts ? path.join(store, ...parts) : store;
    const dest = path.join(dir, name);
    if (existsSync(dest)) {
      if (sameFile(file, dest)) out.kept.push(dest);
      else out.mismatched.push({ dest, from: file });
      continue;
    }
    todo.push({ file, dest, dir });
  }
  if (out.mismatched.length) return out;
  for (const { file, dest, dir } of todo) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // The store is ours and is 0700/0600 throughout, whatever mode the
      // source wears.
      copyFileSync(file, tmp, constants.COPYFILE_EXCL);
      chmodSync(tmp, 0o600);
      // `existsSync` above is the never-overwrite rule; this rename is the
      // never-partial one. The only way the two disagree is a second `ms
      // adopt` of the same conversation running at this instant — which is
      // writing identical bytes from the same source file.
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    out.copied.push(dest);
  }
  return out;
}

/**
 * Copy one rollout and everything its history points at into the shared store.
 *
 * A lineage with a missing source copies NOTHING: Codex refuses that resume
 * (`invalid paginated history lineage for <id>: missing source rollout`), so
 * putting half a chain in the store would be writing files to enable a launch
 * that cannot work.
 */
export function copyLineage(sourceRoot: string, store: string, leaf: string): AdoptCopy {
  const { files, missing } = resolveLineage(sourceRoot, leaf);
  if (missing.length) return { copied: [], kept: [], mismatched: [], missing };
  return copyResolved(store, files);
}

// --- The verb -----------------------------------------------------------

type AdoptArgs = { id: string; as: string | null; continueAfter: boolean; args: string[] };

export function parseAdoptArgs(argv: string[]): AdoptArgs | { error: string } {
  let id: string | null = null;
  let as: string | null = null;
  let continueAfter = false;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a === "--continue") { continueAfter = true; continue; }
    if (a === "--as" || a.startsWith("--as=")) {
      const v = a.startsWith("--as=") ? a.slice("--as=".length) : argv[++i];
      if (!v) return { error: "--as needs an account name" };
      as = v;
      continue;
    }
    if (a.startsWith("-")) return { error: `unexpected argument ${JSON.stringify(a)} — put codex's own arguments after --` };
    if (id !== null) return { error: `unexpected argument ${JSON.stringify(a)} — put codex's own arguments after --` };
    id = a;
  }
  if (!id) return { error: "needs a rollout id (or a path to one)" };
  return { id, as, continueAfter, args };
}

/**
 * The sessions root a file's LINEAGE should be looked up under.
 *
 * A rollout given by path still names its sources by id, and those files live
 * beside it under the same `sessions/` root — three levels up, past
 * `YYYY/MM/DD` — not in the one day directory it happens to sit in. A path
 * that is not in that shape has no root of its own to offer, and the caller's
 * own Codex home is the honest place to look.
 */
export function lineageRootFor(file: string): string | null {
  const up = path.resolve(path.dirname(file), "..", "..", "..");
  return path.basename(up) === "sessions" ? up : null;
}

/**
 * Is the pane we are about to respawn still running a CLI?
 *
 * `ms adopt` replaces this pane's command, so a codex still in it would be
 * killed mid-conversation — and its rollout is the file we are copying. The
 * human exits it first; that is the whole instruction, and it is the one
 * refusal this verb has to get right. Null from tmux means "could not ask",
 * which is never evidence of anything (src/tmux.ts) and never a refusal.
 */
function paneStillRunsCodex(tmux: Tmux, pane: string | null): boolean {
  if (!pane) return false;
  const info = tmux.paneInfo(pane);
  return !!info && !info.dead && /(^|\/)codex$/.test(String(info.command ?? ""));
}

/** `ms adopt <rollout-id> [--as <account>] [--continue] [-- <codex args>]`. */
export const adoptVerb: Verb = async (argv) => {
  const parsed = parseAdoptArgs(argv);
  if ("error" in parsed) { say(parsed.error); process.stderr.write(USAGE + "\n"); return EXIT_USAGE_ERROR; }

  // The pane first: everything below writes into the store, and a refusal
  // after a copy is a refusal that left something behind.
  const pane = currentPane();
  if (pane && paneStillRunsCodex(tmuxFromEnv(), pane)) {
    say(`codex is still running in pane ${pane}`, [
      "exit it first (Ctrl-C twice), then run this again in the same pane",
      "ms adopt respawns this pane, so a codex left in it would be killed mid-conversation",
    ]);
    return EXIT_REFUSED;
  }

  const sourceRoot = sourceSessionsDir();
  // A path, or an id to look one up by. A path is accepted because a human who
  // has already found the file should not have to re-derive its id from the
  // name — and because an archived or hand-moved rollout has no place in the
  // walk below.
  const direct = parsed.id.includes(path.sep) || parsed.id.endsWith(".jsonl");
  let leaf: string | null;
  if (direct) {
    // `lstatSync`, never `statSync`: a path is the one input a human hands
    // this verb that we do not derive ourselves, and a SYMLINK named
    // `rollout-<date>-<id>.jsonl` would copy whatever it points at into the
    // store under a conversation's name. `statSync` follows the link and
    // cannot tell the two apart. A regular file, or nothing.
    const st = existsSync(parsed.id) ? lstatSync(parsed.id) : null;
    if (!st) { say(`no rollout file at ${parsed.id}`); return EXIT_REFUSED; }
    if (st.isSymbolicLink()) {
      say(`${parsed.id} is a symlink`, ["pass the real rollout file; ms adopt copies bytes into MS_HOME and will not follow a link there"]);
      return EXIT_REFUSED;
    }
    if (!st.isFile()) { say(`${parsed.id} is not a file`); return EXIT_REFUSED; }
    leaf = path.resolve(parsed.id);
    // A rollout is a file IN a sessions tree, and that is not a formality: the
    // name carries the id Codex resumes by and the date its layout is keyed
    // on, and the tree is where this file's own lineage lives. Anything else
    // — `./notes.txt`, a loose download — would land at the store root under
    // whatever name it had and be handed to `codex resume` as an id.
    if (!rolloutIdsFromName(path.basename(leaf)) || !datePartsFromName(path.basename(leaf))) {
      say(`${parsed.id} is not a rollout filename`, ["a rollout is rollout-<YYYY-MM-DD>T<hh-mm-ss>-<id>.jsonl"]);
      return EXIT_REFUSED;
    }
    if (!lineageRootFor(leaf)) {
      say(`${parsed.id} is not inside a sessions/YYYY/MM/DD tree`, [
        "ms adopt reads a rollout where codex keeps it, because that is where its own history sources are",
      ]);
      return EXIT_REFUSED;
    }
  } else {
    leaf = findRollout(sourceRoot, parsed.id);
    if (!leaf) {
      say(`no rollout for '${parsed.id}' under ${sourceRoot}`, [
        "the id is the one codex resume takes; the file is rollout-<date>-<id>.jsonl",
        "set CODEX_HOME if that codex runs out of another home, or pass the file's path instead",
      ]);
      return EXIT_REFUSED;
    }
  }

  // `rolloutIdsFromName` and not the argument: a path was given as a path, and
  // a thread id that named a reverted thread's newest file must resume THAT
  // conversation, under the id the file itself carries.
  const named = rolloutIdsFromName(path.basename(leaf));
  const resumeId = named ? named.threadId : parsed.id;

  ensureStore();
  const store = p.codexSessions();
  const lineageRoot = direct ? (lineageRootFor(leaf) ?? sourceRoot) : sourceRoot;
  let copy: AdoptCopy;
  try {
    copy = copyLineage(lineageRoot, store, leaf);
  } catch (e) {
    say(`could not copy the rollout into the store: ${(e as Error).message}`);
    return EXIT_REFUSED;
  }

  // A lineage Codex cannot complete is a resume Codex will refuse, by name and
  // by id. Launching anyway spends an account pick, kills the pane the human
  // is standing in, and leaves a row that sits `launching` until
  // reconciliation parks it — all to arrive at an error we could already read.
  // Nothing was copied, so the store is untouched and a re-run once the file
  // is back does the whole thing.
  if (copy.missing.length) {
    say(`${resumeId}'s history needs ${copy.missing.length} rollout(s) that are not under ${lineageRoot}`, [
      ...copy.missing,
      "codex refuses a resume whose paginated history it cannot complete, so nothing was copied and nothing was launched",
    ]);
    return EXIT_REFUSED;
  }

  // A file already in the store that is NOT this conversation's is the one
  // thing a rescue must never resume over: it is what a killed copy leaves
  // behind, and Codex would read it as the history. Name it and stop; the
  // human decides whether to remove it.
  if (copy.mismatched.length) {
    say(`the store already holds a different file for ${copy.mismatched.length} rollout(s) of this conversation`, [
      ...copy.mismatched.map((m) => `${m.dest} differs from ${m.from}`),
      "nothing was overwritten and nothing was launched; remove the store's copy if it is the stale one",
    ]);
    return EXIT_REFUSED;
  }

  const counted = `${copy.copied.length} copied, ${copy.kept.length} already there`;
  process.stderr.write(`ms adopt: ${resumeId} → ${store} (${counted})\n`);

  // From here it is an ordinary `ms codex`, and deliberately nothing else: the
  // account is chosen the same way, the home is prepared the same way, the row
  // and the launch are written the same way, and `--continue` is the same
  // continuation a rotation sends.
  return await launchWith(
    "codex",
    [...(parsed.as ? ["--as", parsed.as] : []), ...(parsed.continueAfter ? ["--continue"] : []), "--", ...parsed.args],
    { resumeId },
  );
};
