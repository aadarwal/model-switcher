import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";
import { acquire, lockedBy } from "../src/lock.ts";
import { openState, type SessionRow } from "../src/state.ts";
import { appendEvent, readEvents } from "../src/events.ts";
import { paneDied, reconcile, sessionLockName } from "../src/reconcile.ts";
import { main, registerVerb } from "../src/cli.ts";

/** Captured once: every world() prepends a stub dir, and PATH must not grow. */
const ORIG_PATH = process.env.PATH ?? "";
const IDENTITY = "4242:1789000000";
const SOCK = "/tmp/ms-t18-socket";
const MS_BIN = "/opt/ms/bin/ms";
const SHELL = "/bin/testsh";

/**
 * tmux, as far as reconciliation and the pane-died hook drive it. It logs
 * every argv line and keeps ONE piece of real state: whether a pane is dead.
 * `respawn-pane` makes its pane live again, exactly as tmux does — which is
 * what makes the "twice for one death" test mean anything.
 *
 * Every failure mode the repairs must tell apart is switchable:
 * `MS_TMUX_NO_SERVER` (the identity query fails), an empty `MS_TMUX_IDENTITY`
 * (it answers nothing), and `MS_TMUX_LIST_FAILS` (list-panes fails). Panes are
 * alive unless a test says otherwise (`MS_TMUX_PANE_DEAD=1`): a corpse is an
 * event, and a fixture that leaves every pane dead by accident tests nothing.
 */
const TMUX_STUB = `printf '%s\\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
verb="$1"
pane=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-t" ]; then pane="$a"; fi
  prev="$a"
done
deadfile="\${MS_TMUX_STATE}/dead\${pane}"
case "$verb" in
  display-message)
    if [ "\${MS_TMUX_NO_SERVER:-0}" = "1" ]; then echo "no server running" >&2; exit 1; fi
    if [ -f "$deadfile" ]; then d=$(cat "$deadfile"); else d="\${MS_TMUX_PANE_DEAD:-0}"; fi
    case "$*" in
      *"#{pane_pid}"*) printf '%s\\t%s\\t%s\\t%s\\t%s\\n' 4242 claude "$d" /tmp/work "\${MS_TMUX_DEAD_STATUS:-0}" ;;
      *"#{pane_dead_status}"*) if [ "\${MS_TMUX_STATUS_SPLIT:-0}" = "1" ]; then echo ""; else echo "\${MS_TMUX_DEAD_STATUS:-0}"; fi ;;
      *"#{pane_dead}"*) echo "$d" ;;
      *) echo "\${MS_TMUX_IDENTITY}" ;;
    esac ;;
  list-panes)
    if [ "\${MS_TMUX_LIST_FAILS:-0}" = "1" ]; then echo "no server on socket" >&2; exit 1; fi
    printf '%s\\n' \${MS_TMUX_PANES} ;;
  respawn-pane) echo 0 > "$deadfile" ;;
  run-shell) if [ -n "\${MS_TMUX_ON_RUNSHELL}" ]; then eval "\$MS_TMUX_ON_RUNSHELL"; fi ;;
esac
exit 0`;

type World = { home: string; msHome: string; log: string };

function world(): World {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(dir, "tmux.log");
  const state = path.join(dir, "tmux-state");
  mkdirSync(state, { recursive: true });
  stub("tmux", TMUX_STUB);
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.PATH = `${dir}:${ORIG_PATH}`;
  process.env.MS_TMUX_LOG = log;
  process.env.MS_TMUX_STATE = state;
  process.env.MS_TMUX_IDENTITY = IDENTITY;
  process.env.MS_TMUX_PANES = "%7";
  process.env.MS_BIN = MS_BIN;
  process.env.SHELL = SHELL;
  delete process.env.MS_TMUX_NO_SERVER;
  delete process.env.MS_TMUX_LIST_FAILS;
  delete process.env.MS_TMUX_PANE_DEAD;
  delete process.env.MS_TMUX_DEAD_STATUS;
  delete process.env.MS_TMUX_STATUS_SPLIT;
  delete process.env.MS_TMUX_ON_RUNSHELL;
  delete process.env.MS_VERBOSE;
  return { home, msHome, log };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const tmuxLines = (w: World): string[] =>
  existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim()) : [];
const respawns = (w: World): string[] => tmuxLines(w).filter((l) => l.includes("respawn-pane"));
const dispatches = (w: World): string[] => tmuxLines(w).filter((l) => l.includes("_recover"));

const base: Omit<SessionRow, "id" | "wakeupAt" | "createdAt" | "updatedAt" | "transcriptPath" | "rolloutOffset"> = {
  provider: "claude", cliSessionId: "c1", cwd: "/tmp/work", socket: SOCK, pane: "%7",
  serverStart: IDENTITY, need: "any", account: "gmail", generation: 1,
  state: "running", desired: "running", flags: [],
};

/** Reach into the store as another process (or an older `ms`) would have left
 * it: State always stamps `updatedAt` from its own clock, so ageing a row is
 * the only way to test a "stuck for N minutes" rule without sleeping. */
