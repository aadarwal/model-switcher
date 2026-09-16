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
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
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
  "Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions. If the last user message was already answered, or needs nothing more, say so in one line and wait for the user; do not start new work.";

const MS_BIN = path.resolve("bin/ms");
const PANE = "%7";
const SOCKET = "/tmp/ms-recover-test.sock";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const ORIGINAL_PATH = process.env.PATH ?? "";
const HOUR = 3_600_000;

/** tmux, as far as the recovery drives it. One pane, one state file. */
const TMUX_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ -n "$MS_TMUX_ON_MATCH" ]; then case "$*" in *$MS_TMUX_ON_MATCH*) eval "$MS_TMUX_ON" ;; esac; fi
if [ "$1" = "-S" ]; then shift 2; fi
if [ -n "$MS_TMUX_FAIL" ] && [ "$1" = "$MS_TMUX_FAIL" ]; then exit 1; fi
st="$MS_TMUX_STATE"
get() { grep "^$1=" "$st" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { printf '%s=%s\n' "$1" "$2" >> "$st"; }
case "$1" in
  list-panes) get panes ;;
  display-message)
    case "$*" in
      *pane_pid*) printf '%s\t%s\t%s\t%s\n' "$(get pane_pid)" "$(get command)" "$(get pane_dead)" "$(get cwd)" ;;
      *pane_dead_status*) get pane_dead_status ;;
      *) get pane_dead ;;
    esac ;;
  capture-pane) cat "$MS_TMUX_SCREEN" 2>/dev/null ;;
  send-keys) case "$*" in */exit*) put pane_dead 1 ;; esac ;;
  respawn-pane) put pane_dead "$MS_TMUX_RESPAWN_DEAD"; put pane_dead_status "$MS_TMUX_DEAD_STATUS" ;;
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
  /** Has the conversation ever had a turn? Default yes — a session that walled
   * got there by submitting one, and a transcript is what makes `--resume` the
   * right relaunch. `false` is the pane nobody has typed into yet. */
  activity?: boolean;
  /** Did the tool watch this CLI session id begin? Default yes (a `started`
   * event from the first launch). `false` is an id no event ever carried. */
  born?: boolean;
  panes?: string;
  /** Make the stub tmux fail this subcommand, and only this one. */
  failOn?: string;
  /** Raw accounts.json content, for the unreadable-registry case. */
  registry?: string;
  /** The launched CLI dies on arrival: the respawned pane comes back DEAD,
   * holding this exit status. */
  respawnDead?: number;
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
    [`panes=${opts.panes ?? PANE}`, `pane_pid=${pid}`, "command=claude", "pane_dead=0", "pane_dead_status=0", `cwd=${cwd}`, ""].join("\n"),
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
  // What the pane looks like after `respawn-pane`: alive, unless the test is
  // about a launch that died on arrival.
  process.env.MS_TMUX_RESPAWN_DEAD = opts.respawnDead === undefined ? "0" : "1";
  process.env.MS_TMUX_DEAD_STATUS = String(opts.respawnDead ?? 0);
  // The stub's synchronous injection hook: a test sets these to run a shell
  // command the instant the worker makes a particular tmux call. Every tmux
  // call is a `spawnSync`, so this is the only way to land something in the
  // store or the event log at an exact point INSIDE the transaction — a timer
  // in this process could not, the event loop never runs there.
  process.env.MS_TMUX_ON_MATCH = "";
  process.env.MS_TMUX_ON = "";
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
    // The conversation's birth, as Claude Code's own SessionStart hook reported
    // it at the first launch. Without one the tool never watched this id begin,
    // and it may not CREATE it (a corrupted `cliSessionId` must not come back
    // as a brand new empty conversation under the bogus id).
    if (opts.born !== false) appendEvent({ t: nowSeconds() - 60, kind: "started", session: "s1", generation: 1, cliSessionId: "c-1" });
    // Before the wall, so the recovery is never obsolete by it: the turn that
    // walled is what wrote this, and it is also the transcript on disk.
    if (opts.activity !== false) appendEvent({ t: nowSeconds() - 20, kind: "activity", session: "s1", generation: 2, cliSessionId: "c-1" });
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

