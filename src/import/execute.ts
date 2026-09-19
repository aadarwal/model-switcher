// src/import/execute.ts
//
// `ms import`, the half that touches the world: stop the CLI that is holding a
// conversation open, make the pane the plan chose for it, and type the command
// that brings the same conversation back under `ms`.
//
// Three rules shape every line of it.
//
// **A failure never stops the run.** An import is a batch of independent
// rescues; a `codex` that refuses to die, a tmux that refuses a window, a
// resume that never reports — none of those is a reason to leave the other
// eleven conversations where they were. Each row is tried, its outcome is
// written down, and the next row starts. The counts at the end say how it
// went, and the exit code follows the counts.
//
// **The manifest is written after every step, not at the end — and before the
// line that announces the step.** The moment
// after a SIGTERM lands is the moment the record matters most: the human's CLI
// is gone and nothing has replaced it yet. If this process dies right there,
// `MS_HOME/imports/<stamp>.json` still says which conversation that was, in
// which directory, and the exact command line to bring it back by hand.
//
// **Every tmux target is a pane id.** `split-window -P -F '#{pane_id}'` hands
// back `%47`, and `%47` is what every later call names. Not `data:main.2` —
// a window can be renamed, moved between sessions or renumbered by the human
// in the seconds this loop is running, and a target built from names would
// then aim at somebody else's pane and type a command line into it.
//
// Everything with a clock or a consequence is injected (`ExecuteDeps`), so the
// signal path can be proved against a real sleeping script that handles
// SIGTERM and another that ignores it, without the suite ever spawning a CLI
// or waiting out a real ten seconds.

import path from "node:path";
import { msBinary } from "../paths.ts";
import { shellQuote, type Tmux } from "../tmux.ts";
import type { Plan, PaneSpec } from "./plan.ts";
import {
  OUTCOME_PLANNED, OUTCOME_STOPPED, candidateFields, readManifest, resumeFailed, resumedOutcome,
  stopFailed, targetName, writeManifest, type Manifest, type ManifestRow, type ManifestTarget,
} from "./manifest.ts";

/** How long the original CLI gets to leave on SIGTERM before SIGKILL (spec's
 *  Executor, step 1), and how long SIGKILL gets to take effect. */
const TERM_MS = 10_000;
const KILL_MS = 2_000;
/** How long a resumed pane gets to report itself through the CLI's own hook. */
const READY_MS = 60_000;
/** How often either wait looks again. */
const POLL_MS = 200;

const envMs = (name: string, fallback: number): number => Number(process.env[name]) || fallback;
const termMs = (): number => envMs("MS_IMPORT_TERM_MS", TERM_MS);
const killMs = (): number => envMs("MS_IMPORT_KILL_MS", KILL_MS);
export const readyMs = (): number => envMs("MS_IMPORT_READY_MS", READY_MS);
const pollMs = (): number => envMs("MS_IMPORT_POLL_MS", POLL_MS);

export interface ExecuteDeps {
  /** The repo's tmux wrapper, already pointed at the plan's socket. */
  tmux: Tmux;
  /** `false` means the signal could not be delivered (no such process, or it
   *  is not ours) — never "it did not work". */
  kill: (pid: number, sig: NodeJS.Signals) => boolean;
  alive: (pid: number) => boolean;
  /** Epoch ms. Injected so a test can spend ten seconds in no time at all. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Has the conversation come back? `deadlineMs` is an absolute epoch-ms
   * deadline on `now()`'s clock (in production that clock is `Date.now`).
   * `died` is for a pane whose command has exited — the resume that never
   * happened, answered in a second rather than in a minute.
   */
  waitReady: (candidateId: string, deadlineMs: number) => Promise<"ready" | "timeout" | "died">;
  log: (line: string) => void;
}

export interface ExecuteResult {
  moved: number;
  stopped: number;
  failed: number;
}

/**
 * The default `kill`/`alive` pair: the same two calls src/recover.ts makes,
 * with the same reading of errno.
 *
 * `kill` answers "was the signal delivered", so ANY throw is false — ESRCH
 * (it had already gone, which `alive` then confirms and nobody calls a
 * failure) and EPERM alike. EPERM is the one worth being strict about: a pid
 * that is not ours to signal is a conversation this tool cannot stop, and
 * pretending otherwise would have the import make a second pane on a
 * transcript a live CLI is still writing.
 */
