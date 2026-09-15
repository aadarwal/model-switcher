import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { ensureStore, p } from "./paths.ts";

/**
 * Cross-process locks for the short-lived `ms` processes (hook-dispatched
 * recovery workers, manual verbs, status) that must not mutate the same
 * session or refresh the same credential at once.
 *
 * The lock is a directory: `mkdir` is a single atomic create-or-fail on one
 * filesystem, needs no daemon, and leaves something a human can see. Inside it
 * a `holder` file records `<pid> <epochSeconds>` so an abandoned lock can be
 * told from a live one, and so `release` can refuse to remove a lock that now
 * belongs to somebody else.
 */

/** Idempotent; removes the lock dir only while this acquisition still holds it. */
export type Release = () => void;

/** `withLock` gave up waiting: another process holds the name. */
export class Locked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Locked";
  }
}

export type AcquireOptions = {
  /** A lock whose holder is dead, or older than this, is abandoned and
   * reclaimed. Default 10 minutes — longer than any transaction in §9. */
  staleAfterMs?: number;
  /**
   * Test seam. Runs after a stale dir has been renamed aside and before the
   * moved-aside copy is re-validated, so a test can play the process that
   * raced the reclaim. Production callers never set it.
   */
  _afterRename?: (moved: string, dir: string) => void;
};

export type WithLockOptions = AcquireOptions & { waitMs?: number; pollMs?: number };

export const DEFAULT_STALE_MS = 600_000;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 100;

/**
 * No dots, so a reclaim's `<name>.stale.<pid>.<rand>` sibling can never collide
 * with a real lock name, and no separators, so a name coming from a session id
 * cannot walk out of `locks/`.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid lock name ${JSON.stringify(name)}`);
  return name;
}

type Holder = { pid: number; since: number };

/** The `holder` file's line, verbatim, or null when there is none to read. */
function readHolderLine(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, "holder"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function parseHolder(line: string | null): Holder | null {
  const m = line === null ? null : /^(\d+) (\d+)$/.exec(line);
  if (!m) return null;
  const pid = Number(m[1]);
  const sec = Number(m[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(sec)) return null;
  return { pid, since: sec * 1000 };
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

function mtimeMs(dir: string): number | null {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Who holds `name` right now, for status and reconciliation. `since` is epoch
 * milliseconds (the holder file records whole seconds, so it is second-granular).
 * Null also covers a lock dir whose holder is missing or unreadable — held,
 * but naming nobody.
 */
export function lockedBy(name: string): Holder | null {
  return parseHolder(readHolderLine(p.lockDir(checkName(name))));
}

/** Create the dir and claim it, or null if it already exists. */
function claim(dir: string): Release | null {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  const line = `${process.pid} ${Math.floor(Date.now() / 1000)}`;
  try {
    writeFileSync(path.join(dir, "holder"), line + "\n", { mode: 0o600 });
  } catch (e) {
    // We own the dir but cannot name ourselves in it. Take it back down rather
    // than leave an anonymous lock that nothing can reclaim for staleAfterMs.
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only ours to remove. If a reclaim decided we were dead and handed the
    // name on, the dir under it belongs to the new holder.
    if (readHolderLine(dir) !== line) return;
    rmSync(dir, { recursive: true, force: true });
  };
}

function isStale(dir: string, held: Holder | null, staleAfterMs: number): boolean {
  if (held) return !alive(held.pid) || Date.now() - held.since > staleAfterMs;
  // No readable holder: either a lock mid-acquire (the dir exists, the holder
  // is a moment away) or wreckage. Its own mtime is the only age we have.
  const m = mtimeMs(dir);
  return m !== null && Date.now() - m > staleAfterMs;
}

/** Is the moved-aside copy still exactly the acquisition we judged stale? */
function stillStale(moved: string, line: string | null, held: Holder | null, staleAfterMs: number): boolean {
  if (readHolderLine(moved) !== line) return false;
  if (held) return true;
  // The holder-less case has no identity to compare, so it must still be
  // holder-less AND still old — a dir created since our judgement is young.
  const m = mtimeMs(moved);
  return m !== null && Date.now() - m > staleAfterMs;
}

/**
 * Take an abandoned lock away from its dead holder. The `rename` is the atomic
 * step: exactly one racer can move a given dir aside, so the others fail here
 * rather than both deleting and both re-creating. But winning the rename only
 * proves we moved *something*; between judging the holder stale and renaming,
 * that holder may have released and a live process taken the name. So the
 * moved-aside copy is re-validated, and put back when it is not the one we
 * judged.
 */
function reclaim(
  dir: string,
  line: string | null,
  held: Holder | null,
  staleAfterMs: number,
  afterRename?: (moved: string, dir: string) => void,
): boolean {
  const moved = `${dir}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(dir, moved);
  } catch {
    return false; // another reclaimer moved it first, or the holder released it
  }
  afterRename?.(moved, dir);
  if (!stillStale(moved, line, held, staleAfterMs)) {
    // Put it back — but only onto a free name. `rename(2)` onto an existing
    // directory does not fail if that directory is EMPTY: it silently replaces
    // it (verified on macOS; a non-empty target gives ENOTEMPTY). An empty lock
    // dir is exactly what a live process mid-acquire looks like, so moving back
    // without checking would delete a lock somebody else has just taken. If the
    // name is taken again, the copy stays where it is, visible under a
    // `.stale.` name, rather than corrupting the new holder's lock. The check
    // still races the move in principle; the throw is caught for the rest.
    if (!existsSync(dir)) {
      try {
        renameSync(moved, dir);
      } catch {
        /* the name was taken between the check and the move */
      }
    }
    return false;
  }
  rmSync(moved, { recursive: true, force: true });
  return true;
}

/**
 * Take the lock `name`, or return null if another process holds it. Never
 * blocks; `withLock` is the waiting form.
 */
export function acquire(name: string, opts: AcquireOptions = {}): Release | null {
  checkName(name);
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  const dir = p.lockDir(name);
  ensureStore();

  const mine = claim(dir);
  if (mine) return mine;

  const line = readHolderLine(dir);
  const held = parseHolder(line);
  if (!isStale(dir, held, staleAfterMs)) return null;
  if (!reclaim(dir, line, held, staleAfterMs, opts._afterRename)) return null;
  // The name is free, but only for as long as it takes to say so.
  return claim(dir);
}

/**
 * Run `fn` holding `name`, waiting up to `waitMs` for the current holder and
 * polling every `pollMs`. Throws `Locked` if the wait runs out. The lock is
 * released however `fn` ends.
 */
export async function withLock<T>(name: string, fn: () => T | Promise<T>, opts: WithLockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = acquire(name, opts);
    if (release) {
      try {
        return await fn();
      } finally {
        release();
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const by = lockedBy(name);
      const who = by ? ` (pid ${by.pid}, since ${new Date(by.since).toISOString()})` : "";
      throw new Locked(`another process holds the '${name}' lock${who}`);
    }
    await sleep(Math.min(pollMs, left));
  }
}
