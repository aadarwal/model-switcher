// src/reconcile.ts
//
// Reconciliation (spec §9) and the `pane-died` hook.
//
// Nothing of ours stays resident: a recovery worker is a short-lived process
// tmux dispatched, the timers are tmux's, and the state is a SQLite file. So
// there is no daemon to notice that a worker was killed mid-handoff, that the
// tmux server was restarted under a session, or that a scheduled wake-up came
// due while the Mac was asleep. Instead EVERY public `ms` invocation starts by
// repairing what it finds — the cost is a few bounded tmux calls against a
// handful of rows, and the guarantee is that no crash can leave the store
// permanently lying about what is running.
//
// Three rules keep a repair from becoming the damage:
//
//   1. **Nothing is repaired without the session's lock.** `src/recover.ts`
//      runs its whole handoff under `withLock("session-<token>")`; every repair
//      here takes the SAME name, non-blocking, and re-reads the row inside it.
//      A session a live worker is holding is not a session in need of repair —
//      reconciliation steps over it and says so.
//   2. **Absence must be confirmed, never assumed.** A tmux call that fails —
//      no server, no tmux on PATH, a timeout — proves nothing about a pane. It
//      is recorded as "could not inspect" and repairs nothing. Only a
//      SUCCESSFUL query that shows a different server, or a pane list without
//      our pane in it, is evidence a session is over.
//   3. **Every write is conditional on what was judged.** Ownership is
//      released only for the exact owner/timestamp read (`releaseRecoveryIf`),
//      and a wake-up cleared only for the exact deadline consumed
//      (`clearWakeupIf`), so a worker that moved first is never overwritten.
//
// `reconcile()` never throws for a reason the caller should care about: each
// repair is independent, and a failure in one is recorded in the returned list
// rather than allowed to abort the rest (the CLI wraps the whole call in a
// try/catch too — a repair must never block the verb the human asked for).

import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { appendEvent, readEvents } from "./events.ts";
import type { Verb } from "./cli.ts"; // type-only: erased, no import cycle at runtime
import { acquire, sweepStaleLocks } from "./lock.ts";
import { ensureSessionDir, msBinary, p } from "./paths.ts";
import { openState, type RecoveryRow, type SessionRow, type State } from "./state.ts";
import { Tmux } from "./tmux.ts";

/** A recovery owned this long by a worker that is gone is not coming back.
 * Longer than the whole transaction's own budget in §9 (readiness polling caps
 * at 60 s), so a live-but-slow worker is never stolen from. */
const OWNED_STALE_SECONDS = 600;
/** A handoff or a launch that has not produced its event in this long has
 * failed in a way nothing else will report: park it for the human. */
const STUCK_SECONDS = 300;
/**
 * The dispatch grace for a `pending` recovery with nobody on it. The hook
 * writes the row and THEN asks tmux to run the worker, and the worker then has
 * to start Node and take the lock; a row younger than this is simply one whose
 * worker is still on its way. Past it, with no owner and no timer, nobody is
 * coming — that is the crashed-hook and the failed-dispatch case.
 */
const PENDING_GRACE_SECONDS = 30;
/**
 * A `stopping` row younger than this is a handoff in flight. The lock is the
 * primary evidence (a worker inside its transaction holds it), and this is the
 * second: the narrow window around the worker's own writes, where it may have
 * released the lock but the store has not caught up.
 */
const HANDOFF_GRACE_SECONDS = 120;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The lock `src/recover.ts` takes for a whole handoff
 * (`withLock("session-<lockToken(id)>")`). Reconciliation and the pane-died
 * hook take the same name so no repair can interleave with a live worker's
 * read-decide-write.
 *
 * The derivation is duplicated from recover.ts's private `lockToken` on
 * purpose — a lock name is an interface, and `test/reconcile.test.ts` holds
 * THIS name and watches a real `recoverSession` refuse, so the two cannot
 * drift apart silently.
 */
export const sessionLockName = (id: string): string => `session-${id.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 48)}`;

/** EPERM means the pid exists and belongs to another user; only ESRCH is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * `RecoveryRow.owner` is `"<pid>@<host>"`. A pid is only meaningful on the
 * machine that minted it, so an owner naming a DIFFERENT host is reported
 * alive: we cannot ask that kernel, and stealing its recovery would give one
 * session two workers. `ms` is a single-device tool today — the host half of
 * the owner string is what keeps this honest if that ever changes.
 * An unparseable or missing owner is dead: an `owned` row with no usable owner
 * can only have come from a crash.
 */