function planted(msHome: string, sql: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(path.join(msHome, "state.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function plantLock(msHome: string, name: string, pid: number, since: number): void {
  const db = new DatabaseSync(path.join(msHome, "locks.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, since INTEGER NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO locks (name, pid, since) VALUES (?, ?, ?)").run(name, pid, since);
  } finally {
    db.close();
  }
}

/** A pid that is certainly not running: a child we already waited for. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(r.status, 0);
  return r.pid as number;
}

function withState<T>(fn: (st: ReturnType<typeof openState>) => T): T {
  const st = openState();
  try {
    return fn(st);
  } finally {
    st.close();
  }
}

const stateOf = (id: string): string => withState((st) => st.getSession(id)!.state);

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const orig = process.stderr.write;
  let err = "";
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, err };
  } finally {
    process.stderr.write = orig;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Hold SQLite's write lock on locks.sqlite from another process, so every
 * `acquire` in this one comes back Locked. Reuses lock.test.ts's own fixture. */
function holdLockDb(msHome: string, sync: string, holdMs: number): { child: ChildProcess; exit: Promise<number> } {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(HERE, "fixtures", "lock-busy-child.ts"), sync, String(holdMs)], {
    env: { ...process.env, MS_HOME: msHome },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return { child, exit: new Promise((resolve) => child.on("exit", (c) => resolve(c ?? -1))) };
}

async function waitForFile(file: string, boundMs: number): Promise<boolean> {
  const until = Date.now() + boundMs;
  while (Date.now() < until) {
    if (existsSync(file)) return true;
    await sleep(5);
  }
  return existsSync(file);
}

// --- (a) abandoned locks ------------------------------------------------

test("(a) a lock whose holder is dead is removed; a live holder's is left", () => {
  const w = world();
  plantLock(w.msHome, "session-s1", deadPid(), nowSec() - 5);
  plantLock(w.msHome, "handoffs", process.pid, nowSec() - 5);

  const repaired = reconcile();

  assert.ok(repaired.some((l) => l.includes("session-s1")), repaired.join("\n"));
  assert.equal(lockedBy("session-s1"), null, "the dead holder's row is gone");
  assert.equal(lockedBy("handoffs")!.pid, process.pid, "a live holder keeps its lock");
});

// --- serialisation with the recovery worker -----------------------------

test("the session lock name is exactly the one the recovery worker takes", async () => {
  const w = world();
  withState((st) => st.createSession({ id: "s1", ...base }));
  const held = acquire(sessionLockName("s1"));
  assert.ok(held, "nothing else holds it");
  try {
    const { recoverSession } = await import("../src/recover.ts");
    const { value } = await captureStderr(() => recoverSession("s1"));
    assert.equal(value, 1, "the worker refused because WE hold its lock");
    const log = readFileSync(path.join(w.msHome, "sessions", "s1", "recover.log"), "utf8");
    assert.match(log, /another recovery holds s1/);
  } finally {
    held!();
  }
});

test("a session a live worker holds is never repaired underneath it", () => {
  const w = world();
  withState((st) => {
    // Everything about this row invites a repair: its pane is gone, it has
    // been launching for an hour and a due wake-up is sitting on it.
    st.createSession({ id: "s1", ...base, state: "launching", pane: "%9" });
    st.setWakeup("s1", nowSec() - 60);
  });
  planted(w.msHome, "UPDATE sessions SET updatedAt=?", nowSec() - 3600);
  const held = acquire(sessionLockName("s1"));
  assert.ok(held);
  try {
    reconcile();
    withState((st) => {
      assert.equal(st.getSession("s1")!.state, "launching", "the worker's row is untouched");
      assert.ok(st.getSession("s1")!.wakeupAt! < nowSec(), "its wake-up is still there");
    });
    assert.deepEqual(dispatches(w), [], "and nothing was dispatched at it");
  } finally {
    held!();
  }
});

// --- (b) recoveries owned by a dead worker ------------------------------

test("(b) an owned recovery whose worker died goes back to pending and is re-dispatched", () => {
  const w = world();
  const dead = deadPid();
  withState((st) => {
    for (const id of ["s-dead", "s-live", "s-just-died", "s-elsewhere"]) st.createSession({ id, ...base });
    const owners: Record<string, string> = {
      "s-dead": `${dead}@${hostname()}`,
      "s-live": `${process.pid}@${hostname()}`,
      "s-just-died": `${dead}@${hostname()}`,
      "s-elsewhere": `${dead}@some-other-mac`,
    };
    for (const [sessionId, owner] of Object.entries(owners)) {
      const rec = st.addRecovery({ sessionId, generation: 1, turnId: null, kind: "session" });
      assert.ok(st.ownRecovery(rec, owner));
    }
  });
  // Every row but s-just-died's has been owned for eleven minutes; that one was
  // claimed a second ago by a worker somebody has since `kill -9`'d.
  planted(w.msHome, "UPDATE recoveries SET updatedAt=? WHERE sessionId<>'s-just-died'", nowSec() - 660);

  const repaired = reconcile();

  withState((st) => {
    const reclaimed = st.pendingRecovery("s-dead")!;
    assert.equal(reclaimed.status, "pending");
    assert.equal(reclaimed.owner, null);
    assert.equal(st.pendingRecovery("s-live")!.status, "owned", "a live owner is not disturbed");
    // A pid that is gone is gone: the kernel already said so and the worker's
    // own lock was swept in this same pass. Ten minutes of `owned` bought
    // nothing but ten minutes of refused manual verbs.
    const fresh = st.pendingRecovery("s-just-died")!;
    assert.equal(fresh.status, "pending", "a dead owner is reclaimable at once, whatever the row's age");
    assert.equal(fresh.owner, null);
    assert.equal(st.pendingRecovery("s-elsewhere")!.status, "owned", "another host's pid is not ours to judge");
  });
  assert.deepEqual(dispatches(w), [
    `-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's-dead'`,
    `-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's-just-died'`,
  ]);
  assert.ok(repaired.some((l) => l.includes("s-dead")), repaired.join("\n"));
});

test("(b) a recovery a fresh worker claimed between the scan and the lock is left alone", () => {
  const w = world();
  const dead = deadPid();
  withState((st) => {
    st.createSession({ id: "s1", ...base });
    const rec = st.addRecovery({ sessionId: "s1", generation: 1, turnId: null, kind: "session" });
    assert.ok(st.ownRecovery(rec, `${dead}@${hostname()}`));
  });
  planted(w.msHome, "UPDATE recoveries SET updatedAt=?", nowSec() - 660);
  // The compare-and-set is what protects the new owner; prove it by moving the
  // row exactly as a fresh worker would have, under the id we judged stale.
  const judged = withState((st) => st.pendingRecovery("s1")!);
  planted(w.msHome, "UPDATE recoveries SET owner=?, updatedAt=? WHERE id=?", `${process.pid}@${hostname()}`, nowSec() - 660, judged.id);

  reconcile();

  withState((st) => {
    const rec = st.pendingRecovery("s1")!;
    assert.equal(rec.status, "owned");
    assert.equal(rec.owner, `${process.pid}@${hostname()}`, "the live worker keeps its recovery");
  });
  assert.deepEqual(dispatches(w), [], "and nobody is sent to race it");
});

// --- (c) the pane, or the whole server, is gone -------------------------

test("(c) a session whose pane or tmux server is gone is stopped and its recovery obsoleted", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s-gone", ...base, pane: "%9" });
    st.createSession({ id: "s-restarted", ...base, serverStart: "1:1" });
    st.createSession({ id: "s-ok", ...base });
    st.addRecovery({ sessionId: "s-gone", generation: 1, turnId: null, kind: "unknown" });
    st.setWakeup("s-gone", nowSec() + 600);
  });

  const repaired = reconcile();

  withState((st) => {
    assert.equal(st.getSession("s-gone")!.state, "stopped");
    assert.equal(st.getSession("s-gone")!.wakeupAt, null, "the wake-up is cleared");
    assert.equal(st.pendingRecovery("s-gone"), null, "the pending recovery is obsolete");
    assert.equal(st.getSession("s-restarted")!.state, "stopped", "a different server identity is a different server");
    assert.equal(st.getSession("s-ok")!.state, "running");
  });
  assert.equal(repaired.filter((l) => l.includes("stopped")).length, 2, repaired.join("\n"));

  // A second run says nothing more: a stopped session is not repaired twice.
  assert.deepEqual(reconcile(), []);
});

