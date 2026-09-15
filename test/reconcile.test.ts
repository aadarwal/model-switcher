import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";
import { lockedBy } from "../src/lock.ts";
import { openState, type SessionRow } from "../src/state.ts";
import { appendEvent, readEvents } from "../src/events.ts";
import { paneDied, reconcile } from "../src/reconcile.ts";
import { main, registerVerb } from "../src/cli.ts";

/** Captured once: every world() prepends a stub dir, and PATH must not grow. */
const ORIG_PATH = process.env.PATH ?? "";
const IDENTITY = "4242:1789000000";
const SOCK = "/tmp/ms-t18-socket";
const MS_BIN = "/opt/ms/bin/ms";
const SHELL = "/bin/testsh";

/** tmux, as far as reconciliation drives it: logs every argv line, answers the
 * identity query and `list-panes` from the environment, and accepts everything
 * else (respawn-pane, run-shell) with a log line only. */
const TMUX_STUB = `printf '%s\\n' "$*" >> "$MS_TMUX_LOG"
if [ "$1" = "-S" ]; then shift 2; fi
case "$1" in
  display-message)
    if [ "\${MS_TMUX_NO_SERVER:-0}" = "1" ]; then echo "no server running" >&2; exit 1; fi
    echo "\${MS_TMUX_IDENTITY}" ;;
  list-panes) printf '%s\\n' \${MS_TMUX_PANES} ;;
esac
exit 0`;

type World = { home: string; msHome: string; log: string };

function world(): World {
  const { home, msHome } = tempHome();
  const { dir, stub } = stubDir();
  const log = path.join(dir, "tmux.log");
  stub("tmux", TMUX_STUB);
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  process.env.PATH = `${dir}:${ORIG_PATH}`;
  process.env.MS_TMUX_LOG = log;
  process.env.MS_TMUX_IDENTITY = IDENTITY;
  process.env.MS_TMUX_PANES = "%7";
  process.env.MS_BIN = MS_BIN;
  process.env.SHELL = SHELL;
  delete process.env.MS_TMUX_NO_SERVER;
  delete process.env.MS_VERBOSE;
  return { home, msHome, log };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const tmuxLines = (w: World): string[] =>
  existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter((l) => l.trim()) : [];

const base: Omit<SessionRow, "id" | "wakeupAt" | "createdAt" | "updatedAt"> = {
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

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const orig = process.stderr.write;
  let err = "";
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, err };
  } finally {
    process.stderr.write = orig;
  }
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

// --- (b) recoveries owned by a dead worker ------------------------------

test("(b) an owned recovery whose worker died goes back to pending and is re-dispatched", () => {
  const w = world();
  const dead = deadPid();
  withState((st) => {
    for (const id of ["s-dead", "s-live", "s-fresh", "s-elsewhere"]) st.createSession({ id, ...base });
    const owners: Record<string, string> = {
      "s-dead": `${dead}@${hostname()}`,
      "s-live": `${process.pid}@${hostname()}`,
      "s-fresh": `${dead}@${hostname()}`,
      "s-elsewhere": `${dead}@some-other-mac`,
    };
    for (const [sessionId, owner] of Object.entries(owners)) {
      const rec = st.addRecovery({ sessionId, generation: 1, turnId: null, kind: "session" });
      assert.ok(st.ownRecovery(rec, owner));
    }
  });
  // Everything but s-fresh has been owned for eleven minutes.
  planted(w.msHome, "UPDATE recoveries SET updatedAt=? WHERE sessionId<>'s-fresh'", nowSec() - 660);

  const repaired = reconcile();

  withState((st) => {
    const dead_ = st.pendingRecovery("s-dead")!;
    assert.equal(dead_.status, "pending");
    assert.equal(dead_.owner, null);
    assert.equal(st.pendingRecovery("s-live")!.status, "owned", "a live owner is not disturbed");
    assert.equal(st.pendingRecovery("s-fresh")!.status, "owned", "ten minutes have not passed");
    assert.equal(st.pendingRecovery("s-elsewhere")!.status, "owned", "another host's pid is not ours to judge");
  });
  const lines = tmuxLines(w);
  assert.ok(
    lines.includes(`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's-dead'`),
    `no re-dispatch in:\n${lines.join("\n")}`,
  );
  assert.ok(!lines.some((l) => l.includes("_recover") && !l.includes("s-dead")), "only the abandoned one is re-dispatched");
  assert.ok(repaired.some((l) => l.includes("s-dead")), repaired.join("\n"));
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

test("(c) a tmux server that is not running at all stops its sessions", () => {
  world();
  process.env.MS_TMUX_NO_SERVER = "1";
  withState((st) => st.createSession({ id: "s1", ...base }));

  reconcile();

  withState((st) => assert.equal(st.getSession("s1")!.state, "stopped"));
});

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
  const lines = tmuxLines(w);
  assert.ok(lines.includes(`-S ${SOCK} run-shell -b '${MS_BIN}' '_recover' 's-due'`), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("s-later")));
  assert.ok(!lines.some((l) => l.includes("s-due-gone")), "a gone pane is never woken");
  assert.ok(repaired.some((l) => l.includes("s-due")), repaired.join("\n"));
});

// --- (e) a handoff that never came back ---------------------------------