/** Run `fn` the first time `needle` shows up in the tmux log. */
function onFirst(w: World, needle: string, fn: () => void): () => void {
  const timer = setInterval(() => {
    if (!logLines(w).some((l) => l.includes(needle))) return;
    clearInterval(timer);
    fn();
  }, 5);
  return () => clearInterval(timer);
}

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

test("a wall after a /clear resumes the conversation the human is actually in", async (t) => {
  // End to end, with Claude Code's own SessionStart hook in the middle: the
  // human cleared the conversation (a new CLI session id, one process), went on
  // working, and then hit a wall. Resuming the PRE-clear id would hand the model
  // a conversation the human had deliberately left — and the readiness check,
  // comparing against that same stale id, would call it a good resume.
  // The wall is appended after the clear here, in the order the events really
  // happened: a turn on the old conversation, the clear, the turn that made a
  // transcript for the NEW one, and then the wall it ended at.
  const w = await world(t, { wall: false, recovery: false });
  const { run } = await import("./helpers.ts");
  const hook = run(
    ["_hook", "claude"],
    { HOME: w.home, MS_HOME: w.msHome, MS_SESSION: "s1", MS_GENERATION: "2", MS_SOCKET: SOCKET, MS_PANE: PANE },
    JSON.stringify({ hook_event_name: "SessionStart", source: "clear", session_id: "c-2" }),
  );
  assert.equal(hook.code, 0);
  assert.equal(session(w).cliSessionId, "c-2");
  appendEvent({ t: nowSeconds() - 20, kind: "activity", session: "s1", generation: 2, cliSessionId: "c-2" });
  appendEvent({ t: nowSeconds() - 10, kind: "rate_limited", session: "s1", generation: 2, cliSessionId: "c-2", kindDetail: "session" });
  const st = openState();
  try {
    st.addRecovery({ sessionId: "s1", generation: 2, turnId: null, kind: "session" });
  } finally {
    st.close();
  }

  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-2" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--resume", "c-2", CONTINUATION, "--model", "sonnet"]);
  assert.equal(session(w).state, "continuing", "and the resume was accepted, not read as a new conversation");
});

test("a conversation that has never had a turn is started under its own id, not resumed", async (t) => {
  // Live matrix case 3: `ms rotate` on a pane nobody had typed into yet. There
  // is no transcript for that id, and Claude Code 2.1.273 does not quietly
  // start a fresh conversation for `--resume` — it prints "No conversation
  // found with session ID" and exits 1, so the respawned pane died at +1 s.
  const w = await world(t, { activity: false });
  // `--session-id` is a NEW conversation, so the CLI reports a `startup`.
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1", kind: "started" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--session-id", "c-1", "--model", "sonnet"]);
  assert.ok(!launch.command.includes(CONTINUATION), "a conversation with no turns has no unfinished work to continue");
  const s = session(w);
  assert.equal(s.account, "gmail", "the handoff still happened");
  assert.equal(s.generation, 3);
  assert.equal(s.state, "running", "no continuation means the session is merely running");
  assert.match(recoverLog(w), /c-1 has no transcript yet/);
});

test("a conversation a /clear has just begun is started under its own id too", async (t) => {
  // The other half of "born": a `cleared` report is Claude Code saying this
  // conversation begins here, and nobody has typed into it since. Told apart by
  // the ID and not merely by the kind — the activity on the record belongs to
  // the conversation the human LEFT.
  const w = await world(t, { activity: false, born: false, session: { cliSessionId: "c-2" }, wall: false, recovery: false });
  appendEvent({ t: nowSeconds() - 30, kind: "activity", session: "s1", generation: 2, cliSessionId: "c-1" });
  appendEvent({ t: nowSeconds() - 20, kind: "cleared", session: "s1", generation: 2, cliSessionId: "c-2", prevCliSessionId: "c-1" });
  appendEvent({ t: nowSeconds() - 10, kind: "rate_limited", session: "s1", generation: 2, cliSessionId: "c-2", kindDetail: "session" });
  const st = openState();
  try {
    st.addRecovery({ sessionId: "s1", generation: 2, turnId: null, kind: "session" });
  } finally {
    st.close();
  }
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-2", kind: "started" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["claude", "--session-id", "c-2", "--model", "sonnet"]);
});

