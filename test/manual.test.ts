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
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tempHome, stubDir } from "./helpers.ts";
import { appendEvent } from "../src/events.ts";
import { openState, type SessionRow } from "../src/state.ts";
import { rotateVerb, stopVerb, switchVerb } from "../src/manual.ts";

const CONTINUATION =
  "Continue the unfinished work from this conversation. Check the latest tool results and the current state of the files before retrying any action whose outcome is uncertain. Do not repeat completed actions.";

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

type UsageRow = { session: number; weekly: number };
type World = { home: string; msHome: string; log: string; state: string; screen: string; snap: string; pid: number; cwd: string };

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
  panes?: string;
  /** What the stub server answers `serverIdentity` with. */
  identity?: string;
  /** Copy the store the moment the stub is first asked to send keys. */
  snapshot?: boolean;
  /** Bring the pane back alive under this pid once the CLI has left. */
  revivePid?: number;
  /** Park the session with a wake-up already scheduled. */
  wakeup?: boolean;
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
  process.env.MS_POLL_MS = "20";
  process.env.MS_READY_MS = "10000";
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
const logLines = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim());
const respawnLine = (w: World): string | undefined => logLines(w).find((l) => l.includes("respawn-pane"));
const typedAnything = (w: World): boolean => logLines(w).some((l) => l.includes("send-keys"));

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
function reportOnRespawn(w: World, generation = 3): () => void {
  const timer = setInterval(() => {
    if (!respawnLine(w)) return;
    clearInterval(timer);
    appendEvent({ t: nowSeconds(), kind: "resumed", session: "s1", generation, cliSessionId: "c-1" });
  }, 10);
  return () => clearInterval(timer);
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
});

test("rotate refuses a busy pane that shows no wall, and forces past it with --force", async (t) => {
  const w = await world(t, { screen: BUSY_SCREEN });

  assert.equal(await rotateVerb(["s1"]), 1);
  assert.ok(!typedAnything(w), "a mid-turn pane is never typed into");
  assert.equal(session(w).account, "dirk");

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
  assert.ok(!typedAnything(w));
  assert.ok(!respawnLine(w));
  assert.equal(session(w).state, "running");
});

test("switch to an account nobody registered is refused before the pane is touched", async (t) => {
  const w = await world(t, { screen: IDLE_SCREEN });
  const say = stderr(t);

  assert.equal(await switchVerb(["s1", "--to", "nobody"]), 1);
  assert.match(say(), /no such claude account 'nobody'/);
  assert.ok(!typedAnything(w));
  assert.ok(!respawnLine(w));
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
  assert.ok(at("remain-on-exit off") > at("respawn-pane"), "the pane is still the tool's after it was handed back");
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
