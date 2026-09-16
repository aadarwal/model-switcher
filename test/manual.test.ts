// The manual verbs (spec §4, §9): `ms rotate`, `ms switch`, `ms stop`.
//
// Same harness as test/recover.test.ts — a bash `tmux` on PATH that keeps one
// pane's state in a temp file — with three additions the manual verbs need:
//
//   * `display-message` now answers TWO questions. `paneInfo` asks for
//     `#{pane_pid}…`; `serverIdentity` asks for `#{pid}:#{start_time}`, which
//     is what `%N` resolution compares against a session's `serverStart`.
//   * `MS_TMUX_SNAP` copies the store (main + WAL) the moment the stub is first
//     asked to send keys, so "the intent is written before anything reaches the
//     pane" is an ordering the test reads off the database as it was AT that
//     instant, rather than inferring it afterwards. A snapshot, not a gate:
//     every tmux call is a synchronous `spawnSync`, so a stub that blocked
//     would block the very event loop that has to release it.
//   * `MS_TMUX_REVIVE` brings the pane back alive (under a different pid) one
//     `paneInfo` call after the CLI leaves — tmux's own pane-died hook getting
//     to the respawn first, which `ms stop` must not do twice.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { hostname } from "node:os";
import path from "node:path";
import { tempHome, stubDir } from "./helpers.ts";
import { appendEvent } from "../src/events.ts";
import { openState, type SessionRow } from "../src/state.ts";
import { rotateVerb, stopVerb, switchAll, switchVerb } from "../src/manual.ts";
import { HANDOFF_SLOTS } from "../src/recover.ts";

const CONTINUATION =
  "Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions. If the last user message was already answered, or needs nothing more, say so in one line and wait for the user; do not start new work.";

const MS_BIN = path.resolve("bin/ms");
const PANE = "%7";
const SOCKET = "/tmp/ms-manual-test.sock";
const IDENTITY = "1:2";
const SHELL = "/bin/bash";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const ORIGINAL_PATH = process.env.PATH ?? "";
const HOUR = 3_600_000;

const TMUX_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
if [ -n "$MS_TMUX_FAIL" ] && [ "$1" = "$MS_TMUX_FAIL" ]; then exit 1; fi
st="$MS_TMUX_STATE"
get() { grep "^$1=" "$st" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { printf '%s=%s\n' "$1" "$2" >> "$st"; }
case "$1" in
  list-panes) get panes ;;
  display-message)
    case "$*" in
      *pane_pid*)
        if [ -n "$MS_TMUX_REVIVE" ] && [ "$(get exited)" = "1" ]; then
          n=$(get dm)
          if [ -z "$n" ]; then n=0; fi
          n=$(( n + 1 )); put dm "$n"
          if [ "$n" -ge 2 ]; then put pane_dead 0; put pane_pid "$MS_TMUX_REVIVE"; fi
        fi
        printf '%s\t%s\t%s\t%s\n' "$(get pane_pid)" "$(get command)" "$(get pane_dead)" "$(get cwd)" ;;
      *pane_dead_status*) get pane_dead_status ;;
      *pane_dead*) get pane_dead ;;
      *) get identity ;;
    esac ;;
  capture-pane) cat "$MS_TMUX_SCREEN" 2>/dev/null ;;
  send-keys)
    if [ -n "$MS_TMUX_SNAP" ] && [ ! -d "$MS_TMUX_SNAP" ]; then
      mkdir -p "$MS_TMUX_SNAP"
      cp "$MS_HOME/state.sqlite" "$MS_TMUX_SNAP/state.sqlite" 2>/dev/null
      cp "$MS_HOME/state.sqlite-wal" "$MS_TMUX_SNAP/state.sqlite-wal" 2>/dev/null
    fi
    case "$*" in */exit*) put pane_dead 1; put exited 1 ;; esac ;;
  respawn-pane) put pane_dead 0 ;;
esac
exit 0`;

const IDLE_SCREEN = ["❯ ship it", "", "  Done.", "", "❯ ", ""].join("\n");
const WALLED_SCREEN = ["❯ ship it", "", "⎿  You've hit your usage limit. Your limit will reset at 9pm.", "", "❯ ", ""].join("\n");
const BUSY_SCREEN = ["❯ ship it", "", "  Composing… (esc to interrupt)", ""].join("\n");
/** A wall UNDER a spinner the TUI never cleared: the turn ended at the wall. */
const WALLED_BUSY_SCREEN = [
  "❯ ship it",
  "",
  "⎿  You've hit your usage limit. Your limit will reset at 9pm.",
  "",
  "  Composing… (esc to interrupt)",
  "",
].join("\n");

type UsageRow = { session: number; weekly: number };
type World = { home: string; msHome: string; log: string; state: string; screen: string; snap: string; pid: number; cwd: string };

/** A pid that is certainly not running: a child we already waited for. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(r.status, 0);
  return r.pid as number;
}

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
          session: { usedPercent: r.session, resetsAt: new Date(now + HOUR).toISOString() },
          weeklyAll: { usedPercent: r.weekly, resetsAt: new Date(now + 6 * HOUR).toISOString() },
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
  work: { session: 20, weekly: 35 },
};

type WorldOptions = {
  screen?: string;
  session?: Partial<SessionRow>;
  /** Open a pending recovery for the session (default: no). */
  recovery?: boolean;
  /** Append a `rate_limited` event for the current generation (default: no). */
  wall?: boolean;
  /** Has the conversation ever had a turn? Default yes: a pane the human has
   * worked in has a transcript, which is what `--resume` needs to exist. */
  activity?: boolean;
  /** Did the tool watch this CLI session id begin? Default yes. */
  born?: boolean;
  panes?: string;
  /** What the stub server answers `serverIdentity` with. */
  identity?: string;
  /** Copy the store the moment the stub is first asked to send keys. */
  snapshot?: boolean;
  /** Bring the pane back alive under this pid once the CLI has left. */
  revivePid?: number;
  /** Park the session with a wake-up already scheduled. */
  wakeup?: boolean;
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
  const snap = path.join(dir, "snap");
  const pid = liveProcess(t);
  const cwd = home;

  writeFileSync(log, "");
  writeFileSync(screen, opts.screen ?? WALLED_SCREEN);
  writeFileSync(
    state,
    [
      `panes=${opts.panes ?? PANE}`,
      `pane_pid=${pid}`,
      "command=claude",
      "pane_dead=0",
      `cwd=${cwd}`,
      `identity=${opts.identity ?? IDENTITY}`,
      "",
    ].join("\n"),
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
  process.env.MS_TMUX_SNAP = opts.snapshot ? snap : "";
  process.env.MS_TMUX_REVIVE = opts.revivePid ? String(opts.revivePid) : "";
  process.env.MS_TMUX_FAIL = opts.failOn ?? "";
  process.env.MS_POLL_MS = "20";
  process.env.MS_READY_MS = "10000";
  process.env.MS_SETTLE_MS = "";
  process.env.MS_LOCK_WAIT_MS = "";
  process.env.SHELL = SHELL;
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  // The verbs read both; a real tmux around the test runner must not answer
  // for the stub one, and "no argument" is only a pane when we say it is.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  for (const name of ["dirk", "gmail", "work"]) saveLaunchToken(name, `sk-ant-oat01-${name}0123456789abcdefghij`);
  writeSnapshot(msHome, DEFAULT_USAGE);

  const st = openState();
  try {
    st.createSession({
      id: "s1",
      provider: "claude",
      cliSessionId: "c-1",
      cwd,
      socket: SOCKET,
      pane: PANE,
      serverStart: IDENTITY,
      need: "any",
      account: "dirk",
      generation: 2,
      state: "running",
      desired: "running",
      flags: ["--model", "sonnet"],
      ...opts.session,
    });
    // The conversation's birth, as the first launch's SessionStart hook
    // reported it: an id the tool never watched begin may be resumed but never
    // created (`--session-id` would make a new, empty one under a bogus id).
    if (opts.born !== false) appendEvent({ t: nowSeconds() - 60, kind: "started", session: "s1", generation: 1, cliSessionId: "c-1" });
    if (opts.activity !== false) appendEvent({ t: nowSeconds() - 20, kind: "activity", session: "s1", generation: 2, cliSessionId: "c-1" });
    if (opts.wall) appendEvent({ t: nowSeconds() - 10, kind: "rate_limited", session: "s1", generation: 2, cliSessionId: "c-1", kindDetail: "session" });
    if (opts.recovery) st.addRecovery({ sessionId: "s1", generation: 2, turnId: null, kind: "session" });
    if (opts.wakeup) st.setWakeup("s1", nowSeconds() + 3600);
  } finally {
    st.close();
  }
  return { home, msHome, log, state, screen, snap, pid, cwd };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const rx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const logLines = (w: { log: string }): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim());
const respawnLine = (w: World): string | undefined => logLines(w).find((l) => l.includes("respawn-pane"));
const typedAnything = (w: World): boolean => logLines(w).some((l) => l.includes("send-keys"));
const recoverLog = (w: World): string => {
  try {
    return readFileSync(path.join(w.msHome, "sessions", "s1", "recover.log"), "utf8");
  } catch {
    return "";
  }
};

function session(w: World): SessionRow {
  const st = openState();
  try {
    return st.getSession("s1")!;
  } finally {
    st.close();
  }
}

function rowsIn(file: string, table: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}
const rows = (w: World, table: "recoveries" | "attempts"): Record<string, unknown>[] => rowsIn(path.join(w.msHome, "state.sqlite"), table);
/** The store as it was when the stub was first asked to send keys. */
const snapRows = (w: World, table: "sessions" | "recoveries"): Record<string, unknown>[] => {
  assert.ok(existsSync(path.join(w.snap, "state.sqlite")), "the stub never snapshotted the store");
  return rowsIn(path.join(w.snap, "state.sqlite"), table);
};

function launchOf(id: string) {
  const st = openState();
  try {
    return st.getLaunch(id);
  } finally {
    st.close();
  }
}

const respawnLaunchId = (w: World): string => {
  const m = respawnLine(w)?.match(new RegExp(`_exec' '(${UUID.source})'`));
  assert.ok(m, `no respawn with a launch id in:\n${logLines(w).join("\n")}`);
  return m![1];
};

