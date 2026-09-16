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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  send-keys)
    case "$*" in
      */exit*) put pane_dead 1 ;;
      # Codex's own way out: the FIRST Ctrl-C arms the quit, the second takes
      # it (verified live: the TUI is gone in ~2 s). A pane that died on one
      # keystroke would never prove the sequence was sent twice.
      *C-c*) n=$(get sigints); if [ -z "$n" ]; then n=0; fi; n=$((n + 1)); put sigints "$n"
        # A TUI that will not go: the signal path is the floor under both CLIs.
        if [ "$n" -ge 2 ] && [ -z "$MS_TMUX_STUBBORN" ]; then put pane_dead 1; fi ;;
    esac ;;
  respawn-pane)
    put pane_dead "$MS_TMUX_RESPAWN_DEAD"; put pane_dead_status "$MS_TMUX_DEAD_STATUS"
    # What the Codex account homes said at the instant the pane was respawned:
    # the only way a test can see that trust was recorded BEFORE the CLI started.
    if [ -n "$MS_TMUX_SNAPSHOT" ]; then
      for f in "$MS_HOME"/codex/*/config.toml; do
        [ -f "$f" ] || continue
        d="$MS_TMUX_SNAPSHOT/$(basename "$(dirname "$f")")"
        mkdir -p "$d"
        cp "$f" "$d/config.toml"
      done
    fi
    ;;
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
  // Codex-world settings, off in a Claude world: the env is process-global and
  // these tests run one after another.
  process.env.MS_TMUX_SNAPSHOT = "";
  process.env.MS_TMUX_STUBBORN = "";
  delete process.env.MS_CODEX_AUTOROTATE;
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

test("the catch-all touches nothing when the recovery was never claimed", async (t) => {
  // The first guard. The throw came BEFORE this worker owned anything — here,
  // out of reading the session row itself, whose `flags` column is not JSON any
  // more. There is no half-finished recovery to close and no session to park,
  // and parking one anyway would turn a row somebody corrupted into a session a
  // human has to go and rescue while the recovery it needs is thrown away.
  const w = await world(t);
  const file = path.join(w.msHome, "state.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("UPDATE sessions SET flags='{ not json' WHERE id='s1'").run();
  } finally {
    db.close();
  }

  assert.equal(await recoverSession("s1"), 1);

  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "pending", "still owed to whoever comes next");
  assert.equal(rec.owner, null);
  // Read raw: the row this test corrupted is exactly the one `getSession` chokes on.
  const after = new DatabaseSync(file);
  try {
    const row = after.prepare("SELECT state, wakeupAt FROM sessions WHERE id='s1'").get() as { state: string; wakeupAt: number | null };
    assert.equal(row.state, "walled", "nothing was claimed, so nothing is parked");
    assert.equal(row.wakeupAt, null);
  } finally {
    after.close();
  }
  assert.match(recoverLog(w), /recovery failed: /);
  assert.doesNotMatch(recoverLog(w), /is parked/);
});

test("the catch-all never finishes a recovery another worker has taken", async (t) => {
  // The second guard. Between this worker's claim and the throw, the row moved
  // to somebody else — a reclaim, a manual verb that judged this pid dead. It
  // is that worker's recovery now, and closing it `failed` from here would
  // delete a live handoff's record out from under it.
  const w = await world(t);
  const db = new DatabaseSync(path.join(w.msHome, "state.sqlite"));
  try {
    db.exec("CREATE TRIGGER no_launches BEFORE INSERT ON launches BEGIN SELECT RAISE(ABORT, 'the store would not write'); END");
  } finally {
    db.close();
  }
  const other = `999999@${hostname()}`;
  // The instant the first key goes out — well before the launch row is written.
  const stop = onFirst(w, "send-keys", () => {
    const d = new DatabaseSync(path.join(w.msHome, "state.sqlite"));
    try {
      d.exec("PRAGMA busy_timeout=5000");
      d.prepare("UPDATE recoveries SET owner=? WHERE sessionId='s1'").run(other);
    } finally {
      d.close();
    }
  });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 1);

  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "owned", "left exactly as its new owner had it");
  assert.equal(rec.owner, other);
  assert.notEqual(session(w).state, "parked", "and the other worker's session is not parked from here");
  assert.match(recoverLog(w), /recovery failed: /);
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
  // Closed, not released. An ownerless `pending` row is the same unasked-for
  // rotation by another road: reconciliation's orphan rule dispatches one 45
  // seconds later, to an account the human never named.
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  assert.match(recoverLog(w), /ms accounts login <name>/, "`login` is the verb that mints a launch token; `add` only writes the registry row");
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

// --- The Codex world ---------------------------------------------------
//
// The same stub tmux and the same store, with what a Codex session does
// differently: its credential is a DIRECTORY (`auth.json` inside that
// account's own CODEX_HOME, never a launch token), its pane leaves on Ctrl-C
// twice rather than on `/exit`, its relaunch is `codex resume <id>` (or a
// plain `codex`, for a conversation nobody has typed into yet), its home must
// be made to trust the session's directory before the CLI can start
// unattended, and its automatic path is gated until a live wall has been seen.
//
// The usage snapshot is STATED on disk, fresh, exactly as src/snapshot.ts
// would have written it: what a rotation is answerable for here is choosing
// and relaunching correctly from numbers somebody already read. The fetch stub
// is there to make a stray reading loud, not to serve one.

/** A literal path inside a RegExp: a temp dir can hold `.` and `+`. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The default Pro wall, verbatim from the spike record. */
const CODEX_WALLED_SCREEN = [
  "❯ ship it",
  "",
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
  "",
  "❯ ",
  "",
].join("\n");

