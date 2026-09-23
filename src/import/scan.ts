// src/import/scan.ts
//
// `ms import`, front half #1: find every Claude Code and Codex conversation on
// this machine, and say which of them a process is still running.
//
// Both CLIs keep every conversation on disk keyed by working directory — that
// is the whole reason `ms import` can exist. A running process cannot be moved
// into tmux on macOS, but a conversation can be found, its original stopped,
// and the SAME conversation resumed in a pane under an account with room.
// This module is the "found" half, and nothing else: it reads, it never
// writes, it never signals, it never asks tmux to do anything.
//
// Three rules earn their own explanation, because getting any of them wrong
// invents provenance the sources never had:
//
//   * A process is matched to a conversation, never a conversation to a
//     process. A CLI's argv does not name the conversation it is in, so the
//     only honest evidence is "the newest conversation in this process's cwd
//     that has been written since the process started". Nothing older than the
//     process can be its conversation, and a process with no such file is
//     returned with `id: ""` — a row the planner skips and the table prints as
//     `live, no conversation found`, never a guess.
//   * `--since` filters IDLE conversations only. A live process is always a
//     candidate: the window is about finding forgotten work, and a CLI running
//     right now is not forgotten however long ago its last turn was.
//   * Reading is bounded. A transcript is read only as far as the header and
//     the first user line (HEADER_BUDGET below), because a scan of a few
//     hundred conversations must not read a few hundred megabytes, and nothing
//     past the first user message is any of this module's business.
//
// Everything that touches the world — `ps`, `lsof`, tmux, the tool's own store
// — arrives injected, so the rules above are testable against fixtures instead
// of against whatever happens to be running.

import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { listRollouts, rolloutIdsFromName } from "../adopt.ts";
import { msHome } from "../paths.ts";
import { openState } from "../state.ts";
import { Tmux } from "../tmux.ts";

export type ImportProvider = "claude" | "codex";

/** One conversation `ms import` could move, plus everything known about the
 *  process (if any) that is holding it open right now. `id: ""` is the one
 *  special shape: a live CLI whose conversation could not be identified. */
export interface Candidate {
  provider: ImportProvider;
  id: string;
  cwd: string;
  transcriptPath: string;
  /** Epoch ms — the transcript's mtime, which both CLIs touch every turn. */
  lastActivity: number;
  title: string;
  compacted: boolean;
  pid: number | null;
  argv: string[] | null;
  startedAt: number | null;
  inTmux: boolean;
  managed: boolean;
}

/** One row of `ps -axo pid,lstart,tty,command`, already parsed. */
export interface ProcessRow {
  pid: number;
  /** Epoch ms, from `lstart`. */
  startedAt: number;
  /** As `ps` spells it (`s004`, `??`); compared through `normalizeTty`. */
  tty: string;
  argv: string[];
}

export interface ScanOptions {
  claudeConfigDir: string;
  codexHome: string;
  /**
   * The store this tool's own Codex homes share (`p.codexSessions()`, since
   * 0.3.6 a link to `~/.codex/sessions`), walked too when it is not the same
   * directory as `<codexHome>/sessions` — so a conversation is found whether
   * the scan runs under `~/.codex`, an `ms` home, or a `$CODEX_HOME` of the
   * human's own. Omitted, only `codexHome` is walked.
   */
  codexStore?: string | null;
  /**
   * The oldest last-activity an IDLE conversation may have, as epoch ms; null
   * keeps every one of them. It is a cutoff, not a duration — the verb turns
   * `--since 2h` into `Date.now() - 7200000` — so this function needs no clock
   * of its own and a test can pin the window exactly.
   */
  sinceMs: number | null;
  /** Keep only conversations under one of these paths; `[]` = everything. */
  dirs: string[];
  ps: () => ProcessRow[];
  cwdOf: (pid: number) => string | null;
  tmuxTtys: () => Set<string>;
  managedIds: () => Set<string>;
}

/** What a scan knows before it has looked at the process table. */
interface Conversation {
  provider: ImportProvider;
  id: string;
  cwd: string;
  transcriptPath: string;
  lastActivity: number;
  title: string;
  compacted: boolean;
}

// --- Bounded transcript reading ----------------------------------------

/** The most of any transcript this module will read. Big enough for a header
 *  plus a first user message that carries a whole CLAUDE.md, small enough that
 *  scanning hundreds of conversations stays cheap. */
const HEADER_BUDGET = 512 * 1024;
const CHUNK = 64 * 1024;

