// src/codex-share.ts
//
// A codex account home is a VIEW of the human's own Codex home.
//
// Claude accounts share `~/.claude` and differ only in the token a pane is
// started with. This is the same principle for Codex, which cannot be told
// "this token, that directory": it reads its credential from exactly one file,
// `$CODEX_HOME/auth.json`, so every account needs a directory of its own
// (`MS_HOME/codex/<name>`). But the credential is ALL that has to differ. The
// home keeps two real files — `auth.json` and the `config.toml` rendered from
// the human's own (src/hooks/codex-install.ts) — and every other top-level
// entry of the base (`codexBaseDir()`, `~/.codex`) is a symlink to the same
// name there: the conversations, the archive, the history, the state and
// thread-history databases, memories, goals, skills, rules, `AGENTS.md`.
//
// Until 0.3.6 a home linked `sessions` alone, and at a store of this tool's
// own (`MS_HOME/codex/sessions`). So an `ms` pane's `codex resume` picker
// listed only conversations started in `ms` panes, resuming a plain-codex
// conversation by id failed with "No saved session found", and every account
// kept its own memories and history. `ms adopt` existed partly to paper over
// that.
//
// THE RULE IS GENERIC — every top-level entry, except `CODEX_HOME_OWN` — on
// purpose. Codex 0.156 alone keeps seven sqlite databases and a dozen
// directories in its home, and a hand-kept list of the ones to share is a list
// that falls behind the next release without a sound.
//
// THE PASS IS A REPAIR, not a setup step. It runs at `ms accounts add`, on
// every launch and every rotation (`ensureCodexReady`), and under `ms doctor
// --fix`, so a link that something replaced never diverges for longer than
// the next launch. Per top-level entry, it finds one of:
//
//   * a link to the base's entry of that name: nothing to do (the steady
//     state, and why a second run changes nothing and says nothing);
//   * nothing, where the base has an entry: link it;
//   * a link at the retired store (`sessions` only): re-point it at the base;
//   * a link at a base entry that no longer exists: remove the link;
//   * a real entry the base LACKS: MOVE it into the base, then link it —
//     a rename, so it keeps its inode and a CLI with it open keeps writing to
//     the file the base now holds;
//   * a real entry where the base HAS one of that name: merge it back, then
//     link it —
//       - a directory: every file the base lacks is moved in; a file the
//         base holds a strict byte-prefix of (the same conversation, taken
//         further in this home) has its missing tail appended; anything else
//         stays where it was — nothing is overwritten;
//       - a `.jsonl` file: every line the base lacks is appended;
//       - a sqlite database: never merged. The home's (with its `-wal`,
//         `-shm`) is renamed aside and the base's is the one in use;
//       - any other file: an identical copy is simply replaced by the link;
//         a different one is renamed aside and the base's wins.
//     What is renamed aside is `<name>.pre-link.<ms since the epoch>`, in
//     the home, and it is never deleted: a directory's copy keeps whatever
//     the merge left in it (an empty one is removed — it holds nothing).
//
// Nothing is ever deleted that holds a byte the base does not. A symlink the
// human put in a home that points anywhere else is never touched, and is
// reported. The retired store `MS_HOME/codex/sessions` goes through the same
// directory merge once and then becomes a link to the base's `sessions`,
// because `ms adopt`, `ms import` and a rotation's rollout search all read
// the store through that path (src/paths.ts `p.codexSessions`).
//
// VERIFIED LIVE (Codex 0.156.1, 2026-09-23, scratch homes against a local
// mock provider): Codex's SQLite resolves a symlinked database to the real
// file and keeps `-wal`/`-shm` beside it, so two homes sharing a database
// share one WAL rather than growing two (node:sqlite 3.51 and the sqlite3
// 3.54 CLI behave the same, and a DANGLING link creates the database at its
// target); a trust answer writes `config.toml` THROUGH a symlink, a prompt
// appends to `history.jsonl` through one, and a whole session — trust, turn,
// exit, the resume picker, a resume by id — left every link in the home a
// link. The picker in a linked home listed the base's conversations too,
// which is the point. A companion file (`-wal`, `-shm`, `-journal`) is
// therefore never linked on its own: it follows its database.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { acquire, Locked } from "./lock.ts";
import { codexBaseDir, ensureStore, p } from "./paths.ts";