/** `codex login`'s file, as far as a rotation reads it. The token is spelled
 *  distinctively so the secrets scan below cannot pass vacuously. */
const codexAuth = (name: string) =>
  JSON.stringify({
    tokens: { id_token: "x.y.z", access_token: `cat-${name}-SECRET`, refresh_token: `crt-${name}-SECRET`, account_id: `acc-${name}` },
  });

/** A `projects` definition this tool refuses to edit: a bare `[projects]`
 *  table, whose keys live INSIDE it. Appending a second definition of the
 *  same table is invalid TOML, and Codex answers an invalid config.toml by
 *  dropping the whole file — hook tables and existing trust included. */
const UNTOUCHABLE_CONFIG = `[projects]\n"/somewhere/else" = { trust_level = "trusted" }\n`;

type CodexRow = { name: string; weekly: number };
/** `work` is where the session is; `home` is the best candidate and `spare`
 *  the next one. Every window resets at the same moment, so the ranking here
 *  is purely "more room left". */
const CODEX_ACCOUNTS: CodexRow[] = [
  { name: "work", weekly: 100 },
  { name: "home", weekly: 10 },
  { name: "spare", weekly: 40 },
];

/** The claude side of this registry, and the point of it: `spare` is a name
 *  BOTH providers use — identity is (provider, name), never a name alone —
 *  and it has more room than any codex account here. A candidate pool that
 *  matched on the name would rank this claude row first and hand a Codex
 *  session an account whose credential its CLI cannot even read. */
const CLAUDE_ACCOUNTS = ["gmail", "spare"];

/** The usage cache, as src/snapshot.ts writes it. A ChatGPT Pro plan reports
 *  NO five-hour window at all (verified live), which is why `session` is null
 *  on every codex row. */
function writeCodexSnapshot(msHome: string, rows: CodexRow[]): void {
  const now = Date.now();
  const resetsAt = new Date(now + 6 * HOUR).toISOString();
  writeFileSync(
    path.join(msHome, "snapshot.json"),
    JSON.stringify({
      takenAt: now,
      accounts: [
        ...CLAUDE_ACCOUNTS.map((name) => ({
          name,
          provider: "claude",
          shared: false,
          usage: { session: { usedPercent: 0, resetsAt }, weeklyAll: { usedPercent: 0, resetsAt }, weeklyFable: null },
          error: null,
          errorKind: null,
          observedAt: now,
          stale: false,
        })),
        ...rows.map((r) => ({
          name: r.name,
          provider: "codex",
          shared: false,
          usage: { session: null, weeklyAll: { usedPercent: r.weekly, resetsAt }, weeklyFable: null },
          error: null,
          errorKind: null,
          observedAt: now,
          stale: false,
        })),
      ],
      backoff: {},
    }),
    { mode: 0o600 },
  );
}