test("an id no event ever carried is resumed, not created, and the failure is loud", async (t) => {
  // Live matrix case 8: a corrupted `cliSessionId`. It has no `activity`, so
  // the transcript rule alone would relaunch it with `--session-id` — making a
  // brand new, empty conversation under the bogus id and calling the handoff a
  // success, with the human's work not merely unreachable but unmentioned.
  // `--session-id` MAKES a conversation, so it is only ever for an id we
  // watched be born. Everything else goes to `--resume`, which fails audibly.
  const w = await world(t, { activity: false, born: false, session: { cliSessionId: "c-BOGUS" }, respawnDead: 1 });
  process.env.MS_READY_MS = "10000"; // the pane is what ends this, not the clock

  assert.equal(await recoverSession("s1"), 1);

  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--resume", "c-BOGUS", CONTINUATION, "--model", "sonnet"]);
  const s = session(w);
  assert.equal(s.state, "parked", "a row nobody can explain ends with a human, not with a new conversation");
  assert.equal(rows(w, "attempts").at(-1)!.note, "dead");
  assert.match(recoverLog(w), /the resumed CLI exited \(pane_dead_status 1\)/);
  assert.doesNotMatch(recoverLog(w), /no transcript yet/);
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

/** Claude Code's UserPromptSubmit hook, fired from inside the stub tmux: the
 *  human starts a new turn at the exact moment the worker makes `match`. */
function typesDuring(match: string): void {
  const line = JSON.stringify({ t: nowSeconds(), kind: "activity", session: "s1", generation: 2, cliSessionId: "c-1" });
  process.env.MS_TMUX_ON_MATCH = match;
  process.env.MS_TMUX_ON = `printf '%s\\n' '${line}' >> "$MS_HOME/sessions/s1/events.jsonl"`;
}

test("a turn started while the worker polled is noticed before the exit; nothing is killed", async (t) => {
  // The wall is real and the claim was right, but polling usage takes seconds
  // and the human's window reset in the meantime. The recheck happens after the
  // pane is marked and before the first keystroke.
  const w = await world(t);
  typesDuring("@ms_handoff");

  assert.equal(await recoverSession("s1"), 1);

  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "a live turn must never be typed into");
  assert.ok(!respawnLine(w), "and it must never be respawned out from under itself");
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  const s = session(w);
  assert.equal(s.generation, 2, "nothing moved");
  assert.equal(s.account, "dirk");
  assert.equal(s.state, "walled", "the row does not go on claiming a handoff nobody is doing");
  assert.ok(logLines(w).some((l) => l.includes("set-option -pu -t %7 @ms_handoff")), "the handoff mark is taken back");
  assert.match(recoverLog(w), /obsolete: the session went on working after the wall \(noticed before the exit\)/);
});

test("a turn that lands while the CLI is leaving stands the worker down before the respawn", async (t) => {
  const w = await world(t);
  typesDuring("/exit");

  assert.equal(await recoverSession("s1"), 1);

  assert.ok(!respawnLine(w), "the pane is left as the new turn found it");
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  assert.equal(session(w).generation, 2);
  assert.equal(session(w).state, "walled");
  assert.match(recoverLog(w), /obsolete: the session went on working after the wall \(noticed before the respawn\)/);
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
      // dirk is the account being left; its own reset counts towards the wait
      // too, so it is pinned well past gmail's to keep this about the others.
      dirk: { session: 100, weekly: 40, sessionReset: new Date(Date.now() + 8 * HOUR).toISOString() },
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

test("a deadline that already has a timer does not get a second one", async (t) => {
  // The session came back round to the same wake-up — a re-dispatch, or a
  // timer reconciliation fired after a tmux restart. Arming another
  // `run-shell -d` for the instant one is already armed for puts two workers
  // on one deadline, every time round.
  const soon = new Date(Date.now() + 2 * HOUR).toISOString();
  const w = await world(t, {
    usage: {
      dirk: { session: 100, weekly: 40, sessionReset: new Date(Date.now() + 5 * HOUR).toISOString() },
      gmail: { session: 100, weekly: 20, sessionReset: soon },
      work: { session: 100, weekly: 35, sessionReset: new Date(Date.now() + 3 * HOUR).toISOString() },
    },
  });
  const at = Math.floor(Date.parse(soon) / 1000);
  const st = openState();
  try {
    st.setWakeup("s1", at);
  } finally {
    st.close();
  }

  assert.equal(await recoverSession("s1"), 2);

  const s = session(w);
  assert.equal(s.state, "waiting");
  assert.equal(s.wakeupAt, at, "the deadline itself is unchanged");
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")), "a second timer for one deadline is a second worker");
  assert.match(recoverLog(w), /a timer is already armed for/);
});

test("the account being left is excluded from the pick, never from the wait", async (t) => {
  // One registered account, walled: it is excluded as a CANDIDATE — we will not
  // hand it straight back the session it just walled — but it is still the only
  // thing that can have room again, and its five-hour window says when. Without
  // it the session re-dispatched every ten minutes, for ever, and `ms status`
  // showed that as the ETA.
  const resetsAt = new Date(Date.now() + 5 * HOUR).toISOString();
  const w = await world(t, {
    registry: JSON.stringify({ version: 1, accounts: [{ name: "dirk", provider: "claude", label: "dirk", shared: false }] }),
    usage: { dirk: { session: 100, weekly: 40, sessionReset: resetsAt } },
  });

  assert.equal(await recoverSession("s1"), 2);

  const s = session(w);
  assert.equal(s.state, "waiting");
  assert.equal(s.account, "dirk", "nothing moved");
  const at = Math.floor(Date.parse(resetsAt) / 1000);
  assert.ok(Math.abs(s.wakeupAt! - at) < 5, `wakeup ${s.wakeupAt} is not dirk's own five-hour reset (${at})`);
  const dispatch = logLines(w).find((l) => l.includes("run-shell"));
  const delay = Number(dispatch!.match(/run-shell -b -d (\d+)/)![1]);
  assert.ok(delay > 600, `the timer is ${delay}s — the ten-minute "we do not know" fallback, not the reset`);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "nothing is typed when nothing has room");
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
  assert.equal(rows(w, "recoveries")[0].status, "failed", "terminal: an open row here would swallow the next wall");
  assert.equal(s.wakeupAt, null, "a parked session waits for a person, not for a window");
  // The screen is evidence: the last non-blank lines land in the log.
  assert.match(recoverLog(w), /screen\| /);
  // Named for what it is — a new conversation, not merely a silent resume.
  assert.match(recoverLog(w), /the resume started a new conversation; s1 is parked/);
});

test("a launch that dies on arrival is noticed at once, not waited out", async (t) => {
  // Live matrix case 3: the respawned CLI exited at +1 s and the worker went on
  // waiting the full 60 s for a report that could never come, with the session
  // dead on the human's screen throughout. tmux knew: `#{pane_dead}` was 1 and
  // `#{pane_dead_status}` was 1.
  const w = await world(t, { respawnDead: 1 });
  process.env.MS_READY_MS = "10000"; // generous on purpose: the PANE is what ends this

  const started = Date.now();
  assert.equal(await recoverSession("s1"), 1);
  assert.ok(Date.now() - started < 5_000, "the worker waited out its readiness budget over a pane tmux would have called dead");

  const s = session(w);
  assert.equal(s.state, "parked");
  assert.equal(s.generation, 3, "the respawn did happen; it is the launch that died");
  assert.equal(s.wakeupAt, null, "a parked session waits for a person, not for a window");
  const attempt = rows(w, "attempts").at(-1)!;
  assert.equal(attempt.outcome, "resume-broken");
  assert.equal(attempt.note, "dead", "and not `timeout`: this is a death, not a silence");
  assert.equal(rows(w, "recoveries")[0].status, "failed", "terminal: nothing may retry onto a dead pane");
  // The evidence a human needs: what the pane last said, and how it exited.
  assert.match(recoverLog(w), /screen\| /);
  assert.match(recoverLog(w), /the resumed CLI exited \(pane_dead_status 1\) before reporting; s1 is parked/);
});

test("a resume that never reports parks the session too", async (t) => {
  const w = await world(t);
  process.env.MS_READY_MS = "300"; // nobody will report; do not wait a minute for it

  assert.equal(await recoverSession("s1"), 1);

  const s = session(w);
  assert.equal(s.state, "parked");
  assert.ok(respawnLine(w), "the pane was respawned before anyone waited on it");
  assert.equal(rows(w, "attempts").at(-1)!.outcome, "resume-broken");
  assert.equal(rows(w, "recoveries")[0].status, "failed", "terminal, like any broken resume");
  assert.equal(s.wakeupAt, null);
  assert.match(recoverLog(w), /no resume report within/);
});

test("a fourth try is not taken: three failed attempts park the session", async (t) => {
  const w = await world(t);
  const st = openState();
  try {
    const rec = st.pendingRecovery("s1")!;
    for (const account of ["gmail", "work", "gmail"]) st.addAttempt({ recoveryId: rec.id, account, outcome: "resume-broken", note: "" });
    st.setWakeup("s1", nowSeconds() + 3600); // left over from a "nothing has room" round
  } finally {
    st.close();
  }

  assert.equal(await recoverSession("s1"), 1);
  assert.equal(session(w).state, "parked");
  assert.equal(session(w).wakeupAt, null, "a parked session is not also waiting for a window");
  assert.equal(rows(w, "recoveries")[0].status, "failed");
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.match(recoverLog(w), /gave up after 3 attempts/);
});

test("a held session lock refuses the recovery without typing anything", async (t) => {
  const w = await world(t);
  const { acquire } = await import("../src/lock.ts");
  const { sessionLockName } = await import("../src/recover.ts");
  assert.equal(sessionLockName("s1"), "session-s1");
  const release = acquire(sessionLockName("s1"))!;
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

test("a pass-through prompt is never re-submitted beside the continuation", async (t) => {
  // `ms claude -- --model sonnet "finish the docs"` records all three as the
  // session's flags, and a resume re-applies them: two positionals on one
  // command line, which the CLI rejects outright.
  const w = await world(t, { session: { flags: ["--model", "sonnet", "finish the docs"] } });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--resume", "c-1", CONTINUATION, "--model", "sonnet"]);
});

test("flagsForResume keeps flags and their values, and drops what the CLI would read as a prompt", async () => {
  const { flagsForResume } = await import("../src/recover.ts");
  assert.deepEqual(flagsForResume(["--model", "sonnet", "do it"]), ["--model", "sonnet"]);
  assert.deepEqual(flagsForResume(["do it"]), []);
  assert.deepEqual(flagsForResume(["--model=sonnet", "do it"]), ["--model=sonnet"]);
  assert.deepEqual(flagsForResume(["--dangerously-skip-permissions"]), ["--dangerously-skip-permissions"]);
  assert.deepEqual(flagsForResume(["--", "not a flag"]), [], "everything after a -- is positional");
  assert.deepEqual(flagsForResume([]), []);
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
  assert.match(recoverLog(w), /could not respawn the pane/);
  assert.match(recoverLog(w), /parked with its CLI stopped/);

  // The CLI is already dead and the pane did not come back, so the episode is
  // over: no next account, no re-dispatch, no wake-up. A human decides.
  const s = session(w);
  assert.equal(s.state, "parked");
  assert.equal(s.wakeupAt, null);
  assert.equal(s.generation, 2, "nothing ran, so the generation did not move");
  assert.equal(s.account, "dirk", "and neither did the account");
  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.equal(launch.generation, 3, "the launch was written down before it was attempted");
  assert.deepEqual(
    rows(w, "attempts").map((a) => [a.account, a.outcome]),
    [["dirk", "exhausted"], ["gmail", "infra"]],
  );
  assert.equal(rows(w, "recoveries")[0].status, "failed", "terminal: nothing may retry onto a dead pane");
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")), "no worker is sent to respawn a pane that would not respawn");
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
  // The delayed re-dispatch is armed, but nothing showed up on `ms status`
  // or in reconciliation's due-wakeups scan unless the wake-up is recorded
  // too — it must land at the same ~30s the timer itself was set for.
  const wakeup = session(w).wakeupAt!;
  assert.ok(Math.abs(wakeup - (nowSeconds() + 30)) < 5, `wakeup ${wakeup} is not ~30s out`);
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
  // Nothing was touched, so one more worker is sent — immediately, not on a
  // wake-up timer, because there is no window to wait for.
  const dispatches = logLines(w).filter((l) => l.includes("run-shell"));
  assert.equal(dispatches.length, 1, "once, not a loop");
  assert.match(dispatches[0], /run-shell -b '.*ms' '_recover' 's1'/);
  assert.doesNotMatch(dispatches[0], /-d /);

  const attempt = rows(w, "attempts")[0];
  assert.equal(attempt.outcome, "infra", "it counts against the budget: a registry that stays broken parks the session");
  assert.match(String(attempt.note), /registry unreadable/);
  assert.equal(rows(w, "recoveries")[0].status, "pending");
  assert.match(recoverLog(w), /cannot read the registry/);
});

test("a recovery for a generation the session has left is obsolete", async (t) => {
  const w = await world(t);
  // The session moved on (another rotation, a reconciliation) while this
  // recovery still described generation 2.
  const st = openState();
  try {
    st.updateSession("s1", { generation: 3 });
  } finally {
    st.close();
  }

  assert.equal(await recoverSession("s1"), 1);
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "a session at another generation is not ours to move");
  assert.ok(!respawnLine(w));
  assert.match(recoverLog(w), /generation 2 and the session is at 3/);
});

test("the session reads stopping before a single key is sent", async (t) => {
  const w = await world(t);
  let stateWhenTyping: string | null = null;
  // Read the row the moment the first key goes out — the worker then waits
  // 300 ms before `/exit`, so this is not a race.
  const stop = onFirst(w, "send-keys", () => {
    stateWhenTyping = session(w).state;
  });
  t.after(stop);
  const stopReport = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stopReport);

  assert.equal(await recoverSession("s1"), 0);
  assert.equal(stateWhenTyping, "stopping", "a reader must never find a killed CLI under a session that claims to be running");
});

test("a stop that lands mid-handoff stands the worker down and leaves the pane", async (t) => {
  const w = await world(t);
  // The human runs `ms stop` between the exit and the respawn.
  const stop = onFirst(w, "send-keys", () => {
    const st = openState();
    try {
      st.updateSession("s1", { desired: "stopped" });
    } finally {
      st.close();
    }
  });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0, "a stop that arrives during a rotation is a stop that worked");
  assert.ok(!respawnLine(w), "the pane is left as the stop found it");
  assert.equal(session(w).generation, 2);
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  assert.ok(logLines(w).some((l) => l.includes("set-option -pu -t %7 @ms_handoff")), "the handoff mark is taken back");
  assert.match(recoverLog(w), /asked to stop before the respawn; standing down/);
});

test("a candidate with no launch token is skipped for the next one", async (t) => {
  const w = await world(t);
  rmSync(path.join(w.msHome, "launch", "gmail.token")); // the best-ranked account
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  assert.equal(session(w).account, "work", "the chooser's first pick was unlaunchable; the next one took it");
  assert.deepEqual(
    rows(w, "attempts").map((a) => [a.account, a.outcome]),
    [["gmail", "auth"], ["dirk", "exhausted"]],
  );
  assert.match(recoverLog(w), /gmail: no launch token/);
});

/** root reads a 0000 file, so denying ourselves a read proves nothing there. */
const CAN_DENY_READ = process.getuid?.() !== 0;

test("a candidate whose token cannot be READ is skipped like one that has none", { skip: !CAN_DENY_READ }, async (t) => {
  // The live variant of case 10: `chmod 000` on the best-ranked account's token
  // threw EACCES out of the transaction as "recovery failed", and the accounts
  // that were perfectly fine were never tried.
  const w = await world(t);
  const token = path.join(w.msHome, "launch", "gmail.token");
  chmodSync(token, 0o000);
  t.after(() => chmodSync(token, 0o600));
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  assert.equal(session(w).account, "work", "the next account took it");
  assert.deepEqual(
    rows(w, "attempts").map((a) => [a.account, a.outcome]),
    [["gmail", "auth"], ["dirk", "exhausted"]],
  );
  assert.match(recoverLog(w), /gmail: no launch token/);
  assert.doesNotMatch(recoverLog(w), /recovery failed/);
});

test("a throw past the transaction never leaves a recovery owned by a worker that has gone", async (t) => {
  // Whatever threw, this process is about to exit — so an `owned` row is owned
  // by nobody. Live, that left the session `stopping` under a dead pid, with
  // every manual verb refusing ("already owned by <pid>@host") until
  // reconciliation reclaimed it minutes later. A store that will not write is
  // the case the catch-all's own comment names; this is one.
  const w = await world(t);
  const db = new DatabaseSync(path.join(w.msHome, "state.sqlite"));
  try {
    db.exec("CREATE TRIGGER no_launches BEFORE INSERT ON launches BEGIN SELECT RAISE(ABORT, 'the store would not write'); END");
  } finally {
    db.close();
  }

  assert.equal(await recoverSession("s1"), 1);

  const s = session(w);
  assert.equal(s.state, "parked", "not `stopping`: nothing is coming back for this session");
  assert.equal(s.wakeupAt, null, "a parked session is not also waiting for a window");
  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "failed", "closed, not left open for a worker that no longer exists");
  assert.equal(rec.owner, `${process.pid}@${hostname()}`, "and closed by the worker that owned it");
  assert.match(recoverLog(w), /recovery failed: .*the store would not write/);
  assert.match(recoverLog(w), /s1 is parked/);
  assert.ok(!respawnLine(w), "the launch was never written, so nothing was respawned");
});