/** Stand in for Claude Code's SessionStart hook: report the resume the
 *  recovery waits for, as soon as the pane has been respawned. */
function reportOnRespawn(w: World, generation = 3, kind: "resumed" | "started" = "resumed"): () => void {
  const timer = setInterval(() => {
    if (!respawnLine(w)) return;
    clearInterval(timer);
    appendEvent({ t: nowSeconds(), kind, session: "s1", generation, cliSessionId: "c-1" });
  }, 10);
  return () => clearInterval(timer);
}

/** Poll for something another async path is expected to do. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(what);
}

/** Everything the verbs print, so a success line can be asserted verbatim. */
function stderr(t: TestContext): () => string {
  let out = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });
  return () => out;
}

// --- rotate ------------------------------------------------------------

test("rotate hands a walled pane to the next account and continues the work", async (t) => {
  const w = await world(t, { wall: true, recovery: true, session: { state: "walled" } });
  const say = stderr(t);
  const stop = reportOnRespawn(w);
  t.after(stop);

  assert.equal(await rotateVerb(["s1"]), 0);

  const s = session(w);
  assert.equal(s.account, "gmail");
  assert.equal(s.generation, 3);
  assert.equal(s.state, "continuing", "a manual rotate carries the unfinished work over");
  const launch = launchOf(respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--resume", "c-1", CONTINUATION, "--model", "sonnet"]);
  assert.match(say(), /^ms: s1 rotated → gmail$/m);
  // The log says who asked for the move. A wall kind belongs to an automatic
  // recovery; on a manual one it is at best redundant and at worst invented.
  assert.match(recoverLog(w), /handing dirk → gmail \(manual\)/);
  assert.match(recoverLog(w), /s1: dirk → gmail \(manual, generation 3\)/);
  assert.doesNotMatch(recoverLog(w), /wall\)/);
});


test("rotate is the human's intent: an old wall followed by activity does not make it obsolete", async (t) => {
  // The automatic worker stands down when the session went on working after
  // the wall (spec §9 races). A manual move must not: the human is asking for
  // it now, whatever the generation's log says about an earlier wall.
  const w = await world(t, { wall: true, recovery: true, session: { state: "walled" } });
  appendEvent({ t: nowSeconds() - 5, kind: "activity", session: "s1", generation: 2, cliSessionId: "c-1" });
  const say = stderr(t);
  const stop = reportOnRespawn(w);
  t.after(stop);

  assert.equal(await rotateVerb(["s1"]), 0, say());

  const s = session(w);
  assert.equal(s.generation, 3, "the manual move went ahead");
  assert.equal(s.account, "gmail");
  assert.doesNotMatch(say(), /obsolete/);
});
test("rotate takes over at once from a worker that was killed mid-handoff", async (t) => {
  // Task 20's case 9: `kill -9` on the worker after its respawn line. The row
  // is still `owned` by a pid that is gone, the session still reads `resuming`,
  // and reconciliation's lock sweep has already freed the lock it died holding.
  // The human's verb must adopt that recovery now, not be refused for the ten
  // minutes an age bound used to hold it.
  const w = await world(t, { wall: true, recovery: true, session: { state: "resuming" } });
  const say = stderr(t);
  const st = openState();
  try {
    assert.ok(st.ownRecovery(st.pendingRecovery("s1")!.id, `${deadPid()}@${hostname()}`));
  } finally {
    st.close();
  }
  const stop = reportOnRespawn(w);
  t.after(stop);

  const started = Date.now();
  assert.equal(await rotateVerb(["s1"]), 0);
  assert.ok(Date.now() - started < 10_000, "the human waited for a worker that no longer exists");
  assert.doesNotMatch(say(), /already owned/);
  assert.match(say(), /^ms: s1 rotated → gmail$/m);
  assert.equal(session(w).account, "gmail");
  assert.equal(rows(w, "recoveries")[0].status, "done");
});