/** `wham/usage`, stubbed: the snapshot above is fresh, so nothing should ask —
 *  and a call to anything else fails loudly rather than reaching chatgpt.com.
 *  The returned array is every URL that was asked for. */
function stubUsageFetch(t: TestContext): string[] {
  const seen: string[] = [];
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (!url.includes("wham/usage")) throw new Error(`test: unexpected network call to ${url}`);
    return new Response(
      JSON.stringify({ rate_limit: { secondary_window: { used_percent: 10, reset_at: Math.floor((Date.now() + 6 * HOUR) / 1000) } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return seen;
}

type CodexWorldOptions = {
  screen?: string;
  /** The gate. Most of these tests are about the transaction rather than the
   *  gate, so it is open by default and one test closes it. */
  autorotate?: boolean;
  session?: Partial<SessionRow>;
  recovery?: boolean;
  wall?: boolean;
  activity?: boolean;
  born?: boolean;
  accounts?: CodexRow[];
  /** Accounts whose home already holds a config.toml this tool will not edit. */
  untouchableTrust?: string[];
  /** Accounts nobody has run `codex login` for: a home with no auth.json. */
  noAuth?: string[];
  /**
   * Where this conversation's rollout is — which is what says whether there is
   * anything to resume:
   *   "store"     in the shared rollout store, found by name (the default)
   *   "recorded"  named by the row's own `transcriptPath`, and NOWHERE the
   *               search would look: a home whose `sessions` link was never
   *               made. Only the recorded path can find it.
   *   "none"      no rollout at all — the conversation is gone.
   */
  rollout?: "store" | "recorded" | "none";
  /** The pane ignores Ctrl-C: the TUI has to be signalled. */
  survivesCtrlC?: boolean;
  /** The CLI had already exited before the worker got there. */
  paneDead?: boolean;
};

type CodexWorld = World & { atRespawn: string; fetched: string[] };

async function codexWorld(t: TestContext, opts: CodexWorldOptions = {}): Promise<CodexWorld> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", TMUX_STUB);
  const log = path.join(dir, "tmux.log");
  const state = path.join(dir, "tmux.state");
  const screen = path.join(dir, "screen.txt");
  const atRespawn = path.join(dir, "at-respawn");
  const pid = liveProcess(t);
  const cwd = home;
  const accounts = opts.accounts ?? CODEX_ACCOUNTS;

  writeFileSync(log, "");
  writeFileSync(screen, opts.screen ?? CODEX_WALLED_SCREEN);
  writeFileSync(
    state,
    [
      `panes=${PANE}`,
      `pane_pid=${pid}`,
      "command=codex",
      `pane_dead=${opts.paneDead ? 1 : 0}`,
      "pane_dead_status=0",
      "sigints=0",
      `cwd=${cwd}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        ...CLAUDE_ACCOUNTS.map((name) => ({ name, provider: "claude", label: name, shared: false })),
        ...accounts.map((a) => ({ name: a.name, provider: "codex", label: a.name, shared: false })),
      ],
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.MS_BIN = MS_BIN;
  process.env.MS_TMUX_LOG = log;
  process.env.MS_TMUX_STATE = state;
  process.env.MS_TMUX_SCREEN = screen;
  process.env.MS_TMUX_SNAPSHOT = atRespawn;
  process.env.MS_TMUX_FAIL = "";
  process.env.MS_TMUX_RESPAWN_DEAD = "0";
  process.env.MS_TMUX_DEAD_STATUS = "0";
  process.env.MS_TMUX_ON_MATCH = "";
  process.env.MS_TMUX_ON = "";
  process.env.MS_TMUX_STUBBORN = opts.survivesCtrlC ? "1" : "";
  process.env.MS_POLL_MS = "20";
  process.env.MS_READY_MS = "10000";
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  if (opts.autorotate === false) delete process.env.MS_CODEX_AUTOROTATE;
  else process.env.MS_CODEX_AUTOROTATE = "1";

  // The claude accounts are fully launchable on purpose: if the candidate pool
  // ever stopped filtering by provider, one would be CHOSEN (they have the
  // most room), not skipped for want of a token.
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  for (const name of CLAUDE_ACCOUNTS) saveLaunchToken(name, `sk-ant-oat01-${name}0123456789abcdefgh`);
  for (const a of accounts) {
    const h = path.join(msHome, "codex", a.name);
    mkdirSync(h, { recursive: true, mode: 0o700 });
    if (!opts.noAuth?.includes(a.name)) writeFileSync(path.join(h, "auth.json"), codexAuth(a.name), { mode: 0o600 });
    if (opts.untouchableTrust?.includes(a.name)) writeFileSync(path.join(h, "config.toml"), UNTOUCHABLE_CONFIG, { mode: 0o600 });
  }
  writeCodexSnapshot(msHome, accounts);

  const cliSessionId = opts.session && "cliSessionId" in opts.session ? opts.session.cliSessionId! : "cx-1";
  // The rollout: `<store>/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, which is what
  // Codex writes and what `codex resume <id>` needs to exist.
  const rollout = opts.rollout ?? "store";
  let transcriptPath: string | null = null;
  if (cliSessionId && rollout !== "none") {
    const root = rollout === "store" ? path.join(msHome, "codex", "sessions") : path.join(msHome, "codex", "work", "sessions");
    const day = path.join(root, "2026", "09", "16");
    mkdirSync(day, { recursive: true, mode: 0o700 });
    const file = path.join(day, `rollout-2026-09-16T10-00-00-${cliSessionId}.jsonl`);
    writeFileSync(file, `{"type":"session_meta","payload":{"id":"${cliSessionId}"}}\n`, { mode: 0o600 });
    if (rollout === "recorded") transcriptPath = file;
  }
  const st = openState();
  try {
    st.createSession({
      id: "s1",
      provider: "codex",
      cliSessionId,
      cwd,
      socket: SOCKET,
      pane: PANE,
      serverStart: "1:2",
      need: "any",
      account: "work",
      generation: 2,
      state: "walled",
      desired: "running",
      flags: ["--model", "gpt-5"],
      ...opts.session,
    });
    // Codex's hook reports the id Codex chose; there is no `--session-id` to
    // hand it one, so the birth is a `started` for whatever it picked.
    if (opts.born !== false) appendEvent({ t: nowSeconds() - 60, kind: "started", session: "s1", generation: 1, cliSessionId });
    if (opts.activity !== false) appendEvent({ t: nowSeconds() - 20, kind: "activity", session: "s1", generation: 2, cliSessionId });
    if (opts.wall !== false) appendEvent({ t: nowSeconds() - 10, kind: "rate_limited", session: "s1", generation: 2, cliSessionId, kindDetail: "weekly" });
    // `transcriptPath` is not a creation input (the hook records it), so it is
    // patched on afterwards — exactly as a SessionStart payload would.
    if (transcriptPath) st.updateSession("s1", { transcriptPath });
    if (opts.recovery !== false) st.addRecovery({ sessionId: "s1", generation: 2, turnId: null, kind: "weekly" });
  } finally {
    st.close();
  }
  return { home, msHome, log, state, screen, pid, cwd, atRespawn, fetched: stubUsageFetch(t) };
}

/** Every key sequence that went to the pane, with the stub's own `-S <socket>`
 *  prefix cut: what was sent, in order, and nothing else. */
const sendKeys = (w: World): string[] =>
  logLines(w)
    .filter((l) => l.includes("send-keys"))
    .map((l) => l.slice(l.indexOf("send-keys")));

/** A codex home's config.toml — as it is now, or as it was at the respawn. */
const configToml = (w: CodexWorld, account: string): string => path.join(w.msHome, "codex", account, "config.toml");
const trustAtRespawn = (w: CodexWorld, account: string): string => readFileSync(path.join(w.atRespawn, account, "config.toml"), "utf8");

test("the codex happy path: work hands off to home and the resumed conversation continues", async (t) => {
  const w = await codexWorld(t);
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  const s = session(w);
  assert.equal(s.account, "home", "and never the claude `spare`, which has more room: identity is (provider, name)");
  assert.equal(s.generation, 3);
  assert.equal(s.state, "continuing");

  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["codex", "resume", "cx-1", CONTINUATION, "--model", "gpt-5"]);
  assert.equal(launch.account, "home");
  assert.equal(launch.generation, 3);
  assert.deepEqual(launch.env, {}, "the credential is the pane environment's (CODEX_HOME), never the launch row's");

  // Asked to leave the only way a Codex TUI can be: Ctrl-C, twice. `/exit` and
  // `/quit` do nothing there, so typing one would burn the whole grace period.
  const lines = logLines(w);
  assert.deepEqual(sendKeys(w), [`send-keys -t ${PANE} C-c`, `send-keys -t ${PANE} C-c`]);
  assert.ok(!lines.some((l) => l.includes("/exit")), "a Codex pane must never be asked to /exit");
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at("send-keys") < at("respawn-pane"), "the CLI is asked to leave before the pane is respawned");
  assert.match(respawnLine(w)!, new RegExp(`respawn-pane -k -c ${esc(w.cwd)} -t ${PANE} `), "the relaunch runs in the session's own cwd");

  // The NEW account's home trusts this directory, and said so before the
  // respawn: the trust dialog is a modal, and a relaunch that met it would sit
  // in front of it for ever with the human's conversation behind it.
  const trusted = trustAtRespawn(w, "home");
  assert.match(trusted, new RegExp(`^\\[projects\\."${esc(realpathSync(w.cwd))}"\\]$`, "m"));
  assert.match(trusted, /^trust_level = "trusted"$/m);
  assert.ok(!existsSync(configToml(w, "work")), "and the account we LEFT was never written into");

  assert.deepEqual(
    rows(w, "attempts").map((a) => [a.account, a.outcome]),
    [["work", "exhausted"]],
  );
  assert.equal(rows(w, "recoveries")[0].status, "done");
  assert.deepEqual(w.fetched, [], "a fresh snapshot is served without a reading of its own");
  assert.match(recoverLog(w), /s1: work → home \(weekly wall, generation 3\)/);
});

test("without MS_CODEX_AUTOROTATE nothing automatic moves a codex session — and a manual rotate still does", async (t) => {
  // Spike G1 is PARTIAL: no exhausted ChatGPT account existed, so what a
  // walled Codex pane reports is unverified. Until it is, the tool will not
  // move a Codex session on a signal nobody has seen.
  const w = await codexWorld(t, { autorotate: false });

  assert.equal(await recoverSession("s1"), 1);
  assert.match(recoverLog(w), /codex automatic recovery is disabled until a live wall is observed \(set MS_CODEX_AUTOROTATE=1\)/);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "nothing is typed");
  assert.ok(!respawnLine(w), "and nothing is respawned");
  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "pending", "the wall is left on the record for the human's own verb");
  assert.equal(rec.owner, null, "and unclaimed: the refusal happens before the row is touched");
  assert.equal(rows(w, "attempts").length, 0);
  assert.equal(session(w).account, "work");
  assert.equal(session(w).state, "walled");

  // Exactly "1" is on. A variable somebody exported as "0" to turn this OFF
  // must never read as having turned it on.
  process.env.MS_CODEX_AUTOROTATE = "0";
  assert.equal(await recoverSession("s1"), 1);
  assert.ok(!respawnLine(w), "'0' is somebody saying no");
  delete process.env.MS_CODEX_AUTOROTATE;

  // The gate is on the AUTOMATIC claim only. `ms rotate` is a person asking.
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);
  assert.equal(await recoverSession("s1", { manual: { continueAfter: true } }), 0);
  assert.equal(session(w).account, "home");
  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["codex", "resume", "cx-1", CONTINUATION, "--model", "gpt-5"]);
  assert.deepEqual(sendKeys(w), [`send-keys -t ${PANE} C-c`, `send-keys -t ${PANE} C-c`]);
});