/**
 * The only entries a codex account home keeps for itself.
 *
 * `auth.json` is the account — the one thing that makes this home a
 * different subscription from the human's own. `config.toml` is rendered per
 * home from the human's own (src/hooks/codex-install.ts), because it carries
 * this home's hook tables and their trust, which are keyed on this home's own
 * path. Everything else a home holds is the human's state, and is linked.
 *
 * `isHomeOwn` also claims anything NAMED after one of these — `config.toml.
 * bak-ms-<ms>` (the renderer's backups), `.config.toml.tmp-<pid>-<ms>` (its
 * atomic write in flight), an `auth.json.bak` — so a home's backups never
 * move into the base, and the human's own `~/.codex/auth.json.bak` never
 * appears in an account's home.
 */
export const CODEX_HOME_OWN = ["auth.json", "config.toml"] as const;

export function isHomeOwn(name: string): boolean {
  return CODEX_HOME_OWN.some((own) => name === own || name.startsWith(`${own}.`) || name.startsWith(`.${own}.`));
}

/** `<name>.pre-link.<ms>[-<n>]`, and a database's companions renamed with
 *  it (`…-wal`, `…-shm`): what this pass keeps when it links over a real
 *  entry. Never linked, never moved, never merged again. */
const BACKUP = /\.pre-link\.\d+(?:-\d+)?(?:-(?:wal|shm|journal))?$/;
export const isPreLinkBackup = (name: string): boolean => BACKUP.test(name);

/** A sqlite database, by the names Codex gives them (`state_5.sqlite`,
 *  `sqlite/codex-dev.db`). */
const DB = /\.(?:sqlite3?|db)$/;
/** What SQLite keeps beside a database — travels with it, never alone:
 *  another database's WAL beside ours is corruption, not a merge. */
const COMPANIONS = ["-wal", "-shm", "-journal"] as const;

function companionOf(name: string): string | null {
  for (const c of COMPANIONS) {
    if (name.endsWith(c) && DB.test(name.slice(0, -c.length))) return name.slice(0, -c.length);
  }
  return null;
}

/** What a run did, would do, and could not do. */
export type ShareReport = {
  /** One line per change made, for a human. A second run has none. */
  changes: string[];
  /** A dry run's findings: what a real run would change (fixable). */
  pending: string[];
  /** What cannot be fixed automatically, or failed — reported, never skipped. */
  problems: string[];
};

const empty = (): ShareReport => ({ changes: [], pending: [], problems: [] });
const join = (a: ShareReport, b: ShareReport): ShareReport => ({
  changes: [...a.changes, ...b.changes],
  pending: [...a.pending, ...b.pending],
  problems: [...a.problems, ...b.problems],
});

// --- Small filesystem answers --------------------------------------------

