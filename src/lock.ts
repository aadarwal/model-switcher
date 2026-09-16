import { chmodSync, closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { ensureStore, msHome } from "./paths.ts";

/**
 * Cross-process locks for the short-lived `ms` processes (hook-dispatched
 * recovery workers, manual verbs, status) that must not mutate the same session
 * or refresh the same credential at once.
 *
 * A lock is one row in `MS_HOME/locks.sqlite` — deliberately NOT the main
 * `state.sqlite`, so nothing here touches State's WAL or its schema. Every
 * operation is a single SQLite transaction opened with `BEGIN IMMEDIATE`, which
 * takes the database's write lock before reading. SQLite permits exactly one
 * such writer at a time, so read-decide-write is indivisible: no other process
 * can observe or change a lock row between our SELECT and our INSERT/UPDATE.
 *
 * That is the whole point of the design. An earlier version built the lock from
 * `mkdir` plus a `rename`-aside reclaim, and review found three interleavings it
 * could not survive. Each is impossible here, for the same single reason:
 *
 *   1. **Reclaim against a fresh owner.** B reads a stale row for S; A reclaims
 *      it and pauses; C acquires; B, still acting on what it read, hands the
 *      lock to itself — two owners. Here B's read and B's write are inside one
 *      `BEGIN IMMEDIATE` transaction, so B cannot have read before A's commit
 *      and written after C's: it re-reads under the write lock and finds C.
 *   2. **Rollback clobbering a new owner.** The directory version undid a failed
 *      reclaim with `existsSync` then `rename`, and `rename(2)` onto an *empty*
 *      directory silently replaces it — deleting a lock another process had
 *      just taken. There is no rollback-by-hand here: a transaction that does
 *      not commit leaves the row exactly as it was.
 *   3. **Release deleting someone else's lock.** The directory version read the
 *      holder and then removed the path, and a reclaimer could take a fresh
 *      lock between the two. `release()` is one conditional statement —
 *      `DELETE ... WHERE name = ? AND pid = ?` — so a row whose pid is no longer
 *      ours is not matched, and cannot be deleted.
 *
 * **A busy database is not a failure.** Every transaction here lasts
 * microseconds, so `busy_timeout` is short (250 ms) and a `BEGIN IMMEDIATE`
 * that still comes back SQLITE_BUSY means only that another `ms` process was
 * mid-transaction: nothing of ours was read, let alone written. `acquire`
 * reports it as `Locked` rather than letting `database is locked` escape as a
 * bare Error, and `withLock` treats it as a reason to retry inside its own
 * deadline — so a waiter's total wait stays the one its caller asked for
 * instead of becoming `waitMs` plus a hidden multiple of the busy timeout.
 *
 * `since` is unix SECONDS, the store's convention.
 */

/** Idempotent; deletes this process's lock row, and only its own. */
export type Release = () => void;

/**
 * Either another process holds the name, or the lock database was too busy to
 * find out. Both mean the same thing to a caller: you did not get the lock.
 */
export class Locked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Locked";
  }
}

export type Holder = { pid: number; since: number };

export type AcquireOptions = {
  /** A lock whose owner is dead, or older than this, is abandoned and taken.
   * Default 10 minutes — longer than any transaction in §9. */
  staleAfterMs?: number;
};

export type WithLockOptions = AcquireOptions & { waitMs?: number; intervalMs?: number };

export const DEFAULT_STALE_MS = 600_000;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 100;
/** Short on purpose: see "A busy database is not a failure" above. */
const BUSY_TIMEOUT_MS = 250;

const SCHEMA = "CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, since INTEGER NOT NULL)";

/** A lock name is a primary key and appears in error messages: keep it a plain,
 * predictable token so nothing derived from a session id can surprise us. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid lock name ${JSON.stringify(name)}`);
  return name;
}

function lockDbFile(): string {
  return path.join(msHome(), "locks.sqlite");
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6): someone else holds the write lock. */
function isBusy(e: unknown): boolean {
  const err = e as { errcode?: unknown; message?: unknown } | null | undefined;
  if (typeof err?.errcode === "number") return err.errcode === 5 || err.errcode === 6;
  return typeof err?.message === "string" && /database (is locked|table is locked)/i.test(err.message);
}

function busy(name: string): Locked {
  return new Locked(`the lock database is busy; '${name}' was not taken`);
}

/**
 * Open the lock database, run `fn`, and always close. `ms` processes are short
 * lived and these calls are rare (the slowest path polls once per 100 ms), so a
 * per-call handle costs nothing and leaves no state to go stale.
 */
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  ensureStore();
  const file = lockDbFile();
  // Create the file ourselves, at 0600. Letting SQLite create it would make it
  // 0644 first and leave it world-readable until the chmod below lands.
  closeSync(openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec(SCHEMA);
    chmodSync(file, 0o600); // also repairs a file created before the line above
    return fn(db);
  } finally {
    db.close();
  }
}

function readRow(db: DatabaseSync, name: string): Holder | null {
  const raw = db.prepare("SELECT pid, since FROM locks WHERE name = ?").get(name);
  return raw ? { pid: Number(raw.pid), since: Number(raw.since) } : null;
}