export function signalPid(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Wait for a pid to go, on the injected clock. True when it is gone. */
async function waitGone(pid: number, budgetMs: number, deps: ExecuteDeps): Promise<boolean> {
  const deadline = deps.now() + budgetMs;
  for (;;) {
    if (!deps.alive(pid)) return true;
    const left = deadline - deps.now();
    if (left <= 0) return false;
    await deps.sleep(Math.min(pollMs(), left));
  }
}

/**
 * Stop the CLI that is holding this conversation open.
 *
 * SIGTERM, ten seconds, then SIGKILL — the spec's own sequence, and the reason
 * it is safe is that both CLIs write their transcript continuously: the
 * conversation on disk is complete the moment the process is gone, whichever
 * signal did it. There is no "ask it nicely" step here the way there is in a
 * rotation (`/exit`, Ctrl-C): that path types into a pane, and the whole point
 * of an import is a CLI that is NOT in a pane we can type into.
 */
async function stopProcess(pid: number, deps: ExecuteDeps): Promise<{ ok: true; forced: boolean } | { ok: false; why: string }> {
  if (!deps.alive(pid)) return { ok: true, forced: false }; // it left while we were planning
  if (!deps.kill(pid, "SIGTERM") && deps.alive(pid)) return { ok: false, why: `could not signal pid ${pid}` };
  if (await waitGone(pid, termMs(), deps)) return { ok: true, forced: false };
  deps.kill(pid, "SIGKILL");
  if (await waitGone(pid, killMs(), deps)) return { ok: true, forced: true };
  return { ok: false, why: `pid ${pid} is still running after SIGKILL` };
}

/**
 * The command line typed into the new pane.
 *
 * `command[0]` is the plan's literal `ms`, replaced here by this install's own
 * binary: the pane is born holding a login-less shell whose PATH is whatever
 * the human's shell rc built, and an import that resolved `ms` there would
 * work on the developer's machine and fail on a Homebrew install reached only
 * through an alias. Every word is shell-quoted, including the path, because a
 * `send-keys` argument is a line of shell, and a checkout under "Application
 * Support" is the common case.
 *
 * Nothing secret can be in it: the planner keeps flags by whitelist, so a
 * human's `--api-key` never reaches this string, this pane, or the tmux
 * server's own memory of the command.
 */
export function paneCommandLine(command: string[], msBin: string = msBinary()): string {
  return shellQuote([msBin, ...command.slice(1)]);
}

/** One window's first pane, remembered by session+window so the second, third
 *  and fourth panes split IT rather than whatever tmux happens to have active
 *  — which, between two rows, may be a pane in another window entirely. */
const windowKey = (pane: PaneSpec): string => JSON.stringify([pane.session, pane.window]);
const rowKey = (provider: string, id: string, t: ManifestTarget | null): string =>
  JSON.stringify([provider, id, t ? targetName(t) : ""]);

/**
 * Carry out a plan, writing its manifest as it goes.
 *
 * The manifest at `manifestPath` is the one the verb already wrote (every row
 * `planned`) — it is read back rather than rebuilt so that `--dry-run` and the
 * run that follows it, or `--plan <file>` a day later, are the same document
 * with the same `createdAt`, `since` and `dirs`. Rows are matched to panes by
 * conversation and target; a row the file does not have (a hand-edited
 * manifest) is appended rather than silently unrecorded.
 */
export async function executeImport(plan: Plan, manifestPath: string, deps: ExecuteDeps): Promise<ExecuteResult> {
  const manifest: Manifest = readManifest(manifestPath);
  const byKey = new Map<string, ManifestRow>();
  for (const r of manifest.rows) byKey.set(rowKey(r.provider, r.id, r.target), r);
  const save = (): void => writeManifest(manifestPath, manifest);

  const firstPaneOf = new Map<string, string>();
  const sessionsMade = new Set<string>();
  const result: ExecuteResult = { moved: 0, stopped: 0, failed: 0 };

  for (const session of plan.sessions) {
    for (const window of session.windows) {
      for (const pane of window.panes) {
        const c = pane.candidate;
        const target: ManifestTarget = { session: pane.session, window: pane.window, pane: pane.index, paneId: null };
        let row = byKey.get(rowKey(c.provider, c.id, target));
        if (!row) {
          row = {
            ...candidateFields(c),
            root: session.root, worktree: window.worktree,
            command: [...pane.command], target, outcome: OUTCOME_PLANNED,
          };
          manifest.rows.push(row);
          byKey.set(rowKey(c.provider, c.id, target), row);
        }
        row.target ??= target;

        // 1. The original process, if there still is one.
        if (c.pid !== null) {
          const stop = await stopProcess(c.pid, deps);
          if (!stop.ok) {
            row.outcome = stopFailed(stop.why);
            result.failed += 1;
            save();
            deps.log(`${short(c)}: ${row.outcome}`);
            continue; // its transcript is still being written; making a pane for it now would resume a live conversation twice
          }
          result.stopped += 1;
          row.outcome = OUTCOME_STOPPED;
          save();
          deps.log(`${short(c)}: stopped pid ${c.pid}${stop.forced ? " (SIGKILL)" : ""}`);
        }

        // 2. The pane, born holding a shell, in the conversation's own cwd.
        let paneId: string;
        try {
          paneId = makePane(deps.tmux, pane, session.name, firstPaneOf, sessionsMade);
        } catch (e) {
          row.outcome = resumeFailed((e as Error).message);
          result.failed += 1;
          save();
          deps.log(`${short(c)}: ${row.outcome}`);
          continue;
        }
        row.target!.paneId = paneId;
        save();

        // 3. The command line, and the conversation reporting itself back.
        try {
          deps.tmux.sendKeys(paneId, [paneCommandLine(pane.command), "Enter"]);
        } catch (e) {
          row.outcome = resumeFailed((e as Error).message);
          result.failed += 1;
          save();
          deps.log(`${short(c)}: ${row.outcome}`);
          continue;
        }
        const seen = await deps.waitReady(c.id, deps.now() + readyMs());
        // A pane whose command has exited explains a silence tmux could have
        // explained in one call; `paneDead` is null when tmux could not be
        // asked, which is never evidence of a death (src/tmux.ts).
        const verdict = seen === "timeout" && deps.tmux.paneDead(paneId) === true ? "died" : seen;
        if (verdict === "ready") {
          result.moved += 1;
          row.outcome = resumedOutcome(row.target!);
        } else {
          result.failed += 1;
          row.outcome = resumeFailed(
            verdict === "died"
              ? `the pane died (${paneId})`
              : `no report within ${Math.round(readyMs() / 1000)}s (the pane is ${paneId})`,
          );
        }
        save();
        deps.log(`${short(c)}: ${row.outcome}`);
      }
    }
  }
  return result;
}

/** How a row is named in a log line: enough to find it, never the whole id. */
function short(c: { provider: string; id: string; cwd: string }): string {
  const id = c.id.length > 8 ? c.id.slice(0, 8) : c.id;
  return `${c.provider} ${id || "?"} in ${path.basename(c.cwd) || c.cwd}`;
}

/**
 * The pane this row runs in, made the way the plan says.
 *
 * The window's FIRST pane makes the window (and the session, when this is the
 * first window of a session that is not already open); the rest split that
 * pane and re-tile. `newWindow` is given `"<session>:"` rather than the bare
 * name because a bare target is looked up as a window of the CURRENT session
 * first — and our session names are basenames, which is exactly the class of
 * word somebody's current session already has a window called.
 */
function makePane(
  tmux: Tmux,
  pane: PaneSpec,
  sessionName: string,
  firstPaneOf: Map<string, string>,
  sessionsMade: Set<string>,
): string {
  const key = windowKey(pane);
  const first = firstPaneOf.get(key);
  if (first) {
    const id = tmux.splitWindow(first, pane.candidate.cwd, []);
    tmux.selectLayout(first, "tiled");
    return id;
  }
  const open = sessionsMade.has(sessionName) || tmux.hasSession(sessionName);
  const id = open
    ? tmux.newWindow(`${sessionName}:`, pane.candidate.cwd, [], pane.window)
    : tmux.newSession(sessionName, pane.candidate.cwd, [], pane.window);
  sessionsMade.add(sessionName);
  firstPaneOf.set(key, id);
  return id;
}
