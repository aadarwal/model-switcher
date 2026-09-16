import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.ts";
import { acquire, lockedBy, sweepStaleLocks, withLock, Locked } from "../src/lock.ts";

/** A fresh MS_HOME per test; every path these tests touch is under it. */
function useTempHome(): { home: string; msHome: string } {
  const h = tempHome();
  process.env.HOME = h.home;
  process.env.MS_HOME = h.msHome;
  return h;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name);
const dbFile = (msHome: string) => path.join(msHome, "locks.sqlite");
const nowSec = () => Math.floor(Date.now() / 1000);

/** Write a lock row directly, as another process would have left it. */
function plant(msHome: string, name: string, pid: number, since: number): void {
  const db = new DatabaseSync(dbFile(msHome));
  db.exec("CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, since INTEGER NOT NULL)");
  db.prepare("INSERT OR REPLACE INTO locks (name, pid, since) VALUES (?, ?, ?)").run(name, pid, since);
  db.close();
}

/** A pid that is certainly not running: a child we waited for. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(r.status, 0);
  return r.pid as number;
}

type Kid = { child: ChildProcess; exit: Promise<number>; stderr: () => string };

function startChild(script: string, args: string[], env: Record<string, string>): Kid {
  const child = spawn(process.execPath, ["--import", "tsx", fixture(script), ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr?.on("data", (d) => { err += String(d); });
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? -1));
  });
  return { child, exit, stderr: () => err };
}

/** Bound the whole interaction: kill and reap everything, never hang the suite. */
async function bounded<T>(kids: Kid[], ms: number, body: () => Promise<T>): Promise<T> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const k of kids) k.child.kill("SIGKILL");
  }, ms);
  try {
    const out = await body();
    assert.equal(timedOut, false, `timed out after ${ms} ms; stderr: ${kids.map((k) => k.stderr()).join("\n")}`);
    return out;
  } finally {
    clearTimeout(timer);
    for (const k of kids) k.child.kill("SIGKILL");
    await Promise.allSettled(kids.map((k) => k.exit));
  }
}

async function waitForFile(file: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(file)) return true;
    await sleep(10);
  }
  return false;
}

test("a second acquire on a held name returns null", () => {
  const { msHome } = useTempHome();
  const first = acquire("snapshot");
  assert.ok(first, "the first acquire takes the lock");
  assert.equal(acquire("snapshot"), null, "the second finds it held");
  assert.equal(lockedBy("snapshot")?.pid, process.pid);
  assert.equal(statSync(dbFile(msHome)).mode & 0o777, 0o600, "the lock db is 0600");
});

test("release then acquire succeeds, and lockedBy goes quiet", () => {
  useTempHome();
  const first = acquire("snapshot");
  assert.ok(first);
  first();
  assert.equal(lockedBy("snapshot"), null, "release removes the row");
  const again = acquire("snapshot");
  assert.ok(again, "the name is free again");
  assert.equal(lockedBy("snapshot")?.pid, process.pid);
});