test("a codex conversation nobody has typed into is resumed, but not asked to continue", async (t) => {
  // Two questions, two answers. The rollout exists, so there IS a conversation
  // to come back to — but no turn was ever submitted on it, so there is no
  // unfinished work, and handing it the continuation would invite the model to
  // invent some. (A missing `activity` costs a continuation here; it must
  // never cost the conversation.)
  const w = await codexWorld(t, { activity: false });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  const launch = launchOf(w, respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["codex", "resume", "cx-1", "--model", "gpt-5"]);
  assert.ok(!launch.command.includes(CONTINUATION), "a conversation with no turns has no unfinished work to continue");
  const s = session(w);
  assert.equal(s.account, "home", "the handoff still happened");
  assert.equal(s.generation, 3);
  assert.equal(s.state, "running", "no continuation means the session is merely running");
  assert.equal(s.cliSessionId, "cx-1", "and the row still names the conversation it resumed");
  assert.doesNotMatch(recoverLog(w), /starting a new conversation/);
});

test("a rollout the row names itself is resumed without a search", async (t) => {
  // The hook records `transcriptPath` from every Codex payload, and this one
  // sits where no search would look: an account home whose `sessions` link at
  // the shared store was never made. The row's own path is the cheap answer.
  const w = await codexWorld(t, { rollout: "recorded" });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["codex", "resume", "cx-1", CONTINUATION, "--model", "gpt-5"]);
  assert.equal(session(w).state, "continuing");
});