test("no launch token ever reaches a tmux command line", async (t) => {
  const w = await world(t);
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  // The tokens exist and are readable — this is not vacuous.
  const { readLaunchToken } = await import("../src/launch-credentials.ts");
  assert.match(readLaunchToken("gmail") ?? "", /^sk-ant-/);
  // tmux command strings are readable by anything that can talk to the server.
  assert.doesNotMatch(readFileSync(w.log, "utf8"), /sk-ant-/);
  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.doesNotMatch(JSON.stringify(launch), /sk-ant-/, "the credential is the pane environment's, not the launch row's");
});

test("a forced exit on a manual move is still the human's ok", async (t) => {
  const w = await world(t, { screen: MODAL_SCREEN, recovery: false, wall: false });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1", { manual: { toAccount: "work", continueAfter: true }, force: true }), 0);
  const attempt = rows(w, "attempts")[0];
  assert.equal(attempt.outcome, "ok", "the human asked for this; the account did not fail");
  assert.match(String(attempt.note), /forced exit/, "but the force is still on the record");
});

test("a named destination is checked before it can become anything", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, recovery: false, wall: false });
  const move = (toAccount: string) => recoverSession("s1", { manual: { toAccount, continueAfter: true } });

  assert.equal(await move("../../etc/passwd"), 1, "a name that is a path is not a name");
  assert.equal(await move("nosuchaccount"), 1, "an unregistered account is not a destination");
  assert.equal(await move("dirk"), 1, "the session is already there");

  assert.equal(rows(w, "recoveries").length, 0, "a refused destination opens no recovery");
  assert.equal(rows(w, "attempts").length, 0);
  assert.equal(session(w).account, "dirk");
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.ok(!respawnLine(w));
  const log = recoverLog(w);
  assert.match(log, /is not a valid account name/);
  assert.match(log, /no claude account named 'nosuchaccount' is registered/);
  assert.match(log, /already on 'dirk'/);
});