test("a rotate that fails leaves nothing behind for an automatic worker to pick up", async (t) => {
  // The human asked, and every candidate turned out to be unlaunchable. What
  // the transaction must NOT leave is an ownerless `pending` recovery:
  // reconciliation's orphan rule dispatches one of those 45 seconds later as an
  // AUTOMATIC rotation — a different account, chosen by the chooser, and a
  // continuation the human never asked for — long after they read the refusal.
  const w = await world(t, { wall: true, recovery: true, session: { state: "walled" } });
  for (const name of ["gmail", "work"]) rmSync(path.join(w.msHome, "launch", `${name}.token`));
  const say = stderr(t);

  assert.equal(await rotateVerb(["s1"]), 1);

  assert.deepEqual(
    rows(w, "recoveries").filter((r) => r.status === "pending" || r.status === "owned"),
    [],
    "no open recovery row survives a manual move that failed",
  );
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
  assert.equal(session(w).wakeupAt, null, "and nothing is timed to come back for it either");
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")), "no worker is dispatched behind the human's back");
  assert.ok(!typedAnything(w), "and the pane was never touched");
  assert.equal(session(w).account, "dirk");
  // The refusal is the whole of what the human got — and it names the verb that
  // actually mints a launch token, which is `login`, not `add`.
  assert.match(say(), /no candidate account has a launch token \(run: ms accounts login <name>\)/);
});

test("rotate refuses a busy pane that shows no wall, and forces past it with --force", async (t) => {
  const w = await world(t, { screen: BUSY_SCREEN });
  const say = stderr(t);

  assert.equal(await rotateVerb(["s1"]), 1);
  assert.match(say(), /^ms rotate: s1 is mid-turn/m, "the verb refuses in its own name, before the transaction starts");
  assert.ok(!typedAnything(w), "a mid-turn pane is never typed into");
  assert.equal(session(w).account, "dirk");
  assert.equal(rows(w, "recoveries").length, 0, "a refused rotate opens no recovery");

  const stop = reportOnRespawn(w);
  t.after(stop);
  assert.equal(await rotateVerb(["s1", "--force"]), 0);
  assert.equal(session(w).account, "gmail");
});

// --- switch ------------------------------------------------------------

test("switch --to on an idle pane relaunches on that account without a continuation", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const say = stderr(t);
  const stop = reportOnRespawn(w);
  t.after(stop);

  assert.equal(await switchVerb(["s1", "--to", "gmail"]), 0);

  const s = session(w);
  assert.equal(s.account, "gmail");
  assert.equal(s.state, "running", "no continuation means the session is merely running");
  const launch = launchOf(respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--resume", "c-1", "--model", "sonnet"]);
  assert.ok(!launch.command.includes(CONTINUATION), "a finished conversation is not told to continue");
  assert.match(say(), /^ms: s1 switched → gmail$/m);
  // Live matrix case 4: this move used to be logged "(unknown wall)" — the
  // placeholder kind of the recovery row a manual verb opens, printed as though
  // a wall nobody could name had happened. The human named the account.
  assert.match(recoverLog(w), /handing dirk → gmail \(manual, --to gmail\)/);
  assert.match(recoverLog(w), /s1: dirk → gmail \(manual, --to gmail, generation 3\)/);
  assert.doesNotMatch(recoverLog(w), /unknown wall/);
});

test("switch on a pane that has never had a turn starts it under the same id", async (t) => {
  // The pane the human opened and did not type into. `--resume` on an id with
  // no transcript exits 1 ("No conversation found with session ID"), so the
  // switch would have handed them a dead pane on the new account.
  const w = await world(t, { screen: IDLE_SCREEN, activity: false });
  const stop = reportOnRespawn(w, 3, "started");
  t.after(stop);

  assert.equal(await switchVerb(["s1", "--to", "gmail", "--continue"]), 0);

  const launch = launchOf(respawnLaunchId(w))!;
  assert.deepEqual(launch.command, ["claude", "--session-id", "c-1", "--model", "sonnet"]);
  assert.ok(!launch.command.includes(CONTINUATION), "--continue has nothing to continue in a conversation with no turns");
  assert.equal(session(w).account, "gmail");
  assert.equal(session(w).state, "running");
});

test("switch --continue asks the resumed session to carry on", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const stop = reportOnRespawn(w);
  t.after(stop);

  assert.equal(await switchVerb(["s1", "--to", "work", "--continue"]), 0);
  assert.ok(launchOf(respawnLaunchId(w))!.command.includes(CONTINUATION));
});

test("switch off a walled screen carries the unfinished work over without being asked", async (t) => {
  const w = await world(t, { screen: WALLED_SCREEN });
  const stop = reportOnRespawn(w);
  t.after(stop);

  assert.equal(await switchVerb(["s1", "--to", "work"]), 0);
  assert.ok(launchOf(respawnLaunchId(w))!.command.includes(CONTINUATION), "a wall on screen means there is work to carry over");
  assert.equal(session(w).state, "continuing");
});

test("switch refuses a busy pane and does nothing; --force proceeds", async (t) => {
  const w = await world(t, { screen: BUSY_SCREEN });
  const say = stderr(t);

  assert.equal(await switchVerb(["s1", "--to", "work"]), 1);
  assert.ok(!typedAnything(w), "a mid-turn pane is never typed into");
  assert.ok(!respawnLine(w));
  assert.equal(session(w).account, "dirk");
  assert.equal(session(w).state, "running", "a refused switch leaves the session exactly as it was");
  assert.equal(rows(w, "recoveries").length, 0, "a refused switch opens no recovery");
  assert.match(say(), /mid-turn/);

  const stop = reportOnRespawn(w);
  t.after(stop);
  assert.equal(await switchVerb(["s1", "--to", "work", "--force"]), 0);
  assert.equal(session(w).account, "work");
});

test("switch to the account the session is already on is refused", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const say = stderr(t);

  assert.equal(await switchVerb(["s1", "--to", "dirk"]), 1);
  assert.match(say(), /already on dirk/);
  assert.deepEqual(logLines(w), [], "tmux was never even asked a question");
  assert.equal(session(w).state, "running");
});

test("switch to an account nobody registered is refused before the pane is touched", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const say = stderr(t);

  assert.equal(await switchVerb(["s1", "--to", "nobody"]), 1);
  assert.match(say(), /no such claude account 'nobody'/);
  // Not "no keys were sent": no tmux command of any kind was run, which is the
  // only version of "before the pane is touched" that cannot rot.
  assert.deepEqual(logLines(w), [], "tmux was never even asked a question");
});

test("switch will not move a session on a registry it cannot read", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, registry: "{ this is not json" });
  const say = stderr(t);

  assert.equal(await switchVerb(["s1", "--to", "gmail"]), 1);
  assert.match(say(), /cannot read the registry/);
  assert.deepEqual(logLines(w), [], "an unreadable registry is answered without asking tmux anything");
  assert.equal(session(w).account, "dirk");
});

