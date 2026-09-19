// test/import-execute.test.ts — the executor (`src/import/execute.ts`) and the
// manifest (`src/import/manifest.ts`).
//
// Hermetic, and deliberately hermetic in two different ways.
//
// tmux is a bash STUB on PATH, driven through the repo's own `Tmux` wrapper —
// so the argument strings asserted here are the ones a real tmux would have
// received, quoting and all, rather than the ones a hand-written double was
// asked to record. It hands out `%1`, `%2`, … for every pane it makes, which
// is what makes "every target is a pane id" a thing to prove.
//
// The processes are REAL. A row that is "live" holds the pid of a sleeping
// shell script this test started: one that traps SIGTERM and leaves, one that
// ignores it and has to be killed. `kill`/`alive` are the real calls; only the
// CLOCK is fake, so the ten-second grace the spec asks for costs no time at
// all. Nothing here signals a process it did not start.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome, stubDir } from "./helpers.ts";
import { Tmux } from "../src/tmux.ts";
import type { Candidate, ProcessRow } from "../src/import/scan.ts";
import type { Plan } from "../src/import/plan.ts";
import type { ExecuteDeps } from "../src/import/execute.ts";
import type { Manifest } from "../src/import/manifest.ts";

const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);
const ORIGINAL_PATH = process.env.PATH ?? "";

/** tmux, as far as the executor drives it: every call logged, every
 *  window/split answered with a fresh pane id AND tmux's own `#{pane_index}`
 *  for it, `has-session` answered from a file, `#{pane_dead}` answered from
 *  another.
 *
 *  The index is per-WINDOW, reset to a base of 5 (never 0 or 1 — an
 *  arbitrary base is the only way a test can prove the executor reads
 *  tmux's real answer rather than deriving it from `PaneSpec.index`) on
 *  every `new-session`/`new-window`, and incremented on every
 *  `split-window` — which is safe only because the executor always finishes
 *  one window's panes before starting the next (proven by the other tests
 *  in this file), so "the current window" needs no id of its own here. */
const TMUX_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
if [ -n "$MS_TMUX_FAIL" ]; then case "$1" in $MS_TMUX_FAIL) echo "tmux: stub refuses $1" >&2; exit 1 ;; esac; fi
case "$1" in
  new-session|new-window)
    n=$(cat "$MS_TMUX_PANES" 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" > "$MS_TMUX_PANES"
    printf '5' > "$MS_TMUX_WIN_INDEX"
    printf '%%%s 5\n' "$n" ;;
  split-window)
    n=$(cat "$MS_TMUX_PANES" 2>/dev/null || echo 0); n=$((n + 1)); printf '%s' "$n" > "$MS_TMUX_PANES"
    i=$(cat "$MS_TMUX_WIN_INDEX" 2>/dev/null || echo 5); i=$((i + 1)); printf '%s' "$i" > "$MS_TMUX_WIN_INDEX"
    printf '%%%s %s\n' "$n" "$i" ;;
  has-session)
    grep -qxF "$3" "$MS_TMUX_SESSIONS" 2>/dev/null || exit 1 ;;
  list-sessions) cat "$MS_TMUX_SESSIONS" 2>/dev/null ;;
  display-message) cat "$MS_TMUX_DEAD" 2>/dev/null || printf '0\n' ;;
esac
exit 0`;

/**
 * A "CLI": a shell script that sleeps. One leaves on SIGTERM; the other
 * ignores it and has to be killed, which is the whole reason the fallback
 * exists. Always reaped.
 *
 * It announces itself by touching a file AFTER installing its trap, and this
 * waits for that — because a `bash` four milliseconds old has been forked and
 * not yet reached line two, and a SIGTERM that arrives there kills it whatever
 * the script says. Measured: without the wait, the stubborn one dies on
 * SIGTERM about as often as not, which is a test that proves nothing.
 */
async function liveProcess(t: TestContext, dir: string, kind: "polite" | "stubborn"): Promise<number> {
  const script = path.join(dir, `${kind}.sh`);
  const ready = path.join(dir, `${kind}.ready`);
  writeFileSync(
    script,
    `#!/bin/bash\ntrap ${kind === "polite" ? "'exit 0'" : "''"} TERM\ntouch "$1"\nsleep 30 &\nwait\n`,
  );
  chmodSync(script, 0o755);
  const child: ChildProcess = spawn("bash", [script, ready], { stdio: "ignore" });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  for (let i = 0; i < 400 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(existsSync(ready), `${kind} never came up`);
  return child.pid!;
}

