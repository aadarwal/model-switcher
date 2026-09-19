// src/import/manifest.ts
//
// `ms import`, the written record: what was found, where each conversation is
// going, and what became of it.
//
// The manifest is not a log. It is the ROLLBACK RECORD, and that is the whole
// design: an import stops processes the human did not stop themselves, and the
// conversations survive whatever happens next — they are files on disk either
// way — so the one thing that must exist afterwards is a document saying, row
// by row, which conversation this was, where it went, and how to bring it back
// by hand if the tool did not. That is why every row carries its own command
// line rather than a reference to one, why the file is written after every
// step rather than at the end, and why a row that failed says WHY in the same
// field a row that worked says where it landed.
//
// It is also the unit of `--dry-run` / `--plan` / `--status`: the same file the
// human is shown before anything runs is the file `--plan` executes later and
// `--status` reads back. So it holds a little more than the spec's sketch —
// the target server's SOCKET and each row's COMMAND — because a plan that
// cannot say which tmux server it meant, or that re-derives its commands from
// a planner that may have changed since, is not the plan the human approved.
//
// 0600, always, and atomic. A row's `argv` is the original process's command
// line with the launch whitelist already applied by the planner (src/import/
// plan.ts): a credential a human typed on their own command line never reaches
// this file, because it never reaches the `command` either.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeAtomicThroughLink } from "../fsx.ts";
import { msHome } from "../paths.ts";
import { keptFlags } from "./plan.ts";
import type { Candidate, ImportProvider } from "./scan.ts";
import type { Plan, PlanSession, PlanWindow, PaneSpec } from "./plan.ts";

/** Where a row's pane goes, in the plan's own words. `paneId` and
 *  `paneIndex` are filled in by the executor the moment tmux hands them
 *  back — both in the same `-P -F '#{pane_id} #{pane_index}'` call that
 *  makes the pane (`src/import/execute.ts`). `paneId` is the only handle
 *  that survives a window being renamed or moved, and the one every later
 *  tmux target is built from. `paneIndex` is tmux's own `#{pane_index}` for
 *  that pane — deliberately NOT `pane` below: `pane` is the planner's
 *  0-based slot (`PaneSpec.index`), and the two agree only when the tmux
 *  server's `pane-base-index` happens to be 0. Under the author's own
 *  `pane-base-index 1`, slot 0 is tmux's pane 1 — which is exactly the bug
 *  this field exists to stop the report from repeating. */
export interface ManifestTarget {
  session: string;
  window: string;
  pane: number;
  paneId: string | null;
  paneIndex: number | null;
}

export interface ManifestRow {
  provider: ImportProvider;
  id: string;
  cwd: string;
  root: string;
  worktree: string;
  /** ISO 8601 — a human reads this file. */
  lastActivity: string;
  title: string;
  compacted: boolean;
  pid: number | null;
  /**
   * When that process started, ISO 8601, as `ps lstart` reported it at scan
   * time — and the only thing that makes `pid` safe to act on later.
   *
   * A pid is a number the kernel re-uses. A manifest planned at 09:00 and run
   * at 17:00 names a pid that may by then be somebody's `npm run dev`, and a
   * SIGTERM sent on the strength of the number alone would kill it. The
   * executor re-reads the process table before it signals anything and
   * refuses when this does not match (src/import/execute.ts). Null when there
   * was no process.
   */
  startedAt: string | null;
  /**
   * The original process's command line AS CARRIED OVER — the planner's launch
   * whitelist already applied, which is the only form of it this file may
   * hold. The raw argv is exactly where a human's `--api-key` lives, and a
   * manifest is a file, kept, naming every directory they work in. Null when
   * there was no process.
   */
  argv: string[] | null;
  /** The argv the pane runs, `ms` first. Null for a row nothing will run. */
  command: string[] | null;
  target: ManifestTarget | null;
  /** `planned` | `stopped` | `resumed in <session>:<window>.<paneIndex>
   *  (<paneId>)` — tmux's own numbers, read back when the pane was made,
   *  never the planner's 0-based slot | `stop refused: …` |
   *  `stop failed: …` | `resume failed: …` | `skipped: <reason>` */
  outcome: string;
}

export interface Manifest {
  createdAt: string;
  /** `current` (the tmux the command was run from) or `ms` (the tool's own). */
  server: string;
  /** The socket that server is on — `null` means tmux's own default. */
  socket: string | null;
  since: string;
  dirs: string[];
  rows: ManifestRow[];
}

export const OUTCOME_PLANNED = "planned";
export const OUTCOME_STOPPED = "stopped";
/** `resumed in data:main.2 (%58)` — tmux's OWN pane index and id, read back
 *  the moment the pane was made, not `targetName` below: a row is only ever
 *  resumed after `paneId`/`paneIndex` are set, and the whole point of
 *  carrying both is that this string, unlike `targetName`'s, is something a
 *  human can hand to `tmux select-window -t`. */
