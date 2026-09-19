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
// **Every tmux target is a pane id.** `split-window -P -F '#{pane_id}
// #{pane_index}'` hands back `%47 3`, and `%47` is what every later call
// names. `3` — tmux's OWN pane index — is recorded too (`ManifestTarget.
// paneIndex`), but only for the report a human reads; it is never derived
// from `PaneSpec.index`, the planner's 0-based slot, because the two agree
// only when the tmux server's `pane-base-index` is 0. Not `data:main.2` —
// a window can be renamed, moved between sessions or renumbered by the human
// in the seconds this loop is running, and a target built from names would
// then aim at somebody else's pane and type a command line into it.
//
// Everything with a clock or a consequence is injected (`ExecuteDeps`), so the
// signal path can be proved against a real sleeping script that handles
// SIGTERM and another that ignores it, without the suite ever spawning a CLI
// or waiting out a real ten seconds.

import path from "node:path";
import { spawnSync } from "node:child_process";
import { msBinary } from "../paths.ts";
import { defaultPs, providerOfArgv, type Candidate, type ProcessRow } from "./scan.ts";
import { shellQuote, type Tmux } from "../tmux.ts";
import type { Plan, PaneSpec } from "./plan.ts";
import {
  OUTCOME_PLANNED, OUTCOME_STOPPED, candidateFields, killedOutcome, readManifest, resumeFailed, resumedOutcome,
  stopFailed, stopRefused, targetName, writeManifest, type Manifest, type ManifestRow, type ManifestTarget,
} from "./manifest.ts";

/** How long the original CLI gets to leave on SIGTERM before SIGKILL (spec's
 *  Executor, step 1), and how long SIGKILL gets to take effect. */
const TERM_MS = 10_000;
const KILL_MS = 2_000;
/** How long a resumed pane gets to report itself through the CLI's own hook. */
const READY_MS = 60_000;
/** How often either wait looks again. */
const POLL_MS = 200;
/** How often that wait also asks the PANE what it is running. */
const SHELL_POLL_MS = 1_000;
/** How long a pane that has never been anything but a shell is given before
 *  the shell counts as evidence. Under it, the pane is simply one the command
 *  has not started in yet. */
const SHELL_SETTLE_MS = 5_000;
/** Consecutive shell readings that make a verdict. One is the pane it was born
 *  with; two is a moment between programs; three, a second apart, is a pane
 *  that has been handed back. */
const SHELL_STREAK = 3;

const envMs = (name: string, fallback: number): number => Number(process.env[name]) || fallback;
const termMs = (): number => envMs("MS_IMPORT_TERM_MS", TERM_MS);
const killMs = (): number => envMs("MS_IMPORT_KILL_MS", KILL_MS);
export const readyMs = (): number => envMs("MS_IMPORT_READY_MS", READY_MS);
const pollMs = (): number => envMs("MS_IMPORT_POLL_MS", POLL_MS);
export const shellPollMs = (): number => envMs("MS_IMPORT_SHELL_POLL_MS", SHELL_POLL_MS);
const shellSettleMs = (): number => envMs("MS_IMPORT_SHELL_SETTLE_MS", SHELL_SETTLE_MS);

/**
 * The shells a pane is born holding, by the name tmux reports for them.
 *
 * A closed list, on purpose. This decides when a row FAILS, so the cost of
 * over-matching is a working resume called a failure — and a program named
 * after a shell it is not is exactly the shape that would do it. A shell this
 * misses costs one row the full sixty seconds it already spent in 0.3.0.
 */
const SHELLS = new Set(["bash", "zsh", "sh", "fish"]);

/** Is this `#{pane_current_command}` a shell? A login shell arrives as `-zsh`
 *  from some sources, so the leading dash is stripped before the lookup. */
export function isShellCommand(command: string): boolean {
  return SHELLS.has(command.trim().replace(/^-/, ""));
}

/**
 * Watch one pane's `#{pane_current_command}` and say when its command has
 * returned to the shell.
 *
 * The failure this exists for, from the live run on mini 1: the pane's
 * `ms adopt` printed a refusal and exited in under a second, nothing was ever
 * written to the store, and the wait — which reads the store — had nothing to
 * see for sixty seconds, three times over. The pane itself was saying so the
 * whole time.
 *
 * Two readings are deliberately not a verdict, because a pane at a shell is
 * the NORMAL state twice over: it is what the pane is born as, before
 * `send-keys`, and it is what it is again for an instant between one program
 * and the next. So the shell only speaks after the pane has been something
 * else — or, when it never was, after `SHELL_SETTLE_MS`, which is the case of
 * a command that had already failed before the first reading.
 *
 * `null` is tmux declining to answer, and is no evidence either way: it does
 * not count towards the streak and does not clear it (src/tmux.ts).
 *
 * `sentAt` and every `now` are epoch ms on the caller's own clock.
 */
