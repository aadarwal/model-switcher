// src/reconcile.ts
//
// Reconciliation (spec §9) and the `pane-died` hook.
//
// Nothing of ours stays resident: a recovery worker is a short-lived process
// tmux dispatched, the timers are tmux's, and the state is a SQLite file.
// So there is no daemon to notice that a worker was killed mid-handoff, that
// the tmux server was restarted under a session, or that a scheduled wake-up
// came due while the Mac was asleep. Instead EVERY public `ms` invocation
// starts by repairing what it finds — the cost is a few bounded tmux calls
// against a handful of rows, and the guarantee is that no crash can leave the
// store permanently lying about what is running.
//
// `reconcile()` therefore never throws for a reason the caller should care
// about: each repair is independent, and a failure in one is recorded in the
// returned list rather than allowed to abort the rest (the CLI wraps the whole
// call in a try/catch too — a repair must never block the verb the human
// actually asked for).

import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { appendEvent, readEvents, type Event } from "./events.ts";
import type { Verb } from "./cli.ts"; // type-only: erased, no import cycle at runtime
import { sweepStaleLocks } from "./lock.ts";
import { ensureSessionDir, msBinary, p } from "./paths.ts";
import { openState, type SessionRow, type State } from "./state.ts";
import { Tmux } from "./tmux.ts";

/** A recovery owned this long by a worker that is gone is not coming back.
 * Longer than the whole transaction's own budget in §9 (readiness polling caps
 * at 60 s), so a live-but-slow worker is never stolen from. */
const OWNED_STALE_SECONDS = 600;
/** A handoff or a launch that has not produced its event in this long has
 * failed in a way nothing else will report: park it for the human. */
const STUCK_SECONDS = 300;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

/** One `Tmux` and one identity probe per socket, however many sessions share
 * it: every tmux call is a subprocess, and reconciliation runs on every verb. */
class Servers {
  private clients = new Map<string, Tmux>();
  private identities = new Map<string, string | null>();

  tmux(socket: string): Tmux {
    let t = this.clients.get(socket);
    if (!t) {
      t = new Tmux(socket || null);
      this.clients.set(socket, t);
    }
    return t;
  }

  /** The server's `pid:start_time`, or null when there is no server there. */
  identity(socket: string): string | null {
    if (!this.identities.has(socket)) {
      let id: string | null = null;
      try {
        id = this.tmux(socket).serverIdentity();
      } catch {
        id = null; // no server on that socket at all
      }
      this.identities.set(socket, id);
    }
    return this.identities.get(socket) ?? null;
  }
}

/**
 * Is the pane this session was launched into gone? Three ways it can be:
 * the server is not running, the server is a DIFFERENT one (pane ids are per
 * server, so `%7` on a restarted server is somebody else's pane — never touch
 * it), or the pane is simply no longer listed.
 *
 * A session with no pane yet (the outside-tmux launch, between the row and
 * tmux naming the pane) is not gone; rule (f) catches it if it never arrives.
 */