// --- (4) absence must be confirmed, never assumed -----------------------

for (const [name, env] of [
  ["the identity query fails", { MS_TMUX_NO_SERVER: "1" }],
  ["the identity query answers nothing", { MS_TMUX_IDENTITY: "" }],
  ["list-panes fails", { MS_TMUX_LIST_FAILS: "1" }],
] as const) {
  test(`a session is never declared gone because ${name}`, () => {
    const w = world();
    Object.assign(process.env, env);
    withState((st) => {
      // Both of these WOULD be repaired if the probe had succeeded.
      st.createSession({ id: "s-here", ...base, state: "walled" });
      st.createSession({ id: "s-elsewhere", ...base, pane: "%9", state: "walled" });
      st.setWakeup("s-here", nowSec() + 600);
      st.addRecovery({ sessionId: "s-here", generation: 1, turnId: null, kind: "weekly" });
    });

    const repaired = reconcile();

    withState((st) => {
      for (const id of ["s-here", "s-elsewhere"]) assert.equal(st.getSession(id)!.state, "walled", id);
      assert.ok(st.getSession("s-here")!.wakeupAt, "a wake-up is not thrown away on a guess");
      assert.equal(st.pendingRecovery("s-here")!.status, "pending", "nor is a recovery obsoleted");
    });
    assert.ok(!repaired.some((l) => l.includes("stopped")), repaired.join("\n"));
    // Said once for the socket, not once per session on it.
    assert.equal(repaired.filter((l) => l.includes("could not")).length, 1, repaired.join("\n"));
  });
}

// --- (d) due wake-ups ---------------------------------------------------

test("(d) a due wake-up dispatches _recover and is cleared; a future one is left alone", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s-due", ...base, state: "waiting" });
    st.createSession({ id: "s-later", ...base, state: "waiting" });
    // Waiting for an account to reset, and the pane closed in the meantime:
    // (c) runs first precisely so this wake-up never wakes a worker for a
    // session that has nowhere to land.
    st.createSession({ id: "s-due-gone", ...base, state: "waiting", pane: "%9" });
    st.setWakeup("s-due", nowSec() - 5);
    st.setWakeup("s-later", nowSec() + 3600);
    st.setWakeup("s-due-gone", nowSec() - 5);
  });

  const repaired = reconcile();

  withState((st) => {
    assert.equal(st.getSession("s-due")!.wakeupAt, null);
    assert.ok(st.getSession("s-later")!.wakeupAt! > nowSec());
    assert.equal(st.getSession("s-due-gone")!.state, "stopped");
    assert.equal(st.getSession("s-due-gone")!.wakeupAt, null);
  });
  assert.deepEqual(dispatches(w), [`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's-due'`]);
  assert.ok(repaired.some((l) => l.includes("s-due")), repaired.join("\n"));
});