export function paneReturnWatch(sentAt: number): (command: string | null, now: number) => boolean {
  let streak = 0;
  let sawOther = false;
  return (command, now) => {
    if (command === null) return false;
    if (!isShellCommand(command)) {
      sawOther = true;
      streak = 0;
      return false;
    }
    streak += 1;
    const armed = sawOther || now - sentAt >= shellSettleMs();
    return armed && streak >= SHELL_STREAK;
  };
}

/**
 * The last `n` non-empty lines of a captured pane, trimmed.
 *
 * `n` is four because the line worth reading is not the last one: a command
 * that refused printed its reason and then the shell printed a prompt under
 * it, and the reason is usually three lines up (`ms adopt`'s own refusals are
 * a line plus two of detail). The FIRST of these four is what a row records.
 */
export function lastScreenLines(screen: string, n = 4): string[] {
  const lines = screen.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.slice(Math.max(0, lines.length - n));
}

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
   *
   * `paneId` is the pane the command was typed into, so the wait can watch it
   * as well as the store: `returned` is that pane back at a shell prompt,
   * which is a resume that has already refused and will never report
   * (`paneReturnWatch`). The executor reads the refusal off the screen.
   */
  waitReady: (candidateId: string, deadlineMs: number, paneId: string) => Promise<"ready" | "timeout" | "died" | "returned">;
  log: (line: string) => void;
  /**
   * Every descendant of a pid, deepest first — read once, just before the
   * SIGKILL fallback, and never for a SIGTERM (see `stopProcess`). Optional:
   * the default walks `ps -axo pid=,ppid=`.
   */
  descendants?: (pid: number) => number[];
  /**
   * The process table, NOW — read again just before anything is signalled, so
   * a pid can be re-identified rather than taken on trust. Optional: the
   * default is the scanner's own bounded `ps` (`defaultPs`), which is where
   * the recorded `startedAt` came from in the first place, so the two readings
   * are the same reading twice.
   */
  ps?: () => ProcessRow[];
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

/**
 * `ps -axo pid=,ppid=` as a pid → ppid map. A line that is not two numbers is
 * skipped rather than fatal: this decides what gets SIGKILLed, so a line we
 * cannot read must mean "not in the tree", never a guess.
 */
export function parsePidParents(stdout: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    out.set(pid, ppid);
  }
  return out;
}

/**
 * Everything under `pid`, deepest first, never including `pid` itself.
 *
 * Deepest first because a tree is killed from the leaves: signalling a parent
 * before the child it owns is how a grandchild is reparented mid-walk and
 * survives. `seen` bounds it — a table that claims a process is its own
 * ancestor is malformed, and here it simply terminates.
 */
export function descendantsOf(pid: number, parents: Map<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  const levels: number[][] = [];
  const seen = new Set<number>([pid]);
  let frontier = [pid];
  while (frontier.length) {
    const next: number[] = [];
    for (const p of frontier) {
      for (const child of children.get(p) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (next.length) levels.push(next);
    frontier = next;
  }
  return levels.reverse().flat();
}

/**
 * The default descendant lookup: one bounded `ps`, walked in process.
 *
 * One reading, not a `pgrep` per level: a tree read across several calls is a
 * tree that changed between them, and the pids this returns are about to be
 * SIGKILLed.
 */
export function defaultDescendants(pid: number): number[] {
  const r = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 16 << 20,
  });
  return r.stdout ? descendantsOf(pid, parsePidParents(r.stdout)) : [];
}

