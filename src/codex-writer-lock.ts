// src/codex-writer-lock.ts
//
// Who owns a Codex conversation right now, and how long to wait for it to be
// let go.
//
// Since 0.160 a conversation can be OPEN somewhere else, and a relaunch that
// ignores that lands in a TUI that will not work. Every process that writes a
// conversation — a `--no-daemon` TUI, the per-home background server
// (`app-server --managed-daemon`, one per CODEX_HOME), the Codex desktop app's
// own app-server, `codex exec` — goes through Codex's `LocalThreadStore`, and
// that store takes an OS file lock first: `flock(LOCK_EX|LOCK_NB)` on
// `<CODEX_HOME>/thread-writer-locks/<thread-id>.lock`, taken under a blocking
// `flock` of `.coordination.lock` in the same directory. A second writer that
// finds the lock held gets "thread <id> already has an active writer", and the
// TUI turns that into a read-only view of the conversation: "This conversation
// is open in another app — Close it there and press R to continue here", with
// the prompt it was started with left in the composer as an UNSENT draft.
// (codex-rs rust-v0.160.0: rollout/src/writer_lock.rs:17-106,
// thread-store/src/local/mod.rs:339-353, tui/src/app/startup.rs:525-590,
// tui/src/chatwidget/rendering.rs:64,82.)
//
// Every account home of this tool links `thread-writer-locks` at the human's
// own `~/.codex` (src/codex-share.ts), so the lock namespace is ONE across all
// accounts, the human's plain `codex`, and the desktop app. That is not a
// problem to route around: it is the only thing stopping two processes from
// appending to the same rollout.
//
// WHEN THE LOCK GOES:
//   * a `--no-daemon` TUI holds it in its own process: it is gone the instant
//     that process exits, however it exits (the kernel drops a flock with the
//     last descriptor);
//   * a background server holds it for as long as the conversation is LOADED
//     there, which outlives the TUI that asked for it. A server unloads an
//     idle conversation `thread_unload_delay_secs` (default 60) after its last
//     client leaves, with up to 10 s for the shutdown itself
//     (app-server/src/request_processors/thread_lifecycle.rs:56-63, :408-469).
//     There is no request a client can send to unload a conversation another
//     client holds — `thread/unsubscribe` only removes the caller, and the
//     only force paths are `thread/archive` and `thread/delete`, which are
//     destructive. Stopping the server releases it too, and every other
//     conversation that server hosts with it — which is why nothing here ever
//     stops, restarts or signals a server: other panes depend on it.
//
// So the release is WAITING: end only the pane's own CLI, then watch the lock
// until nothing holds it. The watch takes the lock the way Codex itself does
// (`.coordination.lock` blocking, then the conversation's lock non-blocking,
// both closed at once), so a Codex writer that starts during the probe waits
// a few microseconds on the coordination lock instead of failing. Node has no
// `flock`, so the probe is four lines of Perl — on every macOS and essentially
// every Linux — given its paths as ARGV, never as code. Where it cannot run,
// the answer is "unknown" and the caller falls back to what the screen says.

import { spawnSync } from "node:child_process";
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Codex's lock directory inside a CODEX_HOME. */
export const WRITER_LOCK_DIR = "thread-writer-locks";

/** What a probe found: nothing holds it, something does, or it could not be
 *  asked (no Perl, a permission error, a coordination lock held past 5 s). */
export type LockState = "free" | "held" | "unknown";

/**
 * Exit 0: free (no lock file, or one nobody holds). Exit 1: held. Exit 3:
 * could not tell. The conversation's lock file is never CREATED here — a
 * missing file is a conversation nobody has open — and neither is the
 * coordination lock: a directory without one has never had a writer.
 */
const PROBE = String.raw`use strict; use Fcntl qw(:flock O_RDONLY);
my ($coord, $lock) = @ARGV;
$SIG{ALRM} = sub { exit 3 }; alarm 5;
my ($c, $l);
if (sysopen($c, $coord, O_RDONLY)) { flock($c, LOCK_EX) or exit 3; } elsif (!$!{ENOENT}) { exit 3; }
unless (sysopen($l, $lock, O_RDONLY)) { exit($!{ENOENT} ? 0 : 3); }
exit(flock($l, LOCK_EX | LOCK_NB) ? 0 : ($!{EWOULDBLOCK} ? 1 : 3));`;

/** Is the conversation `threadId` held by a writer, as seen from `dir`
 *  (a `thread-writer-locks` directory)? Never throws. */