/**
 * Feed `onRecord` each parsed JSONL record from the start of `file`, stopping
 * the moment it returns true (it has what it came for), at EOF, or at
 * `HEADER_BUDGET` — whichever comes first.
 *
 * A line that will not parse is skipped rather than fatal: a rollout is
 * append-only JSONL written by a CLI that is very possibly writing it right
 * now, so a torn last line is normal, not corruption.
 */
function eachHeaderRecord(file: string, onRecord: (rec: Record<string, unknown>) => boolean): void {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let read = 0;
    while (read < HEADER_BUDGET) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, Math.min(CHUNK, HEADER_BUDGET - read), read);
      } catch {
        return;
      }
      if (n <= 0) break;
      read += n;
      carry += decoder.write(buf.subarray(0, n));
      let i: number;
      while ((i = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, i);
        carry = carry.slice(i + 1);
        const rec = parseRecord(line);
        if (rec && onRecord(rec)) return;
      }
    }
    // A file whose last record has no trailing newline is still a record.
    if (carry.trim()) {
      const rec = parseRecord(carry);
      if (rec) onRecord(rec);
    }
  } finally {
    closeSync(fd);
  }
}

function parseRecord(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t || t[0] !== "{") return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- Titles --------------------------------------------------------------

/** The first line of a user message, at most 80 characters, with every
 *  control character removed — a title goes into a terminal table, and an
 *  escape sequence from a transcript must never be re-emitted there. */
export function cleanTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] ?? "";
  let out = "";
  for (const ch of firstLine) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.trim().slice(0, 80);
}

/** Message content is a string in some records and an array of parts in
 *  others (both CLIs, both shapes); only the text parts are text. `drop`
 *  rejects a part before it is joined, so a record that is preamble PLUS
 *  prompt keeps the prompt. */
function textOf(content: unknown, drop?: (text: string) => boolean): string | null {
  if (typeof content === "string") return drop?.(content) ? null : content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const o = part as Record<string, unknown>;
    if ((o.type === "text" || o.type === "input_text") && typeof o.text === "string" && !drop?.(o.text)) parts.push(o.text);
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * The openings of the context Codex injects into a conversation as a USER
 * message, ahead of anything the human has said.
 *
 * It is a user message in the rollout because that is how the model is meant
 * to read it, which makes "the first user message" the wrong title for every
 * Codex conversation on the machine — the first live dry-run titled all of
 * them `# AGENTS.md instructions`. Taken from this machine's own rollouts:
 * the AGENTS.md block leads with or without a trailing path, and
 * `<recommended_plugins>` leads others; `<environment_context>` and
 * `<user_instructions>` are the same class of injected block.
 *
 * A closed list, matched only at the START, on purpose. "Skip anything that
 * opens with `<`" would eat a real prompt that begins with a tag, and a
 * substring match would eat one that MENTIONS AGENTS.md. A marker this misses
 * costs one bad title; a marker that over-matches costs a conversation its
 * name.
 */
const CODEX_PREAMBLE_MARKERS = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<user_instructions>",
  "<recommended_plugins>",
];

export function isCodexPreamble(text: string): boolean {
  const t = text.trimStart();
  return CODEX_PREAMBLE_MARKERS.some((marker) => t.startsWith(marker));
}

function claudeUserText(rec: Record<string, unknown>): string | null {
  if (rec.type !== "user") return null;
  const message = rec.message;
  if (!message || typeof message !== "object") return null;
  return textOf((message as Record<string, unknown>).content);
}

function codexUserText(rec: Record<string, unknown>): string | null {
  const payload = rec.payload;
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  // The preamble is dropped here and not by the caller, so the caller's
  // "keep reading until there is a title" loop simply moves on to the next
  // user message — the human's own first word.
  if (o.type === "user_message" && typeof o.message === "string") {
    return isCodexPreamble(o.message) ? null : o.message;
  }
  if (o.type === "message" && o.role === "user") return textOf(o.content, isCodexPreamble);
  return null;
}

// --- Paths ---------------------------------------------------------------

/**
 * `-Users-x-y` → `/Users/x/y`: Claude Code's project-directory escaping, run
 * backwards. It is LOSSY — the escaping replaces `.` with `-` as well as `/`,
 * so `~/src/some.dir` and `~/src/some/dir` escape identically — which is
 * exactly why the recorded `cwd` wins whenever a record carries one, and this
 * is only the fallback.
 */