function paneGone(s: SessionRow, servers: Servers): boolean {
  if (!s.pane) return false;
  const identity = servers.identity(s.socket);
  if (identity === null) return true;
  if (s.serverStart && identity !== s.serverStart) return true;
  return !servers.tmux(s.socket).paneExists(s.pane);
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

/**
 * (b) A recovery still marked `owned` by a worker that no longer exists.
 *
 * Only `owned` rows: a `pending` one is NOT an orphan to be re-dispatched.
 * That is exactly the shape a recovery takes when every account was out —
 * §9 step 3 releases it, sets a wake-up and asks tmux for a timer — so
 * dispatching it here would race that timer and burn an attempt early. A
 * pending row that lost its timer comes back through rule (d) instead.
 */
function reclaimRecovery(st: State, servers: Servers, s: SessionRow): string[] {
  const rec = st.pendingRecovery(s.id);
  if (!rec || rec.status !== "owned") return [];
  if (nowSeconds() - rec.updatedAt <= OWNED_STALE_SECONDS) return [];
  if (!ownerDead(rec.owner)) return [];
  // Release BEFORE dispatching: the worker tmux starts can only take a row
  // that is `pending`. A dispatch that fails leaves the row pending and says
  // so — `ms status` shows it and `ms rotate` can drive it by hand.
  st.releaseRecovery(rec.id);
  servers.tmux(s.socket).runShell([msBinary(), "_recover", s.id]);
  log(s.id, s.generation, `recovery ${rec.id} was owned by a dead worker (${rec.owner}); re-dispatched`);
  return [`session ${s.id}: recovery ${rec.id} abandoned by a dead worker (${rec.owner}), re-dispatched`];
}

/** (c) The pane is gone, so the session is over however it ended. */
function stopGone(st: State, s: SessionRow): string[] {
  const rec = st.pendingRecovery(s.id);
  if (rec) st.finishRecovery(rec.id, "obsolete");
  st.setWakeup(s.id, null);
  st.updateSession(s.id, { state: "stopped" });
  log(s.id, s.generation, `pane ${s.pane} is gone; marked stopped`);
  return [`session ${s.id}: pane ${s.pane} is gone, marked stopped`];
}

/** (e)/(f) A transition that never completed. The event log is the only
 * witness — the CLI's own hooks write it — so "no event for THIS generation"
 * is the test, never the newest event of any generation. */
function stuck(st: State, s: SessionRow): string[] {
  const resuming = s.state === "resuming" || s.state === "continuing";
  const launching = s.state === "launching";
  if (!resuming && !launching) return [];
  if (nowSeconds() - s.updatedAt <= STUCK_SECONDS) return [];
  const events: Event[] = readEvents(s.id).filter((e) => e.generation === s.generation);
  if (resuming) {
    if (events.some((e) => e.kind === "resumed")) return [];
    return [park(st, s, `${s.state} for over ${STUCK_SECONDS / 60} minutes with no resumed event`)];
  }
  if (events.some((e) => e.kind === "started")) return [];
  return [park(st, s, `launching for over ${STUCK_SECONDS / 60} minutes with no started event`)];
}

/** (d) A wake-up scheduled by a recovery that ran out of accounts. tmux holds
 * the timer, but a tmux restart (or a sleeping Mac) loses it — this is the
 * other half of that promise. */
function wakeups(st: State, servers: Servers): string[] {
  const out: string[] = [];
  for (const s of st.dueWakeups(nowSeconds())) {
    try {
      if (s.desired === "stopped" || s.state === "stopped") {
        st.setWakeup(s.id, null);
        out.push(`session ${s.id}: stopped, stale wake-up cleared`);
        continue;
      }
      // Dispatch first: a wake-up cleared by a dispatch that then failed would
      // be a promise silently dropped. Clearing after means the worst case is
      // one repeat on the next invocation.
      servers.tmux(s.socket).runShell([msBinary(), "_recover", s.id]);
      st.setWakeup(s.id, null);
      log(s.id, s.generation, "wake-up was due; dispatched _recover");
      out.push(`session ${s.id}: wake-up was due, dispatched _recover`);
    } catch (e) {
      out.push(`session ${s.id}: wake-up dispatch failed: ${reason(e)}`);
    }
  }
  return out;
}

/**
 * Repair everything a crashed worker, a restarted tmux server or a closed pane
 * left behind, and return one line per repair (printed by the CLI under
 * `MS_VERBOSE=1`). Empty means there was nothing to do.
 */
export function reconcile(): string[] {
  const out: string[] = [];

  // (a) Locks outlive the process that took them; a holder that is gone holds
  // nothing. (Age alone is NOT stale here: a slow holder is still a holder —
  // `acquire`'s own staleAfterMs handles that case for the caller that waits.)
  try {
    for (const name of sweepStaleLocks()) out.push(`lock '${name}': holder is dead, removed`);
  } catch (e) {
    out.push(`locks: sweep failed: ${reason(e)}`);
  }

  const st = openState();
  try {
    const servers = new Servers();
    for (const s of st.listSessions()) {
      try {
        if (s.state === "stopped") continue; // already reconciled; say it once
        if (paneGone(s, servers)) {
          out.push(...stopGone(st, s)); // (c) — and nothing else is worth asking about a gone pane
          continue;
        }
        out.push(...reclaimRecovery(st, servers, s)); // (b)
        out.push(...stuck(st, s)); // (e), (f)
      } catch (e) {
        out.push(`session ${s.id}: reconcile failed: ${reason(e)}`);
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
 * Never prints: tmux runs this detached and nobody would read it.
 */
export function paneDiedSession(id: string): number {
  const st = openState();
  try {
    const s = st.getSession(id);
    if (!s) return 0; // a pane we did not launch, or a session already swept
    // A handoff owns this pane: `ms _recover` sets `stopping` before asking the
    // CLI to exit, and its own respawn is what revives the pane. Respawning a
    // shell here would clobber the rotation. If that worker dies mid-flight,
    // rule (e) parks the session on the next invocation.
    if (s.state === "stopping") return 0;

    const events = readEvents(id).filter((e) => e.generation === s.generation);
    const normalEnd = events[events.length - 1]?.kind === "ended";
    if (s.desired === "stopped" || normalEnd) {
      st.updateSession(id, { state: "stopped" });
      st.setWakeup(id, null);
      // A pending recovery would otherwise find a live pane (the shell we are
      // about to put there) and respawn claude over the human's prompt.
      const rec = st.pendingRecovery(id);
      if (rec) st.finishRecovery(rec.id, "obsolete");
      try {
        if (s.pane) new Tmux(s.socket || null).respawn(s.pane, s.cwd, [process.env.SHELL || "/bin/zsh", "-l"]);
      } catch {
        /* the pane went away between the hook and us; the row is what matters */
      }
      return 0;
    }

    appendEvent({ t: nowSeconds(), kind: "died", session: id, generation: s.generation, cliSessionId: s.cliSessionId });
    st.updateSession(id, { state: "parked" });
    log(id, s.generation, "pane died with no ended event; parked (pane left for inspection)");
    return 0;
  } finally {
    st.close();
  }
}

export const paneDied: Verb = async ([id]) => {
  if (!id) {
    process.stderr.write("usage: ms _pane_died <session>\n");
    return 2;
  }
  return paneDiedSession(id);
};