function cand(over: Partial<Candidate> & Pick<Candidate, "id" | "cwd">): Candidate {
  return {
    provider: "claude", transcriptPath: `/t/${over.id}.jsonl`, lastActivity: T0,
    title: `title ${over.id}`, compacted: false, pid: null, argv: null,
    // A live candidate always has a start time: the scanner reads it off `ps`,
    // and it is what makes the pid re-identifiable later.
    startedAt: over.pid !== undefined && over.pid !== null ? T0 - 60_000 : null,
    inTmux: false, managed: false, ...over,
  };
}

/** The process table as the plan recorded it — every live row still itself. */
function tableFor(plan: Plan): ProcessRow[] {
  const out: ProcessRow[] = [];
  for (const s of plan.sessions) {
    for (const w of s.windows) {
      for (const p of w.panes) {
        const c = p.candidate;
        if (c.pid !== null) out.push({ pid: c.pid, startedAt: c.startedAt ?? 0, tty: "s001", argv: [c.provider] });
      }
    }
  }
  return out;
}

/** A one-session plan over the given candidates, four panes to a window. */
function planOf(candidates: Candidate[], over: Partial<Plan> = {}): Plan {
  const root = candidates[0]?.cwd ?? "/tmp";
  const windows = [];
  for (let start = 0, part = 1; start < candidates.length; start += 4, part++) {
    const name = part === 1 ? "main" : `main-${part}`;
    windows.push({
      name,
      worktree: root,
      panes: candidates.slice(start, start + 4).map((candidate, index) => ({
        candidate,
        command: candidate.provider === "claude"
          ? ["ms", "claude", "--", "--resume", candidate.id]
          : ["ms", "adopt", candidate.id],
        session: "data",
        window: name,
        index,
      })),
    });
  }
  return { server: "current", socket: "/tmp/ms-import-test.sock", sessions: [{ name: "data", root, windows }], skipped: [], ...over };
}

type World = {
  deps: ExecuteDeps;
  file: string;
  log: string[];
  tmuxLog: () => string[];
  ready: { calls: [string, number][] };
  setReady: (v: "ready" | "timeout" | "died") => void;
  setDead: (v: boolean) => void;
  manifest: () => Manifest;
  clock: () => number;
};

async function world(t: TestContext, plan: Plan, over: Partial<ExecuteDeps> = {}): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", TMUX_STUB);
  const tmuxLog = path.join(dir, "tmux.log");
  const panes = path.join(dir, "panes");
  const winIndex = path.join(dir, "win-index");
  const sessions = path.join(dir, "sessions");
  const dead = path.join(dir, "dead");
  writeFileSync(tmuxLog, "");
  writeFileSync(sessions, "");
  writeFileSync(dead, "0\n");

  const prev = { ...process.env };
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.MS_TMUX_LOG = tmuxLog;
  process.env.MS_TMUX_PANES = panes;
  process.env.MS_TMUX_WIN_INDEX = winIndex;
  process.env.MS_TMUX_SESSIONS = sessions;
  process.env.MS_TMUX_DEAD = dead;
  t.after(() => {
    for (const k of ["PATH", "HOME", "MS_HOME", "MS_TMUX_LOG", "MS_TMUX_PANES", "MS_TMUX_WIN_INDEX", "MS_TMUX_SESSIONS", "MS_TMUX_DEAD", "MS_TMUX_FAIL"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  });

  const { manifestFromPlan, writeManifest, readManifest } = await import("../src/import/manifest.ts");
  mkdirSync(path.join(msHome, "imports"), { recursive: true, mode: 0o700 });
  const file = path.join(msHome, "imports", "run.json");
  writeManifest(file, manifestFromPlan(plan, { since: "2h", dirs: [], createdAt: new Date(T0) }));

  let clock = T0;
  let verdict: "ready" | "timeout" | "died" = "ready";
  const log: string[] = [];
  const ready: { calls: [string, number][] } = { calls: [] };
  const deps: ExecuteDeps = {
    tmux: new Tmux(plan.socket),
    kill: (pid, sig) => {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    },
    now: () => clock,
    // The clock moves by what was asked for; the real wait is a tick, so a
    // real process that is really leaving still gets real time to do it.
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 5));
    },
    waitReady: async (id, deadline) => {
      ready.calls.push([id, deadline]);
      return verdict;
    },
    ps: () => tableFor(plan),
    log: (line) => log.push(line),
    ...over,
  };

  return {
    deps, file, log,
    tmuxLog: () => readFileSync(tmuxLog, "utf8").split("\n").filter((l) => l !== ""),
    ready,
    setReady: (v) => { verdict = v; },
    setDead: (v) => writeFileSync(dead, v ? "1\n" : "0\n"),
    manifest: () => readManifest(file),
    clock: () => clock,
  };
}