test("the budget counts failures, not the record of a handoff that happened", async (t) => {
  const w = await world(t);
  const st = openState();
  try {
    const rec = st.pendingRecovery("s1")!;
    // Three rows for accounts this recovery LEFT — one is written on every
    // successful handoff. None of them is a try that went wrong.
    for (const account of ["a", "b", "c"]) st.addAttempt({ recoveryId: rec.id, account, outcome: "exhausted", note: "" });
  } finally {
    st.close();
  }
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "c-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0, "three handoff records are not three failures");
  assert.notEqual(session(w).state, "parked");
});

test("a failed manual move never dispatches an automatic one behind the human's back", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, recovery: false, wall: false });
  rmSync(path.join(w.msHome, "launch", "work.token")); // the account they named

  const code = await recoverSession("s1", { manual: { toAccount: "work", continueAfter: false } });
  assert.equal(code, 1);

  // A dispatched worker runs as an AUTOMATIC rotation: it would pick an account
  // the human never named and hand it the continuation they declined.
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")), "a manual move that failed is over");
  assert.ok(!respawnLine(w));
  const s = session(w);
  assert.equal(s.account, "dirk");
  assert.equal(s.state, "walled");
  assert.deepEqual(rows(w, "attempts").map((a) => [a.account, a.outcome]), [["work", "auth"]]);
  assert.equal(rows(w, "recoveries")[0].status, "pending", "what it claimed is released");
});

