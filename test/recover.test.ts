// The recovery transaction (spec §9), driven in-process against a stub tmux.
//
// Nothing here runs a real tmux or a real claude. `tmux` is a bash script on
// PATH that keeps one pane's state in a temp file: `send-keys … /exit` marks
// the pane dead, `respawn-pane` brings it back, `capture-pane` prints a screen
// file, and `display-message` answers the four fields `paneInfo` asks for. The
// resume report that the real worker waits for — the `resumed` event Claude
// Code's own SessionStart hook writes — is appended BY THE TEST the moment the
// respawn appears in the tmux log, which is also how each test proves the
// worker respawned before it started waiting.
//
// The pane's pid is a real, harmless `sleep` child, so the signal path can be
// exercised without ever aiming a SIGTERM at the test runner.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { tempHome, stubDir } from "./helpers.ts";
import { appendEvent } from "../src/events.ts";
import { openState, type SessionRow } from "../src/state.ts";
import { recoverSession } from "../src/recover.ts";

/** The continuation text, spelled out here rather than imported: the whole
 *  point of the assertion is that the shipped constant still says this. */
const CONTINUATION =
  "Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions.";

const MS_BIN = path.resolve("bin/ms");
const PANE = "%7";
const SOCKET = "/tmp/ms-recover-test.sock";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const ORIGINAL_PATH = process.env.PATH ?? "";
const HOUR = 3_600_000;

/** tmux, as far as the recovery drives it. One pane, one state file. */
const TMUX_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
if [ -n "$MS_TMUX_FAIL" ] && [ "$1" = "$MS_TMUX_FAIL" ]; then exit 1; fi
st="$MS_TMUX_STATE"
get() { grep "^$1=" "$st" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { printf '%s=%s\n' "$1" "$2" >> "$st"; }
case "$1" in
  list-panes) get panes ;;
  display-message) printf '%s\t%s\t%s\t%s\n' "$(get pane_pid)" "$(get command)" "$(get pane_dead)" "$(get cwd)" ;;
  capture-pane) cat "$MS_TMUX_SCREEN" 2>/dev/null ;;
  send-keys) case "$*" in */exit*) put pane_dead 1 ;; esac ;;
  respawn-pane) put pane_dead 0 ;;
