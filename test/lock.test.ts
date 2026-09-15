import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

const lockDir = (msHome: string, name: string) => path.join(msHome, "locks", name);
const holderOf = (msHome: string, name: string) => path.join(lockDir(msHome, name), "holder");
const nowSec = () => Math.floor(Date.now() / 1000);
const stales = (msHome: string) => readdirSync(path.join(msHome, "locks")).filter((n) => n.includes(".stale."));

/** A pid that is certainly not running: a child we waited for. Pid reuse
 * inside one test run is not a practical risk on macOS. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(r.status, 0);
  return r.pid as number;
}

/** Plant a lock dir that this process did not acquire. */
function plant(msHome: string, name: string, holder: string | null, ageMs = 0): string {
  const dir = lockDir(msHome, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (holder !== null) writeFileSync(holderOf(msHome, name), holder + "\n");
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(dir, t, t);
  }
  return dir;
}

test("a second acquire on a held name returns null", () => {
  const { msHome } = useTempHome();
  const first = acquire("snapshot");
  assert.ok(first, "the first acquire takes the lock");
  assert.equal(acquire("snapshot"), null, "the second finds it held");
  assert.equal(lockedBy("snapshot")?.pid, process.pid);
  assert.match(readFileSync(holderOf(msHome, "snapshot"), "utf8"), /^\d+ \d+\n$/);
  assert.equal(statSync(lockDir(msHome, "snapshot")).mode & 0o777, 0o700);
});

test("release then acquire succeeds, and lockedBy goes quiet", () => {
  const { msHome } = useTempHome();
  const first = acquire("snapshot");
  assert.ok(first);
  first();
  assert.equal(existsSync(lockDir(msHome, "snapshot")), false, "release removes the dir");
  assert.equal(lockedBy("snapshot"), null);
  assert.ok(acquire("snapshot"), "the name is free again");
});

test("release is idempotent and never removes a lock someone else now holds", () => {
  const { msHome } = useTempHome();
  const release = acquire("session-a");
  assert.ok(release);
  // Another process reclaimed it and wrote its own holder.
  writeFileSync(holderOf(msHome, "session-a"), `${deadPid()} ${nowSec()}\n`);
  release();
  assert.ok(existsSync(lockDir(msHome, "session-a")), "not ours to remove");
  const mine = acquire("session-b");
  assert.ok(mine);
  mine();
  mine();
  assert.equal(existsSync(lockDir(msHome, "session-b")), false);
});

test("a holder-less dir older than staleAfter is reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "orphan", null, 60_000);
  const release = acquire("orphan", { staleAfterMs: 1_000 });
  assert.ok(release, "an abandoned, holder-less dir is reclaimed");
  assert.equal(lockedBy("orphan")?.pid, process.pid);
  assert.deepEqual(stales(msHome), [], "the moved-aside copy is removed, not leaked");
});

test("a fresh dir with a live pid is not reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "live", `${process.pid} ${nowSec()}`);
  assert.equal(acquire("live"), null, "a live, recent holder keeps the lock");
  assert.equal(lockedBy("live")?.pid, process.pid);
  assert.deepEqual(stales(msHome), []);
});

test("a holder-less dir younger than staleAfter is not reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "booting", null);
  assert.equal(acquire("booting", { staleAfterMs: 600_000 }), null, "a dir mid-acquire is left alone");
  assert.deepEqual(stales(msHome), []);
});

test("a dead holder is reclaimed however recent it is", () => {
  const { msHome } = useTempHome();
  plant(msHome, "crashed", `${deadPid()} ${nowSec()}`);
  const release = acquire("crashed");
  assert.ok(release, "a holder whose pid is gone is abandoned");
  assert.equal(lockedBy("crashed")?.pid, process.pid);
  assert.deepEqual(stales(msHome), []);
});

test("a live holder older than staleAfter is reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "wedged", `${process.pid} ${nowSec() - 3600}`);
  const release = acquire("wedged", { staleAfterMs: 60_000 });
  assert.ok(release, "age alone is enough");
  assert.ok((lockedBy("wedged")?.since ?? 0) > Date.now() - 60_000, "the holder line is ours, freshly written");
  assert.deepEqual(stales(msHome), []);
});

test("lockedBy reports a parsed holder and null for anything else", () => {
  const { msHome } = useTempHome();
  const since = nowSec() - 5;
  plant(msHome, "held", `4242 ${since}`);
  assert.deepEqual(lockedBy("held"), { pid: 4242, since: since * 1000 });
  assert.equal(lockedBy("nothing"), null, "no dir, no holder");
  plant(msHome, "garbled", "not a holder line");
  assert.equal(lockedBy("garbled"), null, "an unreadable holder names nobody");
});

test("a reclaim whose holder changed under the rename is abandoned, not stolen", () => {
  const { msHome } = useTempHome();
  plant(msHome, "hot", `${deadPid()} ${nowSec() - 3600}`);
  let moved = "";
  const release = acquire("hot", {
    staleAfterMs: 1_000,
    _afterRename(m) {
      moved = m;
      // Between our judgement and our rename, the holder released and a live
      // process took the lock: what we moved aside is not what we judged.
      writeFileSync(path.join(m, "holder"), `${process.pid} ${nowSec()}\n`);
    },
  });
  assert.equal(release, null, "we do not take a lock we cannot prove was stale");
  assert.notEqual(moved, "");
  assert.equal(existsSync(moved), false, "the moved-aside dir was put back");
  assert.equal(lockedBy("hot")?.pid, process.pid, "the live holder's dir is intact at its own name");
  assert.deepEqual(stales(msHome), []);
});