function lst(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/** A directory, through any symlink. */
function dirAt(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** A regular file, through any symlink. */
function fileAt(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function realOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Where a symlink points, as an absolute path: its text, resolved against
 *  the link's own directory — which answers for a dangling link too. */
function linkTarget(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
}

/** Is `link` a link to `want`: by its own text, or — when the base is
 *  spelled another way than when the link was made (a `~/.codex` that is
 *  itself a symlink) — by where both really resolve. */
function pointsAt(link: string, want: string): boolean {
  const target = linkTarget(link);
  if (target === null) return false;
  if (target === path.resolve(want)) return true;
  try {
    return realpathSync(link) === realpathSync(want);
  } catch {
    return false;
  }
}

/** A free `<name>.pre-link.<ms>` in `dir` — free for the companions too, so
 *  a database and its WAL are renamed under one stamp and stay a database. */
function backupName(dir: string, name: string, companions: readonly string[] = []): string {
  const stem = `${name}.pre-link.${Date.now()}`;
  const taken = (c: string) => [c, ...companions.map((x) => `${c}${x}`)].some((n) => lst(path.join(dir, n)) !== null);
  let candidate = stem;
  for (let i = 1; taken(candidate); i++) candidate = `${stem}-${i}`;
  return candidate;
}

/** A rename that never replaces: `renameSync` would silently overwrite a
 *  file, or an empty directory, at the destination. */
function move(from: string, to: string): void {
  if (lst(to)) throw new Error(`${to} already exists`);
  renameSync(from, to);
}

const CHUNK = 1 << 20;

function readAt(fd: number, buf: Buffer, want: number, pos: number): number {
  let got = 0;
  while (got < want) {
    const n = readSync(fd, buf, got, want - got, pos + got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

/** Do the first `n` bytes of two files agree? Read in chunks: a rollout runs
 *  to tens of megabytes. */
function samePrefix(a: string, b: string, n: number): boolean {
  if (n === 0) return true;
  const fa = openSync(a, "r");
  try {
    const fb = openSync(b, "r");
    try {
      const ba = Buffer.allocUnsafe(Math.min(CHUNK, n));
      const bb = Buffer.allocUnsafe(Math.min(CHUNK, n));
      for (let off = 0; off < n; ) {
        const want = Math.min(ba.length, n - off);
        if (readAt(fa, ba, want, off) !== want || readAt(fb, bb, want, off) !== want) return false;
        if (!ba.subarray(0, want).equals(bb.subarray(0, want))) return false;
        off += want;
      }
      return true;
    } finally {
      closeSync(fb);
    }
  } finally {
    closeSync(fa);
  }
}

type Relation = "same" | "base-prefix" | "home-prefix" | "differ";

/** How the home's copy of a file stands to the base's, byte for byte — and
 *  how long the base's was when it was compared. */
function relation(home: string, base: string): { how: Relation; baseSize: number } {
  const hs = statSync(home).size;
  const bs = statSync(base).size;
  const how: Relation = !samePrefix(home, base, Math.min(hs, bs))
    ? "differ"
    : hs === bs ? "same" : bs < hs ? "base-prefix" : "home-prefix";
  return { how, baseSize: bs };
}

/** Append `from`'s bytes past `start` to `to` — only if `to` is still
 *  exactly `start` long, because a file that grew since it was compared is no
 *  longer the prefix it was. */
function appendTail(from: string, to: string, start: number): boolean {
  if (statSync(to).size !== start) return false;
  const fin = openSync(from, "r");
  try {
    const fout = openSync(to, "a");
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (let off = start; ; ) {
        const n = readSync(fin, buf, 0, CHUNK, off);
        if (n <= 0) break;
        for (let w = 0; w < n; ) w += writeSync(fout, buf, w, n - w);
        off += n;
      }
    } finally {
      closeSync(fout);
    }
  } finally {
    closeSync(fin);
  }
  return true;
}

/** Lines as byte-exact strings (`latin1` maps every byte to one character),
 *  so a line that is not valid UTF-8 is compared and appended unchanged. */
const lines = (file: string): string[] => readFileSync(file).toString("latin1").split("\n");

/** Append every line of `from` that `to` does not already have, in `from`'s
 *  order. Returns how many. */
function appendMissingLines(from: string, to: string): number {
  const have = readFileSync(to);
  const seen = new Set(have.toString("latin1").split("\n"));
  const add: string[] = [];
  for (const line of lines(from)) {
    if (line === "" || seen.has(line)) continue;
    seen.add(line);
    add.push(line);
  }
  if (!add.length) return 0;
  const lead = have.length > 0 && have[have.length - 1] !== 0x0a ? "\n" : "";
  appendFileSync(to, Buffer.from(`${lead}${add.join("\n")}\n`, "latin1"));
  return add.length;
}

// --- Merging a directory -------------------------------------------------

type Tally = { moved: number; extended: number; kept: number; differing: string[] };

const companionsIn = (dir: string, db: string): string[] =>
  COMPANIONS.map((c) => `${db}${c}`).filter((n) => lst(path.join(dir, n)) !== null);

/**
 * Merge `src` into `dst`, file by file: move what `dst` lacks, extend what
 * `dst` holds a strict prefix of, and leave everything else exactly where it
 * is. Never overwrites, never deletes.
 */
function mergeInto(src: string, dst: string, t: Tally, rel = ""): void {
  for (const name of names(src)) {
    if (companionOf(name)) continue; // follows its database, below
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const r = rel ? path.join(rel, name) : name;
    const ss = lst(s);
    if (!ss) continue;
    const ds = lst(d);
    if (ss.isDirectory()) {
      if (!ds) {
        move(s, d);
        t.moved++;
      } else if (dirAt(d)) {
        mergeInto(s, d, t, r);
      } else {
        t.kept++;
        t.differing.push(r);
      }
      continue;
    }
    if (ss.isFile() && DB.test(name)) {
      // A database is never merged: it moves in whole, with its companions,
      // when the base has none of it — and otherwise stays where it is.
      if (!ds && companionsIn(dst, name).length === 0) {
        const comps = companionsIn(src, name);
        move(s, d);
        for (const c of comps) move(path.join(src, c), path.join(dst, c));
        t.moved++;
      } else {
        t.kept++;
        if (!(ds && fileAt(d) && relation(s, d).how === "same")) t.differing.push(r);
      }
      continue;
    }
    if (!ds) {
      move(s, d);
      t.moved++;
      continue;
    }
    if (ss.isFile() && fileAt(d)) {
      const { how, baseSize } = relation(s, d);
      if (how === "base-prefix" && appendTail(s, d, baseSize)) t.extended++;
      else if (how === "differ") t.differing.push(r);
      t.kept++;
      continue;
    }
    t.kept++;
    t.differing.push(r);
  }
}

/** Remove every EMPTY directory under `dir`, then `dir` itself if it is now
 *  empty. `rmdir` refuses a directory with anything in it, which is the
 *  guarantee: nothing that holds a byte goes. True when `dir` is gone. */
function prune(dir: string): boolean {
  for (const name of names(dir)) {
    const f = path.join(dir, name);
    if (lst(f)?.isDirectory()) prune(f);
  }
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn the real directory `dir` into a link to `into`, merging it on the way.
 *
 * Merge FIRST, while `dir` is still where every CLI expects it: a file the
 * base lacks is moved (renamed — a CLI appending to it keeps appending, now
 * to the base's copy), so the only thing left behind is what the base already
 * has. Then the rename aside and the link, and one more merge from the renamed
 * copy — the sweep, for anything created in `dir` while the first merge ran.
 * A failure in between leaves `dir` in place and the merge idempotent, so the
 * next run simply finishes it.
 */
function mergeDirAndLink(dir: string, into: string): string {
  const t: Tally = { moved: 0, extended: 0, kept: 0, differing: [] };
  mergeInto(dir, into, t);
  const parent = path.dirname(dir);
  const backup = backupName(parent, path.basename(dir));
  const aside = path.join(parent, backup);
  move(dir, aside);
  try {
    symlinkSync(into, dir);
  } catch (e) {
    renameSync(aside, dir);
    throw e;
  }
  const sweep: Tally = { moved: 0, extended: 0, kept: 0, differing: [] };
  mergeInto(aside, into, sweep);
  const moved = t.moved + sweep.moved;
  const extended = t.extended + sweep.extended;
  const counts = `${moved} moved in${extended ? `, ${extended} extended` : ""}`;
  if (prune(aside)) return `merged ${dir} into ${into} (${counts})`;
  const shown = sweep.differing.slice(0, 5).join(", ");
  const more = sweep.differing.length > 5 ? ` and ${sweep.differing.length - 5} more` : "";
  const differ = sweep.differing.length ? `; differs from the base, so both are kept: ${shown}${more}` : "";
  return `merged ${dir} into ${into} (${counts}; ${sweep.kept} already there, kept in ${aside}${differ})`;
}

// --- The base -------------------------------------------------------------

/**
 * Make the base usable: the directory (0700 when this creates it), its
 * `sessions`, and the retired store as a link to that `sessions`.
 *
 * The retired store is merged into the base's `sessions` once, exactly as a
 * home's own `sessions` directory would be, and then replaced by the link —
 * every rollout it held that the base lacked is moved in, and the rest stays
 * in `MS_HOME/codex/sessions.pre-link.<ms>`.
 *
 * `usable` is whether a home can be linked against this base at all.
 */
export function ensureCodexBase(opts: { dryRun?: boolean } = {}): ShareReport & { usable: boolean } {
  const out = { ...empty(), usable: true };
  const base = codexBaseDir();
  const sessions = path.join(base, "sessions");
  const dry = !!opts.dryRun;

  const unusable = (why: string) => {
    out.problems.push(why);
    out.usable = false;
    return out;
  };
  if (!lst(base)) {
    if (dry) {
      out.pending.push(`${base} does not exist yet`);
      return out;
    }
    try {
      mkdirSync(base, { recursive: true, mode: 0o700 });
      chmodSync(base, 0o700); // mkdir's mode is masked by the umask
    } catch (e) {
      return unusable(`could not create ${base}: ${(e as Error).message}`);
    }
    out.changes.push(`created ${base}`);
  } else if (!dirAt(base)) {
    return unusable(`${base} is not a directory, so no codex account can share it`);
  }

  if (!lst(sessions)) {
    if (dry) out.pending.push(`${sessions} does not exist yet`);
    else {
      try {
        mkdirSync(sessions, { mode: 0o700 });
      } catch (e) {
        return unusable(`could not create ${sessions}: ${(e as Error).message}`);
      }
    }
  } else if (!dirAt(sessions)) {
    return unusable(`${sessions} is not a directory, so no conversation can be shared`);
  }

  const legacy = p.codexSessions();
  const st = lst(legacy);
  if (!st) {
    if (!dry) {
      try {
        ensureStore();
        symlinkSync(sessions, legacy);
      } catch (e) {
        out.problems.push(`could not link ${legacy} to ${sessions}: ${(e as Error).message}`);
      }
    }
  } else if (st.isDirectory() && !st.isSymbolicLink() && realOr(legacy) === realOr(sessions)) {
    // A base whose `sessions` IS the store (a base kept inside MS_HOME): one
    // directory, nothing to merge, and renaming it aside would take the
    // base's own sessions with it.
  } else if (st.isSymbolicLink()) {
    if (!pointsAt(legacy, sessions)) {
      out.problems.push(`${legacy} is a symlink to ${linkTarget(legacy) ?? "an unreadable target"}, not to ${sessions} — never touched automatically`);
    }
  } else if (st.isDirectory()) {
    if (dry) {
      out.pending.push(`${legacy} is still a store of its own, not a link to ${sessions}`);
    } else {
      try {
        out.changes.push(mergeDirAndLink(legacy, sessions));
      } catch (e) {
        out.problems.push(`could not merge ${legacy} into ${sessions}: ${(e as Error).message}`);
      }
    }
  } else {
    out.problems.push(`${legacy} is a file, not the store — never touched automatically`);
  }
  return out;
}

// --- A home ---------------------------------------------------------------

/** How an entry is merged back: a directory file by file, a `.jsonl` line by
 *  line, a database never, any other file whole or not at all — and anything
 *  that is neither a file nor a directory (a socket) only ever moved. */
type Kind = "dir" | "jsonl" | "sqlite" | "file" | "other";

const kindOf = (name: string, st: Stats): Kind =>
  st.isDirectory() ? "dir" : !st.isFile() ? "other" : DB.test(name) ? "sqlite" : name.endsWith(".jsonl") ? "jsonl" : "file";

/** A symlink whose target is gone. */
function dangling(file: string): boolean {
  try {
    statSync(file);
    return false;
  } catch {
    return lst(file) !== null;
  }
}

type Action =
  | { do: "link"; name: string }
  | { do: "relink"; name: string }
  | { do: "unlink"; name: string }
  | { do: "same"; name: string }
  | { do: "move"; name: string; kind: Kind; companions: string[] }
  | { do: "merge"; name: string; kind: Kind; companions: string[] };

/** What a pass over `home` would do, and what it must not. Reads only. */
function plan(home: string, base: string): { actions: Action[]; problems: string[] } {
  const actions: Action[] = [];
  const problems: string[] = [];
  const homeNames = names(home);
  const inHome = new Set(homeNames);
  const legacy = p.codexSessions();
  const homeReal = realOr(home);

  for (const name of homeNames) {
    if (isHomeOwn(name) || isPreLinkBackup(name) || companionOf(name)) continue;
    const h = path.join(home, name);
    const b = path.join(base, name);
    const hs = lst(h);
    if (!hs) continue;
    const bs = lst(b);
    if (hs.isSymbolicLink()) {
      // The link every home had until 0.3.6: `sessions` at the retired store.
      if (name === "sessions" && linkTarget(h) === path.resolve(legacy)) {
        actions.push({ do: bs ? "relink" : "unlink", name });
        continue;
      }
      if (pointsAt(h, b)) {
        if (!bs) actions.push({ do: "unlink", name });
        continue;
      }
      problems.push(`${h} is a symlink to ${linkTarget(h) ?? "an unreadable target"}, not to ${b} — never touched automatically`);
      continue;
    }
    const kind = kindOf(name, hs);
    const companions = kind === "sqlite" ? companionsIn(home, name) : [];
    if (!bs) {
      if (kind === "sqlite" && companionsIn(base, name).length) {
        problems.push(`${base} has ${companionsIn(base, name).join(", ")} but no ${name}; ${h} is left where it is rather than put beside another database's journal`);
        continue;
      }
      actions.push({ do: "move", name, kind, companions });
      continue;
    }
    if (dangling(b)) {
      problems.push(`${b} is a dangling symlink; ${h} is left where it is`);
      continue;
    }
    if (kind === "other" || (kind === "dir" ? !dirAt(b) : !fileAt(b))) {
      const what = kind === "dir" ? "a directory" : kind === "other" ? "neither a file nor a directory" : "a file";
      problems.push(`${h} is ${what} and ${b} is not the same kind of thing — never merged automatically`);
      continue;
    }
    if (kind === "file" && fileAt(b) && relation(h, b).how === "same") {
      actions.push({ do: "same", name });
      continue;
    }
    actions.push({ do: "merge", name, kind, companions });
  }

  for (const name of names(base)) {
    if (inHome.has(name) || isHomeOwn(name) || isPreLinkBackup(name) || companionOf(name)) continue;
    // A base entry that CONTAINS this home (an MS_HOME kept inside ~/.codex)
    // would be a link from the home to its own ancestor: a cycle for anything
    // that walks the tree.
    const b = realOr(path.join(base, name));
    if (homeReal === b || homeReal.startsWith(b + path.sep)) continue;
    actions.push({ do: "link", name });
  }
  return { actions, problems };
}

/** One action, done. Returns the line to report, or null for a plain link. */
function apply(home: string, base: string, a: Action): string | null {
  const h = path.join(home, a.name);
  const b = path.join(base, a.name);
  switch (a.do) {
    case "link":
      symlinkSync(b, h);
      return null;
    case "unlink": {
      const was = linkTarget(h) ?? b;
      unlinkSync(h);
      return `removed ${h}, a link to ${was}, which no longer exists`;
    }
    case "relink":
      unlinkSync(h);
      symlinkSync(b, h);
      return `re-pointed ${h} from the retired store to ${b}`;
    case "same":
      // A byte-identical copy: the link loses nothing.
      unlinkSync(h);
      symlinkSync(b, h);
      return null;
    case "move": {
      move(h, b);
      for (const c of a.companions) move(path.join(home, c), path.join(base, c));
      symlinkSync(b, h);
      return `moved ${h} into ${base} (it had none) and linked it`;
    }
    case "merge":
      return merge(home, base, a);
  }
}

function merge(home: string, base: string, a: Extract<Action, { do: "merge" }>): string {
  const h = path.join(home, a.name);
  const b = path.join(base, a.name);
  if (a.kind === "dir") return mergeDirAndLink(h, b);

  if (a.kind === "jsonl") {
    // First pass while the file is still where Codex appends to it, the
    // sweep after, for a line appended in between.
    let added = appendMissingLines(h, b);
    const aside = path.join(home, backupName(home, a.name));
    move(h, aside);
    relinkOrRestore(b, h, aside);
    added += appendMissingLines(aside, b);
    return `merged ${h} into ${b} (${added} line${added === 1 ? "" : "s"} added); the original is kept as ${aside}`;
  }

  // A database is never merged, and neither is any other file: the base's
  // copy is the one in use, and the home's is kept beside the link.
  const stem = backupName(home, a.name, a.kind === "sqlite" ? COMPANIONS : []);
  const aside = path.join(home, stem);
  move(h, aside);
  const moved: [string, string][] = [];
  try {
    for (const c of a.companions) {
      move(path.join(home, c), path.join(home, `${stem}${c.slice(a.name.length)}`));
      moved.push([path.join(home, c), path.join(home, `${stem}${c.slice(a.name.length)}`)]);
    }
  } catch (e) {
    for (const [from, to] of moved.reverse()) renameSync(to, from);
    renameSync(aside, h);
    throw e;
  }
  relinkOrRestore(b, h, aside);
  return a.kind === "sqlite"
    ? `kept ${h} as ${aside}; a database is never merged, so the home now uses ${b}`
    : `kept ${h} as ${aside}; it differs from ${b}, which the home now links`;
}

/** Link `h` to `b`, or put the renamed original back: a home must never be
 *  left missing an entry it had. */
function relinkOrRestore(b: string, h: string, aside: string): void {
  try {
    symlinkSync(b, h);
  } catch (e) {
    renameSync(aside, h);
    throw e;
  }
}

const describe = (home: string, base: string, a: Action): string => {
  const h = path.join(home, a.name);
  switch (a.do) {
    case "link": return a.name;
    case "unlink": return `${h} links to something that no longer exists`;
    case "relink": return `${h} still points at the retired store`;
    case "same": return `${h} is a copy of ${path.join(base, a.name)}, not a link`;
    case "move": return `${h} is not in ${base} yet`;
    case "merge": return `${h} is a real ${a.kind === "dir" ? "directory" : "file"}, not a link to ${path.join(base, a.name)}`;
  }
};

/**
 * Link one codex home to the base, repairing whatever is not a link yet.
 * The pass the header describes; `dryRun` reports it without doing it.
 *
 * Callers normally want `shareCodexState`, which makes the base usable first
 * and holds the lock; this is the home half alone.
 */
export function shareCodexHome(home: string, opts: { dryRun?: boolean } = {}): ShareReport {
  const out = empty();
  const base = codexBaseDir();
  if (!dirAt(base)) {
    (opts.dryRun ? out.pending : out.problems).push(`${base} does not exist yet`);
    return out;
  }
  if (realOr(home) === realOr(base)) {
    out.problems.push(`${home} IS the base ${base}; a home cannot be linked to itself`);
    return out;
  }
  const { actions, problems } = plan(home, base);
  out.problems.push(...problems);
  if (opts.dryRun) {
    const links = actions.filter((a) => a.do === "link").map((a) => a.name);
    if (links.length) {
      const shown = links.slice(0, 6).join(", ");
      out.pending.push(`${links.length} of ${base}'s entries not linked (${shown}${links.length > 6 ? ", …" : ""})`);
    }
    out.pending.push(...actions.filter((a) => a.do !== "link").map((a) => describe(home, base, a)));
    return out;
  }
  let linked = 0;
  for (const a of actions) {
    try {
      const line = apply(home, base, a);
      if (line === null) linked++;
      else out.changes.push(line);
    } catch (e) {
      out.problems.push(`could not link ${path.join(home, a.name)} to ${path.join(base, a.name)}: ${(e as Error).message}`);
    }
  }
  if (linked) out.changes.unshift(`linked ${linked} ${linked === 1 ? "entry" : "entries"} of ${base} into ${home}`);
  return out;
}

// --- The lock, and the entry points --------------------------------------

/** One name for every pass over every home: two launches linking at once
 *  would each rename the other's fresh link aside as a "backup". */
const SHARE_LOCK = "codex-share";
const SHARE_LOCK_WAIT_MS = 15_000;

/** A blocking sleep for the synchronous callers (a launch's `prepare`, a
 *  rotation's candidate check), which have no event loop to yield to. */
const nap = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function underShareLock(fn: () => ShareReport): ShareReport {
  const deadline = performance.now() + SHARE_LOCK_WAIT_MS;
  for (;;) {
    let release: (() => void) | null = null;
    try {
      release = acquire(SHARE_LOCK);
    } catch (e) {
      if (!(e instanceof Locked)) throw e;
    }
    if (release) {
      try {
        return fn();
      } finally {
        release();
      }
    }
    if (performance.now() >= deadline) {
      return { ...empty(), problems: [`another ms process held the '${SHARE_LOCK}' lock for ${SHARE_LOCK_WAIT_MS / 1000}s; nothing was linked — try again`] };
    }
    nap(100);
  }
}

/**
 * The whole pass for one home, under the lock: the base made usable (and the
 * retired store merged into it), then the home linked to it. What `ms
 * accounts add`, every launch and rotation, `ms accounts remove` and `ms
 * doctor --fix` run. A dry run takes no lock and changes nothing.
 */
export function shareCodexState(home: string, opts: { dryRun?: boolean } = {}): ShareReport {
  const run = (): ShareReport => {
    const base = ensureCodexBase(opts);
    // A base that is not there yet (a dry run does not create it) has no
    // entries to compare a home against: its own line already says so.
    if (!base.usable || !dirAt(codexBaseDir())) return base;
    return join(base, shareCodexHome(home, opts));
  };
  return opts.dryRun ? run() : underShareLock(run);
}

/** The base and the store link alone, under the lock — for `ms adopt`, which
 *  writes into the store without having a home of its own to link. */
export function prepareCodexStore(): ShareReport {
  return underShareLock(() => ensureCodexBase());
}

/**
 * Whether `home`'s `sessions` is the base's — the one entry a rotation cannot
 * do without, since it resumes a conversation some OTHER home started. A
 * link that still reaches the base through the retired store counts: it is
 * the same directory.
 */
export function codexSessionsShared(home: string): boolean {
  const link = path.join(home, "sessions");
  return !!lst(link)?.isSymbolicLink() && dirAt(link) && pointsAt(link, path.join(codexBaseDir(), "sessions"));
}
