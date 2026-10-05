// test/codex-writer-lock.test.ts
//
// The writer-lock probe against REAL flocks. Codex takes its conversation
// lock with Rust's `File::try_lock`, which is `flock(2)` on every Unix, so a
// Perl child holding `flock(LOCK_EX)` on the same file is the same lock a
// Codex writer holds — not a model of it.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  probeConversation,
  probeWriterLock,
  showsLockCard,
  waitForWriterRelease,
  writerLockDirs,
} from "../src/codex-writer-lock.ts";

const ID = "01a10951-a81b-7a52-9a37-6c3f1d1f0c11";

function lockDir(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "ms-wlock-")), "thread-writer-locks");
  mkdirSync(dir);
  writeFileSync(path.join(dir, ".coordination.lock"), "");
  return dir;
}

/** A process holding `flock(LOCK_EX)` on `file` until it is killed. Resolves
 *  once the lock is really held (the child says so on stdout). */
async function holdLock(t: TestContext, file: string): Promise<() => Promise<void>> {
  const child = spawn("perl", ["-e", 'use Fcntl ":flock"; open(F, "<", $ARGV[0]) or die; flock(F, LOCK_EX) or die; $|=1; print "held\\n"; sleep 60', file], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
  return async () => {
    child.kill("SIGKILL");
    await gone;
  };
}

test("a conversation with no lock file is free, and the probe creates none", () => {
  const dir = lockDir();
  assert.equal(probeWriterLock(dir, ID), "free");
  assert.equal(existsSync(path.join(dir, `${ID}.lock`)), false, "the probe never creates the conversation's lock");
});

test("a lock file nobody holds is free: a crashed writer leaves the file, not the lock", () => {
  const dir = lockDir();
  writeFileSync(path.join(dir, `${ID}.lock`), "");
  assert.equal(probeWriterLock(dir, ID), "free");
});

test("a held lock is held, and free the moment its holder exits — however it exits", async (t) => {
  const dir = lockDir();
  const file = path.join(dir, `${ID}.lock`);
  writeFileSync(file, "");
  const release = await holdLock(t, file);
  assert.equal(probeWriterLock(dir, ID), "held");
  assert.equal(probeWriterLock(dir, "01a10951-0000-7000-8000-000000000000"), "free", "another conversation's lock is not this one's");
  await release(); // SIGKILL: no cleanup ran, the kernel dropped the flock
  assert.equal(probeWriterLock(dir, ID), "free");
});

test("a directory with no coordination lock has never had a writer: still answerable", () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "ms-wlock-")), "thread-writer-locks");
  mkdirSync(dir);
  assert.equal(probeWriterLock(dir, ID), "free");
});

test("an id that is not a plain name is never turned into a path", () => {
  const dir = lockDir();
  assert.equal(probeWriterLock(dir, "../escape"), "unknown");
  assert.equal(probeWriterLock(dir, ".coordination"), "unknown");
  assert.equal(probeWriterLock(dir, ""), "unknown");
});

test("no Perl on PATH is unknown, never free", (t) => {
  const was = process.env.PATH;
  t.after(() => { process.env.PATH = was; });
  process.env.PATH = mkdtempSync(path.join(tmpdir(), "ms-empty-path-"));
  assert.equal(probeWriterLock(lockDir(), ID), "unknown");
});

test("the homes' lock directories are read through their links, once each", () => {
  const base = mkdtempSync(path.join(tmpdir(), "ms-wlock-base-"));
  const shared = path.join(base, "thread-writer-locks");
  mkdirSync(shared);
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  const c = path.join(base, "c");
  const none = path.join(base, "none");
  for (const h of [a, b, c, none]) mkdirSync(h);
  symlinkSync(shared, path.join(a, "thread-writer-locks"));
  symlinkSync(shared, path.join(b, "thread-writer-locks"));
  mkdirSync(path.join(c, "thread-writer-locks")); // a home that never got linked
  assert.deepEqual(
    writerLockDirs([a, b, c, none]).sort(),
    [realpathSync(shared), realpathSync(path.join(c, "thread-writer-locks"))].sort(),
  );
});

test("held in ANY of the directories is held", async (t) => {
  const one = lockDir();
  const two = lockDir();
  writeFileSync(path.join(two, `${ID}.lock`), "");
  const release = await holdLock(t, path.join(two, `${ID}.lock`));
  assert.equal(probeConversation([one, two], ID), "held");
  await release();
  assert.equal(probeConversation([one, two], ID), "free");
});

test("the wait returns as soon as the holder lets go", async (t) => {
  const dir = lockDir();
  const file = path.join(dir, `${ID}.lock`);
  writeFileSync(file, "");
  const release = await holdLock(t, file);
  setTimeout(() => void release(), 300);
  const t0 = performance.now();
  assert.equal(await waitForWriterRelease([dir], ID, 10_000, 50), "free");
  const took = performance.now() - t0;
  assert.ok(took >= 250 && took < 5_000, `waited ${took}ms`);
});

test("the wait gives up at its budget and says the lock is still held", async (t) => {
  const dir = lockDir();
  const file = path.join(dir, `${ID}.lock`);
  writeFileSync(file, "");
  await holdLock(t, file);
  assert.equal(await waitForWriterRelease([dir], ID, 300, 50), "held");
});

test("the lock card and the read-only refusal are both recognised; an ordinary screen is not", () => {
  assert.equal(showsLockCard("🔒 This conversation is open in another app — Close it there and press R to continue here"), true);
  assert.equal(showsLockCard("■ This conversation is read-only or unavailable; no operation was sent."), true);
  assert.equal(showsLockCard("❯ ship it\n\n  Done.\n\n❯ "), false);
  assert.equal(showsLockCard("You've hit your usage limit."), false);
});