test("candidates used up by failures park the session; they do not wait for a window", async (t) => {
  const w = await world(t, {
    usage: {
      dirk: { session: 100, weekly: 40 },
      gmail: { session: 10, weekly: 20 },
      work: { session: 100, weekly: 35, sessionReset: new Date(Date.now() + 2 * HOUR).toISOString() },
    },
  });
  // An earlier pass of this episode already spent gmail on a failure of its own.
  const st = openState();
  try {
    st.addAttempt({ recoveryId: st.pendingRecovery("s1")!.id, account: "gmail", outcome: "auth", note: "no launch token" });
  } finally {
    st.close();
  }

  assert.equal(await recoverSession("s1"), 1, "not 2: the fleet is not full, it is used up");

  const s = session(w);
  assert.equal(s.state, "parked");
  assert.equal(s.wakeupAt, null, "no wake-up for a window that was never the problem");
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")));
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.equal(rows(w, "recoveries")[0].status, "failed");
  assert.match(recoverLog(w), /all candidates failed: gmail: no launch token/);
});

test("a corrupt registry says so when a destination is named", async (t) => {
  const w = await world(t, { registry: "{ this is not json", screen: IDLE_SCREEN, recovery: false, wall: false });

  assert.equal(await recoverSession("s1", { manual: { toAccount: "work", continueAfter: true } }), 1);
  const log = recoverLog(w);
  assert.match(log, /cannot read the registry/);
  assert.doesNotMatch(log, /is not registered/, "an unreadable file is not evidence the account is gone");
  assert.equal(rows(w, "recoveries").length, 0, "nothing was claimed");
});