test("(d) a wake-up the dispatched worker replaces is not then cleared from under it", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s1", ...base, state: "waiting" });
    st.setWakeup("s1", nowSec() - 5);
  });
  // The real race, at the moment it really happens: the worker we dispatch is
  // running (here, the stub tmux stands in for it) by the time we get to the
  // clear, and it has already scheduled the NEXT wait. Clearing "the wake-up"
  // rather than "the deadline we consumed" would drop that retry on the floor.
  const later = nowSec() + 3600;
  const db = path.join(w.msHome, "state.sqlite");
  process.env.MS_TMUX_ON_RUNSHELL = `sqlite3 '${db}' "update sessions set wakeupAt=${later} where id='s1'"`;

  const repaired = reconcile();

  assert.deepEqual(dispatches(w), [`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's1'`]);
  withState((st) => assert.equal(st.getSession("s1")!.wakeupAt, later, "the worker's newer deadline survives"));
  assert.ok(repaired.some((l) => l.includes("newer deadline")), repaired.join("\n"));
});

// --- (5) a pending recovery nobody is coming for ------------------------

test("(d) a due wake-up stamps the recovery it dispatched for, so the next pass sends nobody", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s1", ...base, state: "waiting" });
    st.addRecovery({ sessionId: "s1", generation: 1, turnId: null, kind: "session" });
    st.setWakeup("s1", nowSec() - 5);
  });
  // The row has been pending, with a timer, since long before the dispatch
  // grace — which is the ordinary shape of a session waiting out a reset.
  planted(w.msHome, "UPDATE recoveries SET updatedAt=?", nowSec() - 600);

  reconcile(); // the wake-up is due: one worker
  reconcile(); // the wake-up is gone now, so rule (5) is what could fire here

  assert.deepEqual(dispatches(w), [`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's1'`], "exactly one worker for one deadline");
});

test("(5) an ownerless pending recovery with no timer is re-dispatched after the grace", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s-orphan", ...base, state: "parked" });
    st.createSession({ id: "s-scheduled", ...base, state: "waiting" });
    st.createSession({ id: "s-fresh", ...base, state: "walled" });
    for (const id of ["s-orphan", "s-scheduled", "s-fresh"]) {
      st.addRecovery({ sessionId: id, generation: 1, turnId: null, kind: "session" });
    }
    // A scheduled wait owns its own timing — rule (d) will dispatch it when it
    // comes due, and this must not jump the queue.
    st.setWakeup("s-scheduled", nowSec() + 3600);
  });
  planted(w.msHome, "UPDATE recoveries SET updatedAt=? WHERE sessionId<>'s-fresh'", nowSec() - 60);

  const repaired = reconcile();

  assert.deepEqual(dispatches(w), [`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's-orphan'`]);
  assert.ok(repaired.some((l) => l.includes("s-orphan")), repaired.join("\n"));
  withState((st) => {
    for (const id of ["s-orphan", "s-scheduled", "s-fresh"]) {
      assert.equal(st.pendingRecovery(id)!.status, "pending", id);
    }
  });
});


test("(5) a dispatched orphan is not dispatched again by the next invocation", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s1", ...base, state: "parked" });
    st.addRecovery({ sessionId: "s1", generation: 1, turnId: null, kind: "session" });
  });
  planted(w.msHome, "UPDATE recoveries SET updatedAt=?", nowSec() - 60);

  reconcile();
  reconcile();

  // The dispatch stamps the row, so the grace starts again and the worker on
  // its way is not raced by the next `ms status`. (It is also why the grace is
  // 45s and not 30: recover.ts's own no-slot path arms a `run-shell -d 30`
  // retry without a wake-up, and the two must not come due together.)
  assert.deepEqual(dispatches(w), [`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's1'`]);
  withState((st) => assert.ok(nowSec() - st.pendingRecovery("s1")!.updatedAt < 45));
});

test("(5) the dispatch grace outlasts the worker's own retry timer", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s1", ...base, state: "waiting" });
    st.addRecovery({ sessionId: "s1", generation: 1, turnId: null, kind: "session" });
  });
  // recover.ts asks tmux for a 30-second retry when every handoff slot is
  // taken, and records no wake-up for it. A row that age is a worker still on
  // its way, not an orphan.
  planted(w.msHome, "UPDATE recoveries SET updatedAt=?", nowSec() - 35);

  reconcile();

  assert.deepEqual(dispatches(w), []);
});

// --- (e)/(f) transitions that never completed ---------------------------

test("(e) resuming or continuing for over five minutes with no resumed event is parked", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s-stuck-resuming", ...base, state: "resuming", generation: 2 });
    st.createSession({ id: "s-stuck-continuing", ...base, state: "continuing", generation: 2 });
    st.createSession({ id: "s-resumed", ...base, state: "continuing", generation: 2 });
    st.createSession({ id: "s-restarted-id", ...base, state: "resuming", generation: 2 });
    st.createSession({ id: "s-recent", ...base, state: "resuming", generation: 2 });
  });
  appendEvent({ t: nowSec() - 400, kind: "resumed", session: "s-resumed", generation: 2, cliSessionId: "c1" });
  // A handoff of a conversation with no transcript relaunches it with
  // `--session-id`, and Claude Code reports that as a `startup`. The CLI is
  // back; parking it for reporting in the other word is a repair that is the
  // damage.
  appendEvent({ t: nowSec() - 400, kind: "started", session: "s-restarted-id", generation: 2, cliSessionId: "c1" });
  // A `resumed` from the generation BEFORE this one is not this handoff's.
  appendEvent({ t: nowSec() - 900, kind: "resumed", session: "s-stuck-continuing", generation: 1, cliSessionId: "c1" });
  planted(w.msHome, "UPDATE sessions SET updatedAt=? WHERE id<>'s-recent'", nowSec() - 400);

  const repaired = reconcile();

  assert.equal(stateOf("s-stuck-resuming"), "parked");
  assert.equal(stateOf("s-stuck-continuing"), "parked", "continuing is a handoff state too, and this one never landed");
  assert.equal(stateOf("s-resumed"), "continuing", "it did resume; it is just still working");
  assert.equal(stateOf("s-restarted-id"), "resuming", "a `started` for this generation is a CLI that came back");
  assert.equal(stateOf("s-recent"), "resuming", "five minutes have not passed");
  for (const id of ["s-stuck-resuming", "s-stuck-continuing"]) {
    assert.ok(repaired.some((l) => l.includes(id)), repaired.join("\n"));
    assert.match(readFileSync(path.join(w.msHome, "sessions", id, "recover.log"), "utf8"), /parked/);
  }
});