test("a conversation whose rollout is gone starts a new one, and the row stops naming the old", async (t) => {
  // The only thing that says there is nothing to come back to. The row keeps
  // an id and a transcript path that no longer resolve — a home the human
  // cleaned out, a store that moved — and `codex resume` on it would die on
  // arrival.
  const w = await codexWorld(t, { rollout: "none" });
  const st = openState();
  try {
    st.updateSession("s1", { transcriptPath: "/nonexistent/rollout-2026-09-16T10-00-00-cx-1.jsonl", rolloutOffset: 4096 });
  } finally {
    st.close();
  }
  // `codex` picks its own id and the hook reports whichever one it picked.
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-2", kind: "started" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["codex", "--model", "gpt-5"]);
  const s = session(w);
  assert.equal(s.account, "home");
  assert.equal(s.state, "running");
  // The identity of the conversation this relaunch did NOT resume must not
  // survive it: the hook refuses to adopt a `resuming` row whose reported id
  // is not the one on it, and the next rotation would resume a conversation
  // this one already replaced.
  assert.equal(s.cliSessionId, null, "the row stops naming a conversation it is not in");
  assert.equal(s.transcriptPath, null, "and stops pointing at a rollout that is not its own");
  assert.equal(s.rolloutOffset, 0, "the byte offset indexes a file this session does not have");
  assert.match(recoverLog(w), /cx-1 has no rollout on disk; starting a new conversation rather than resuming/);
});