test("a failure against the account being left does not spend a candidate", async (t) => {
  const resetsAt = new Date(Date.now() + 2 * HOUR).toISOString();
  const w = await world(t, {
    usage: {
      dirk: { session: 100, weekly: 40, sessionReset: new Date(Date.now() + 8 * HOUR).toISOString() },
      gmail: { session: 100, weekly: 20, sessionReset: resetsAt },
      work: { session: 100, weekly: 35, sessionReset: new Date(Date.now() + 5 * HOUR).toISOString() },
    },
  });
  // An earlier pass could not read the registry. That failure is recorded
  // against dirk — the account being LEFT, which is never a candidate.
  const st = openState();
  try {
    st.addAttempt({ recoveryId: st.pendingRecovery("s1")!.id, account: "dirk", outcome: "infra", note: "registry unreadable: boom" });
  } finally {
    st.close();
  }

  assert.equal(await recoverSession("s1"), 2, "no candidate was spent; the fleet really is at 100");

  const s = session(w);
  assert.equal(s.state, "waiting");
  assert.ok(Math.abs(s.wakeupAt! - Math.floor(Date.parse(resetsAt) / 1000)) < 5, "and it waits for the earliest reset");
  assert.equal(rows(w, "recoveries")[0].status, "pending");
  assert.match(logLines(w).find((l) => l.includes("run-shell")) ?? "", /run-shell -b -d \d+ '.*ms' '_recover' 's1'/);
});