test("a holder-less dir that turns out to be fresh is put back, not reclaimed", () => {
  const { msHome } = useTempHome();
  plant(msHome, "warm", null, 60_000);
  const release = acquire("warm", {
    staleAfterMs: 1_000,
    _afterRename(m) {
      const t = new Date();
      utimesSync(m, t, t); // it was being acquired all along
    },
  });
  assert.equal(release, null);
  assert.ok(existsSync(lockDir(msHome, "warm")));
  assert.deepEqual(stales(msHome), []);
});

test("a name re-taken during a failed reclaim is left alone, holder and all", () => {
  const { msHome } = useTempHome();
  plant(msHome, "hot", `${deadPid()} ${nowSec() - 3600}`);
  let moved = "";
  const release = acquire("hot", {
    staleAfterMs: 1_000,
    _afterRename(m, dir) {
      moved = m;
      writeFileSync(path.join(m, "holder"), `${process.pid} ${nowSec()}\n`);
      mkdirSync(dir, { mode: 0o700 }); // and a third process took the free name
      writeFileSync(path.join(dir, "holder"), `4242 ${nowSec()}\n`);
    },
  });
  assert.equal(release, null);
  assert.equal(lockedBy("hot")?.pid, 4242, "the new holder's dir is untouched");
  assert.deepEqual(readdirSync(lockDir(msHome, "hot")), ["holder"], "nothing was moved into it");
  assert.deepEqual(stales(msHome), [path.basename(moved)], "the copy we could not put back stays visible");
});

test("a failed reclaim never replaces a lock that is mid-acquire", () => {
  // The dangerous shape: rename(2) onto an EMPTY directory succeeds silently,
  // and an empty lock dir is a live process between its mkdir and its holder
  // write. Moving back without checking would delete that process's lock.
  const { msHome } = useTempHome();
  plant(msHome, "hot", `${deadPid()} ${nowSec() - 3600}`);
  let moved = "";
  const release = acquire("hot", {
    staleAfterMs: 1_000,
    _afterRename(m, dir) {
      moved = m;
      writeFileSync(path.join(m, "holder"), `${process.pid} ${nowSec()}\n`);
      mkdirSync(dir, { mode: 0o700 }); // taken again, holder not written yet
    },
  });
  assert.equal(release, null);
  assert.deepEqual(readdirSync(lockDir(msHome, "hot")), [], "the mid-acquire dir survives, still empty");
  assert.deepEqual(stales(msHome), [path.basename(moved)], "our copy stays aside rather than overwriting it");
});

test("withLock runs fn while holding the name and releases after", async () => {
  const { msHome } = useTempHome();
  let inside = false;
  const out = await withLock("snapshot", () => {
    inside = true;
    assert.equal(acquire("snapshot"), null, "held for the duration");
    return 7;
  });
  assert.equal(out, 7);
  assert.ok(inside);
  assert.equal(existsSync(lockDir(msHome, "snapshot")), false, "released after");
});

test("withLock releases when fn throws", async () => {
  const { msHome } = useTempHome();
  await assert.rejects(withLock("snapshot", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lockDir(msHome, "snapshot")), false);
});

test("withLock waits for the holder, then throws Locked naming it", async () => {
  const { msHome } = useTempHome();
  plant(msHome, "busy", `${process.pid} ${nowSec()}`);
  const t0 = Date.now();
  await assert.rejects(
    withLock("busy", () => 1, { waitMs: 400, pollMs: 50 }),
    (e: unknown) => e instanceof Locked && /busy/.test(e.message) && new RegExp(String(process.pid)).test(e.message),
  );
  assert.ok(Date.now() - t0 >= 350, "it waited for the deadline before giving up");
});

test("withLock takes the lock as soon as the holder releases", async () => {
  useTempHome();
  const held = acquire("handoffs");
  assert.ok(held);
  setTimeout(() => held(), 150);
  let ran = false;
  await withLock("handoffs", () => { ran = true; }, { waitMs: 5_000, pollMs: 25 });
  assert.ok(ran);
});

test("a lock name that could escape the locks dir is refused", () => {
  useTempHome();
  assert.throws(() => acquire("../../evil"), /lock name/);
  assert.throws(() => acquire("a/b"), /lock name/);
  assert.throws(() => acquire(""), /lock name/);
  assert.throws(() => lockedBy("snap.stale.1.ff"), /lock name/);
});

test("only one of eight racing processes takes the lock", async () => {
  const { home, msHome } = useTempHome();
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lock-race-child.ts");
  const ready = path.join(home, "ready");
  const N = 8;
  const codes = await Promise.all(
    Array.from({ length: N }, () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, "race", ready, String(N)], {
          env: { ...process.env, HOME: home, MS_HOME: msHome },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => { err += String(d); });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 || code === 3 ? resolve(code) : reject(new Error(`racer exited ${code}: ${err}`)));
      })),
  );
  assert.equal(codes.filter((c) => c === 0).length, 1, `exactly one winner, got [${codes.join(",")}]`);
  assert.equal(codes.filter((c) => c === 3).length, N - 1);
  assert.equal(existsSync(lockDir(msHome, "race")), false, "the winner released on its way out");
});