test("a rollout the search runs out of budget before reaching is resumed, not replaced", async (t) => {
  // A search that gave up has not found the conversation ABSENT. Reading "I
  // stopped looking" as "it is gone" would discard a live conversation
  // silently; resuming a rollout that really is missing fails loudly instead —
  // the pane dies on arrival, readiness sees it, and the session parks.
  const w = await codexWorld(t, { rollout: "none" });
  const store = path.join(w.msHome, "codex", "sessions");
  const day = path.join(store, "2024", "01", "01");
  mkdirSync(day, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(day, "rollout-2024-01-01T10-00-00-cx-1.jsonl"), "{}\n", { mode: 0o600 });
  // More recent days than the search will look through, all of them empty.
  for (const year of ["2026", "2025"]) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 28; d++) {
        mkdirSync(path.join(store, year, String(m).padStart(2, "0"), String(d).padStart(2, "0")), { recursive: true, mode: 0o700 });
      }
    }
  }
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["codex", "resume", "cx-1", CONTINUATION, "--model", "gpt-5"]);
  assert.equal(session(w).cliSessionId, "cx-1", "nothing was discarded");
});

test("a codex TUI that will not go on Ctrl-C is signalled", async (t) => {
  // The floor under both CLIs. Two Ctrl-C and two seconds is what the spike
  // measured; a pane still running past that is not asked a third time.
  const w = await codexWorld(t, { survivesCtrlC: true });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  assert.deepEqual(sendKeys(w), [`send-keys -t ${PANE} C-c`, `send-keys -t ${PANE} C-c`], "asked twice, and only twice");
  assert.ok(await gone(w.pid), "the pane's process was never signalled");
  const attempt = rows(w, "attempts")[0]!;
  assert.equal(attempt.outcome, "forced");
  assert.match(String(attempt.note), /forced exit/);
  assert.match(recoverLog(w), /the CLI did not leave on Ctrl-C; signalling/);
  assert.match(recoverLog(w), /sent SIGTERM to pid/);
  assert.equal(session(w).account, "home", "and the handoff still happened");
});