export function probeWriterLock(dir: string, threadId: string): LockState {
  // An id is a uuid; anything with a separator in it is not one, and must not
  // become a path that walks out of the directory.
  if (!threadId || threadId.includes("/") || threadId.includes("\0") || threadId.startsWith(".")) return "unknown";
  const r = spawnSync("perl", ["-e", PROBE, path.join(dir, ".coordination.lock"), path.join(dir, `${threadId}.lock`)], {
    stdio: "ignore",
    timeout: 10_000,
  });
  if (r.error || r.signal) return "unknown";
  return r.status === 0 ? "free" : r.status === 1 ? "held" : "unknown";
}

/**
 * The lock directories that matter for moving a conversation between the
 * given CODEX_HOMEs: each home's own `thread-writer-locks`, as the real
 * directory it resolves to, once each. They are normally all ONE directory
 * (every home links it at ~/.codex); a home whose link is missing or
 * different is still checked, because a writer there would hold its lock
 * there. A home with no directory at all contributes nothing.
 */
export function writerLockDirs(homes: string[]): string[] {
  const out = new Set<string>();
  for (const home of homes) {
    try {
      out.add(realpathSync(path.join(home, WRITER_LOCK_DIR)));
    } catch {
      /* no lock directory: no writer has ever used this home */
    }
  }
  return [...out];
}

/** One probe over every directory: held anywhere is held, and an answer
 *  that could not be read anywhere makes the whole answer unknown. */
export function probeConversation(dirs: string[], threadId: string): LockState {
  let unknown = false;
  for (const dir of dirs) {
    const s = probeWriterLock(dir, threadId);
    if (s === "held") return "held";
    if (s === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "free";
}

/**
 * Wait until nothing holds `threadId`'s writer lock, or `budgetMs` passes.
 * `unknown` returns at once: there is nothing to wait FOR, and the caller's
 * on-screen check is the fallback. `held` means the budget ran out.
 */
export async function waitForWriterRelease(dirs: string[], threadId: string, budgetMs: number, pollMs: number): Promise<LockState> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const s = probeConversation(dirs, threadId);
    if (s !== "held") return s;
    const left = deadline - performance.now();
    if (left <= 0) return "held";
    await sleep(Math.min(pollMs, left));
  }
}

/**
 * The read-only view, on screen. Codex 0.160 draws "This conversation is open
 * in another app — Close it there and press R to continue here" when it could
 * not take the writer lock, and answers every operation after that with "This
 * conversation is read-only or unavailable; no operation was sent." Either
 * line means the relaunch is NOT the conversation's writer, and that the
 * continuation it was started with was not sent.
 */
const LOCK_CARD = /open in another app|conversation is read-only or unavailable/i;

export function showsLockCard(screen: string): boolean {
  return LOCK_CARD.test(screen);
}

/**
 * Does process `pid` have conversation `threadId`'s writer lock file open?
 * A writer keeps it open for as long as it holds the lock, while a Codex that
 * could not take the lock closes the file at once (writer_lock.rs: the
 * `WouldBlock` arm drops the `File`) — so this is the difference between a
 * TUI that IS the conversation's writer and one showing the read-only card.
 * Null when it cannot be asked (no /proc and no lsof, or the pid is gone).
 * Matched by the `thread-writer-locks/<id>.lock` tail, so it does not depend
 * on how a home's link to the shared directory is spelled.
 */
export function holdsWriterLock(pid: number, threadId: string): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0 || !threadId || threadId.includes("/")) return null;
  const tail = `/${WRITER_LOCK_DIR}/${threadId}.lock`;
  try {
    const fds = readdirSync(`/proc/${pid}/fd`);
    return fds.some((fd) => {
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`).endsWith(tail);
      } catch {
        return false;
      }
    });
  } catch {
    /* no /proc (macOS), or no such process: ask lsof */
  }
  const r = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-F", "n"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.signal || !r.stdout) return null;
  return r.stdout.split("\n").some((l) => l.startsWith("n") && l.endsWith(tail));
}

/**
 * The read-only view, as evidence: the card on screen AND the pane's own
 * process not holding the conversation. The card's words are ordinary text,
 * and a conversation ABOUT this lock — the very conversations that hit it —
 * shows them in its re-rendered history; a TUI that holds the lock is the
 * writer whatever its history says, and ending it would interrupt a turn the
 * continuation already started and send the continuation twice. When the
 * holder cannot be asked (`pid`/`threadId` unknown, no /proc or lsof), the
 * screen alone decides, as before.
 */
export function lockCardMeansReadOnly(screen: string, pid: number | null | undefined, threadId: string | null | undefined): boolean {
  if (!showsLockCard(screen)) return false;
  if (!pid || !threadId) return true;
  return holdsWriterLock(pid, threadId) !== true;
}

/** How long a background server may keep a conversation after its last
 *  client left: Codex's default `thread_unload_delay_secs` (60) plus its
 *  10 s shutdown bound, plus margin. */
export const RELEASE_BUDGET_MS = 75_000;