esac
exit 0`;

const IDLE_SCREEN = ["❯ ship it", "", "  Done.", "", "❯ ", ""].join("\n");
const WALLED_SCREEN = ["❯ ship it", "", "⎿  You've hit your usage limit. Your limit will reset at 9pm.", "", "❯ ", ""].join("\n");
const MODAL_SCREEN = [
  "❯ ship it",
  "  Do you want to make this edit?",
  "❯ 1. Yes",
  "  2. No, tell Claude what to do differently (esc to cancel)",
  "",
].join("\n");
const BUSY_SCREEN = ["❯ ship it", "", "  Composing… (esc to interrupt)", ""].join("\n");

type UsageRow = { session: number; weekly: number; sessionReset?: string; weeklyReset?: string };

type World = {
  home: string;
  msHome: string;
  log: string;
  state: string;
  screen: string;
  pid: number;
  cwd: string;
};

/** A live, disposable process whose pid the stub pane reports. */
function liveProcess(t: TestContext): number {
  const child: ChildProcess = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  return child.pid!;
}

function writeSnapshot(msHome: string, rows: Record<string, UsageRow>): void {
  const now = Date.now();
  writeFileSync(
    path.join(msHome, "snapshot.json"),
    JSON.stringify({
      takenAt: now,
      accounts: Object.entries(rows).map(([name, r]) => ({
        name,
        provider: "claude",
        shared: false,
        usage: {
          session: { usedPercent: r.session, resetsAt: r.sessionReset ?? new Date(now + HOUR).toISOString() },
          weeklyAll: { usedPercent: r.weekly, resetsAt: r.weeklyReset ?? new Date(now + 6 * HOUR).toISOString() },
          weeklyFable: null,
        },
        error: null,
        errorKind: null,
        observedAt: now,
        stale: false,
      })),
      backoff: {},
    }),
    { mode: 0o600 },
  );
}

const DEFAULT_USAGE: Record<string, UsageRow> = {
  dirk: { session: 100, weekly: 40 },
  gmail: { session: 10, weekly: 20 },
  work: { session: 10, weekly: 35 },
};

type WorldOptions = {
  screen?: string;
  usage?: Record<string, UsageRow>;
  session?: Partial<SessionRow>;
  recovery?: boolean;
  wall?: boolean;
  panes?: string;
  /** Make the stub tmux fail this subcommand, and only this one. */
  failOn?: string;
  /** Raw accounts.json content, for the unreadable-registry case. */
  registry?: string;
};

async function world(t: TestContext, opts: WorldOptions = {}): Promise<World> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", TMUX_STUB);
  const log = path.join(dir, "tmux.log");
  const state = path.join(dir, "tmux.state");
  const screen = path.join(dir, "screen.txt");
  const pid = liveProcess(t);
  const cwd = home;

  writeFileSync(log, "");
  writeFileSync(screen, opts.screen ?? WALLED_SCREEN);
  writeFileSync(
    state,
    [`panes=${opts.panes ?? PANE}`, `pane_pid=${pid}`, "command=claude", "pane_dead=0", `cwd=${cwd}`, ""].join("\n"),
  );
  writeFileSync(
    path.join(msHome, "accounts.json"),
    opts.registry ??
      JSON.stringify({
        version: 1,
        accounts: ["dirk", "gmail", "work"].map((name) => ({ name, provider: "claude", label: name, shared: false })),
      }),
    { mode: 0o600 },
  );

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.MS_BIN = MS_BIN;
  process.env.MS_TMUX_LOG = log;
  process.env.MS_TMUX_STATE = state;
  process.env.MS_TMUX_SCREEN = screen;
  process.env.MS_TMUX_FAIL = opts.failOn ?? "";
  process.env.MS_POLL_MS = "20";
  process.env.MS_READY_MS = "10000"; // generous: the report below arrives in milliseconds
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;

  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  for (const name of ["dirk", "gmail", "work"]) saveLaunchToken(name, `sk-ant-oat01-${name}0123456789abcdefghij`);
  writeSnapshot(msHome, opts.usage ?? DEFAULT_USAGE);

  const st = openState();
  try {
    st.createSession({
      id: "s1",
      provider: "claude",
      cliSessionId: "c-1",
      cwd,
      socket: SOCKET,
      pane: PANE,
      serverStart: "1:2",
      need: "any",
      account: "dirk",
      generation: 2,
      state: "walled",
      desired: "running",
      flags: ["--model", "sonnet"],
      ...opts.session,
    });
    if (opts.wall !== false) appendEvent({ t: nowSeconds() - 10, kind: "rate_limited", session: "s1", generation: 2, cliSessionId: "c-1", kindDetail: "session" });
    if (opts.recovery !== false) st.addRecovery({ sessionId: "s1", generation: 2, turnId: null, kind: "session" });
  } finally {
    st.close();
  }
  return { home, msHome, log, state, screen, pid, cwd };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Wait for a pid to leave the table — a just-signalled child is a zombie
 *  until its parent reaps it, which is not the same as still running. */
async function gone(pid: number, budgetMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
}

const logLines = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim());
const recoverLog = (w: World): string => {
  try {
    return readFileSync(path.join(w.msHome, "sessions", "s1", "recover.log"), "utf8");
  } catch {
    return "";
  }
};

function rows(w: World, table: "recoveries" | "attempts"): Record<string, unknown>[] {
  const db = new DatabaseSync(path.join(w.msHome, "state.sqlite"));
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function session(w: World): SessionRow {
  const st = openState();
  try {
    return st.getSession("s1")!;
  } finally {
    st.close();
  }
}

function launchOf(w: World, id: string) {
  const st = openState();
  try {
    return st.getLaunch(id);
  } finally {
    st.close();
  }
}

const respawnLine = (w: World): string | undefined => logLines(w).find((l) => l.includes("respawn-pane"));
const respawnLaunchId = (w: World): string => {
  const m = respawnLine(w)?.match(new RegExp(`_exec' '(${UUID.source})'`));
  assert.ok(m, `no respawn with a launch id in:\n${logLines(w).join("\n")}`);
  return m![1];
};