test("a codex pane whose CLI had already exited is not asked to leave", async (t) => {
  // Keys sent into a corpse do nothing, the settle wait is two seconds of a
  // dead pane on a human's screen, and "signalling instead" would name a step
  // that cannot run: `stopPane` signals a live pid or nothing.
  const w = await codexWorld(t, { paneDead: true });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  assert.deepEqual(sendKeys(w), [], "nothing is typed into a pane that has already gone");
  assert.ok(respawnLine(w), "the handoff still happened");
  assert.equal(rows(w, "attempts")[0]!.outcome, "exhausted", "a CLI that had already left was not forced out");
  assert.match(recoverLog(w), /the CLI had already exited; nothing to ask/);
  assert.doesNotMatch(recoverLog(w), /signalling/);
});

test("every candidate's home refusing trust parks at once, saying what the file said", async (t) => {
  // Not "come back when a credential lands": the writer will make the same
  // decision about the same file in thirty seconds. Re-dispatching would only
  // spend the budget and end at "gave up after 3 attempts", which names
  // nothing a human can act on.
  const w = await codexWorld(t, { untouchableTrust: ["home", "spare"] });

  assert.equal(await recoverSession("s1"), 1);

  const s = session(w);
  assert.equal(s.state, "parked");
  assert.equal(s.account, "work", "nothing moved");
  assert.equal(s.wakeupAt, null, "a parked session waits for a person, not for a window");
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")), "and no worker is sent to make the same decision again");
  assert.deepEqual(sendKeys(w), [], "the pane still holds the conversation");
  assert.equal(rows(w, "recoveries")[0]!.status, "failed");
  assert.deepEqual(
    rows(w, "attempts").map((a) => [a.account, a.outcome]),
    [["home", "infra"], ["spare", "infra"]],
  );
  // Verbatim: it already names the file, the line and what to add to it.
  assert.match(recoverLog(w), /already defines 'projects' in a form this tool will not edit \(the table on line 1\)/);
  assert.doesNotMatch(recoverLog(w), /gave up after 3 attempts/);
});

test("the fable refusal is the automatic path's; a human's own move is never gated", async (t) => {
  // A hand-edited row that needs a window Codex does not have still has to be
  // movable — refusing the human here would leave it with no way out at all.
  const w = await codexWorld(t, { session: { need: "fable" } });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1", { manual: { toAccount: "spare", continueAfter: true } }), 0);

  const s = session(w);
  assert.equal(s.account, "spare");
  assert.equal(s.state, "continuing");
  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["codex", "resume", "cx-1", CONTINUATION, "--model", "gpt-5"]);
  assert.doesNotMatch(recoverLog(w), /codex has no fable window/);
});

test("a codex pane whose hook has not yet named its conversation is relaunched, not parked", async (t) => {
  // Codex fills `cliSessionId` only through the hook's first SessionStart, so
  // a pane that has launched and not yet reported carries a null. For Claude
  // that is a row with nothing to resume and the session is parked; here it is
  // a conversation whose name we have not been told, and a plain `codex`
  // starts one the hook then adopts.
  const w = await codexWorld(t, { session: { cliSessionId: null }, activity: false, born: false });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-9", kind: "started" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["codex", "--model", "gpt-5"]);
  const s = session(w);
  assert.equal(s.state, "running");
  assert.equal(s.account, "home");
  assert.doesNotMatch(recoverLog(w), /never reported a CLI session id/, "a null id is not a broken row on this side");
});

test("a codex home this tool will not edit costs that candidate, not the rotation", async (t) => {
  const w = await codexWorld(t, { untouchableTrust: ["home"] });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  assert.equal(session(w).account, "spare", "the next candidate took it");
  const attempts = rows(w, "attempts");
  assert.deepEqual(
    attempts.map((a) => [a.account, a.outcome]),
    [["home", "infra"], ["work", "exhausted"]],
    "a home we cannot prepare is infra, not auth: the credential is fine, the file is not",
  );
  assert.match(String(attempts[0].note), /already defines 'projects' in a form this tool will not edit/);
  assert.equal(readFileSync(configToml(w, "home"), "utf8"), UNTOUCHABLE_CONFIG, "not one byte written into the home that refused");
  assert.match(trustAtRespawn(w, "spare"), /^trust_level = "trusted"$/m);
  assert.match(recoverLog(w), /home: .*trying the next account/);
});