const SUBPROCESS_TIMEOUT_MS = 10_000;

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
 * Is the pid on this row still the process the plan was made against?
 *
 * A pid is a number the kernel re-uses, and a manifest is a file that outlives
 * the moment it was written: `--dry-run` at 09:00 and `--plan` at 17:00 is a
 * documented way to use this verb, and by 17:00 pid 4242 may be somebody's
 * `npm run dev`. `alive(pid)` cannot tell the two apart — it answers "some
 * process has this number", which is the question that matters least.
 *
 * So the process table is read again and the row's own record checked against
 * it: the START TIME (to the second — `ps lstart` has no finer resolution),
 * and that the command is still that CLI. Either one differing is a stranger.
 *
 * Both of the "cannot tell" cases refuse, deliberately. A row with no recorded
 * start time cannot be re-identified at all, and a pid that `alive` accepts
 * but the table does not list is two readings that disagree. Nothing is lost
 * by refusing: the conversation is on disk, the manifest says where, and the
 * human can re-run the scan — which is not true of a SIGKILL sent to the wrong
 * process.
 */
function sameProcess(c: Candidate, deps: ExecuteDeps): { ok: true } | { ok: false; why: string } {
  const pid = c.pid!;
  if (c.startedAt === null) return { ok: false, why: `pid ${pid} has no recorded start time to check against` };
  const table = (deps.ps ?? defaultPs)();
  const row = table.find((r) => r.pid === pid);
  if (!row) return { ok: false, why: `pid ${pid} is not in the process table any more` };
  const stranger = Math.abs(row.startedAt - c.startedAt) > 1000 || providerOfArgv(row.argv) !== c.provider;
  return stranger ? { ok: false, why: `pid ${pid} is not the process the plan recorded` } : { ok: true };
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
 *
 * `refused` is not `ok: false` with a nicer word: nothing was signalled, and
 * the row says so, because "we would not touch this pid" and "we tried and it
 * would not go" are different things to read in a rollback record.
 *
 * The SIGKILL fallback takes the DESCENDANTS with it, and SIGTERM deliberately
 * does not. A CLI installed from npm is a wrapper and the process doing the
 * work — `node …/codex` and its native child — and a wrapper forwards a
 * SIGTERM, which is why the polite path stays the parent's alone. SIGKILL
 * cannot be forwarded by anything, so killing the wrapper there leaves the
 * child orphaned onto launchd, still holding the conversation this import is
 * about to resume in a pane. The tree is read BEFORE the first signal, because
 * once the parent is gone its children are reparented and the link that names
 * them is lost, and it is signalled leaves first for the same reason.
 */
async function stopProcess(c: Candidate, deps: ExecuteDeps): Promise<{ ok: true; forced: boolean; killed: number[] } | { ok: false; refused: boolean; why: string }> {
  const pid = c.pid!;
  if (!deps.alive(pid)) return { ok: true, forced: false, killed: [] }; // it left while we were planning
  const same = sameProcess(c, deps);
  if (!same.ok) return { ok: false, refused: true, why: same.why };
  if (!deps.kill(pid, "SIGTERM") && deps.alive(pid)) return { ok: false, refused: false, why: `could not signal pid ${pid}` };
  if (await waitGone(pid, termMs(), deps)) return { ok: true, forced: false, killed: [] };
  const kin = (deps.descendants ?? defaultDescendants)(pid);
  for (const child of kin) deps.kill(child, "SIGKILL");
  deps.kill(pid, "SIGKILL");
  if (await waitGone(pid, killMs(), deps)) return { ok: true, forced: true, killed: kin };
  return { ok: false, refused: false, why: `pid ${pid} is still running after SIGKILL` };
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
        const target: ManifestTarget = { session: pane.session, window: pane.window, pane: pane.index, paneId: null, paneIndex: null };
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
          const stop = await stopProcess(c, deps);
          if (!stop.ok) {
            row.outcome = stop.refused ? stopRefused(stop.why) : stopFailed(stop.why);
            result.failed += 1;
            save();
            deps.log(`${short(c)}: ${row.outcome}`);
            continue; // its transcript is still being written; making a pane for it now would resume a live conversation twice
          }
          result.stopped += 1;
          row.outcome = stop.forced ? killedOutcome(c.pid, stop.killed.length) : OUTCOME_STOPPED;
          save();
          deps.log(`${short(c)}: ${stop.forced ? row.outcome : `stopped pid ${c.pid}`}`);
        }

        // 2. The pane, born holding a shell, in the conversation's own cwd.
        let paneId: string;
        try {
          const created = makePane(deps.tmux, pane, session.name, firstPaneOf, sessionsMade);
          paneId = created.id;
          row.target!.paneId = created.id;
          row.target!.paneIndex = created.index;
        } catch (e) {
          row.outcome = resumeFailed((e as Error).message);
          result.failed += 1;
          save();
          deps.log(`${short(c)}: ${row.outcome}`);
          continue;
        }
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
        const seen = await deps.waitReady(c.id, deps.now() + readyMs(), paneId);
        // A pane whose command has exited explains a silence tmux could have
        // explained in one call; `paneDead` is null when tmux could not be
        // asked, which is never evidence of a death (src/tmux.ts).
        const verdict = seen === "timeout" && deps.tmux.paneDead(paneId) === true ? "died" : seen;
        if (verdict === "ready") {
          result.moved += 1;
          row.outcome = resumedOutcome(row.target!);
        } else {
          result.failed += 1;
          row.outcome = resumeFailed(whyNotResumed(verdict, paneId, deps.tmux));
        }
        save();
        deps.log(`${short(c)}: ${row.outcome}`);
      }
    }
  }
  return result;
}