test("(f) launching for over five minutes with no started event is parked", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s-never", ...base, state: "launching" });
    st.createSession({ id: "s-started", ...base, state: "launching" });
  });
  appendEvent({ t: nowSec() - 400, kind: "started", session: "s-started", generation: 1, cliSessionId: "c1" });
  planted(w.msHome, "UPDATE sessions SET updatedAt=?", nowSec() - 400);

  const repaired = reconcile();

  assert.equal(stateOf("s-never"), "parked");
  assert.equal(stateOf("s-started"), "launching", "it did start; the hook will move it on");
  assert.ok(repaired.some((l) => l.includes("s-never")), repaired.join("\n"));
});

// --- (6) a handoff that was abandoned in `stopping` ---------------------

test("(6) a live handoff in stopping is left to its worker", () => {
  const w = world();
  withState((st) => {
    // Fresh: the worker wrote `stopping` seconds ago and is inside step 6.
    st.createSession({ id: "s-fresh", ...base, state: "stopping" });
    // Old, but its recovery is owned by a pid that is still running.
    st.createSession({ id: "s-owned", ...base, state: "stopping" });
    const rec = st.addRecovery({ sessionId: "s-owned", generation: 1, turnId: null, kind: "session" });
    assert.ok(st.ownRecovery(rec, `${process.pid}@${hostname()}`));
  });
  planted(w.msHome, "UPDATE sessions SET updatedAt=? WHERE id='s-owned'", nowSec() - 3600);

  reconcile();

  assert.equal(stateOf("s-fresh"), "stopping");
  assert.equal(stateOf("s-owned"), "stopping");
  assert.deepEqual(respawns(w), [], "nothing is put in a pane a handoff is using");
});

test("(6) an abandoned stopping session honours the stop the human asked for", () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1"; // the pane is a corpse: that is why we are here
  withState((st) => {
    st.createSession({ id: "s-stop", ...base, state: "stopping", desired: "stopped" });
    st.addRecovery({ sessionId: "s-stop", generation: 1, turnId: null, kind: "session" });
  });
  planted(w.msHome, "UPDATE sessions SET updatedAt=?", nowSec() - 3600);

  const repaired = reconcile();

  assert.equal(stateOf("s-stop"), "stopped");
  assert.deepEqual(respawns(w), [`-S ${SOCK} respawn-pane -k -c /tmp/work -t %7 '${SHELL}' '-l'`],
    "the pane comes back as a shell, which is what `ms stop` promised");
  withState((st) => assert.equal(st.pendingRecovery("s-stop"), null, "no worker may respawn claude into that shell"));
  assert.ok(repaired.some((l) => l.includes("s-stop")), repaired.join("\n"));
});

test("(6) an abandoned stopping session that was mid-rotation is parked, not stopped", () => {
  const w = world();
  withState((st) => st.createSession({ id: "s-mid", ...base, state: "stopping", generation: 2 }));
  planted(w.msHome, "UPDATE sessions SET updatedAt=?", nowSec() - 3600);

  reconcile();

  assert.equal(stateOf("s-mid"), "parked", "the human decides; a rotation that vanished is not a clean stop");
  assert.deepEqual(respawns(w), [], "the pane is left as it is");
  const last = readEvents("s-mid").at(-1)!;
  assert.equal(last.kind, "died");
  assert.equal(last.generation, 2);
});


// --- (h) a corpse nobody handled ----------------------------------------

test("(h) a dead pane the hook could not act on is settled by the next reconcile", async () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1";
  withState((st) => st.createSession({ id: "s1", ...base, state: "running" }));
  appendEvent({ t: nowSec() - 5, kind: "started", session: "s1", generation: 1, cliSessionId: "c1" });
  appendEvent({ t: nowSec(), kind: "ended", session: "s1", generation: 1, cliSessionId: "c1", kindDetail: "exit" });

  // tmux delivers `pane-died` exactly once, and this one lands while a worker
  // holds the session: the hook must decline, and then nothing else in the
  // system knows the pane is a corpse.
  const held = acquire(sessionLockName("s1"));
  assert.ok(held);
  try {
    assert.equal(await paneDied(["s1"]), 0);
  } finally {
    held!();
  }
  assert.deepEqual(respawns(w), [], "the hook declined, as it should have");
  assert.equal(stateOf("s1"), "running");

  const repaired = reconcile();

  assert.deepEqual(respawns(w), [`-S ${SOCK} respawn-pane -k -c /tmp/work -t %7 '${SHELL}' '-l'`],
    "the next invocation is the net the hook does not have");
  assert.equal(stateOf("s1"), "stopped");
  assert.ok(repaired.some((l) => l.includes("s1")), repaired.join("\n"));

  // And it is once-only for the same reason the hook is: the pane is alive now.
  assert.deepEqual(reconcile(), []);
  assert.equal(respawns(w).length, 1);
});