test("a wall on screen means the turn ended there, so neither verb calls the pane busy", async (t) => {
  const w = await world(t, { screen: WALLED_BUSY_SCREEN });
  const stop = reportOnRespawn(w);
  t.after(stop);

  // The spinner is still drawn above the wall; the turn is over all the same.
  assert.equal(await switchVerb(["s1", "--to", "gmail"]), 0);
  assert.equal(session(w).account, "gmail");
  assert.equal(session(w).state, "continuing", "the unfinished work carries over");

  const w2 = await world(t, { screen: WALLED_BUSY_SCREEN, wall: true, recovery: true });
  const stop2 = reportOnRespawn(w2);
  t.after(stop2);
  assert.equal(await rotateVerb(["s1"]), 0, "rotate reads the same screen the same way");
});

// --- stop --------------------------------------------------------------

test("stop records the intent before anything reaches the pane, then gives the pane back to a shell", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, recovery: true, wakeup: true, snapshot: true });
  const say = stderr(t);

  assert.equal(await stopVerb(["s1"]), 0);

  // The store as it stood at the first keystroke: the intent was already
  // written, so a racing recovery (and the pane-died hook) reads a pane that is
  // on its way out on purpose, whatever happens to the CLI next.
  const mid = snapRows(w, "sessions")[0]!;
  assert.equal(mid.desired, "stopped", "the intent is recorded before anything reaches the pane");
  assert.equal(mid.state, "stopping", "…and the state says it is on its way out");
  assert.equal(mid.wakeupAt, null, "a session that is ending is not woken up later");
  assert.equal(snapRows(w, "recoveries")[0]!.status, "obsolete", "a pending recovery for a stopping session is obsolete");
  const s = session(w);
  assert.equal(s.state, "stopped");
  assert.equal(s.desired, "stopped");

  const lines = logLines(w);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at("send-keys -t %7 Escape") >= 0, "no Escape");
  assert.ok(at("send-keys -t %7 /exit Enter") > at("send-keys -t %7 Escape"), "no /exit after Escape");
  const respawn = respawnLine(w);
  assert.ok(respawn, "the pane was never given back");
  assert.match(respawn!, new RegExp(`respawn-pane -k -c ${rx(w.cwd)} -t %7 '${SHELL}' '-l'$`), "the login shell was not respawned in the session's cwd");
  assert.ok(at("remain-on-exit off") >= 0, "the pane was never released");
  assert.ok(
    at("remain-on-exit off") < at("respawn-pane"),
    "remain-on-exit must go off BEFORE the shell goes in: left on, the human's own exit leaves a dead pane nothing will ever close",
  );
  assert.match(say(), /^ms: s1 stopped$/m);
});

test("stop does not respawn a pane something else already brought back", async (t) => {
  const revived = liveProcess(t);
  const w = await world(t, { screen: IDLE_SCREEN, revivePid: revived });
  const say = stderr(t);

  const started = Date.now();
  assert.equal(await stopVerb(["s1"]), 0);
  assert.ok(logLines(w).some((l) => l.includes("send-keys -t %7 /exit Enter")), "the CLI was never asked to leave");
  assert.ok(!respawnLine(w), "the pane-died hook got there first; a second respawn would kill the shell it just made");
  assert.equal(session(w).state, "stopped");
  // A new process in a live pane is an ANSWER, not a pane we are still waiting
  // on: the verb must recognise it and finish, not sit out its whole budget.
  assert.match(say(), /^ms: s1 stopped$/m, "a revived pane is an ordinary ending, not a stubborn one");
  assert.ok(Date.now() - started < 5_000, "stop waited for a pane that had already come back");
  assert.ok(
    logLines(w).some((l) => l.includes("remain-on-exit off")),
    "the pane stayed the tool's: exiting that shell would leave a dead pane and re-fire the pane-died hook",
  );
});

test("a pane that will not die is not recorded as stopped", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  // The pane comes back alive under the SAME pid: the CLI outlived /exit,
  // SIGTERM and SIGKILL, so there is nothing honest to call this but unfinished.
  process.env.MS_TMUX_REVIVE = String(w.pid);
  process.env.MS_SETTLE_MS = "200";
  const say = stderr(t);

  assert.equal(await stopVerb(["s1"]), 1);
  assert.match(say(), /did not exit/);
  const s = session(w);
  assert.equal(s.desired, "stopped", "the human's intent stands");
  assert.equal(s.state, "stopping", "…and the state says the stop never finished");
  assert.ok(!respawnLine(w), "nothing was handed back over a live CLI");
  assert.ok(!logLines(w).some((l) => l.includes("remain-on-exit off")), "the pane is still the tool's");
});

test("a second stop never types into the login shell the first one handed back", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const say = stderr(t);

  assert.equal(await stopVerb(["s1"]), 0);
  assert.ok(respawnLine(w), "the first stop handed the pane back");
  writeFileSync(w.log, ""); // everything from here on is the second stop's doing

  assert.equal(await stopVerb(["s1"]), 0, "a stop that has nothing to do is not a failure");
  assert.match(say(), /^ms: s1 already stopped$/m);
  assert.deepEqual(logLines(w), [], "tmux was never asked to touch the human's shell");
});

test("a retried stop finishes the CLI a worker put back, rather than calling it already stopped", async (t) => {
  // What the first `ms stop` leaves when it loses the lock to a live worker:
  // the intent is written, and the worker then completes its handoff and
  // overwrites `stopping` with a state of its own. The pane holds a fresh CLI
  // on a new account — and nothing but this retry will ever stop it, because
  // the hook ignores walls once `desired` is not `running` and reconciliation
  // only acts on dead panes.
  const w = await world(t, { screen: IDLE_SCREEN, session: { desired: "stopped", state: "resuming" } });
  const say = stderr(t);

  assert.equal(await stopVerb(["s1"]), 0);

  assert.doesNotMatch(say(), /already stopped/, "a live CLI is not an ended session");
  assert.ok(logLines(w).some((l) => l.includes("send-keys -t %7 /exit Enter")), "the CLI in the pane was never asked to leave");
  assert.ok(respawnLine(w), "and the pane was never given back");
  assert.equal(session(w).state, "stopped");
  assert.match(say(), /^ms: s1 stopped$/m);
});

test("stop stands down while a recovery holds the session, and leaves the intent written", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, recovery: true, wakeup: true });
  const say = stderr(t);
  process.env.MS_LOCK_WAIT_MS = "300";
  const { acquire } = await import("../src/lock.ts");
  const { sessionLockName } = await import("../src/recover.ts");
  const release = acquire(sessionLockName("s1"));
  assert.ok(release, "the test could not take the lock it means to hold");
  t.after(() => release?.());

  assert.equal(await stopVerb(["s1"]), 1);
  assert.match(say(), /a recovery is in progress .*; retry/);
  assert.ok(!typedAnything(w), "nothing reaches a pane another worker is inside");
  assert.ok(!respawnLine(w));

  // The intent is what a worker rechecks, so it is written even though the
  // destructive half never ran — and the session stays retryable.
  const s = session(w);
  assert.equal(s.desired, "stopped");
  assert.equal(s.state, "stopping");
  assert.equal(s.wakeupAt, null);
  assert.equal(rows(w, "recoveries")[0].status, "obsolete");
});