function ownerDead(owner: string | null): boolean {
  if (!owner) return true;
  const at = owner.lastIndexOf("@");
  const host = at < 0 ? "" : owner.slice(at + 1);
  if (host && host !== hostname()) return false;
  const pid = Number(at < 0 ? owner : owner.slice(0, at));
  if (!Number.isInteger(pid) || pid <= 0) return true;
  return !alive(pid);
}

/** What one successful look at a tmux server saw. `identity`/`panes` are null
 * when the question could not be answered at all — never "nothing there". */
type Look = { identity: string | null; panes: Set<string> | null; note: string | null };

/** Where a session's pane is, as far as we can HONESTLY tell. */
type Presence = "present" | "absent" | "unknown";

/** One look per socket, however many sessions share it: every tmux call is a
 * subprocess, and reconciliation runs on every public verb. A look that failed
 * is cached too — so a broken socket costs one failed call, not one per
 * session, and (because a failure is `unknown`) repairs nothing either way. */
class Servers {
  private clients = new Map<string, Tmux>();
  private looks = new Map<string, Look>();

  tmux(socket: string): Tmux {
    let t = this.clients.get(socket);
    if (!t) {
      t = new Tmux(socket || null);
      this.clients.set(socket, t);
    }
    return t;
  }

  look(socket: string): Look {
    let look = this.looks.get(socket);
    if (!look) {
      look = this.probe(socket);
      this.looks.set(socket, look);
    }
    return look;
  }

  private probe(socket: string): Look {
    const where = socket || "the default socket";
    const t = this.tmux(socket);
    let identity: string | null = null;
    try {
      identity = t.serverIdentity().trim() || null;
    } catch {
      identity = null;
    }
    // A server that will not name itself is a server we cannot reason about:
    // `tmux` may be missing, the call may have timed out, or the server may
    // really be gone — and those are not the same fact.
    if (identity === null) return { identity: null, panes: null, note: `could not read the tmux server on ${where}; nothing repaired there` };
    const r = t.run(["list-panes", "-a", "-F", "#{pane_id}"]);
    if (r.code !== 0) return { identity, panes: null, note: `could not list panes on ${where}; nothing repaired there` };
    return { identity, panes: new Set(r.stdout.split("\n").map((x) => x.trim()).filter(Boolean)), note: null };
  }
}

/**
 * Is this session's pane still there? Three ways to be sure it is not: the
 * server names itself as a DIFFERENT server (pane ids are per server, so `%7`
 * on a restarted one is a stranger's pane — never touch it), or the pane is
 * not in a list we actually got. Anything we could not ask is `unknown`.
 *
 * A session with no pane yet (the outside-tmux launch, between writing the row
 * and tmux naming the pane) has nothing to confirm; rule (f) catches it if the
 * pane never arrives.
 */
function presenceOf(s: SessionRow, look: Look): Presence {
  if (!s.pane) return "unknown";
  if (look.identity === null || look.panes === null) return "unknown";
  if (s.serverStart && look.identity !== s.serverStart) return "absent";
  return look.panes.has(s.pane) ? "present" : "absent";
}

/** True only when tmux SAID this pane is dead; `null` (could not ask) is not a
 * death. Says nothing about whether the pane is OURS — `presenceOf` is that
 * question, and both answers are needed before anything respawns. */
function paneIsDead(servers: Servers, s: SessionRow): boolean {
  return servers.tmux(s.socket).paneDead(s.pane) === true;
}

/** One durable line in the session's own log, for repairs the human will want
 * an account of later (a park is a decision, not a detail). Best effort: a log
 * that cannot be written must not cost the repair itself. */
function log(session: string, generation: number, text: string): void {
  try {
    ensureSessionDir(session);
    appendFileSync(p.recoverLog(session), `${new Date().toISOString()} reconcile (generation ${generation}): ${text}\n`, { mode: 0o600 });
  } catch {
    /* the store row is the load-bearing record */
  }
}

function park(st: State, s: SessionRow, why: string): string {
  st.updateSession(s.id, { state: "parked" });
  log(s.id, s.generation, `parked: ${why}`);
  return `session ${s.id}: ${why}, parked`;
}

/** Give the pane back to the human as their login shell. Only ever called for
 * a pane we have just confirmed is dead. */
function respawnShell(servers: Servers, s: SessionRow): void {
  try {
    servers.tmux(s.socket).respawn(s.pane, s.cwd, [process.env.SHELL || "/bin/zsh", "-l"]);
  } catch {
    /* the pane went away between the check and the respawn; the row is what matters */
  }
}