test("a codex session that needs fable is refused: there is no such window to wait for", async (t) => {
  // Codex reports one subscription's windows and no model-scoped one at all,
  // so the chooser would pass over every account for "no fable window" and a
  // wake-up would be scheduled for a window that cannot reset.
  const w = await codexWorld(t, { session: { need: "fable" } });

  assert.equal(await recoverSession("s1"), 2);

  assert.match(recoverLog(w), /codex has no fable window; s1 cannot be recovered while it needs fable/);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")));
  assert.ok(!respawnLine(w));
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")), "and no timer for a window that does not exist");
  const s = session(w);
  assert.equal(s.account, "work");
  assert.equal(s.state, "walled");
  assert.equal(s.wakeupAt, null);
  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "pending");
  assert.equal(rec.owner, null, "nothing was claimed");
});

test("no codex credential ever reaches a tmux command line", async (t) => {
  const w = await codexWorld(t);
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);

  // The credential exists and is readable — this is not vacuous.
  const { readCodexAuth } = await import("../src/providers/codex-probe.ts");
  assert.equal(readCodexAuth(path.join(w.msHome, "codex", "home"))?.accessToken, "cat-home-SECRET");
  // tmux command strings are readable by anything that can talk to the server,
  // and the launch row is world-readable to anything that can read the store.
  assert.doesNotMatch(readFileSync(w.log, "utf8"), /SECRET|auth\.json/);
  assert.doesNotMatch(JSON.stringify(launchOf(w, respawnLaunchId(w))), /SECRET/);
  // The whole of the credential's path into the CLI is CODEX_HOME, set by
  // `_exec` inside the pane — never an argument, never an env recorded here.
  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.env, {});
});

test("a pass-through prompt is never re-submitted beside the codex continuation", async (t) => {
  // `ms codex -- --model gpt-5 "finish the docs"` records all three as the
  // session's flags, and a relaunch re-applies them: two positionals on one
  // `codex resume` line, one of which is a turn the human asked for once.
  const w = await codexWorld(t, { session: { flags: ["--model", "gpt-5", "finish the docs"] } });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  assert.deepEqual(launchOf(w, respawnLaunchId(w))!.command, ["codex", "resume", "cx-1", CONTINUATION, "--model", "gpt-5"]);
});

test("a codex account nobody has logged into is skipped for the next one", async (t) => {
  // The Codex credential is a directory, not a token: `auth.json` inside that
  // account's own CODEX_HOME. An account without one cannot authenticate, and
  // respawning the pane onto it would trade a walled CLI for a refused one.
  const w = await codexWorld(t, { noAuth: ["home"] });
  const stop = reportOnRespawn(w, { generation: 3, cliSessionId: "cx-1" });
  t.after(stop);

  assert.equal(await recoverSession("s1"), 0);
  assert.equal(session(w).account, "spare", "the chooser's first pick had no credential; the next one took it");
  assert.deepEqual(
    rows(w, "attempts").map((a) => [a.account, a.outcome]),
    [["home", "auth"], ["work", "exhausted"]],
  );
  assert.match(String(rows(w, "attempts")[0].note), /no codex credential \(run: ms accounts login home --provider codex\)/);
  assert.ok(!existsSync(configToml(w, "home")), "and a home with no credential is not written into either");
});

test("with no codex account left to launch, the refusal names the verb that logs one in", async (t) => {
  const w = await codexWorld(t, { noAuth: ["home", "spare"] });

  assert.equal(await recoverSession("s1"), 1);

  assert.match(recoverLog(w), /no candidate codex account can be launched \(run: ms accounts login <name> --provider codex\)/);
  assert.ok(!logLines(w).some((l) => l.includes("send-keys")), "nothing was touched: the pane still holds the conversation");
  assert.ok(!respawnLine(w));
  const rec = rows(w, "recoveries")[0];
  assert.equal(rec.status, "pending", "still owed to whoever comes next");
  assert.equal(rec.owner, null);
  // Nothing was disturbed, so one more worker is sent in case a login lands.
  assert.match(logLines(w).find((l) => l.includes("run-shell")) ?? "", /_recover' 's1'/);
});