test("a lock db left with loose permissions is repaired on open", () => {
  // The file is pre-created at 0600 so SQLite never makes it 0644 first, but a
  // file from before that line (or from another tool) must still be tightened.
  const { msHome } = useTempHome();
  const file = dbFile(msHome);
  closeSync(openSync(file, "a", 0o644));
  chmodSync(file, 0o644);
  assert.ok(acquire("repair"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("release is idempotent", () => {
  useTempHome();
  const release = acquire("handoffs");
  assert.ok(release);
  release();
  release();
  assert.equal(lockedBy("handoffs"), null);
});

test("a row whose pid is dead is reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "crashed", deadPid(), nowSec());
  const release = acquire("crashed");
  assert.ok(release, "a holder whose pid is gone is abandoned, however recent");
  assert.equal(lockedBy("crashed")?.pid, process.pid);
});

test("a live pid with a fresh since is not reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "live", process.pid, nowSec());
  assert.equal(acquire("live"), null, "a live, recent holder keeps the lock");
  assert.equal(lockedBy("live")?.pid, process.pid);
});

test("a live pid older than staleAfter is reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "wedged", process.pid, nowSec() - 3600);
  const before = lockedBy("wedged")?.since ?? 0;
  const release = acquire("wedged", { staleAfterMs: 60_000 });
  assert.ok(release, "age alone is enough");
  assert.ok((lockedBy("wedged")?.since ?? 0) > before, "the row was taken over, since refreshed");
});

test("lockedBy reports the row in seconds, or null", () => {
  const { msHome } = useTempHome();
  const since = nowSec() - 5;
  plant(msHome, "held", 4242, since);
  assert.deepEqual(lockedBy("held"), { pid: 4242, since }, "unix seconds, the store convention");
  assert.equal(lockedBy("nothing"), null, "no row, no holder");
});

test("a lock name that is not a plain token is refused", () => {
  useTempHome();
  assert.throws(() => acquire("../../evil"), /lock name/);
  assert.throws(() => acquire("a/b"), /lock name/);
  assert.throws(() => acquire("a.b"), /lock name/);
  assert.throws(() => acquire("Snapshot"), /lock name/);
  assert.throws(() => acquire(""), /lock name/);
  assert.throws(() => lockedBy("a/b"), /lock name/);
});

test("release after another process reclaimed and re-acquired leaves the new owner alone", async () => {
  // The reviewer's finding (3), as three real processes: child 1 holds, child 2
  // reclaims it, child 1 then releases. Child 1's DELETE is conditional on its
  // own pid, so it must not touch child 2's row.
  const { home, msHome } = useTempHome();
  const sync = path.join(home, "sync");
  mkdirSync(sync, { recursive: true });
  const env = { HOME: home, MS_HOME: msHome };

  const holder = startChild("lock-hold-child.ts", ["shared", sync, "1"], env);
  await bounded([holder], 20_000, async () => {
    assert.ok(await waitForFile(path.join(sync, "acquired"), 15_000), "child 1 took the lock");
    const holderPid = Number(readFileSync(path.join(sync, "acquired"), "utf8"));
    assert.equal(lockedBy("shared")?.pid, holderPid);

    const thief = startChild("lock-reclaim-child.ts", ["shared", sync, "1"], env);
    assert.equal(await thief.exit, 0, `child 2 reclaimed: ${thief.stderr()}`);
    const thiefPid = Number(readFileSync(path.join(sync, "reclaimed"), "utf8"));
    assert.notEqual(thiefPid, holderPid);
    assert.equal(lockedBy("shared")?.pid, thiefPid, "child 2 now owns the row");

    // Now let child 1 release, believing it still holds the lock.
    writeFileSync(path.join(sync, "go"), "");
    assert.equal(await holder.exit, 0, `child 1 released: ${holder.stderr()}`);
    assert.equal(lockedBy("shared")?.pid, thiefPid, "child 2's row survived child 1's release");
  });
});

test("withLock never enters after its wait has expired", async () => {
  useTempHome();
  const held = acquire("busy");
  assert.ok(held);
  const late = setTimeout(() => held(), 100);
  let entered = false;
  const t0 = performance.now();
  try {
    await assert.rejects(
      withLock("busy", () => { entered = true; }, { waitMs: 40, intervalMs: 25 }),
      (e: unknown) => e instanceof Locked && /busy/.test(e.message),
    );
    assert.equal(entered, false, "fn was never entered");
    assert.ok(performance.now() - t0 < 100, "it gave up before the holder released");
  } finally {
    clearTimeout(late);
    held();
  }
});

test("withLock gives up at its own deadline, not at the holder's convenience", async () => {
  // The holder keeps the lock until well AFTER the wait expires, so there is
  // no instant at which a correct implementation and a broken one could
  // disagree by a few milliseconds of timer drift: whatever the scheduling,
  // every attempt inside the wait finds the lock held, and the only question
  // left is whether the waiter stopped at ITS deadline or sat on for the
  // holder. (The previous version of this test released the lock 40 ms before
  // the deadline and asked which side of it four sqlite-backed attempts landed
  // on — a coin toss on a loaded machine, and the class of flake this module's
  // ledger already records once.)
  useTempHome();
  const held = acquire("busy");
  assert.ok(held);
  let released = false;
  const timer = setTimeout(() => {
    held();
    released = true;
  }, 1_300);
  let entered = false;
  const t0 = performance.now();
  try {
    await assert.rejects(
      withLock("busy", () => { entered = true; }, { waitMs: 1_000, intervalMs: 200 }),
      (e: unknown) => e instanceof Locked && e.name === "Locked",
    );
    const elapsed = performance.now() - t0;
    assert.equal(entered, false, "fn was entered although the lock was never free");
    assert.equal(released, false, "it waited for the holder to let go instead of for its own deadline");
    assert.ok(elapsed >= 1_000, `it gave up after ${Math.round(elapsed)}ms, before its own 1000ms deadline`);
  } finally {
    clearTimeout(timer);
    held();
  }
});

test("a busy lock database reads as not-acquired, never as a bare Error", async () => {
  // Another process holds SQLite's write lock (an open BEGIN IMMEDIATE) for
  // ~600 ms — longer than the 250 ms busy_timeout, so every attempt inside the
  // 300 ms wait comes back SQLITE_BUSY. That must surface as Locked and be
  // retried inside withLock's own deadline, not escape as `database is locked`
  // and not stretch the wait to waitMs plus a multiple of the busy timeout.
  const { home, msHome } = useTempHome();
  const sync = path.join(home, "busydb");
  const holder = startChild("lock-busy-child.ts", [sync, "600"], { HOME: home, MS_HOME: msHome });

  await bounded([holder], 20_000, async () => {
    assert.ok(await waitForFile(path.join(sync, "holding"), 15_000), "the other process holds the write lock");
    let entered = false;
    const t0 = performance.now();
    await assert.rejects(
      withLock("contended", () => { entered = true; }, { waitMs: 300, intervalMs: 100 }),
      (e: unknown) => e instanceof Locked && e.name === "Locked",
    );
    const elapsed = performance.now() - t0;
    assert.equal(entered, false);
    assert.ok(elapsed < 1_500, `gave up on its own deadline, not the busy timeout's (${Math.round(elapsed)} ms)`);
    assert.equal(await holder.exit, 0, `the holder finished cleanly: ${holder.stderr()}`);
  });
});

test("withLock runs fn while holding the name, and releases after", async () => {
  useTempHome();
  let inside = false;
  const out = await withLock("snapshot", () => {
    inside = true;
    assert.equal(acquire("snapshot"), null, "held for the duration");
    return 7;
  });
  assert.equal(out, 7);
  assert.ok(inside);
  assert.equal(lockedBy("snapshot"), null, "released after");
});

test("withLock releases when fn throws", async () => {
  useTempHome();
  await assert.rejects(withLock("snapshot", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(lockedBy("snapshot"), null);
});

test("withLock takes the lock as soon as the holder releases", async () => {
  useTempHome();
  const held = acquire("handoffs");
  assert.ok(held);
  const timer = setTimeout(() => held(), 150);
  try {
    let ran = false;
    await withLock("handoffs", () => { ran = true; }, { waitMs: 5_000, intervalMs: 25 });
    assert.ok(ran);
  } finally {
    clearTimeout(timer);
  }
});

test("only one of eight racing processes takes the lock", async () => {
  const { home, msHome } = useTempHome();
  const sync = path.join(home, "race");
  const N = 8;
  const kids = Array.from({ length: N }, () =>
    startChild("lock-race-child.ts", ["race", sync, String(N)], { HOME: home, MS_HOME: msHome }));

  await bounded(kids, 30_000, async () => {
    const codes = await Promise.all(kids.map((k) => k.exit));
    const bad = codes.filter((c) => c !== 0 && c !== 3);
    assert.deepEqual(bad, [], `every racer reported a verdict; stderr: ${kids.map((k) => k.stderr()).join("\n")}`);
    assert.equal(codes.filter((c) => c === 0).length, 1, `exactly one winner, got [${codes.join(",")}]`);
    assert.equal(codes.filter((c) => c === 3).length, N - 1);
    assert.equal(readdirSync(path.join(sync, "attempted")).length, N, "all eight really attempted");
    assert.equal(lockedBy("race"), null, "the winner released on its way out");
  });
});

test("sweepStaleLocks removes only the rows whose holder is gone", () => {
  const { msHome } = useTempHome();
  plant(msHome, "session-s1", deadPid(), nowSec() - 5);
  plant(msHome, "session-s2", process.pid, nowSec() - 5);
  // Not stale by age: sweeping is about a holder that cannot come back, not a
  // slow one. A long-running holder is still a holder.
  plant(msHome, "handoffs", process.pid, nowSec() - 86_400);

  assert.deepEqual(sweepStaleLocks().sort(), ["session-s1"]);

  assert.equal(lockedBy("session-s1"), null);
  assert.equal(lockedBy("session-s2")!.pid, process.pid);
  assert.equal(lockedBy("handoffs")!.pid, process.pid);
  assert.deepEqual(sweepStaleLocks(), [], "a second sweep has nothing left to do");
});