/** Stand in for Claude Code's SessionStart hook: as soon as the worker has
 *  respawned the pane, report the resume it is waiting for. */
function reportOnRespawn(w: World, event: { generation: number; cliSessionId: string; kind?: "resumed" | "started" }): () => void {
  const timer = setInterval(() => {
    if (!respawnLine(w)) return;
    clearInterval(timer);
    appendEvent({
      t: nowSeconds(),
      kind: event.kind ?? "resumed",
      session: "s1",
      generation: event.generation,
      cliSessionId: event.cliSessionId,
    });
  }, 10);
  return () => clearInterval(timer);
}

test("the happy path: dirk hands off to gmail and the resumed session continues", async (t) => {
  const w = await world(t);
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  const code = await recoverSession("s1");
  assert.equal(code, 0);

  const s = session(w);
  assert.equal(s.account, "gmail");
  assert.equal(s.generation, 3);
  assert.equal(s.state, "continuing");

  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--resume", "c-1", CONTINUATION, "--model", "sonnet"]);
  assert.equal(launch.account, "gmail");
  assert.equal(launch.generation, 3);

  // Asked to leave before being made to: Escape, then /exit, then the respawn.
  const lines = logLines(w);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at("send-keys -t %7 Escape") >= 0, "no Escape");
  assert.ok(at("send-keys -t %7 /exit Enter") > at("send-keys -t %7 Escape"), "no /exit after Escape");
  assert.ok(at("@ms_handoff dirk→gmail") >= 0, "the handoff was never advertised");
  assert.ok(at("@ms_handoff dirk→gmail") < at("respawn-pane"), "the handoff must be set before the respawn");
  assert.ok(at("set-option -pu -t %7 @ms_handoff") > at("respawn-pane"), "the handoff must be cleared after the respawn");

  const recoveries = rows(w, "recoveries");
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].status, "done");
  const attempts = rows(w, "attempts");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].account, "dirk", "the attempt records the account we LEFT");
  assert.equal(attempts[0].outcome, "exhausted");

  assert.match(recoverLog(w), /s1: dirk → gmail \(session wall, generation 3\)/);
});

test("activity newer than the wall makes the recovery obsolete, and nothing is typed", async (t) => {
  const w = await world(t);
  appendEvent({ t: nowSeconds(), kind: "activity", session: "s1", generation: 2, cliSessionId: "c-1" });

  assert.equal(await recoverSession("s1"), 1);
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  assert.equal(session(w).generation, 2);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "a live session must never be typed into");
  assert.ok(!respawnLine(w), "a live session must never be respawned");
  assert.match(recoverLog(w), /obsolete/);
});

test("a pane that is gone makes the recovery obsolete", async (t) => {
  const w = await world(t, { panes: "" });

  assert.equal(await recoverSession("s1"), 1);
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.match(recoverLog(w), /pane is gone/);
});