const verbs = (lines: string[]): string[] => lines.map((l) => l.replace(/^-S \S+ /, "").split(" ")[0]!);

// --- The happy path --------------------------------------------------------

test("a live row is stopped, a pane is made for every row, and each is sent its own command line", async (t) => {
  const { dir } = stubDir();
  const pid = await liveProcess(t, dir, "polite");
  const plan = planOf([
    cand({ id: "sess-live", cwd: "/tmp", pid, argv: ["claude", "--model", "opus"] }),
    cand({ id: "sess-idle", cwd: "/tmp" }),
  ]);
  const w = await world(t, plan);
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);

  assert.deepEqual(result, { moved: 2, stopped: 1, failed: 0 });
  assert.deepEqual(
    verbs(w.tmuxLog()),
    ["has-session", "new-session", "send-keys", "split-window", "select-layout", "send-keys"],
    "the window is made once, the second pane splits it, and each pane is typed into as it is made",
  );
  const lines = w.tmuxLog();
  assert.match(lines[1]!, /new-session -d -P -F #\{pane_id\} #\{pane_index\} -s data -c \/tmp -n main/);
  assert.match(lines[2]!, /send-keys -t %1 /, "the first pane is named by the id tmux handed back");
  assert.match(lines[3]!, /split-window -P -F #\{pane_id\} #\{pane_index\} -t %1 -c \/tmp/);
  assert.match(lines[4]!, /select-layout -t %1 tiled/);
  assert.match(lines[5]!, /send-keys -t %2 /);

  const rows = w.manifest().rows;
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ["resumed in data:main.5 (%1)", "resumed in data:main.6 (%2)"],
    "the outcome carries tmux's own pane index (5, 6 — this stub's arbitrary base) and id, never the planner's 0-based slot",
  );
  assert.deepEqual(rows.map((r) => r.target!.paneId), ["%1", "%2"]);
  assert.deepEqual(rows.map((r) => r.target!.paneIndex), [5, 6]);
  assert.ok(!w.deps.alive(pid), "the live CLI was stopped before its conversation was resumed");
  assert.deepEqual(w.ready.calls.map((c) => c[0]), ["sess-live", "sess-idle"]);

  const { formatManifest } = await import("../src/import/manifest.ts");
  const table = formatManifest(w.manifest());
  assert.match(table, /main\.#1\s+resumed in data:main\.5 \(%1\)/, "the TARGET column shows the planner's 1-based slot (#1), never tmux's own number, and the OUTCOME carries tmux's real answer");
  assert.match(table, /main\.#2\s+resumed in data:main\.6 \(%2\)/);
});

test("the command line is this install's own ms, shell-quoted, and carries no secret", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp", argv: ["claude", "--api-key", "sk-secret"] })]);
  const w = await world(t, plan);
  const { executeImport, paneCommandLine } = await import("../src/import/execute.ts");
  process.env.MS_BIN = "/opt/home brew/bin/ms";
  t.after(() => { delete process.env.MS_BIN; });
  await executeImport(plan, w.file, w.deps);

  const sent = w.tmuxLog().find((l) => l.includes("send-keys"))!;
  assert.ok(sent.includes("'/opt/home brew/bin/ms' 'claude' '--' '--resume' 's-1'"), sent);
  assert.ok(!sent.includes(" ms claude"), "a bare `ms` would resolve on the pane's PATH, which is not ours to assume");
  for (const line of w.tmuxLog()) assert.ok(!line.includes("sk-secret"), line);
  assert.ok(!readFileSync(w.file, "utf8").includes("sk-secret"), "nor may the manifest carry it");
  assert.equal(paneCommandLine(["ms", "adopt", "r-1"], "/x/ms"), "'/x/ms' 'adopt' 'r-1'");
});

test("an existing session is appended to rather than created", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp" })]);
  const w = await world(t, plan);
  writeFileSync(process.env.MS_TMUX_SESSIONS!, "data\n");
  const { executeImport } = await import("../src/import/execute.ts");
  await executeImport(plan, w.file, w.deps);
  assert.deepEqual(verbs(w.tmuxLog()), ["has-session", "new-window", "send-keys"]);
  assert.match(w.tmuxLog()[1]!, /new-window -P -F #\{pane_id\} #\{pane_index\} -t data: -c \/tmp -n main/);
});

test("a fifth conversation lands in its own window, and that window's panes split ITS first pane", async (t) => {
  const five = Array.from({ length: 5 }, (_, i) => cand({ id: `c${i + 1}`, cwd: "/tmp" }));
  const plan = planOf(five);
  const w = await world(t, plan);
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);
  assert.equal(result.moved, 5);
  assert.deepEqual(verbs(w.tmuxLog()), [
    "has-session", "new-session", "send-keys",
    "split-window", "select-layout", "send-keys",
    "split-window", "select-layout", "send-keys",
    "split-window", "select-layout", "send-keys",
    "new-window", "send-keys",
  ]);
  assert.match(w.tmuxLog().find((l) => l.includes("new-window"))!, /-n main-2/);
  assert.deepEqual(w.manifest().rows.map((r) => r.target!.paneId), ["%1", "%2", "%3", "%4", "%5"]);
  assert.deepEqual(
    w.manifest().rows.map((r) => r.target!.paneIndex),
    [5, 6, 7, 8, 5],
    "the new window's own first pane resets tmux's index — it is not a continuation of the first window's count",
  );
});