/** A session that is over: no worker may act on it again. */
function closeOut(st: State, s: SessionRow): void {
  const rec = st.pendingRecovery(s.id);
  if (rec) st.finishRecovery(rec.id, "obsolete");
  if (s.wakeupAt !== null) st.clearWakeupIf(s.id, s.wakeupAt);
  st.updateSession(s.id, { state: "stopped" });
}

/** (c) The pane is gone, so the session is over however it ended. */
function stopGone(st: State, s: SessionRow): string[] {
  closeOut(st, s);
  log(s.id, s.generation, `pane ${s.pane} is gone; marked stopped`);
  return [`session ${s.id}: pane ${s.pane} is gone, marked stopped`];
}

/** Is a `stopping` row a handoff still in flight? We already hold the session
 * lock, so a worker INSIDE its transaction cannot be here at all; these two
 * tests cover the window around its writes. */
function handoffIsLive(st: State, s: SessionRow, rec: RecoveryRow | null): boolean {
  if (nowSeconds() - s.updatedAt <= HANDOFF_GRACE_SECONDS) return true;
  return !!rec && rec.status === "owned" && !ownerDead(rec.owner);
}

/**
 * (g) A handoff abandoned in `stopping`. The worker set that state, asked the
 * CLI to leave, and never came back — so the pane is very likely a corpse and
 * the store says a rotation is in progress that is not.
 *
 * What the human asked for decides: a `stopped` desire is the promise `ms stop`
 * made (give the pane back as a shell), and a `running` desire means a rotation
 * vanished mid-flight, which is a death to be looked at, not a clean stop.
 */
function abandonedStopping(st: State, servers: Servers, s: SessionRow, presence: Presence): string[] {
  const rec = st.pendingRecovery(s.id);
  if (handoffIsLive(st, s, rec)) return [];
  if (s.desired === "stopped") {
    if (presence === "present" && paneIsDead(servers, s)) respawnShell(servers, s);
    closeOut(st, s);
    log(s.id, s.generation, "handoff abandoned while stopping; the stop stands");
    return [`session ${s.id}: abandoned mid-stop, marked stopped`];
  }
  try {
    appendEvent({ t: nowSeconds(), kind: "died", session: s.id, generation: s.generation, cliSessionId: s.cliSessionId });
  } catch {
    /* the state change below is the load-bearing record */
  }
  return [park(st, s, "abandoned mid-handoff with no live worker")];
}

/**
 * (b) A recovery still marked `owned` by a worker that no longer exists.
 *
 * Only `owned` rows are reclaimed here; a `pending` one is not an orphan by
 * this rule — see `redispatchOrphan`, which knows about timers.
 */
function reclaimRecovery(st: State, servers: Servers, s: SessionRow, rec: RecoveryRow | null): string[] {
  if (!rec || rec.status !== "owned") return [];
  if (nowSeconds() - rec.updatedAt <= OWNED_STALE_SECONDS) return [];
  if (!ownerDead(rec.owner)) return [];
  // Conditional on exactly the row that was judged: between reading it and
  // asking the kernel about that pid, a real worker may have claimed it.
  if (!st.releaseRecoveryIf(rec.id, { owner: rec.owner, updatedAt: rec.updatedAt })) {
    return [`session ${s.id}: recovery ${rec.id} moved under us, left to its owner`];
  }
  // Released BEFORE dispatching: the worker tmux starts can only take a row
  // that is `pending`. A dispatch that fails leaves the row pending and says
  // so — and `redispatchOrphan` picks it up on a later invocation.
  servers.tmux(s.socket).runShell([msBinary(), "_recover", s.id]);
  log(s.id, s.generation, `recovery ${rec.id} was owned by a dead worker (${rec.owner}); re-dispatched`);
  return [`session ${s.id}: recovery ${rec.id} abandoned by a dead worker (${rec.owner}), re-dispatched`];
}

/**
 * (5) A `pending` recovery with nobody on it and no timer coming.
 *
 * A pending row is normally SOMEONE's: either a worker is about to take it (the
 * hook writes the row, then asks tmux to run the worker), or §9 step 3 released
 * it and armed a tmux timer, recording the deadline as the session's wake-up.
 * A row with no owner, no wake-up, and more than the dispatch grace behind it
 * is neither — that is a hook killed between its two writes, a `run-shell` that
 * failed, or a worker that parked the session and released (recover.ts names
 * this reconciliation as the thing that picks it back up).
 *
 * Sessions with a wake-up are left entirely to rule (d), so one due recovery is
 * never dispatched twice in one pass.
 */