export const resumedOutcome = (t: ManifestTarget): string => `resumed in ${t.session}:${t.window}.${t.paneIndex} (${t.paneId})`;
export const stopFailed = (why: string): string => `stop failed: ${why}`;
export const resumeFailed = (why: string): string => `resume failed: ${why}`;
export const skipped = (why: string): string => `skipped: ${why}`;
/** A stop that was never attempted, as distinct from one that was and did not
 *  work: the pid on the row is not the process the plan was made against. */
export const stopRefused = (why: string): string => `stop refused: ${why}`;

/** `data:main.#2` — the TARGET column, printed before anything has run: the
 *  planner's own 1-based position within the window (`PaneSpec.index + 1`),
 *  marked with a leading `#` so it is never mistaken for a number tmux would
 *  recognise. It is NOT what the human hands to `tmux select-window` — under
 *  a `pane-base-index` other than 0, tmux numbers the same panes
 *  differently, and `resumedOutcome` above is the only place that carries
 *  tmux's own answer for it. */
export const targetName = (t: ManifestTarget): string => `${t.session}:${t.window}.#${t.pane + 1}`;

/** Where a run's manifest goes: `MS_HOME/imports/<ISO timestamp>.json`, with
 *  the colons of the timestamp flattened so the name is one word in a shell
 *  and on every filesystem. */
export function manifestPath(at: Date = new Date()): string {
  return path.join(msHome(), "imports", `${at.toISOString().replace(/[:.]/g, "-")}.json`);
}

// --- Plan ⇄ manifest ----------------------------------------------------

/**
 * The manifest a plan starts as: every movable conversation `planned`, and
 * every skipped one recorded with the reason it was skipped.
 *
 * The skipped rows are not padding. "This conversation was NOT moved, because
 * it is already in tmux" is exactly as much a part of the record as a row that
 * was — without them, a human comparing the table to their own machine cannot
 * tell a conversation the tool passed over from one it never saw.
 */
export function manifestFromPlan(plan: Plan, meta: { since: string; dirs: string[]; createdAt?: Date }): Manifest {
  const rows: ManifestRow[] = [];
  for (const session of plan.sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        rows.push({
          ...candidateFields(pane.candidate),
          root: session.root,
          worktree: window.worktree,
          command: [...pane.command],
          target: { session: pane.session, window: pane.window, pane: pane.index, paneId: null, paneIndex: null },
          outcome: OUTCOME_PLANNED,
        });
      }
    }
  }
  for (const s of plan.skipped) {
    rows.push({ ...candidateFields(s.candidate), root: s.candidate.cwd, worktree: s.candidate.cwd, command: null, target: null, outcome: skipped(s.reason) });
  }
  return {
    createdAt: (meta.createdAt ?? new Date()).toISOString(),
    server: plan.server,
    socket: plan.socket,
    since: meta.since,
    dirs: [...meta.dirs],
    rows,
  };
}

/** Everything a row says about the conversation itself, from the candidate —
 *  with the flag whitelist applied to `argv`, once, here, so no caller of this
 *  module can write a raw command line into the file by accident. */
export function candidateFields(c: Candidate): Omit<ManifestRow, "root" | "worktree" | "command" | "target" | "outcome"> {
  return {
    provider: c.provider,
    id: c.id,
    cwd: c.cwd,
    lastActivity: new Date(c.lastActivity).toISOString(),
    title: c.title,
    compacted: c.compacted,
    pid: c.pid,
    startedAt: c.startedAt === null ? null : new Date(c.startedAt).toISOString(),
    argv: c.argv ? keptFlags(c.provider, c.argv) : null,
  };
}

/**
 * The plan a manifest IS — what `ms import --plan <file>` runs.
 *
 * Nothing is re-derived: the rows already say which session, which window,
 * which pane index and which command line, and those are the decisions the
 * human approved when they were shown the table. Re-running the planner here
 * would let a `git worktree` that has moved since, or a planner that has
 * changed since, quietly produce a different plan under the same file name.
 *
 * Rows the file records as already finished (`resumed in …`) are kept in the
 * plan: the executor re-reads the manifest anyway, and an execution that
 * skipped them would make `--plan` of a completed manifest silently a no-op
 * rather than an honest re-run.
 */