test("(h) a dead pane with no ended event is parked, and a live pane is left alone", () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1";
  withState((st) => {
    st.createSession({ id: "s-crashed", ...base, state: "running", generation: 2 });
    st.createSession({ id: "s-alive", ...base, state: "running" });
  });
  appendEvent({ t: nowSec() - 10, kind: "resumed", session: "s-crashed", generation: 2, cliSessionId: "c1" });
  appendEvent({ t: nowSec() - 10, kind: "started", session: "s-alive", generation: 1, cliSessionId: "c1" });
  // The stub answers per pane from a file; give s-alive a live one.
  writeFileSync(path.join(process.env.MS_TMUX_STATE!, "dead%7"), "1\n");

  const repaired = reconcile();

  assert.equal(stateOf("s-crashed"), "parked");
  const last = readEvents("s-crashed").at(-1)!;
  assert.equal(last.kind, "died");
  assert.equal(last.generation, 2);
  assert.deepEqual(respawns(w), [], "a crash leaves its pane for inspection");
  assert.ok(repaired.some((l) => l.includes("s-crashed")), repaired.join("\n"));
});

test("(h) a pane that is dead because a handoff is in flight is left to the worker", () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1";
  withState((st) => {
    // `ms _recover` step 6 has just asked the CLI to leave; between that and
    // its own respawn the pane IS a corpse, and it is not ours to settle.
    st.createSession({ id: "s1", ...base, state: "resuming", generation: 2 });
    const rec = st.addRecovery({ sessionId: "s1", generation: 2, turnId: null, kind: "session" });
    assert.ok(st.ownRecovery(rec, `${process.pid}@${hostname()}`));
  });
  // Past the `stopping` grace (120s) and short of the stuck rule (300s), so the
  // live owner is the ONLY thing standing between this corpse and a repair.
  planted(w.msHome, "UPDATE sessions SET updatedAt=?", nowSec() - 200);

  reconcile();

  assert.equal(stateOf("s1"), "resuming", "a live owner means a live handoff");
  assert.deepEqual(respawns(w), []);
  assert.ok(!readEvents("s1").some((e) => e.kind === "died"));
});

// --- ms _pane_died ------------------------------------------------------

test("_pane_died: a normal end respawns the login shell and stops the session", async () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1"; // the pane is a corpse: that is why we are here
  withState((st) => {
    st.createSession({ id: "s1", ...base });
    st.addRecovery({ sessionId: "s1", generation: 1, turnId: null, kind: "session" });
    st.setWakeup("s1", nowSec() + 600);
  });
  appendEvent({ t: nowSec() - 1, kind: "rate_limited", session: "s1", generation: 1, cliSessionId: "c1" });
  appendEvent({ t: nowSec(), kind: "ended", session: "s1", generation: 1, cliSessionId: "c1", kindDetail: "exit" });

  assert.equal(await paneDied(["s1"]), 0);

  assert.deepEqual(respawns(w), [`-S ${SOCK} respawn-pane -k -c /tmp/work -t %7 '${SHELL}' '-l'`]);
  // Spec §7: the pane returns to a prompt exactly as one that ran `claude`
  // would — which means it must also CLOSE when the human exits that prompt.
  // With remain-on-exit left on, their exit makes the pane dead again,
  // pane-died fires, finds a session already stopped and returns, and the
  // corpse sits there until it is killed by hand.
  const lines = tmuxLines(w);
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at("remain-on-exit off") >= 0, "the pane was handed back still owned by the tool");
  assert.ok(at("remain-on-exit off") < at("respawn-pane"), "the pane is released before the shell goes in");
  withState((st) => {
    assert.equal(st.getSession("s1")!.state, "stopped");
    assert.equal(st.getSession("s1")!.wakeupAt, null);
    assert.equal(st.pendingRecovery("s1"), null, "the pane is a shell now; no worker may respawn claude into it");
  });
  assert.ok(!readEvents("s1").some((e) => e.kind === "died"), "a normal end is not a death");

  // Once only: tmux delivered the callback twice, or a stale one arrived late.
  // The respawn made the pane live again, and a live pane is not a death.
  assert.equal(await paneDied(["s1"]), 0);
  assert.equal(respawns(w).length, 1, "exactly one forced respawn for one death");
});

test("_pane_died: no ended event for this generation appends died, parks, and leaves the pane", async () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1"; // the pane is a corpse: that is why we are here
  withState((st) => {
    st.createSession({ id: "s2", ...base, generation: 2 });
    st.createSession({ id: "s2b", ...base, generation: 2 });
  });
  // s2 is the handoff that crashed on arrival: generation 1 ended normally
  // (that `ended` is what `/exit` during the rotation wrote) and generation 2
  // died before its own SessionStart hook ever ran. The NEWEST event in the
  // file is therefore an `ended` belonging to a generation that is over —
  // reading it as this generation's would hand the human a shell and file a
  // crash as a clean exit.
  appendEvent({ t: nowSec() - 60, kind: "ended", session: "s2", generation: 1, cliSessionId: "c1", kindDetail: "exit" });
  // s2b got as far as resuming, then died mid-turn.
  appendEvent({ t: nowSec() - 60, kind: "ended", session: "s2b", generation: 1, cliSessionId: "c1", kindDetail: "exit" });
  appendEvent({ t: nowSec() - 10, kind: "resumed", session: "s2b", generation: 2, cliSessionId: "c1" });

  assert.equal(await paneDied(["s2"]), 0);
  assert.equal(await paneDied(["s2b"]), 0);

  assert.deepEqual(respawns(w), [], "the dead pane is left for inspection");
  for (const id of ["s2", "s2b"]) {
    assert.equal(stateOf(id), "parked", id);
    const last = readEvents(id).at(-1)!;
    assert.equal(last.kind, "died", id);
    assert.equal(last.generation, 2, id);
  }
});