// --- Stopping --------------------------------------------------------------

test("a CLI that ignores SIGTERM is killed once the grace is spent, and still counts as stopped", async (t) => {
  const { dir } = stubDir();
  const pid = await liveProcess(t, dir, "stubborn");
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp", pid })]);
  const w = await world(t, plan);
  const signals: [number, string][] = [];
  const realKill = w.deps.kill;
  w.deps.kill = (p, sig) => {
    signals.push([p, sig]);
      return realKill(p, sig);
  };
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);

  assert.deepEqual(signals, [[pid, "SIGTERM"], [pid, "SIGKILL"]], "SIGTERM first, and only then the floor under it");
  assert.ok(w.clock() - T0 >= 10_000, "SIGKILL waited out the whole ten-second grace");
  assert.deepEqual(result, { moved: 1, stopped: 1, failed: 0 });
  assert.ok(w.log.some((l) => l.includes("(SIGKILL)")), w.log.join("\n"));
  assert.ok(!w.deps.alive(pid));
});

test("a process that cannot be signalled fails its own row and stops nothing else", async (t) => {
  const { dir } = stubDir();
  const pid = await liveProcess(t, dir, "polite");
  const plan = planOf([
    cand({ id: "s-locked", cwd: "/tmp", pid: 1 }), // pid 1 is launchd: alive, and not ours
    cand({ id: "s-next", cwd: "/tmp", pid }),
  ]);
  const w = await world(t, plan);
  w.deps.kill = (p, sig) => (p === 1 ? false : (() => { try { process.kill(p, sig); return true; } catch { return false; } })());
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);

  assert.deepEqual(result, { moved: 1, stopped: 1, failed: 1 });
  const rows = w.manifest().rows;
  assert.equal(rows[0]!.outcome, "stop failed: could not signal pid 1");
  assert.equal(rows[0]!.target!.paneId, null, "a row whose CLI is still writing that transcript gets no pane");
  assert.equal(rows[1]!.outcome, "resumed in data:main.5 (%1)", "the surviving row becomes the window's first pane, made by new-session");
  assert.deepEqual(verbs(w.tmuxLog()), ["has-session", "new-session", "send-keys"], "only the second row reached tmux");
  assert.ok(!w.deps.alive(pid));
});