function redispatchOrphan(st: State, servers: Servers, s: SessionRow, rec: RecoveryRow | null): string[] {
  if (!rec || rec.status !== "pending" || rec.owner !== null) return [];
  if (s.wakeupAt !== null) return [];
  if (nowSeconds() - rec.updatedAt <= PENDING_GRACE_SECONDS) return [];
  servers.tmux(s.socket).runShell([msBinary(), "_recover", s.id]);
  log(s.id, s.generation, `recovery ${rec.id} was pending with no worker and no timer; dispatched`);
  return [`session ${s.id}: recovery ${rec.id} had no worker and no timer, dispatched`];
}

/** (e)/(f) A transition that never completed. The event log is the only
 * witness — the CLI's own hooks write it — so "no event for THIS generation"
 * is the test, never the newest event of any generation. */
function stuck(st: State, s: SessionRow): string[] {
  const resuming = s.state === "resuming" || s.state === "continuing";
  const launching = s.state === "launching";
  if (!resuming && !launching) return [];
  if (nowSeconds() - s.updatedAt <= STUCK_SECONDS) return [];
  const events = readEvents(s.id).filter((e) => e.generation === s.generation);
  const minutes = STUCK_SECONDS / 60;
  if (resuming) {
    if (events.some((e) => e.kind === "resumed")) return [];
    return [park(st, s, `${s.state} for over ${minutes} minutes with no resumed event`)];
  }
  if (events.some((e) => e.kind === "started")) return [];
  return [park(st, s, `launching for over ${minutes} minutes with no started event`)];
}

/** (d) A wake-up scheduled by a recovery that ran out of accounts. tmux holds
 * the timer, but a tmux restart (or a sleeping Mac) loses it — this is the
 * other half of that promise. */
function wakeups(st: State, servers: Servers): string[] {
  const out: string[] = [];
  for (const scanned of st.dueWakeups(nowSeconds())) {
    const release = acquire(sessionLockName(scanned.id));
    if (!release) {
      out.push(`session ${scanned.id}: a worker holds it, wake-up left for them`);
      continue;
    }
    try {
      // Re-read: the scan is a snapshot, and the row may have moved on.
      const s = st.getSession(scanned.id);
      if (!s || s.wakeupAt === null || s.wakeupAt > nowSeconds()) continue;
      const deadline = s.wakeupAt;
      if (s.desired === "stopped" || s.state === "stopped") {
        if (st.clearWakeupIf(s.id, deadline)) out.push(`session ${s.id}: stopped, stale wake-up cleared`);
        continue;
      }
      // Dispatch first: a deadline cleared by a dispatch that then failed is a
      // promise silently dropped. Clearing after means the worst case is one
      // repeat on the next invocation.
      servers.tmux(s.socket).runShell([msBinary(), "_recover", s.id]);
      if (st.clearWakeupIf(s.id, deadline)) {
        log(s.id, s.generation, "wake-up was due; dispatched _recover");
        out.push(`session ${s.id}: wake-up was due, dispatched _recover`);
      } else {
        out.push(`session ${s.id}: wake-up was due, dispatched _recover (a newer deadline was scheduled meanwhile)`);
      }
    } catch (e) {
      out.push(`session ${scanned.id}: wake-up dispatch failed: ${reason(e)}`);
    } finally {
      release();
    }
  }
  return out;
}

/**
 * Repair everything a crashed worker, a restarted tmux server or a closed pane
 * left behind, and return one line per repair — or per deliberate abstention,
 * which is just as much a thing reconciliation did. The CLI prints them under
 * `MS_VERBOSE=1`. Empty means there was nothing to do.
 */
export function reconcile(): string[] {
  const out: string[] = [];

  // (a) Locks outlive the process that took them; a holder that is gone holds
  // nothing. (Age alone is NOT stale here: a slow holder is still a holder —
  // `acquire`'s own staleAfterMs handles that case for the caller that waits.)
  // First, so a session whose worker died is lockable in this same pass.
  try {
    for (const name of sweepStaleLocks()) out.push(`lock '${name}': holder is dead, removed`);
  } catch (e) {
    out.push(`locks: sweep failed: ${reason(e)}`);
  }

  const st = openState();
  try {
    const servers = new Servers();
    const noted = new Set<string>();
    for (const scanned of st.listSessions()) {
      if (scanned.state === "stopped") continue; // already reconciled; say it once
      const release = acquire(sessionLockName(scanned.id));
      if (!release) {
        // A worker is inside its transaction. Whatever we think we know about
        // this session is older than what it is doing.
        out.push(`session ${scanned.id}: a worker holds it, left alone`);
        continue;
      }
      try {
        // Everything below reads the row as it is NOW, under the lock.
        const s = st.getSession(scanned.id);
        if (!s || s.state === "stopped") continue;
        const look = servers.look(s.socket);
        if (look.note && !noted.has(s.socket)) {
          noted.add(s.socket);
          out.push(look.note);
        }
        const presence = presenceOf(s, look);
        if (presence === "absent") {
          out.push(...stopGone(st, s)); // (c) — nothing else is worth asking about a gone pane
          continue;
        }
        if (s.state === "stopping") {
          out.push(...abandonedStopping(st, servers, s, presence)); // (g)
          continue;
        }
        const rec = st.pendingRecovery(s.id);
        out.push(...reclaimRecovery(st, servers, s, rec)); // (b)
        out.push(...redispatchOrphan(st, servers, s, rec)); // (5)
        out.push(...stuck(st, s)); // (e), (f)
      } catch (e) {
        out.push(`session ${scanned.id}: reconcile failed: ${reason(e)}`);
      } finally {
        release();
      }
    }
    // (d) last: a session (c) just stopped has had its wake-up cleared
    // already, so this never dispatches a worker into a pane that is gone.
    out.push(...wakeups(st, servers));
  } finally {
    st.close();
  }
  return out;
}