test("_pane_died: a launch that exited non-zero is a death, whatever its own hook wrote", async () => {
  // Live matrix case 3. The replacement CLI exited 1 within a second —
  // `--resume` on an id with no transcript — and Claude Code's SessionEnd hook
  // still fired on the way out, so the newest event for this generation reads
  // `ended`. Taken at its word that is the human typing `/exit`: shell back,
  // session `stopped`, no `died` event, nothing anywhere saying the handoff
  // broke. tmux had the fact: `#{pane_dead_status}` was 1.
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1";
  process.env.MS_TMUX_DEAD_STATUS = "1";
  withState((st) => st.createSession({ id: "s-crashed", ...base, state: "resuming", generation: 2 }));
  appendEvent({ t: nowSec() - 2, kind: "ended", session: "s-crashed", generation: 2, cliSessionId: "c1", kindDetail: "other" });

  assert.equal(await paneDied(["s-crashed"]), 0);

  assert.equal(stateOf("s-crashed"), "parked", "a crash is for the human to look at, not a clean exit");
  assert.deepEqual(respawns(w), [], "and its pane is left as evidence, not handed back as a shell");
  const last = readEvents("s-crashed").at(-1)!;
  assert.equal(last.kind, "died");
  assert.equal(last.generation, 2);
  assert.equal(last.kindDetail, "exit 1", "the status is on the record, not just in the decision");
  assert.match(readFileSync(path.join(w.msHome, "sessions", "s-crashed", "recover.log"), "utf8"), /exit status 1/);
});

test("_pane_died: the exit status comes from the same read as the dead-check", async (t) => {
  // Asked as a second `display-message`, the status can come from a later
  // moment than the dead-check — and a pane respawned in between answers with
  // nothing, which would put B3 back on the event log it exists to correct.
  // `MS_TMUX_STATUS_SPLIT` makes the standalone query answer exactly that way;
  // the crash must still be read as a crash, because the status rode along.
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1";
  process.env.MS_TMUX_DEAD_STATUS = "1";
  process.env.MS_TMUX_STATUS_SPLIT = "1";
  t.after(() => {
    delete process.env.MS_TMUX_STATUS_SPLIT;
  });
  withState((st) => st.createSession({ id: "s-split", ...base, state: "resuming", generation: 2 }));
  appendEvent({ t: nowSec() - 2, kind: "ended", session: "s-split", generation: 2, cliSessionId: "c1", kindDetail: "other" });

  assert.equal(await paneDied(["s-split"]), 0);

  assert.equal(stateOf("s-split"), "parked");
  assert.deepEqual(respawns(w), [], "the pane is left as evidence, not handed back");
  assert.equal(readEvents("s-split").at(-1)!.kindDetail, "exit 1");
});

test("_pane_died: the stop the human asked for outranks a non-zero exit", async () => {
  // `ms stop` promised the pane back as a shell. How the CLI it killed happened
  // to exit does not change that promise.
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1";
  process.env.MS_TMUX_DEAD_STATUS = "1";
  withState((st) => st.createSession({ id: "s-stopped", ...base, desired: "stopped" }));

  assert.equal(await paneDied(["s-stopped"]), 0);

  assert.deepEqual(respawns(w), [`-S ${SOCK} respawn-pane -k -c /tmp/work -t %7 '${SHELL}' '-l'`]);
  assert.equal(stateOf("s-stopped"), "stopped");
  assert.ok(!readEvents("s-stopped").some((e) => e.kind === "died"), "a stop that worked is not a death");
});

test("_pane_died: a late callback for a generation that is over does nothing", async () => {
  const w = world();
  withState((st) => st.createSession({ id: "s1", ...base, generation: 2, state: "running" }));
  appendEvent({ t: nowSec() - 60, kind: "ended", session: "s1", generation: 1, cliSessionId: "c1", kindDetail: "exit" });
  appendEvent({ t: nowSec() - 30, kind: "resumed", session: "s1", generation: 2, cliSessionId: "c1" });
  // Generation 2 is live in that pane: the pane is not dead.
  process.env.MS_TMUX_PANE_DEAD = "0";

  assert.equal(await paneDied(["s1"]), 0);

  assert.equal(stateOf("s1"), "running", "a running generation is not parked by its predecessor's death");
  assert.deepEqual(respawns(w), []);
  assert.ok(!readEvents("s1").some((e) => e.kind === "died"));
});

test("_pane_died: the pane must be this session's, on this server, and dead", async () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1"; // the pane is a corpse: that is why we are here
  withState((st) => {
    st.createSession({ id: "s-restarted", ...base, serverStart: "1:1" });
    st.createSession({ id: "s-nopane", ...base, pane: "%9" });
    st.createSession({ id: "s-unknown", ...base, socket: "/tmp/other-socket" });
  });

  assert.equal(await paneDied(["s-restarted"]), 0);
  assert.equal(await paneDied(["s-nopane"]), 0);
  process.env.MS_TMUX_NO_SERVER = "1";
  assert.equal(await paneDied(["s-unknown"]), 0);
  delete process.env.MS_TMUX_NO_SERVER;

  assert.deepEqual(respawns(w), [], "a pane id we could not vouch for is never respawned");
  for (const id of ["s-restarted", "s-nopane", "s-unknown"]) assert.equal(stateOf(id), "running", id);
  assert.deepEqual(readEvents("s-restarted"), []);
});