/** EPERM means the pid exists and belongs to another user; only ESRCH is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function abandoned(row: Holder, staleAfterMs: number): boolean {
  return !alive(row.pid) || Date.now() - row.since * 1000 > staleAfterMs;
}

/**
 * Who holds `name`, for status and reconciliation. `since` is unix seconds.
 * The row is reported as recorded — a row an `acquire` would reclaim still
 * reads as held, because until someone takes it, it is.
 */
export function lockedBy(name: string): Holder | null {
  checkName(name);
  return withDb((db) => readRow(db, name));
}

/**
 * Take the lock `name`, or return null if another process holds it. Throws
 * `Locked` if the database itself was too busy to decide — also "not acquired",
 * but worth telling apart from a lock that is genuinely held. Never blocks on
 * the lock itself; `withLock` is the waiting form.
 */
export function acquire(name: string, opts: AcquireOptions = {}): Release | null {
  checkName(name);
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  const pid = process.pid;

  const taken = withDb((db) => {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      // Nothing was read and nothing written: there is no transaction to undo.
      if (isBusy(e)) throw busy(name);
      throw e;
    }
    try {
      const row = readRow(db, name);
      if (row && !abandoned(row, staleAfterMs)) {
        db.exec("ROLLBACK");
        return false;
      }
      const now = Math.floor(Date.now() / 1000);
      if (row) db.prepare("UPDATE locks SET pid = ?, since = ? WHERE name = ?").run(pid, now, name);
      else db.prepare("INSERT INTO locks (name, pid, since) VALUES (?, ?, ?)").run(name, pid, now);
      db.exec("COMMIT");
      return true;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction is already finished */
      }
      if (isBusy(e)) throw busy(name);
      throw e;
    }
  });
  if (!taken) return null;

  let released = false;
  return () => {
    if (released) return;
    try {
      withDb((db) => db.prepare("DELETE FROM locks WHERE name = ? AND pid = ?").run(name, pid));
      released = true;
    } catch (e) {
      // Never mask the caller's own error from a `finally`. A row we could not
      // delete is left to the stale rule, and a later release() may still win.
      if (!isBusy(e)) throw e;
    }
  };
}

/**
 * Run `fn` holding `name`, waiting up to `waitMs` for the current holder and
 * retrying every `intervalMs`. The deadline is checked on the monotonic clock
 * BEFORE every attempt, so `fn` is never entered after the wait has expired.
 * Throws `Locked` when it runs out. The lock is released however `fn` ends.
 */
export async function withLock<T>(name: string, fn: () => T | Promise<T>, opts: WithLockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = performance.now() + waitMs;
  for (;;) {
    // Before every attempt, including the first, and on the monotonic clock: an
    // expired wait must never still enter fn, and a wall-clock step must never
    // extend or collapse one. `waitMs: 0` therefore makes no attempt at all —
    // a caller that wants one try and no waiting wants `acquire`.
    if (performance.now() >= deadline) throw locked(name);

    let release: Release | null = null;
    try {
      release = acquire(name, opts);
    } catch (e) {
      // A busy database is a reason to retry, not to fail the caller.
      if (!(e instanceof Locked)) throw e;
    }
    if (release) {
      try {
        return await fn();
      } finally {
        release();
      }
    }

    const left = deadline - performance.now();
    if (left <= 0) throw locked(name);
    // Round the last sleep up. `left` is fractional, and a truncated timer would
    // wake a fraction of a millisecond early, only for the check above to reject
    // the attempt it just paid for — or, worse, to let one through.
    await sleep(Math.ceil(Math.min(intervalMs, left)));
  }
}

function locked(name: string): Locked {
  let by: Holder | null = null;
  try {
    by = lockedBy(name);
  } catch {
    /* a busy or unreadable database names nobody */
  }
  const who = by ? ` (pid ${by.pid}, since ${new Date(by.since * 1000).toISOString()})` : "";
  return new Locked(`another process holds the '${name}' lock${who}`);
}

/**
 * Remove every lock whose holder pid is gone, and report their names. This is
 * reconciliation's (a): `ms` processes are short lived and nothing of ours
 * stays resident, so a killed worker leaves its row behind with no one to
 * clean it up, and the next process to want that name would wait out the full
 * `staleAfterMs` for a holder that cannot come back.
 *
 * Age is deliberately NOT a reason to sweep: a slow holder is still a holder,
 * and only the caller that is actually waiting (via `acquire`'s
 * `staleAfterMs`) may decide a live one has taken too long.
 *
 * One `BEGIN IMMEDIATE` transaction for the whole sweep, so read-decide-delete
 * is indivisible against a concurrent `acquire`; the `pid` predicate on the
 * DELETE is the same belt-and-braces as `release()`.
 */
export function sweepStaleLocks(): string[] {
  return withDb((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const removed: string[] = [];
      for (const raw of db.prepare("SELECT name, pid FROM locks").all()) {
        const name = String(raw.name);
        const pid = Number(raw.pid);
        if (alive(pid)) continue;
        db.prepare("DELETE FROM locks WHERE name = ? AND pid = ?").run(name, pid);
        removed.push(name);
      }
      db.exec("COMMIT");
      return removed;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction is already finished */
      }
      throw e;
    }
  });
}