/**
 * `ms _pane_died <session>` — tmux's `pane-died` hook, set on the pane at
 * launch. It fires when the managed CLI exits and `remain-on-exit` holds the
 * pane open, which happens for two very different reasons:
 *
 *   * The human ended it (`/exit`, logout, a `/clear` that restarts the CLI):
 *     Claude Code's own SessionEnd hook has already written an `ended` event
 *     for this generation. Give the pane back as a login shell and record the
 *     session as stopped.
 *   * It died (a crash, a kill, an `ms _exec` that could not start): there is
 *     no `ended` event. Append `died`, park the session, and LEAVE the dead
 *     pane exactly as it is — its last screen is the only evidence of why, and
 *     the human decides what to do with it (`ms status` shows it parked).
 *
 * The notification carries only a session id, never the identity of the
 * process that died, and tmux may deliver it late or twice. So nothing happens
 * until the pane about to be acted on has been FENCED: taken under the session
 * lock, re-read, and confirmed on the session's own socket to be on the same
 * server, present, and actually dead. A late callback for a generation that is
 * over finds a live pane and does nothing; and because the shell respawn makes
 * the pane live again, a second delivery for one death does nothing either.
 * That is the once-only guarantee — it is the pane's own state, not a flag.
 *
 * Never prints: tmux runs this detached and nobody would read it.
 */
export function paneDiedSession(id: string): number {
  // A worker holding this session owns the pane: `ms _recover` kills the CLI
  // itself (step 6) and its own respawn is what revives the pane. Acting here
  // would clobber the rotation. If that worker dies, reconciliation repairs it.
  const release = acquire(sessionLockName(id));
  if (!release) return 0;
  try {
    const st = openState();
    try {
      const s = st.getSession(id);
      if (!s || !s.pane || s.state === "stopped") return 0; // not ours, or already swept
      const servers = new Servers();
      const presence = presenceOf(s, servers.look(s.socket));
      // "absent" is a confirmed-gone pane: there is nothing to respawn into,
      // and reconciliation's rule (c) is what closes that session out.
      // "unknown" is a question we could not ask — never a licence to act.
      if (presence !== "present") return 0;
      if (!paneIsDead(servers, s)) return 0; // something is running in it: not this death

      if (s.state === "stopping") {
        // The worker that asked the CLI to leave is gone; `abandonedStopping`
        // is the one place that decides what an interrupted handoff becomes.
        abandonedStopping(st, servers, s, presence);
        return 0;
      }

      const events = readEvents(id).filter((e) => e.generation === s.generation);
      const normalEnd = events[events.length - 1]?.kind === "ended";
      if (s.desired === "stopped" || normalEnd) {
        // Close the row out BEFORE the respawn: a pending recovery would
        // otherwise find a live pane (the shell we are about to put there) and
        // respawn claude over the human's prompt.
        closeOut(st, s);
        respawnShell(servers, s);
        log(id, s.generation, "pane ended normally; the login shell is back and the session is stopped");
        return 0;
      }

      appendEvent({ t: nowSeconds(), kind: "died", session: id, generation: s.generation, cliSessionId: s.cliSessionId });
      st.updateSession(id, { state: "parked" });
      log(id, s.generation, "pane died with no ended event; parked (pane left for inspection)");
      return 0;
    } finally {
      st.close();
    }
  } finally {
    release();
  }
}

export const paneDied: Verb = async ([id]) => {
  if (!id) {
    process.stderr.write("usage: ms _pane_died <session>\n");
    return 2;
  }
  return paneDiedSession(id);
};