test("(e) resuming/continuing for over five minutes with no resumed event is parked", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s-stuck", ...base, state: "resuming", generation: 2 });
    st.createSession({ id: "s-resumed", ...base, state: "continuing", generation: 2 });
    st.createSession({ id: "s-recent", ...base, state: "resuming", generation: 2 });
  });
  appendEvent({ t: nowSec() - 400, kind: "resumed", session: "s-resumed", generation: 2, cliSessionId: "c1" });
  planted(w.msHome, "UPDATE sessions SET updatedAt=? WHERE id<>'s-recent'", nowSec() - 400);

  const repaired = reconcile();

  withState((st) => {
    assert.equal(st.getSession("s-stuck")!.state, "parked");
    assert.equal(st.getSession("s-resumed")!.state, "continuing", "it did resume; it is just still working");
    assert.equal(st.getSession("s-recent")!.state, "resuming", "five minutes have not passed");
  });
  assert.ok(repaired.some((l) => l.includes("s-stuck")), repaired.join("\n"));
  const log = readFileSync(path.join(w.msHome, "sessions", "s-stuck", "recover.log"), "utf8");
  assert.match(log, /parked/);
});

// --- (f) a launch that never started ------------------------------------

test("(f) launching for over five minutes with no started event is parked", () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s-never", ...base, state: "launching" });
    st.createSession({ id: "s-started", ...base, state: "launching" });
  });
  appendEvent({ t: nowSec() - 400, kind: "started", session: "s-started", generation: 1, cliSessionId: "c1" });
  planted(w.msHome, "UPDATE sessions SET updatedAt=?", nowSec() - 400);

  const repaired = reconcile();

  withState((st) => {
    assert.equal(st.getSession("s-never")!.state, "parked");
    assert.equal(st.getSession("s-started")!.state, "launching", "it did start; the hook will move it on");
  });
  assert.ok(repaired.some((l) => l.includes("s-never")), repaired.join("\n"));
});

// --- ms _pane_died ------------------------------------------------------

test("_pane_died: a normal end respawns the login shell and stops the session", async () => {
  const w = world();
  withState((st) => {
    st.createSession({ id: "s1", ...base });
    st.addRecovery({ sessionId: "s1", generation: 1, turnId: null, kind: "session" });
    st.setWakeup("s1", nowSec() + 600);
  });
  appendEvent({ t: nowSec() - 1, kind: "rate_limited", session: "s1", generation: 1, cliSessionId: "c1" });
  appendEvent({ t: nowSec(), kind: "ended", session: "s1", generation: 1, cliSessionId: "c1", kindDetail: "exit" });

  assert.equal(await paneDied(["s1"]), 0);

  const lines = tmuxLines(w);
  assert.ok(
    lines.includes(`-S ${SOCK} respawn-pane -k -c /tmp/work -t %7 '${SHELL}' '-l'`),
    `no login shell respawn in:\n${lines.join("\n")}`,
  );
  withState((st) => {
    assert.equal(st.getSession("s1")!.state, "stopped");
    assert.equal(st.getSession("s1")!.wakeupAt, null);
    assert.equal(st.pendingRecovery("s1"), null, "the pane is a shell now; no worker may respawn claude into it");
  });
  assert.ok(!readEvents("s1").some((e) => e.kind === "died"), "a normal end is not a death");
});

test("_pane_died: no ended event for this generation appends died, parks, and leaves the pane", async () => {
  const w = world();
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

  assert.ok(!tmuxLines(w).some((l) => l.includes("respawn-pane")), "the dead pane is left for inspection");
  for (const id of ["s2", "s2b"]) {
    withState((st) => assert.equal(st.getSession(id)!.state, "parked", id));
    const last = readEvents(id).at(-1)!;
    assert.equal(last.kind, "died", id);
    assert.equal(last.generation, 2, id);
  }
});

test("_pane_died: `ms stop` gets the login shell back even with no ended event", async () => {
  const w = world();
  withState((st) => st.createSession({ id: "s3", ...base, desired: "stopped" }));

  assert.equal(await paneDied(["s3"]), 0);

  assert.ok(tmuxLines(w).some((l) => l.includes(`respawn-pane -k -c /tmp/work -t %7 '${SHELL}' '-l'`)));
  withState((st) => assert.equal(st.getSession("s3")!.state, "stopped"));
});

test("_pane_died: a pane dying mid-handoff belongs to the recovery worker", async () => {
  const w = world();
  withState((st) => st.createSession({ id: "s4", ...base, state: "stopping" }));
  appendEvent({ t: nowSec(), kind: "ended", session: "s4", generation: 1, cliSessionId: "c1", kindDetail: "exit" });

  assert.equal(await paneDied(["s4"]), 0);

  assert.ok(!tmuxLines(w).some((l) => l.includes("respawn-pane")), "the worker's own respawn is the one that counts");
  withState((st) => assert.equal(st.getSession("s4")!.state, "stopping"));
});

test("_pane_died: an unmanaged pane is not ours", async () => {
  const w = world();
  assert.equal(await paneDied(["nobody"]), 0);
  assert.deepEqual(tmuxLines(w), []);
});

// --- wiring -------------------------------------------------------------

test("reconcile runs before a public verb, not before an internal one", async () => {
  const w = world();
  process.env.MS_VERBOSE = "1";
  registerVerb("probe", async () => 0);
  registerVerb("_probe", async () => 0);

  plantLock(w.msHome, "stale-a", deadPid(), nowSec() - 5);
  const pub = await captureStderr(() => main(["probe"]));
  assert.equal(pub.code, 0);
  assert.match(pub.err, /reconcile: lock 'stale-a'/);
  assert.equal(lockedBy("stale-a"), null);

  plantLock(w.msHome, "stale-b", deadPid(), nowSec() - 5);
  const internal = await captureStderr(() => main(["_probe"]));
  assert.equal(internal.code, 0);
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

  assert.equal(r.code, 0, "the verb the human asked for still ran");
  assert.match(r.err, /reconcile failed/);
});