export function unescapeProjectDir(name: string): string {
  return name.replace(/-/g, "/");
}

/** The real path when there is one, the literal path when the directory is
 *  gone. Every cwd comparison in this module is between real paths: `lsof`
 *  reports one, and `--dir ~/src` must match a conversation recorded in
 *  `/tmp/x` that is really `/private/tmp/x`. */
function realish(p: string): string {
  if (!p) return "";
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// --- Claude transcripts --------------------------------------------------

function claudeConversations(configDir: string): Conversation[] {
  const projects = path.join(configDir, "projects");
  let dirs: Dirent<string>[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return []; // no Claude store on this machine, which is not an error
  }
  const out: Conversation[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files: string[];
    try {
      files = readdirSync(path.join(projects, dir.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(projects, dir.name, name);
      let mtime: number;
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      let cwd: string | null = null;
      let title = "";
      eachHeaderRecord(file, (rec) => {
        if (!cwd && typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
        if (!title) {
          const text = claudeUserText(rec);
          if (text) title = cleanTitle(text);
        }
        return cwd !== null && title !== "";
      });
      out.push({
        provider: "claude",
        id: name.slice(0, -".jsonl".length),
        cwd: realish(cwd ?? unescapeProjectDir(dir.name)),
        transcriptPath: file,
        lastActivity: mtime,
        title,
        compacted: false,
      });
    }
  }
  return out;
}

// --- Codex rollouts ------------------------------------------------------

/** Every sessions root to walk, once each: two spellings of one directory
 *  (an `ms` home's `sessions` link and the store's own) are one root. */
function codexRoots(codexHome: string, store: string | null | undefined): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const root of [path.join(codexHome, "sessions"), ...(store ? [store] : [])]) {
    const key = realish(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

function codexConversations(codexHome: string, store?: string | null): Conversation[] {
  const out: Conversation[] = [];
  // Which root each id was first found under, and where it sits in `out`.
  const first = new Map<string, { at: number; root: number }>();
  codexRoots(codexHome, store).forEach((root, r) => {
    // `listRollouts` is `src/adopt.ts`'s own walker — the same one that finds a
    // conversation to rescue — so the two verbs can never disagree about what
    // counts as a rollout file.
    for (const file of listRollouts(root)) {
      const c = codexConversation(file);
      if (!c) continue;
      const seen = first.get(c.id);
      if (seen && seen.root !== r) {
        // One conversation under two roots — a copy `ms adopt` once made into
        // the store — is one conversation: the copy written last carries its
        // latest turn. (Two files for one id under ONE root is a reverted
        // thread, Codex's own business, and both are kept as they always were.)
        if (c.lastActivity > out[seen.at]!.lastActivity) out[seen.at] = c;
        continue;
      }
      if (!seen) first.set(c.id, { at: out.length, root: r });
      out.push(c);
    }
  });
  return out;
}

/** One rollout as a conversation, or null when it names no id at all. */
function codexConversation(file: string): Conversation | null {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  let id: string | null = null;
  let cwd: string | null = null;
  let compacted = false;
  let seenMeta = false;
  let title = "";
  eachHeaderRecord(file, (rec) => {
    if (!seenMeta && rec.type === "session_meta" && rec.payload && typeof rec.payload === "object") {
      const meta = rec.payload as Record<string, unknown>;
      seenMeta = true;
      if (typeof meta.id === "string" && meta.id) id = meta.id;
      else if (typeof meta.session_id === "string" && meta.session_id) id = meta.session_id;
      if (typeof meta.cwd === "string" && meta.cwd) cwd = meta.cwd;
      // `history_base` is the pointer at the rollout holding this
      // conversation's prefix: its presence IS the fact that this
      // conversation was compacted (see `lineageIds` in src/adopt.ts).
      compacted = !!meta.history_base && typeof meta.history_base === "object";
    }
    if (!title) {
      const text = codexUserText(rec);
      if (text) title = cleanTitle(text);
    }
    return seenMeta && title !== "";
  });
  // A rollout with no readable meta still has its ids in its own filename.
  const fromName = rolloutIdsFromName(path.basename(file));
  const resolved = id ?? fromName?.threadId ?? null;
  if (!resolved) return null;
  return {
    provider: "codex",
    id: resolved,
    cwd: realish(cwd ?? ""),
    transcriptPath: file,
    lastActivity: mtime,
    title,
    compacted,
  };
}

// --- The process table ---------------------------------------------------

/**
 * Which CLI a command line is, or null for everything else.
 *
 * `argv[0]`'s basename, or — for the `node …/claude` shape an npm-installed
 * CLI runs as — the basename of the script that node was handed. The match is
 * on the whole stem, never a prefix: `claude-code-router` is a different
 * program and must not be stopped by an import.
 */
export function providerOfArgv(argv: string[]): ImportProvider | null {
  if (!argv.length) return null;
  const stem = (p: string): string => path.basename(p).replace(/\.(m|c)?js$/, "");
  const names = [stem(argv[0]!)];
  if (/^node(\d+)?$/.test(names[0]!) && argv[1]) names.push(stem(argv[1]));
  for (const name of names) {
    if (name === "claude") return "claude";
    if (name === "codex") return "codex";
  }
  return null;
}

/**
 * `ps -axo pid,lstart,tty,command` — pid, five fixed `lstart` fields, tty, and
 * the command line as the rest of the line.
 *
 * The command is split on whitespace, which loses the quoting of an argument
 * that contained a space. That is deliberate and safe HERE: the only thing
 * done with this argv is picking whitelisted flags out of it (see
 * `KEPT_FLAGS` in the planner), so a mangled positional is dropped either way
 * — and a wrongly-joined one could never become a flag.
 */
export function parsePs(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 8) continue;
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue; // the header line, among other things
    const startedAt = Date.parse(parts.slice(1, 6).join(" "));
    if (!Number.isFinite(startedAt)) continue;
    rows.push({ pid, startedAt, tty: parts[6]!, argv: parts.slice(7) });
  }
  return rows;
}

/** `lsof -a -p <pid> -d cwd -Fn` prints one `n`-prefixed path. */
export function parseLsofCwd(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("n") && line.length > 1) return line.slice(1).trim();
  }
  return null;
}

/**
 * One spelling for a tty, because the three sources spell it three ways:
 * `ps` says `s004`, tmux says `/dev/ttys004`, and a process with no
 * controlling terminal says `??`. The empty string means "no tty", and it
 * never matches anything — a process with no terminal cannot be in tmux.
 */
export function normalizeTty(tty: string): string {
  const t = tty.trim();
  if (!t || t === "??" || t === "-") return "";
  const bare = t.startsWith("/dev/") ? t.slice("/dev/".length) : t;
  if (!bare) return "";
  return /^(tty|cu\.)/.test(bare) ? bare : `tty${bare}`;
}

/**
 * One process per tty, keeping the LOWEST pid on it.
 *
 * An npm-installed Codex is two processes for one conversation: `node
 * …/codex` and the native binary it runs, sharing a tty and a cwd, and both
 * matching `providerOfArgv`. Only one of them can claim the conversation, so
 * the other arrived in the live run as a row of its own — `live, no
 * conversation found`, one per session, for a conversation that does not
 * exist.
 *
 * The tty is the evidence that they are one session: a terminal has one
 * foreground process group, so two matching CLIs on one tty are one CLI seen
 * twice. The lowest pid is the parent — the one that was started, the one
 * that owns the tty's job, and the one a SIGTERM belongs to (it forwards it
 * to the child it spawned).
 *
 * A process with NO tty is never deduped against anything: the empty spelling
 * means "no controlling terminal" (`normalizeTty`), and two of those share
 * nothing at all.
 */
export function dedupeByTty<T extends { pid: number; tty: string }>(rows: T[]): T[] {
  const lowest = new Map<string, number>();
  for (const r of rows) {
    const tty = normalizeTty(r.tty);
    if (!tty) continue;
    const seen = lowest.get(tty);
    if (seen === undefined || r.pid < seen) lowest.set(tty, r.pid);
  }
  return rows.filter((r) => {
    const tty = normalizeTty(r.tty);
    return !tty || lowest.get(tty) === r.pid;
  });
}

// --- The scan ------------------------------------------------------------

export function scanConversations(opts: ScanOptions): Candidate[] {
  const conversations = [...claudeConversations(opts.claudeConfigDir), ...codexConversations(opts.codexHome, opts.codexStore)]
    .sort((a, b) => b.lastActivity - a.lastActivity);

  const ttys = new Set([...opts.tmuxTtys()].map(normalizeTty).filter((t) => t !== ""));
  const managed = opts.managedIds();

  // Newest process first, so when two CLIs share a directory the newer one
  // takes the newer conversation instead of racing for the same row — after
  // the wrapper-and-child pairs have been collapsed to one process each, so
  // that "two CLIs" means two conversations.
  const matching = opts.ps()
    .map((row) => ({ row, provider: providerOfArgv(row.argv) }))
    .filter((x): x is { row: ProcessRow; provider: ImportProvider } => x.provider !== null);
  const kept = new Set(dedupeByTty(matching.map((x) => x.row)));
  const processes = matching
    .filter((x) => kept.has(x.row))
    .sort((a, b) => b.row.startedAt - a.row.startedAt);

  const liveOf = new Map<Conversation, ProcessRow>();
  const claimed = new Set<Conversation>();
  const orphans: { row: ProcessRow; provider: ImportProvider; cwd: string }[] = [];
  for (const { row, provider } of processes) {
    const cwd = realish(opts.cwdOf(row.pid) ?? "");
    const match = cwd
      ? conversations.find(
          (c) => !claimed.has(c) && c.provider === provider && c.cwd === cwd && c.lastActivity >= row.startedAt,
        )
      : undefined;
    if (match) {
      claimed.add(match);
      liveOf.set(match, row);
    } else {
      orphans.push({ row, provider, cwd });
    }
  }

  const dirs = opts.dirs.map(realish).filter((d) => d !== "");
  const under = (p: string): boolean => !dirs.length || dirs.some((d) => p === d || p.startsWith(d + path.sep));

  const out: Candidate[] = [];
  for (const c of conversations) {
    const live = liveOf.get(c) ?? null;
    // The live bypass: a window may only ever hide an IDLE conversation.
    if (!live && opts.sinceMs !== null && c.lastActivity < opts.sinceMs) continue;
    if (!under(c.cwd)) continue;
    out.push({
      ...c,
      pid: live?.pid ?? null,
      argv: live ? [...live.argv] : null,
      startedAt: live?.startedAt ?? null,
      inTmux: live ? ttys.has(normalizeTty(live.tty)) : false,
      managed: managed.has(c.id),
    });
  }
  for (const o of orphans) {
    if (!under(o.cwd)) continue;
    out.push({
      provider: o.provider,
      id: "",
      cwd: o.cwd,
      transcriptPath: "",
      lastActivity: o.row.startedAt,
      title: "",
      compacted: false,
      pid: o.row.pid,
      argv: [...o.row.argv],
      startedAt: o.row.startedAt,
      inTmux: ttys.has(normalizeTty(o.row.tty)),
      managed: false,
    });
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
}

// --- The default dependencies -------------------------------------------
//
// Bounded, every one of them: a `ps` that hangs must fail the scan, not the
// human's terminal.

const SUBPROCESS_TIMEOUT_MS = 10_000;

export function defaultPs(): ProcessRow[] {
  const r = spawnSync("ps", ["-axo", "pid,lstart,tty,command"], {
    encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 16 << 20,
  });
  return r.stdout ? parsePs(r.stdout) : [];
}

export function defaultCwdOf(pid: number): string | null {
  const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 1 << 20,
  });
  return r.stdout ? parseLsofCwd(r.stdout) : null;
}