/**
 * Why a row did not come back, in the words a human can act on.
 *
 * `returned` is the one that reads the SCREEN, and only there: the pane has
 * handed the shell back, so whatever the command said before it exited is
 * still on it, and that sentence is worth more than any phrasing of ours. The
 * pane id carries the fallback, for a command that refused without a word.
 */
function whyNotResumed(verdict: "timeout" | "died" | "returned", paneId: string, tmux: Tmux): string {
  if (verdict === "died") return `the pane died (${paneId})`;
  if (verdict === "timeout") return `no report within ${Math.round(readyMs() / 1000)}s (the pane is ${paneId})`;
  const said = lastScreenLines(tmux.capture(paneId))[0];
  return said ?? `the command returned to a shell (the pane is ${paneId})`;
}

/** How a row is named in a log line: enough to find it, never the whole id. */
function short(c: { provider: string; id: string; cwd: string }): string {
  const id = c.id.length > 8 ? c.id.slice(0, 8) : c.id;
  return `${c.provider} ${id || "?"} in ${path.basename(c.cwd) || c.cwd}`;
}

/** `-F` for every pane-creation call this module makes: the id AND tmux's
 *  own index for the pane, in the same call, so the two numbers are read
 *  from the same moment rather than a second query that could race a human
 *  renumbering the window in between. `Tmux.newSession`/`newWindow`/
 *  `splitWindow` only ever ask for `#{pane_id}`, which is why `makePane`
 *  below drives `tmux.run` directly instead of those three. */
const PANE_FORMAT = "#{pane_id} #{pane_index}";

/**
 * Runs one tmux pane-creation command and parses both fields `PANE_FORMAT`
 * asked for. The error text matches what `Tmux`'s own (private) `must` would
 * have thrown for the same failure — `args[0]` is the tmux verb — because a
 * manifest row that fails here still needs to say which one refused.
 */
function paneCreated(tmux: Tmux, args: string[]): { id: string; index: number } {
  const r = tmux.run(args);
  if (r.code !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim() || r.code}`);
  const [id, index] = r.stdout.trim().split(/\s+/);
  return { id: id!, index: Number(index) };
}

/**
 * The pane this row runs in, made the way the plan says — and BOTH numbers
 * tmux hands back for it: the id (the only address that survives a rename)
 * and tmux's own `#{pane_index}` in that window, never derived from
 * `PaneSpec.index` (the planner's 0-based slot — see the module doc comment
 * and `ManifestTarget.paneIndex`).
 *
 * The window's FIRST pane makes the window (and the session, when this is the
 * first window of a session that is not already open); the rest split that
 * pane and re-tile. `new-window` is given `"<session>:"` rather than the bare
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
): { id: string; index: number } {
  const key = windowKey(pane);
  const cwd = pane.candidate.cwd;
  const first = firstPaneOf.get(key);
  if (first) {
    const created = paneCreated(tmux, ["split-window", "-P", "-F", PANE_FORMAT, "-t", first, "-c", cwd]);
    tmux.selectLayout(first, "tiled");
    return created;
  }
  const open = sessionsMade.has(sessionName) || tmux.hasSession(sessionName);
  const created = open
    ? paneCreated(tmux, ["new-window", "-P", "-F", PANE_FORMAT, "-t", `${sessionName}:`, "-c", cwd, ...(pane.window ? ["-n", pane.window] : [])])
    : paneCreated(tmux, ["new-session", "-d", "-P", "-F", PANE_FORMAT, "-s", sessionName, "-c", cwd, ...(pane.window ? ["-n", pane.window] : [])]);
  sessionsMade.add(sessionName);
  firstPaneOf.set(key, created.id);
  return created;
}