test("a pid that is no longer the process the plan recorded is not signalled", async (t) => {
  const { dir } = stubDir();
  const pid = await liveProcess(t, dir, "polite");
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp", pid }), cand({ id: "s-2", cwd: "/tmp" })]);
  const w = await world(t, plan);
  const signals: [number, string][] = [];
  w.deps.kill = (p, sig) => {
    signals.push([p, sig]);
    return true;
  };
  // The pid was recycled between the plan and the run: same number, a process
  // that started four hours later.
  w.deps.ps = () => [{ pid, startedAt: T0 + 4 * 3_600_000, tty: "s002", argv: ["npm"] }];
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);

  assert.deepEqual(signals, [], "a stranger's pid is never signalled");
  assert.ok(w.deps.alive(pid), "and the process it named is untouched");
  assert.deepEqual(result, { moved: 1, stopped: 0, failed: 1 });
  const rows = w.manifest().rows;
  assert.equal(rows[0]!.outcome, `stop refused: pid ${pid} is not the process the plan recorded`);
  assert.equal(rows[0]!.target!.paneId, null, "and no pane is made for a conversation still being written");
  assert.equal(rows[1]!.outcome, "resumed in data:main.5 (%1)", "the next row still runs");
});

test("a manifest that does not say when the process started cannot re-identify it, and refuses", async (t) => {
  const { dir } = stubDir();
  const pid = await liveProcess(t, dir, "polite");
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp", pid, startedAt: null })]);
  const w = await world(t, plan);
  const signals: [number, string][] = [];
  w.deps.kill = (p, sig) => { signals.push([p, sig]); return true; };
  w.deps.ps = () => [{ pid, startedAt: T0 - 60_000, tty: "s001", argv: ["claude"] }];
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);
  assert.deepEqual(signals, []);
  assert.equal(result.failed, 1);
  assert.match(w.manifest().rows[0]!.outcome, /^stop refused: pid \d+ has no recorded start time/);
});

test("the start time travels in the manifest, so `--plan` tomorrow checks it", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp", pid: 4321 })]);
  await world(t, plan);
  const { manifestFromPlan, planFromManifest } = await import("../src/import/manifest.ts");
  const m = manifestFromPlan(plan, { since: "2h", dirs: [], createdAt: new Date(T0) });
  assert.equal(m.rows[0]!.startedAt, new Date(T0 - 60_000).toISOString());
  const back = planFromManifest(m);
  assert.equal(back.sessions[0]!.windows[0]!.panes[0]!.candidate.startedAt, T0 - 60_000);
});

test("a CLI that survives SIGKILL is never resumed over: the row fails and tmux is not touched", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp", pid: 4321 })]);
  const w = await world(t, plan);
  // Every signal lands and nothing ever dies — the floor under both waits.
  w.deps.kill = () => true;
  w.deps.alive = () => true;
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);

  assert.deepEqual(result, { moved: 0, stopped: 0, failed: 1 });
  assert.equal(w.manifest().rows[0]!.outcome, "stop failed: pid 4321 is still running after SIGKILL");
  assert.deepEqual(
    w.tmuxLog(),
    [],
    "a conversation whose CLI is still writing it must never be resumed in a second pane",
  );
  assert.equal(w.manifest().rows[0]!.target!.paneId, null);
});

// --- Resuming --------------------------------------------------------------

test("a resume that never reports is a failed row, and the next row still runs", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp" }), cand({ id: "s-2", cwd: "/tmp" })]);
  const w = await world(t, plan);
  let first = true;
  w.deps.waitReady = async () => {
    const v = first ? "timeout" : "ready";
    first = false;
    return v;
  };
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);
  assert.deepEqual(result, { moved: 1, stopped: 0, failed: 1 });
  const rows = w.manifest().rows;
  assert.match(rows[0]!.outcome, /^resume failed: no report within 60s/);
  assert.match(rows[0]!.outcome, /%1/, "the row still says where the pane is, so it can be finished by hand");
  assert.equal(rows[1]!.outcome, "resumed in data:main.6 (%2)", "the second row still split the same window, even though the first row's pane never reported");
});

test("a pane that died says so, rather than waiting out a silence tmux could explain", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp" })]);
  const w = await world(t, plan);
  w.setReady("timeout");
  w.setDead(true);
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);
  assert.deepEqual(result, { moved: 0, stopped: 0, failed: 1 });
  assert.equal(w.manifest().rows[0]!.outcome, "resume failed: the pane died (%1)");
});

test("waitReady is asked with the conversation's id and a deadline sixty seconds out", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp" })]);
  const w = await world(t, plan);
  const { executeImport } = await import("../src/import/execute.ts");
  await executeImport(plan, w.file, w.deps);
  assert.deepEqual(w.ready.calls, [["s-1", T0 + 60_000]]);
});

