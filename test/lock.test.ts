import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.ts";
import { acquire, lockedBy, withLock, Locked } from "../src/lock.ts";

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

test("withLock makes no attempt once the deadline has passed", async () => {
  // The test above passes either way: with waitMs 40 the lock is still held at
  // every attempt, so checking the deadline after the attempt reaches the same
  // verdict. This one separates them. waitMs is an exact multiple of intervalMs,
  // so attempts land at ~0 and ~500 and the last sleep ends exactly on the
  // 1000 ms deadline; the holder releases at 750, squarely in the gap, leaving
  // 250 ms of slack on either side for timer jitter. An implementation that
  // attempts before checking would take the now-free lock at ~1000 and enter fn
  // after its wait had expired.
  useTempHome();
  const held = acquire("busy");
  assert.ok(held);
  const timer = setTimeout(() => held(), 750);
  let entered = false;
  try {
    await assert.rejects(
      withLock("busy", () => { entered = true; }, { waitMs: 1_000, intervalMs: 500 }),
      (e: unknown) => e instanceof Locked,
    );
    assert.equal(entered, false, "the deadline was checked before the attempt, not after");
  } finally {
    clearTimeout(timer);
    held();
  }
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