export function planFromManifest(m: Manifest): Plan {
  const sessions: PlanSession[] = [];
  const skippedRows: { candidate: Candidate; reason: string }[] = [];
  for (const row of m.rows) {
    if (!row.target || !row.command) {
      const reason = row.outcome.startsWith("skipped: ") ? row.outcome.slice("skipped: ".length) : row.outcome;
      skippedRows.push({ candidate: candidateFromRow(row), reason });
      continue;
    }
    let session = sessions.find((s) => s.name === row.target!.session);
    if (!session) {
      session = { name: row.target.session, root: row.root, windows: [] };
      sessions.push(session);
    }
    let window: PlanWindow | undefined = session.windows.find((w) => w.name === row.target!.window);
    if (!window) {
      window = { name: row.target.window, worktree: row.worktree, panes: [] };
      session.windows.push(window);
    }
    const pane: PaneSpec = {
      candidate: candidateFromRow(row),
      command: [...row.command],
      session: row.target.session,
      window: row.target.window,
      index: row.target.pane,
    };
    window.panes.push(pane);
  }
  return {
    server: m.server === "ms" ? "ms" : "current",
    socket: m.socket,
    sessions,
    skipped: skippedRows,
  };
}

/**
 * A row read back as the candidate it came from.
 *
 * `transcriptPath`, `inTmux` and `managed` are scan-time facts with no meaning
 * at execution time and are deliberately not in the file: a manifest read
 * tomorrow must not claim yesterday's tmux server or yesterday's store are
 * still true.
 *
 * `startedAt` is the exception, and for the same reason. It is precisely
 * yesterday's process table — which is why it has to travel: it is what lets
 * the executor ask whether the pid on this row is still the process that was
 * planned against, instead of taking the number on trust.
 */
function candidateFromRow(row: ManifestRow): Candidate {
  const t = Date.parse(row.lastActivity);
  const started = row.startedAt === null || row.startedAt === undefined ? NaN : Date.parse(row.startedAt);
  return {
    provider: row.provider,
    id: row.id,
    cwd: row.cwd,
    transcriptPath: "",
    lastActivity: Number.isFinite(t) ? t : 0,
    title: row.title,
    compacted: row.compacted,
    pid: row.pid,
    argv: row.argv ? [...row.argv] : null,
    startedAt: Number.isFinite(started) ? started : null,
    inTmux: false,
    managed: false,
  };
}

// --- The file -----------------------------------------------------------

/** Write it, atomically, 0600, creating `MS_HOME/imports` if this is the
 *  first one. The executor calls this after every step, so it has to be cheap
 *  and it has to be all-or-nothing: a manifest half-written by a crash is the
 *  one artefact a rollback cannot use. */
export function writeManifest(file: string, m: Manifest): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomicThroughLink(file, JSON.stringify(m, null, 2) + "\n", { forceMode: 0o600 });
}

/** Read one back. A file that is not a manifest says so by name rather than
 *  failing somewhere deep in the executor with `undefined is not iterable`. */
export function readManifest(file: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not an import manifest`);
  const m = parsed as Partial<Manifest>;
  if (!Array.isArray(m.rows)) throw new Error(`${file} is not an import manifest (no rows)`);
  return {
    createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    server: m.server === "ms" ? "ms" : "current",
    socket: typeof m.socket === "string" ? m.socket : null,
    since: typeof m.since === "string" ? m.since : "",
    dirs: Array.isArray(m.dirs) ? m.dirs.filter((d): d is string => typeof d === "string") : [],
    rows: m.rows as ManifestRow[],
  };
}

// --- The table ----------------------------------------------------------

const HOME = (): string => process.env.HOME ?? "";

/** `~/src/data`, because the full path is the least interesting 20 characters
 *  of every row. */
export function shorten(p: string): string {
  const home = HOME();
  return home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function columns(rows: string[][]): string[] {
  const width: number[] = [];
  for (const r of rows) r.forEach((cell, i) => { width[i] = Math.max(width[i] ?? 0, [...cell].length); });
  return rows.map((r) =>
    r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat((width[i] ?? 0) - [...cell].length)))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * The table — the one thing a human actually reads, in `--dry-run`, before the
 * confirmation, and from `--status` afterwards.
 *
 * One line per conversation, in plan order, ending in the outcome: that column
 * is the whole point of the file, so it is last and it is never truncated.
 */
export function formatManifest(m: Manifest): string {
  const moving = m.rows.filter((r) => r.target).length;
  const live = m.rows.filter((r) => r.target && r.pid !== null).length;
  const head = [
    `${moving} conversation${moving === 1 ? "" : "s"} to move${live ? `, stopping ${live} live process${live === 1 ? "" : "es"}` : ""}`,
    `server ${m.server}`,
    `since ${m.since || "all"}`,
    ...(m.dirs.length ? [m.dirs.map(shorten).join(" ")] : []),
  ].join(" · ");

  const body = columns([
    ["", "CLI", "CONVERSATION", "WHERE", "PID", "TARGET", "OUTCOME"],
    ...m.rows.map((r) => [
      "",
      r.provider,
      clip(r.title || r.id || "—", 40),
      clip(shorten(r.cwd), 34),
      r.pid === null ? "—" : String(r.pid),
      r.target ? targetName(r.target) : "—",
      r.outcome,
    ]),
  ]);
  return [head, "", ...body, ""].join("\n");
}