test("a tmux that refuses a pane fails that row and leaves the rest of the plan alone", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp" }), cand({ id: "s-2", cwd: "/tmp" })]);
  const w = await world(t, plan);
  process.env.MS_TMUX_FAIL = "new-session";
  const { executeImport } = await import("../src/import/execute.ts");
  const result = await executeImport(plan, w.file, w.deps);
  assert.equal(result.failed, 2, "both rows of the window that could not be made");
  assert.equal(result.moved, 0);
  for (const row of w.manifest().rows) assert.match(row.outcome, /^resume failed: tmux new-session failed/);
});

// --- The manifest ----------------------------------------------------------

test("the manifest is on disk after every step, not at the end of the run", async (t) => {
  const { dir } = stubDir();
  const pid = await liveProcess(t, dir, "polite");
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp", pid }), cand({ id: "s-2", cwd: "/tmp" })]);
  const w = await world(t, plan);
  // Read the FILE from inside the run, at each line the executor logs.
  const seen: string[][] = [];
  const log = w.deps.log;
  w.deps.log = (line) => {
    log(line);
    seen.push(w.manifest().rows.map((r) => r.outcome));
  };
  const { executeImport } = await import("../src/import/execute.ts");
  await executeImport(plan, w.file, w.deps);

  assert.deepEqual(seen, [
    ["stopped", "planned"],
    ["resumed in data:main.5 (%1)", "planned"],
    ["resumed in data:main.5 (%1)", "resumed in data:main.6 (%2)"],
  ], "the stop is recorded before the pane exists — that is the moment the record matters most");
});

test("the manifest round-trips through a plan and keeps what the run was asked for", async (t) => {
  const pidRow = cand({ id: "s-1", cwd: "/tmp", pid: 4321, argv: ["claude", "--model", "opus"] });
  const plan = planOf([pidRow, cand({ id: "s-2", cwd: "/tmp", provider: "codex" })]);
  plan.skipped = [{ candidate: cand({ id: "s-9", cwd: "/tmp" }), reason: "in tmux" }];
  await world(t, plan);
  const { manifestFromPlan, planFromManifest, formatManifest, writeManifest, readManifest } = await import("../src/import/manifest.ts");
  const m = manifestFromPlan(plan, { since: "2h", dirs: ["/tmp"], createdAt: new Date(T0) });
  assert.equal(m.rows.length, 3);
  assert.equal(m.rows[2]!.outcome, "skipped: in tmux");
  assert.equal(m.rows[2]!.target, null);

  const file = path.join(process.env.MS_HOME!, "imports", "round.json");
  writeManifest(file, m);
  const back = planFromManifest(readManifest(file));
  assert.equal(back.socket, plan.socket);
  assert.equal(back.sessions[0]!.windows[0]!.panes.length, 2);
  assert.deepEqual(back.sessions[0]!.windows[0]!.panes[0]!.command, ["ms", "claude", "--", "--resume", "s-1"]);
  assert.equal(back.sessions[0]!.windows[0]!.panes[0]!.candidate.pid, 4321);
  assert.deepEqual(back.skipped.map((s) => s.reason), ["in tmux"]);

  const table = formatManifest(readManifest(file));
  assert.match(table, /2 conversations to move, stopping 1 live process/);
  assert.match(table, /since 2h/);
  assert.match(table, /data:main\.#1/, "the TARGET column is the planner's own 1-based slot, marked with a leading # so it is never mistaken for tmux's own pane number");
  assert.match(table, /skipped: in tmux/);
});

test("the manifest is 0600 — it names every directory the human is working in", async (t) => {
  const plan = planOf([cand({ id: "s-1", cwd: "/tmp" })]);
  const w = await world(t, plan);
  assert.equal(statSync(w.file).mode & 0o777, 0o600);
  const { executeImport } = await import("../src/import/execute.ts");
  await executeImport(plan, w.file, w.deps);
  assert.equal(statSync(w.file).mode & 0o777, 0o600, "and still 0600 after every rewrite");
});

test("a file that is not a manifest is refused by name", async (t) => {
  await world(t, planOf([]));
  const { readManifest } = await import("../src/import/manifest.ts");
  const file = path.join(process.env.MS_HOME!, "imports", "junk.json");
  writeFileSync(file, "[1,2,3]\n");
  assert.throws(() => readManifest(file), /is not an import manifest/);
  writeFileSync(file, "not json at all\n");
  assert.throws(() => readManifest(file), /cannot read/);
});