/** Every pane tty on the default tmux server AND on the tool's own, because a
 *  conversation already in either one is already somewhere it can be rotated. */
export function defaultTmuxTtys(): Set<string> {
  const out = new Set<string>();
  for (const socket of [null, path.join(msHome(), "tmux.sock")]) {
    const r = new Tmux(socket).run(["list-panes", "-a", "-F", "#{pane_tty}"]);
    if (r.code !== 0) continue;
    for (const line of r.stdout.split("\n")) {
      const v = line.trim();
      if (v) out.add(v);
    }
  }
  return out;
}

/** The CLI session ids this tool is already running. A conversation of ours is
 *  not something to import; it is something already imported. */
export function defaultManagedIds(): Set<string> {
  const out = new Set<string>();
  let st: ReturnType<typeof openState>;
  try {
    st = openState();
  } catch {
    return out; // no store yet: nothing is managed
  }
  try {
    for (const s of st.listSessions()) {
      if (s.state !== "stopped" && s.cliSessionId) out.add(s.cliSessionId);
    }
  } finally {
    st.close();
  }
  return out;
}

export function defaultScanDeps(): Pick<ScanOptions, "ps" | "cwdOf" | "tmuxTtys" | "managedIds"> {
  return { ps: defaultPs, cwdOf: defaultCwdOf, tmuxTtys: defaultTmuxTtys, managedIds: defaultManagedIds };
}