test("stop ends the CLI that is in the pane NOW, not the one that was there when it asked", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const { acquire } = await import("../src/lock.ts");
  const { sessionLockName } = await import("../src/recover.ts");
  const release = acquire(sessionLockName("s1"));
  assert.ok(release, "the test could not take the lock it means to hold");

  const done = stopVerb(["s1"]);
  await until(() => session(w).state === "stopping", "the intent was never written while the lock was held");
  assert.ok(!typedAnything(w), "the destructive half waits for the lock");

  // While we hold it, the worker finishes a handoff: a new generation, in a
  // different pane. A `stop` acting on its stale row would type into %7.
  const st = openState();
  try {
    st.updateSession("s1", { pane: "%9", generation: 3, account: "gmail", state: "continuing" });
  } finally {
    st.close();
  }
  writeFileSync(w.state, `panes=%9\npane_pid=${w.pid}\ncommand=claude\npane_dead=0\ncwd=${w.cwd}\nidentity=${IDENTITY}\n`);
  release!();

  assert.equal(await done, 0);
  assert.ok(logLines(w).some((l) => l.includes("send-keys -t %9 /exit Enter")), "the CLI asked to leave was the stale one");
  assert.ok(!logLines(w).some((l) => l.includes("-t %7")), "a pane the session had already left was touched");
  assert.equal(session(w).state, "stopped");
});

test("stop says so when tmux will not give the pane back, and still records the session stopped", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, failOn: "respawn-pane" });
  const say = stderr(t);

  assert.equal(await stopVerb(["s1"]), 0, "the CLI left; only the courtesy shell failed");
  assert.match(say(), /could not be given back to a shell/);
  assert.equal(session(w).state, "stopped");
});

test("stop on a pane that is already gone touches nothing and still marks the session stopped", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, panes: "" });
  const say = stderr(t);

  assert.equal(await stopVerb(["s1"]), 0);
  assert.ok(!typedAnything(w));
  assert.ok(!respawnLine(w));
  assert.equal(session(w).state, "stopped");
  assert.match(say(), /already gone/);
});

test("a stopped session refuses a later rotation", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, wall: true, recovery: true });
  assert.equal(await stopVerb(["s1"]), 0);

  assert.equal(await rotateVerb(["s1"]), 1, "a session on its way out is not rotated");
  assert.ok(!logLines(w).some((l) => l.includes("_exec")), "nothing was launched back into the pane the human took back");
});

// --- resolving a session -----------------------------------------------

test("a %pane on the caller's own tmux server resolves to its session", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const say = stderr(t);
  const stop = reportOnRespawn(w);
  t.after(stop);

  assert.equal(await switchVerb(["%7", "--to", "gmail"]), 0);
  assert.equal(session(w).account, "gmail");
  assert.match(say(), /^ms: s1 switched → gmail$/m);
});

test("a %pane on a different tmux server is refused by name", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN, identity: "9:9" });
  const say = stderr(t);

  assert.equal(await switchVerb(["%7", "--to", "gmail"]), 1);
  assert.match(say(), /%7/, "the refusal names the pane the human asked for");
  assert.ok(!typedAnything(w));
  assert.ok(!respawnLine(w));
  assert.equal(session(w).account, "dirk");
});

test("after a tmux restart no verb touches the pane the session remembers", async (t) => {
  // tmux restarts its numbering at %0, so the session's %7 is now a stranger's
  // pane — and `paneExists` says yes about it.
  const w = await world(t, { screen: IDLE_SCREEN, identity: "9:9", wall: true, recovery: true });
  const say = stderr(t);

  assert.equal(await rotateVerb(["s1"]), 1);
  assert.equal(await switchVerb(["s1", "--to", "gmail"]), 1);
  assert.equal(await stopVerb(["s1"]), 1);

  const lines = say().split("\n").filter((l) => l.startsWith("ms "));
  assert.equal(lines.length, 3, `each verb said one thing: ${JSON.stringify(lines)}`);
  for (const verb of ["rotate", "switch", "stop"]) {
    assert.match(say(), new RegExp(`^ms ${verb}: tmux server restarted; the pane id is stale \\(ms status shows it gone\\)$`, "m"));
  }
  assert.ok(!typedAnything(w), "a stranger's pane is never typed into");
  assert.ok(!respawnLine(w));
  const s = session(w);
  assert.equal(s.account, "dirk");
  assert.equal(s.state, "running", "stop did not even record an intent against a pane that is not ours");
  assert.equal(s.desired, "running");
});

test("inside tmux, no argument means the caller's own pane", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const say = stderr(t);
  process.env.TMUX = `${SOCKET},1,0`;
  process.env.TMUX_PANE = PANE;
  t.after(() => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  // The refusal is the proof: it names s1, so the bare pane resolved to it.
  assert.equal(await switchVerb(["--to", "dirk"]), 1);
  assert.match(say(), /s1 is already on dirk/);
});

test("a session id nobody knows is refused", async (t) => {
  const w = await world(t);
  const say = stderr(t);

  assert.equal(await rotateVerb(["nope"]), 1);
  assert.match(say(), /no such session nope/);
  assert.ok(!typedAnything(w));
});

// --- the command line --------------------------------------------------

test("usage errors exit 2", async (t) => {
  const w = await world(t);
  const say = stderr(t);

  assert.equal(await switchVerb(["s1"]), 2, "switch without --to");
  assert.equal(await switchVerb(["s1", "--to"]), 2, "--to without an account");
  assert.equal(await switchVerb(["s1", "--to", "--force"]), 2, "a forgotten account name, not an account called --force");
  assert.equal(await rotateVerb(["s1", "--frobnicate"]), 2, "an option nobody defined");
  assert.equal(await rotateVerb(["s1", "--to", "gmail"]), 2, "rotate does not choose the account");
  assert.equal(await stopVerb(["s1", "--force"]), 2, "stop takes no options");
  assert.equal(await stopVerb(["s1", "s2"]), 2, "one session at a time");
  assert.equal(await rotateVerb([]), 2, "outside tmux there is no pane to mean");
  assert.match(say(), /usage: ms rotate/);
  assert.ok(!typedAnything(w), "a command line that did not parse never reaches the pane");
});

test("rotate, switch and stop are registered verbs", async (t) => {
  const w = await world(t);
  const { run } = await import("./helpers.ts");
  for (const verb of ["rotate", "switch", "stop"]) {
    const r = run([verb], { HOME: w.home, MS_HOME: w.msHome });
    assert.doesNotMatch(r.stderr, /unknown verb/, `ms ${verb} is not registered`);
    assert.equal(r.code, 2, `ms ${verb} with no argument is a usage error`);
    assert.match(r.stderr, new RegExp(`usage: ms ${verb}`));
  }
});

// --- the fleet: ms switch --all ----------------------------------------
//
// A second world, because everything above is one session in one pane and a
// fleet move is the opposite: several panes, each with its own screen and its
// own life. The stub tmux therefore keys its pane state BY PANE (`dead%3`,
// `pid%3`) and reads each pane's screen from its own file, so one session's
// `/exit` cannot be read as another's — the single-pane stub above would have
// made every concurrent handoff answer for whichever pane wrote last.

const FLEET_SOCKET = "/tmp/ms-fleet-test.sock";