test("nothing has room: the session waits, a wake-up is scheduled and the recovery goes back to pending", async (t) => {
  const resetsAt = new Date(Date.now() + 2 * HOUR).toISOString();
  const w = await world(t, {
    usage: {
      dirk: { session: 100, weekly: 40 },
      gmail: { session: 100, weekly: 20, sessionReset: resetsAt },
      work: { session: 10, weekly: 100, weeklyReset: new Date(Date.now() + 5 * HOUR).toISOString() },
    },
  });

  assert.equal(await recoverSession("s1"), 2);

  const s = session(w);
  assert.equal(s.state, "waiting");
  assert.equal(s.account, "dirk", "nothing moved");
  const wakeup = s.wakeupAt!;
  assert.ok(Math.abs(wakeup - Math.floor(Date.parse(resetsAt) / 1000)) < 5, `wakeup ${wakeup} is not the earliest reset`);

  const dispatch = logLines(w).find((l) => l.includes("run-shell"));
  assert.ok(dispatch, "no re-dispatch");
  const delay = Number(dispatch!.match(/run-shell -b -d (\d+)/)![1]);
  // Not the 600 s fallback and not the 30 s floor: the delay IS the wake-up.
  assert.ok(Math.abs(delay - (wakeup - nowSeconds())) < 30, `delay ${delay} does not match the wake-up`);
  assert.match(dispatch!, /_recover' 's1'/);

  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "pending");
  assert.equal(rec.owner, null);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "nothing is typed when nothing has room");
  assert.match(recoverLog(w), /nothing has room/);
});

test("a resume that falls back to a new conversation parks the session", async (t) => {
  const w = await world(t);
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-BRAND-NEW", kind: "started" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 1);

  const s = session(w);
  assert.equal(s.state, "parked");
  assert.equal(s.generation, 3, "the respawn did happen; it is the resume that broke");
  const attempts = rows(w, "attempts");
  assert.equal(attempts.at(-1)!.outcome, "resume-broken");
  assert.equal(rows(w, "recoveries")[0].status, "pending", "a broken resume is not a finished recovery");
  // The screen is evidence: the last non-blank lines land in the log.
  assert.match(recoverLog(w), /screen\| /);
  // Named for what it is — a new conversation, not merely a silent resume.
  assert.match(recoverLog(w), /the resume started a new conversation; s1 is parked/);
});

test("a resume that never reports parks the session too", async (t) => {
  const w = await world(t);
  process.env.MS_READY_MS = "300"; // nobody will report; do not wait a minute for it

  assert.equal(await recoverSession("s1"), 1);

  const s = session(w);
  assert.equal(s.state, "parked");
  assert.ok(respawnLine(w), "the pane was respawned before anyone waited on it");
  assert.equal(rows(w, "attempts").at(-1)!.outcome, "resume-broken");
  assert.match(recoverLog(w), /no resume report within/);
});

test("a fourth try is not taken: three failed attempts park the session", async (t) => {
  const w = await world(t);
  const st = openState();
  try {
    const rec = st.pendingRecovery("s1")!;
    for (const account of ["gmail", "work", "gmail"]) st.addAttempt({ recoveryId: rec.id, account, outcome: "resume-broken", note: "" });
  } finally {
    st.close();
  }

  assert.equal(await recoverSession("s1"), 1);
  assert.equal(session(w).state, "parked");
  assert.equal(rows(w, "recoveries")[0].status, "done");
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.match(recoverLog(w), /gave up after 3 attempts/);
});

test("a held session lock refuses the recovery without typing anything", async (t) => {
  const w = await world(t);
  const { acquire } = await import("../src/lock.ts");
  const release = acquire("session-s1")!;
  assert.ok(release, "the test could not take the lock it means to hold");
  t.after(release);

  assert.equal(await recoverSession("s1"), 1);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "nothing is typed while another worker holds the session");
  assert.ok(!respawnLine(w));
  assert.equal(session(w).state, "walled");
  assert.equal(rows(w, "recoveries")[0].status, "pending");
  assert.match(recoverLog(w), /another recovery holds s1/);
});