test("_pane_died: `ms stop` gets the login shell back even with no ended event", async () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1"; // the pane is a corpse: that is why we are here
  withState((st) => st.createSession({ id: "s3", ...base, desired: "stopped" }));

  assert.equal(await paneDied(["s3"]), 0);

  assert.deepEqual(respawns(w), [`-S ${SOCK} respawn-pane -k -c /tmp/work -t %7 '${SHELL}' '-l'`]);
  assert.equal(stateOf("s3"), "stopped");
});

test("_pane_died: a pane dying mid-handoff belongs to the recovery worker", async () => {
  const w = world();
  process.env.MS_TMUX_PANE_DEAD = "1"; // the pane is a corpse: that is why we are here
  // The lock is the whole guarantee here, so nothing else may be standing in
  // for it: this row is old enough and ordinary enough that an unfenced hook
  // would give the pane straight back as a shell.
  withState((st) => st.createSession({ id: "s4", ...base, state: "stopping", desired: "stopped" }));
  appendEvent({ t: nowSec(), kind: "ended", session: "s4", generation: 1, cliSessionId: "c1", kindDetail: "exit" });
  planted(w.msHome, "UPDATE sessions SET updatedAt=?", nowSec() - 3600);
  const held = acquire(sessionLockName("s4"));
  assert.ok(held, "stand in for the worker that holds this session");
  try {
    assert.equal(await paneDied(["s4"]), 0);
  } finally {
    held!();
  }

  assert.deepEqual(respawns(w), [], "the worker's own respawn is the one that counts");
  assert.deepEqual(tmuxLines(w), [], "a locked session is not even inspected");
  assert.equal(stateOf("s4"), "stopping");

  // Released, the same callback finds an abandoned stop and honours it.
  assert.equal(await paneDied(["s4"]), 0);
  assert.equal(stateOf("s4"), "stopped");
  assert.equal(respawns(w).length, 1);
});

test("_pane_died: an unmanaged pane is not ours", async () => {
  const w = world();
  assert.equal(await paneDied(["nobody"]), 0);
  assert.deepEqual(tmuxLines(w), [], "not even a query for a session we never launched");
});


// --- (N3) a lock store that will not answer -----------------------------

test("a busy lock database skips that item and never aborts the pass", async () => {
  const w = world();
  const sync = path.join(w.home, "busy");
  // Held long enough that every acquire in the pass below comes back Locked
  // (the lock module's busy timeout is 250 ms), then released.
  const holder = holdLockDb(w.msHome, sync, 2_000);
  try {
    assert.ok(await waitForFile(path.join(sync, "holding"), 15_000), "the other process holds the write lock");
    withState((st) => {
      st.createSession({ id: "s-gone", ...base, pane: "%9" });
      st.createSession({ id: "s-due", ...base, state: "waiting" });
      st.setWakeup("s-due", nowSec() - 5);
    });

    const repaired = reconcile();

    // One busy hit used to throw out of the loop, skipping every later session
    // AND rule (d) — so the verb saw "reconcile failed" and nothing was done.
    assert.equal(repaired.filter((l) => l.includes("lock store")).length, 3,
      `both sessions and the wake-up are each accounted for:\n${repaired.join("\n")}`);
    assert.equal(stateOf("s-gone"), "running", "and nothing was repaired on a lock we never took");
    assert.deepEqual(dispatches(w), []);
    assert.equal(await holder.exit, 0);
  } finally {
    holder.child.kill();
  }

  // With the database free again, the same pass repairs both.
  reconcile();
  assert.equal(stateOf("s-gone"), "stopped");
  assert.deepEqual(dispatches(w), [`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's-due'`]);
});

// --- wiring -------------------------------------------------------------

test("reconcile runs before a public verb, not before an internal one", async () => {
  const w = world();
  process.env.MS_VERBOSE = "1";
  registerVerb("probe", async () => 0);
  registerVerb("_probe", async () => 0);

  plantLock(w.msHome, "stale-a", deadPid(), nowSec() - 5);
  const pub = await captureStderr(() => main(["probe"]));
  assert.equal(pub.value, 0);
  assert.match(pub.err, /reconcile: lock 'stale-a'/);
  assert.equal(lockedBy("stale-a"), null);

  plantLock(w.msHome, "stale-b", deadPid(), nowSec() - 5);
  const internal = await captureStderr(() => main(["_probe"]));
  assert.equal(internal.value, 0);
  assert.equal(internal.err, "", "an internal verb is on a hot path and says nothing");
  assert.ok(lockedBy("stale-b"), "and repairs nothing");
});

test("a reconcile failure never blocks the verb", async () => {
  const w = world();
  process.env.MS_VERBOSE = "1";
  registerVerb("probe", async () => 0);
  const notADir = path.join(w.home, "wall");
  writeFileSync(notADir, "");
  process.env.MS_HOME = path.join(notADir, "store");

  const r = await captureStderr(() => main(["probe"]));

  assert.equal(r.value, 0, "the verb the human asked for still ran");
  assert.match(r.err, /reconcile failed/);
});