const FLEET_STUB = String.raw`printf '%s\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
st="$MS_TMUX_STATE"
pane=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-t" ]; then pane="$a"; fi
  prev="$a"
done
get() { grep "^$1=" "$st" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { printf '%s=%s\n' "$1" "$2" >> "$st"; }
# The one fault a test can inject from OUTSIDE the process: take the store's
# permissions away while a fleet move is under way, so the sessions still
# queued behind this pane throw where they open it.
if [ -n "$MS_TMUX_BREAK_DB" ] && [ "$pane" = "$MS_TMUX_BREAK_DB" ]; then chmod 000 "$MS_HOME/state.sqlite"; fi
case "$1" in
  list-panes) get panes | tr ' ' '\n' ;;
  display-message)
    case "$*" in
      *pane_pid*) printf '%s\t%s\t%s\t%s\n' "$(get "pid$pane")" claude "$(get "dead$pane")" "$(get cwd)" ;;
      *pane_dead_status*) printf '\n' ;;
      *pane_dead*) get "dead$pane" ;;
      *) get identity ;;
    esac ;;
  capture-pane) cat "$MS_TMUX_SCREENS/$pane" 2>/dev/null ;;
  send-keys) case "$*" in */exit*) put "dead$pane" 1 ;; esac ;;
  respawn-pane) put "dead$pane" 0 ;;
esac
exit 0`;

type FleetSession = {
  id: string;
  pane: string;
  account: string;
  provider?: "claude" | "codex";
  screen?: string;
  state?: SessionRow["state"];
  desired?: SessionRow["desired"];
};
type Fleet = { home: string; msHome: string; log: string; state: string; screens: string; cwd: string; sessions: FleetSession[] };

/** Four sessions on two accounts, and three that are not the fleet at all:
 *  `ms switch --all --to home` moves s1–s3 and must leave the rest alone.
 *  s4 is already home, s5 is not a claude session, s6 is over, and s7 has
 *  been told to stop. */
const FLEET: FleetSession[] = [
  { id: "s1", pane: "%1", account: "away" },
  { id: "s2", pane: "%2", account: "away" },
  { id: "s3", pane: "%3", account: "away" },
  { id: "s4", pane: "%4", account: "home" },
  { id: "s5", pane: "%5", account: "cdx", provider: "codex" },
  { id: "s6", pane: "%6", account: "away", state: "stopped" },
  { id: "s7", pane: "%7", account: "away", state: "stopping", desired: "stopped" },
];

/** N claude sessions, all on `away`, for the tests that only count handoffs. */
const fleetSessions = (n: number): FleetSession[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, pane: `%${i + 1}`, account: "away" }));

async function fleet(t: TestContext, sessions: FleetSession[]): Promise<Fleet> {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  stub("tmux", FLEET_STUB);
  const log = path.join(dir, "tmux.log");
  const state = path.join(dir, "tmux.state");
  const screens = path.join(dir, "screens");
  mkdirSync(screens, { recursive: true });
  const pid = liveProcess(t);
  const cwd = home;

  writeFileSync(log, "");
  writeFileSync(
    state,
    [
      `panes=${sessions.map((s) => s.pane).join(" ")}`,
      ...sessions.map((s) => `pid${s.pane}=${pid}`),
      ...sessions.map((s) => `dead${s.pane}=0`),
      `cwd=${cwd}`,
      `identity=${IDENTITY}`,
      "",
    ].join("\n"),
  );
  for (const s of sessions) writeFileSync(path.join(screens, s.pane), s.screen ?? IDLE_SCREEN);
  writeFileSync(
    path.join(msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { name: "home", provider: "claude", label: "home", shared: false },
        { name: "away", provider: "claude", label: "away", shared: false },
        { name: "cdx", provider: "codex", label: "cdx", shared: false },
      ],
    }),
    { mode: 0o600 },
  );

  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.MS_BIN = MS_BIN;
  process.env.MS_TMUX_LOG = log;
  process.env.MS_TMUX_STATE = state;
  process.env.MS_TMUX_SCREENS = screens;
  process.env.MS_TMUX_SCREEN = "";
  process.env.MS_TMUX_SNAP = "";
  process.env.MS_TMUX_REVIVE = "";
  process.env.MS_TMUX_FAIL = "";
  process.env.MS_TMUX_BREAK_DB = "";
  process.env.MS_POLL_MS = "20";
  // Wider than the single-pane world's: a barrier-held reporter may sit on a
  // respawned pane for up to five seconds before it opens the gate, and that
  // must stay comfortably inside the readiness budget it is eating into.
  process.env.MS_READY_MS = "20000";
  process.env.MS_SETTLE_MS = "";
  process.env.MS_LOCK_WAIT_MS = "";
  process.env.SHELL = SHELL;
  process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  for (const name of ["home", "away"]) saveLaunchToken(name, `sk-ant-oat01-${name}0123456789abcdefghij`);
  writeSnapshot(msHome, { home: { session: 10, weekly: 20 }, away: { session: 100, weekly: 40 } });

  const st = openState();
  try {
    for (const s of sessions) {
      st.createSession({
        id: s.id,
        provider: s.provider ?? "claude",
        cliSessionId: `c-${s.id}`,
        cwd,
        socket: FLEET_SOCKET,
        pane: s.pane,
        serverStart: IDENTITY,
        need: "any",
        account: s.account,
        generation: 2,
        state: s.state ?? "running",
        desired: s.desired ?? "running",
        flags: [],
      });
    }
  } finally {
    st.close();
  }
  // Distinct creation times: candidate order is the store's `ORDER BY
  // createdAt`, and four rows written in the same second would leave the
  // order this asserts to the sorter rather than to the rule.
  const db = new DatabaseSync(path.join(msHome, "state.sqlite"));
  try {
    sessions.forEach((s, i) => db.prepare("UPDATE sessions SET createdAt=? WHERE id=?").run(1_700_000_000 + i, s.id));
  } finally {
    db.close();
  }
  for (const s of sessions) {
    appendEvent({ t: nowSeconds() - 60, kind: "started", session: s.id, generation: 1, cliSessionId: `c-${s.id}` });
    appendEvent({ t: nowSeconds() - 20, kind: "activity", session: s.id, generation: 2, cliSessionId: `c-${s.id}` });
  }
  return { home, msHome, log, state, screens, cwd, sessions };
}

/** One session row by id — the fleet tests watch several at once. */
function row(id: string): SessionRow {
  const st = openState();
  try {
    return st.getSession(id)!;
  } finally {
    st.close();
  }
}

type FleetReporter = { stop: () => void; peak: () => number };

/**
 * Claude Code's SessionStart hook for a whole fleet: report each pane's resume
 * as soon as the stub tmux shows that pane respawned.
 *
 * `barrier` is what makes concurrency observable. Held back, a respawned pane
 * cannot finish its handoff — readiness is this report and nothing else — so
 * the number of panes waiting at once IS the number of handoffs in flight, and
 * `peak()` is the high-water mark. The reporter opens the gate once that many
 * are waiting (or once 3 s pass with nothing new respawning, so a pool that is
 * too SMALL fails the assertion instead of hanging the test).
 *
 * `reverse` then releases them one at a time, newest first, which is how the
 * fleet finishes in a different order than it started.
 */