test("a manual move to a named account on an idle pane resumes without a continuation", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, recovery: false, wall: false });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  const code = await recoverSession("s1", { manual: { toAccount: "work", continueAfter: false } });
  assert.equal(code, 0);

  const s = session(w);
  assert.equal(s.account, "work");
  assert.equal(s.state, "running", "no continuation means the session is merely running");
  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--resume", "c-1", "--model", "sonnet"]);
  assert.equal(rows(w, "attempts")[0].outcome, "ok", "a manual move is not an exhaustion");
});

test("a modal choice on screen is never typed into; the pane is signalled instead", async (t) => {
  const w = await world(t, { screen: MODAL_SCREEN });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "a modal must never be answered by us");
  assert.ok(respawnLine(w), "the handoff still happened");
  // The `sleep` standing in for the CLI was signalled, not asked. Poll for it:
  // a just-signalled child is a zombie until its parent reaps it.
  assert.ok(await gone(w.pid), "the pane's process was never signalled");
  assert.equal(rows(w, "attempts")[0].outcome, "forced");
  assert.match(recoverLog(w), /modal choice/);
});

test("a busy pane refuses a manual move unless forced", async (t) => {
  const w = await world(t, { screen: BUSY_SCREEN, recovery: false, wall: false });

  assert.equal(await recoverSession("s1", { manual: { toAccount: "work", continueAfter: true } }), 1);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.equal(session(w).account, "dirk");
  assert.equal(rows(w, "recoveries").length, 0, "a refused manual move opens no recovery");
});

test("a tmux that fails mid-handoff is a failed recovery, not an exception", async (t) => {
  const w = await world(t, { failOn: "respawn-pane" });

  assert.equal(await recoverSession("s1"), 1, "the worker reports the failure rather than throwing past its caller");
  assert.match(recoverLog(w), /recovery failed: tmux respawn-pane failed/);
  // The store is left as it was found, for reconciliation to read.
  assert.equal(rows(w, "recoveries")[0].status, "owned");
});

test("with every handoff slot taken the recovery stands down and re-dispatches itself", async (t) => {
  const w = await world(t);
  const { acquire } = await import("../src/lock.ts");
  const held = [0, 1, 2, 3].map((k) => acquire(`handoff-${k}`));
  assert.ok(held.every(Boolean), "the test could not fill the handoff slots");
  t.after(() => held.forEach((r) => r?.()));

  assert.equal(await recoverSession("s1"), 1);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "a worker that cannot hand off must not disturb the pane");
  assert.ok(!respawnLine(w));
  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "pending", "the recovery is still owed to whoever comes next");
  assert.equal(rec.owner, null);
  const dispatch = logLines(w).find((l) => l.includes("run-shell"));
  assert.match(dispatch ?? "", /run-shell -b -d 30 '.*ms' '_recover' 's1'/);
  assert.match(recoverLog(w), /too many handoffs in flight/);
});

test("ms _recover is a registered verb and needs a session id", async (t) => {
  const w = await world(t);
  const { run } = await import("./helpers.ts");
  const r = run(["_recover"], { HOME: w.home, MS_HOME: w.msHome });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs a session id/);
  assert.doesNotMatch(r.stderr, /unknown verb/);
});

test("a registry that cannot be read is a failed attempt, not an empty fleet", async (t) => {
  const w = await world(t, { registry: "{ this is not json" });

  assert.equal(await recoverSession("s1"), 1, "not 2: the fleet was never read, so it cannot be full");

  const s = session(w);
  assert.equal(s.state, "walled", "the pane was never disturbed");
  assert.equal(s.account, "dirk");
  assert.equal(s.wakeupAt, null, "no wake-up invented out of a fleet nobody could look at");
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")));

  const attempt = rows(w, "attempts")[0];
  assert.equal(attempt.outcome, "infra", "it counts against the budget: a registry that stays broken parks the session");
  assert.match(String(attempt.note), /registry unreadable/);
  assert.equal(rows(w, "recoveries")[0].status, "pending");
  assert.match(recoverLog(w), /cannot read the registry/);
});