function reportFleet(w: Fleet, opts: { barrier?: number; reverse?: boolean } = {}): FleetReporter {
  const paneOf = new Map(w.sessions.map((s) => [s.pane, s.id]));
  const pending = new Map<string, string>();
  const done = new Set<string>();
  let peak = 0;
  let armed = !opts.barrier;
  let lastNew = Date.now();
  let tick = 0;
  const release = (pane: string, id: string): void => {
    appendEvent({ t: nowSeconds(), kind: "resumed", session: id, generation: 3, cliSessionId: `c-${id}` });
    pending.delete(pane);
    done.add(pane);
  };
  const timer = setInterval(() => {
    tick++;
    for (const line of logLines(w)) {
      if (!line.includes("respawn-pane")) continue;
      const m = line.match(/ -t (%\d+) /);
      const pane = m?.[1];
      if (!pane || done.has(pane) || pending.has(pane) || !paneOf.has(pane)) continue;
      pending.set(pane, paneOf.get(pane)!);
      lastNew = Date.now();
    }
    peak = Math.max(peak, pending.size);
    // The escape hatch never fires before a single pane has respawned: under a
    // loaded machine the first handoff can take seconds, and a gate that opened
    // on that silence would measure a pool that had not started yet.
    if (!armed && (pending.size >= opts.barrier! || (pending.size > 0 && Date.now() - lastNew > 5_000))) armed = true;
    if (!armed) return;
    if (opts.reverse) {
      // One per five ticks (~75 ms), newest first: far enough apart that the
      // 20 ms readiness polls cannot reorder them.
      if (tick % 5) return;
      const last = [...pending].at(-1);
      if (last) release(last[0], last[1]);
      return;
    }
    for (const [pane, id] of [...pending]) release(pane, id);
  }, 15);
  return { stop: () => clearInterval(timer), peak: () => peak };
}

test("switch --all moves every session that is not already on the account", async (t) => {
  const w = await fleet(t, FLEET);
  const say = stderr(t);
  const rep = reportFleet(w);
  t.after(rep.stop);

  assert.equal(await switchVerb(["--all", "--to", "home"]), 0, say());

  for (const id of ["s1", "s2", "s3"]) {
    assert.equal(row(id).account, "home", `${id} did not move`);
    assert.equal(row(id).generation, 3);
    assert.equal(row(id).state, "running", "an idle screen carries nothing over unless asked");
    assert.match(say(), new RegExp(`^ms: ${id} moved → home$`, "m"));
  }
  const s4 = row("s4");
  assert.equal(s4.generation, 2, "the session already on home was not touched");
  assert.ok(!logLines(w).some((l) => l.includes("-t %4")), "…and its pane was never even asked a question");
  const s5 = row("s5");
  assert.deepEqual([s5.account, s5.generation], ["cdx", 2], "a codex session is not part of a claude account's fleet");
  assert.ok(!logLines(w).some((l) => l.includes("-t %5")));
  // A session that is over, and one the human has already told to leave, are
  // not the fleet either: moving them would fail for a reason that has nothing
  // to do with accounts, and s6's pane is not even the tool's any more.
  assert.equal(row("s6").generation, 2, "a stopped session was dragged into the fleet move");
  assert.equal(row("s7").generation, 2, "a session on its way out was dragged into the fleet move");
  for (const pane of ["%6", "%7"]) assert.ok(!logLines(w).some((l) => l.includes(`-t ${pane}`)), `${pane} was touched`);
  assert.match(say(), /^ms: moved 3, refused 0$/m);
  assert.doesNotMatch(say(), /refused:/);
});

test("switch --all refuses the session that is mid-turn and moves the rest", async (t) => {
  const w = await fleet(t, [
    { id: "s1", pane: "%1", account: "away" },
    { id: "s2", pane: "%2", account: "away", screen: BUSY_SCREEN },
    { id: "s3", pane: "%3", account: "away" },
  ]);
  const say = stderr(t);
  const rep = reportFleet(w);
  t.after(rep.stop);

  assert.equal(await switchVerb(["--all", "--to", "home"]), 1, "one refusal fails the fleet move");

  assert.equal(row("s1").account, "home");
  assert.equal(row("s3").account, "home");
  assert.equal(row("s2").account, "away", "a mid-turn session is left exactly where it was");
  assert.ok(!logLines(w).some((l) => l.includes("send-keys -t %2")), "a mid-turn pane is never typed into");
  assert.match(say(), /^ms: s2 refused: s2 is mid-turn/m);
  assert.match(say(), /^ms: moved 2, refused 1$/m);

  // And the deliberate override moves the one that was left — the two that
  // already arrived are no longer candidates at all.
  assert.equal(await switchVerb(["--all", "--to", "home", "--force"]), 0, say());
  assert.equal(row("s2").account, "home");
  assert.equal(row("s1").generation, 3, "a session already on the account is not moved twice");
  assert.match(say(), /^ms: moved 1, refused 0$/m);
});

test("switch --all --continue carries every session's unfinished work over", async (t) => {
  const w = await fleet(t, fleetSessions(2));
  const rep = reportFleet(w);
  t.after(rep.stop);

  assert.equal(await switchVerb(["--all", "--to", "home", "--continue"]), 0);
  assert.equal(row("s1").state, "continuing");
  assert.equal(row("s2").state, "continuing");
});

test("a fleet move never runs more handoffs at once than there are handoff slots", async (t) => {
  const w = await fleet(t, fleetSessions(6));
  const say = stderr(t);
  const rep = reportFleet(w, { barrier: HANDOFF_SLOTS });
  t.after(rep.stop);

  assert.equal(await switchVerb(["--all", "--to", "home"]), 0, say());

  assert.equal(rep.peak(), HANDOFF_SLOTS, "the pool did not fill, or overflowed, the handoff slots");
  assert.match(say(), /^ms: moved 6, refused 0$/m);
  for (const s of w.sessions) assert.equal(row(s.id).account, "home");
  // The slots are a counting bound the transaction itself enforces: a worker
  // that finds none free re-dispatches itself through tmux. The pool exists so
  // that never happens — a fleet move that queued in tmux would finish minutes
  // later, under the automatic worker's rules rather than the human's.
  assert.ok(!logLines(w).some((l) => l.includes("run-shell")), "a handoff was pushed back into tmux");
});

test("switchAll reports every candidate in the store's order, as each one finishes", async (t) => {
  const w = await fleet(t, FLEET);
  const rep = reportFleet(w, { barrier: 3, reverse: true });
  t.after(rep.stop);

  const finished: string[] = [];
  const { results, code } = await switchAll("home", {
    force: false,
    continueAfter: "auto",
    timeoutMs: 60_000,
    onResult: (r) => finished.push(r.session),
  });

  assert.equal(code, 0);
  assert.deepEqual(finished, ["s3", "s2", "s1"], "the caller hears about each session as it completes");
  assert.deepEqual(
    results.map((r) => r.session),
    ["s1", "s2", "s3"],
    "…and the results keep candidate order, whatever order they finished in",
  );
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0]);
});

test("switch --all --timeout 0 moves nothing and says so", async (t) => {
  const w = await fleet(t, FLEET);
  const say = stderr(t);

  assert.equal(await switchVerb(["--all", "--to", "home", "--timeout", "0"]), 1);

  assert.deepEqual(logLines(w), [], "no pane was even asked a question");
  for (const id of ["s1", "s2", "s3"]) {
    assert.equal(row(id).account, "away");
    assert.match(say(), new RegExp(`^ms: ${id} refused: not started: the 0ms budget ran out$`, "m"));
  }
  assert.match(say(), /^ms: moved 0, refused 3$/m);
});

test("--all needs an account, takes no session, and only it takes --timeout", async (t) => {
  const w = await fleet(t, FLEET);
  const say = stderr(t);

  assert.equal(await switchVerb(["--all"]), 2, "--all without --to");
  assert.equal(await switchVerb(["--all", "s1", "--to", "home"]), 2, "--all and one session are different commands");
  assert.equal(await switchVerb(["s1", "--to", "home", "--timeout", "5"]), 2, "--timeout bounds a fleet move");
  assert.equal(await switchVerb(["--all", "--to", "home", "--timeout", "soon"]), 2, "a timeout that is not a number of seconds");
  assert.equal(await switchVerb(["--all", "--to", "home", "--timeout"]), 2, "a forgotten timeout");
  assert.match(say(), /usage: ms switch/);
  assert.deepEqual(logLines(w), [], "a command line that did not parse never reaches a pane");
  assert.equal(row("s1").account, "away");
});

test("switch --all to an account nobody registered is refused without touching a pane", async (t) => {
  const w = await fleet(t, FLEET);
  const say = stderr(t);

  assert.equal(await switchVerb(["--all", "--to", "nobody"]), 1);
  assert.match(say(), /no such account 'nobody'/);
  assert.deepEqual(logLines(w), []);
  assert.equal(row("s1").account, "away");
});

test("--all refuses an account name two providers both claim", async (t) => {
  // Which sessions the fleet IS depends on the destination's provider, so a
  // name with two of them has no answer here — and guessing would move a whole
  // claude fleet on a codex typo.
  const w = await fleet(t, FLEET);
  writeFileSync(
    path.join(w.msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: ["claude", "codex"].map((provider) => ({ name: "home", provider, label: "home", shared: false })),
    }),
    { mode: 0o600 },
  );
  const say = stderr(t);

  assert.equal(await switchVerb(["--all", "--to", "home"]), 1);
  assert.match(say(), /cannot tell which fleet you mean/);
  assert.deepEqual(logLines(w), [], "nothing was asked of tmux, let alone moved");
  assert.equal(row("s1").account, "away");
});

test("the library refuses that name too, in the same words the verb prints", async (t) => {
  // The verb is not the only caller. The dashboard's POST /api/switch-all calls
  // `switchAll` directly, and `findAccount` with no provider returns the FIRST
  // name match — so a guard that lived only in the verb would let the whole
  // claude fleet move on a codex typo, from the same registry the CLI refuses.
  const w = await fleet(t, FLEET);
  writeFileSync(
    path.join(w.msHome, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: ["claude", "codex"].map((provider) => ({ name: "home", provider, label: "home", shared: false })),
    }),
    { mode: 0o600 },
  );
  const say = stderr(t);

  const { results, code, message } = await switchAll("home", { force: false, continueAfter: "auto", timeoutMs: 60_000 });

  assert.equal(code, 1);
  assert.deepEqual(results, [], "the library moved nothing and started nothing");
  assert.match(message ?? "", /cannot tell which fleet you mean/);
  assert.deepEqual(logLines(w), [], "nothing was asked of tmux, let alone moved");
  assert.equal(row("s1").account, "away");

  // …and the refusal the verb prints is that message, once, with no summary
  // under it: a move that never started has nothing to summarise.
  assert.equal(await switchVerb(["--all", "--to", "home"]), 1);
  assert.deepEqual(say().split("\n").filter(Boolean), [`ms switch: ${message}`]);
});

test("a switchOne that throws is that session's refusal, never the fleet's", async (t) => {
  // `openState` is the one call in `switchOne` that is outside every guard the
  // transaction has — the store either opens or it throws — so a store it
  // cannot open is how a real throw reaches the pool. Left to reject, that
  // throw takes `Promise.all` with it: the summary never prints, every
  // sibling's result is lost with it, and the workers still running keep
  // driving handoffs while the process unwinds.
  const w = await fleet(t, fleetSessions(3));
  // The first pane's own tmux call takes the store away, which is after s1 has
  // resolved itself and before s2 and s3 resolve theirs.
  process.env.MS_TMUX_BREAK_DB = "%1";
  const say = stderr(t);

  const code = await switchVerb(["--all", "--to", "home"]);
  chmodSync(path.join(w.msHome, "state.sqlite"), 0o600);

  assert.equal(code, 1);
  for (const id of ["s1", "s2", "s3"]) {
    assert.match(say(), new RegExp(`^ms: ${id} refused: \\S`, "m"), `${id}'s result went missing`);
  }
  for (const id of ["s2", "s3"]) {
    assert.match(say(), new RegExp(`^ms: ${id} refused: .*(EACCES|permission denied)`, "m"), `${id} did not carry the throw's own reason`);
  }
  assert.match(say(), /^ms: moved 0, refused 3$/m, "the summary is what a caught throw keeps");
  assert.equal(row("s1").account, "away");
});

test("a refusal from the transaction itself is reported once, by whoever asked", async (t) => {
  // `recoverSession` has already said why — on stderr, and in the session's own
  // log — by the time it returns non-zero. The single-session verb therefore
  // adds nothing to it (byte-identical to before fix-R), and the fleet line
  // now carries the transaction's OWN reason (fix-R, fix-C-report.md item 2)
  // instead of a generic "the reason is above" pointer — on the dashboard,
  // where the transaction's stderr is captured and discarded, "above" would
  // point at nothing.
  const w = await fleet(t, fleetSessions(1));
  rmSync(path.join(w.msHome, "launch", "home.token"));
  const say = stderr(t);

  assert.equal(await switchVerb(["s1", "--to", "home"]), 1);
  assert.match(say(), /^ms _recover: no candidate account has a launch token/m);
  assert.deepEqual(
    say().split("\n").filter((l) => l.startsWith("ms switch:")),
    [],
    "the verb repeated a reason the transaction had already given",
  );

  assert.equal(await switchVerb(["--all", "--to", "home"]), 1);
  // The same words `ms _recover:` used, not the old boilerplate ("the
  // handoff did not happen…") that pointed at a reason the reader had to go
  // find elsewhere.
  assert.match(say(), /^ms: s1 refused: no candidate account has a launch token \(run: ms accounts login <name>\)$/m);
  assert.ok(
    !say().includes("the handoff did not happen"),
    "the fleet refusal line carries the reason itself, not a pointer to it",
  );
  assert.match(say(), /^ms: moved 0, refused 1$/m);
  assert.equal(row("s1").account, "away", "a session whose handoff failed is left where it was");
});
