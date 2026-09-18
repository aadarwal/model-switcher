// src/hooks/codex-hook.ts
//
// `ms _hook codex` and `ms _codex_watch` — the Codex trigger.
//
// The Claude hook has one job that matters: Claude Code reports a rate limit to
// it directly (`StopFailure` with `error: "rate_limit"`), so the wall announces
// itself and the hook only has to write it down. Codex announces nothing. From
// its own 0.153.4 source: the quota branch ends the turn through an internal
// error path that fires NO lifecycle hook, runs NO `notify`, and persists no
// standalone error event. `Stop` runs only when a turn COMPLETES.
//
// But the turn's ending IS written down — in the session's rollout file, the
// `transcript_path` every hook payload carries:
//
//   {"timestamp":"…","type":"event_msg","payload":{"type":"task_complete",
//    "turn_id":"…","last_agent_message":null,
//    "error":{"message":"…","codex_error_info":"usage_limit_exceeded"}}}
//
// A successful turn writes the same record with no error. So the tool tails
// that file. That is the whole design, and it replaces an earlier one that
// captured the pane and corroborated with a usage poll: the rollout record is
// first-party, structured, and unquotable, where a screen is none of the three
// (a Codex pane asked to echo its own wall text during the spike returned it
// verbatim). `src/wall.ts` keeps the Codex pattern, but only for `ms status`'s
// `unreported` flag — nothing rotates on text any more.
//
// The watchdog is ONE timer for the whole tmux server, not one per turn:
// `UserPromptSubmit` arms `ms _codex_watch` 45 s out only when no timer is
// already pending, and the watch re-arms itself while any Codex session still
// has a turn in flight. A per-turn timer would have meant N timers for N
// parallel panes, all of them reading the same rows.
//
// Automatic rotation is ON by default since 0.2.4: the record above was
// verified against 85 real walled rollouts, and the whole chain from this
// watchdog to the resumed conversation answering was observed live against a
// mock-walled account. With the gate turned OFF (`MS_CODEX_AUTOROTATE=0`) the
// watch still records the `rate_limited` event — which is what `ms status`
// reads — and stops there. The gate is the single line that turns evidence
// into action, and it is a row in the store rather than `process.env` because
// `_codex_watch` and `_recover` are dispatched by `tmux run-shell`, which
// hands them the tmux server's global environment and not the shell that
// exported `MS_CODEX_AUTOROTATE` (src/autorotate.ts). THIS hook is one of the
// few `ms` processes that does see the human's own environment — the CLI
// inherits the pane's — so it mirrors an exported value into the store on its
// way past.
//
// Neither verb ever prints. `_hook` is read by the Codex TUI, which renders a
// hook's output; `_codex_watch` is dispatched by tmux, where stderr becomes a
// message over the human's pane. Both exit 0 on every path, including failure.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { codexAutorotateEnabled, codexAutorotateEnv, syncCodexAutorotate } from "../autorotate.ts";
import { appendEvent, readEvents, type EventKind } from "../events.ts";
import { msBinary } from "../paths.ts";
// type-only: erased, so naming them here never loads node:sqlite
import type { SessionRow, State, WallKind as RecoveryWallKind } from "../state.ts";
import { Tmux } from "../tmux.ts";

// Nothing that reaches `node:sqlite` may be imported at module scope. `cli.ts`
// loads this file for EVERY verb, and the hook's own unmanaged-pane return has
// to happen before a store is opened or a warning can be emitted into the
// human's transcript — so `state.ts`, `lock.ts` and `snapshot.ts` (which pulls
// in `lock.ts`, the registry and both providers) are all loaded on demand,
// inside the functions that actually need them. The Claude hook does the same
// for the same reason.

/** Total budget for reading the payload. Codex waits on the hook. */
const STDIN_MS = 3_000;
/** A hook payload is a few hundred bytes; anything past this is not one. */
const STDIN_MAX = 1 << 20;

/** SessionStart's `source`, as the spike captured it: `startup` on a new
 * session, `resume` on `codex resume`. Codex has no `/clear` or `/compact`
 * source, so — unlike Claude's — this map has exactly two entries and an
 * unknown source falls back to `started`. */
const SOURCE_KIND: Record<string, EventKind> = { startup: "started", resume: "resumed" };

/**
 * How long the watch waits between looks — adaptive, because the two costs it
 * trades off are not symmetric.
 *
 * Waking every 45 s reads a handful of rows and tails a few KB, which is
 * nothing on its own but is a wake-up per 45 s for as long as any Codex pane is
 * thinking. Waking every 120 s costs, at worst, 75 extra seconds of a walled
 * session sitting there. So: look often only when a wall is plausible, which is
 * when SOME Codex account's last reading was already near its limit.
 *
 * "Last reading" is the snapshot cache file and nothing else — no poll, no
 * network, no lock. This runs on a hook's clock and inside the tmux server,
 * where neither is affordable. No reading at all therefore means SLOW, not
 * fast: absence of evidence is not evidence of a wall, and a fresh install
 * with no cache is exactly the case where nothing is near a limit yet.
 *
 * The three numbers are overridable by env so a test can prove the choice
 * without waiting two minutes for it.
 */
export const WATCH_FAST_S = 45;
export const WATCH_SLOW_S = 120;
export const WATCH_HOT_PERCENT = 80;
/** The one lock both arming and watching take, so there is never a second
 * timer and never two passes over the same rollout bytes. */
const WATCH_LOCK = "codex-watch";
/** The kv key holding the epoch a pending timer is expected to fire at. It is
 * an epoch rather than a flag on purpose: a watch that dies without clearing
 * it leaves a stale claim, and a stale epoch simply expires. */
const ARMED_UNTIL = "codexWatchArmedUntil";
/** A hook is on the human's turn. It waits this long for the lock and no
 * longer — and the wait is worth taking rather than skipping, because the
 * holder is the watch, whose pass may have read this session's events a
 * moment BEFORE this hook wrote its `activity`. */
const ARM_LOCK_WAIT_MS = 2_000;
/** At most this many new rollout bytes are read in one pass per session. A
 * rollout grows by a few KB a turn; anything past this is a file the tool has
 * no business slurping into memory, and the offset still advances so the next
 * pass continues where this one stopped. */
export const ROLLOUT_CHUNK_MAX = 4 << 20;

/**
 * `ms _hook codex` — the four lifecycle events, written down.
 *
 * Gated exactly as the Claude hook is, on the `MS_*` identity `ms _exec`
 * exports into the CLI's environment: a Codex the human launched by hand
 * inherits none of it and this returns 0 having written nothing. The
 * generation is the INHERITED one, never the store's latest, so a late event
 * from a replaced generation stays attributable to the process that sent it.
 */
export async function codexHook(): Promise<number> {
  try {
    const session = process.env.MS_SESSION;
    const gen = Number(process.env.MS_GENERATION);
    const socket = process.env.MS_SOCKET;
    const pane = process.env.MS_PANE;
    // A generation is a positive counter. `Number("")` is 0 and `Number(" ")`
    // is 0 too, so "finite" is not enough to tell a real one from a blank.
    if (!session || !Number.isInteger(gen) || gen <= 0 || !socket || !pane) return 0;

    // The gate, carried from the human's shell into the store the dispatched
    // processes can actually read. Only when the variable is set here — the
    // ordinary case is unset (and on), and that must cost no store at all.
    await mirrorAutorotate();

    if (process.stdin.isTTY) return 0;
    let input: Record<string, unknown>;
    try { input = JSON.parse(await readStdin(STDIN_MS)) as Record<string, unknown>; } catch { return 0; }
    if (!input || typeof input !== "object") return 0;

    const name = String(input.hook_event_name ?? "");
    const cliSessionId = typeof input.session_id === "string" ? input.session_id : null;
    const turnId = typeof input.turn_id === "string" && input.turn_id ? input.turn_id : null;
    const transcript = typeof input.transcript_path === "string" && input.transcript_path ? input.transcript_path : null;
    const t = Math.floor(Date.now() / 1000);

    if (name === "SessionStart") {
      const kind = SOURCE_KIND[String(input.source ?? "startup")] ?? "started";
      // The store first, so the event can record BOTH ids when the id moved.
      const prev = await noteSessionStart(session, gen, kind, cliSessionId, transcript);
      appendEvent({ t, kind, session, generation: gen, cliSessionId, ...(prev !== undefined ? { prevCliSessionId: prev } : {}) });
    } else if (name === "UserPromptSubmit") {
      // The event FIRST, then the watchdog: the watch reads the log to find a
      // session's in-flight turn, so arming before the write is arming for a
      // turn that does not exist yet. The state move is bookkeeping on both.
      appendEvent({ t, kind: "activity", session, generation: gen, cliSessionId, turnId });
      await noteActivity(session, gen, transcript);
      await armWatch(socket);
    } else if (name === "Stop") {
      // A turn that finished successfully — Codex fires this on no other path.
      // The watch would eventually read the same `task_complete` out of the
      // rollout, so this is redundant; it is kept because it is FREE and it is
      // immediate, and because a session whose rollout the tool cannot read
      // still gets its turns closed.
      appendEvent({ t, kind: "stop", session, generation: gen, cliSessionId, turnId });
    } else if (name === "SessionEnd") {
      const reason = typeof input.reason === "string" && input.reason ? input.reason : null;
      appendEvent({ t, kind: "ended", session, generation: gen, cliSessionId, ...(reason ? { kindDetail: reason } : {}) });
    }
    return 0;
  } catch {
    // A hook that throws would print through the CLI's error path and show up
    // in the human's transcript. Losing one event is the cheaper failure;
    // reconciliation reads the store and the screen on the next `ms` command.
    return 0;
  }
}

/**
 * Write an exported `MS_CODEX_AUTOROTATE` into the store, so `_codex_watch`
 * and `_recover` — which tmux dispatches with the SERVER's environment, not
 * this one — read the gate the human actually set.
 *
 * A variable that is not set here says nothing and writes nothing: the stored
 * gate stays as it was. Everything is guarded, because a hook that threw would
 * print through the CLI's error path into the human's transcript.
 */
async function mirrorAutorotate(): Promise<void> {
  if (codexAutorotateEnv() === null) return; // the ordinary case: no store opened
  try {
    const { openState } = await import("../state.ts");
    const st = openState();
    try { syncCodexAutorotate(st); } finally { st.close(); }
  } catch { /* a gate we could not record is the gate that was already there */ }
}

/**
 * Arm the fleet watch, unless a timer is already pending.
 *
 * ONE timer for the whole tmux server. Ten Codex panes taking a turn each
 * would otherwise mean ten timers waking together to read the same rows; the
 * compare-and-set under the shared lock is what collapses them into one.
 *
 * The lock wait is not an optimisation to skip. The holder, when there is one,
 * is the watch itself — and its pass may have read this session's events a
 * moment before this hook appended `activity`, decided nothing was in flight,
 * and cleared the claim. Waiting for it to finish and then re-reading the
 * claim is what closes that race. A lock we still cannot get, or a tmux that
 * will not take the request, costs this turn its watch and nothing more: the
 * next turn arms again, and the Stop hook still closes this one.
 */
async function armWatch(socket: string): Promise<void> {
  try {
    const { withLock } = await import("../lock.ts");
    await withLock(WATCH_LOCK, async () => {
      const { openState } = await import("../state.ts");
      const st = openState();
      try {
        if (timerPending(st)) return;
        const seconds = await watchSeconds();
        // tmux first: a claim written for a timer that was never accepted
        // would silence the next interval of arming for nothing.
        new Tmux(socket).runShell([msBinary(), "_codex_watch"], { delaySeconds: seconds });
        claimTimer(st, seconds);
      } finally {
        st.close();
      }
    }, { waitMs: ARM_LOCK_WAIT_MS });
  } catch {
    // A lock we could not take in time, or a tmux that would not take the
    // request: this turn goes unwatched and nothing else. The next turn arms
    // again, and the Stop hook still closes this one.
  }
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const timerPending = (st: State): boolean => Number(st.getKv(ARMED_UNTIL) ?? 0) > nowSeconds();
/** The claim covers exactly the interval the timer was given, so a slow watch
 * does not leave a 75-second hole in which a second timer can be armed. */
const claimTimer = (st: State, seconds: number): void => st.setKv(ARMED_UNTIL, String(nowSeconds() + seconds));

/** A positive number from the environment, or the compiled-in default. A
 * blank, a zero, a negative or a word all mean "the default". */
function envSeconds(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How long until the next look. Fast when any Codex account's last cached
 * reading has a window at or above the hot mark, slow otherwise.
 *
 * Every window counts, including `weeklyAll`: a weekly limit walls a turn just
 * as hard as a five-hour one. Codex has no Fable-scoped window, but reading
 * the field costs nothing and keeps this honest if one ever appears.
 */
async function watchSeconds(): Promise<number> {
  let hot = false;
  try {
    const { cachedAccounts } = await import("../snapshot.ts");
    const mark = envSeconds("MS_CODEX_WATCH_HOT_PERCENT", WATCH_HOT_PERCENT);
    for (const a of cachedAccounts()) {
      if (a.provider !== "codex" || !a.usage) continue;
      for (const w of [a.usage.session, a.usage.weeklyAll, a.usage.weeklyFable]) {
        if (w && w.usedPercent >= mark) { hot = true; break; }
      }
      if (hot) break;
    }
  } catch {
    // An unreadable cache is not a reason to wake up more often.
  }
  return hot ? envSeconds("MS_CODEX_WATCH_FAST_S", WATCH_FAST_S) : envSeconds("MS_CODEX_WATCH_SLOW_S", WATCH_SLOW_S);
}

/**
 * Read the session's row and let `fn` decide what to do about it, or do
 * nothing at all. Never throws, and never touches a row that is not this
 * report's: the generation compared is the INHERITED one.
 *
 * `state.ts` is imported here rather than at module scope because it pulls in
 * `node:sqlite`, whose ExperimentalWarning would print on EVERY invocation —
 * including the unmanaged-pane early return — into the human's transcript.
 */
async function onRow<T>(session: string, gen: number, fn: (st: State, s: SessionRow) => T): Promise<T | undefined> {
  try {
    const { openState } = await import("../state.ts");
    const st = openState();
    try {
      const s = st.getSession(session);
      if (!s || s.generation !== gen) return undefined;
      return fn(st, s);
    } finally {
      st.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * What a SessionStart means for the ROW — the same rule as the Claude hook's,
 * with two clauses that matter more here.
 *
 * **Codex has no `--session-id`.** Claude Code can be told which conversation
 * id to start under, so a launch knows its CLI session id before the CLI runs.
 * Codex mints its own and reports it here, which makes this hook the ONLY
 * place the tool ever learns it — and the id is what `codex resume <id>` needs
 * to bring a rotated session back. A row whose `cliSessionId` is null is the
 * normal state of a freshly launched Codex session, not an anomaly, and
 * recording the payload's id on it is this function's first job rather than a
 * correction. The same write also covers the id MOVING, exactly as for Claude.
 *
 * That first job is deliberately NOT conditioned on the row's state, because
 * the state by then is routinely `running`. The TUI reports SessionStart only
 * when a prompt is SUBMITTED (C1, the 2026-09-16 live matrix), so a relaunch
 * that carried no prompt is marked `running` on the strength of its live pane
 * by the recovery worker (`waitForSettle`, src/recover.ts) and the report
 * arrives whenever the human first types — an hour later, or never. Adopting
 * only from `launching`/`resuming` would leave that session's id null for the
 * rest of its life, and a null id is a session no rotation can resume.
 *
 * **The rollout path arrives the same way**, and it is the only evidence a
 * usage-limit turn ever leaves. A new path means a new conversation, so the
 * byte offset into the old one is meaningless and is reset with it — carrying
 * it over would make the watch skip the first N bytes of a fresh rollout.
 *
 * The state half is unchanged: a `startup` report for this generation is the
 * launch answering (`launching → running`), and a `resume`/`startup` report
 * for a row still in `resuming` is the replacement CLI saying it is up, which
 * adopts it (`continuing` for a resume that carries a continuation, `running`
 * for one that does not) and drops the wake-up. Only from `resuming`: every
 * other state belongs to somebody else.
 *
 * Returns the id the row USED to carry when it changed, `undefined` when it
 * did not.
 */
async function noteSessionStart(session: string, gen: number, kind: EventKind, cliSessionId: string | null, transcript: string | null): Promise<string | null | undefined> {
  return await onRow(session, gen, (st, s) => {
    const patch: Partial<SessionRow> = {};
    let prev: string | null | undefined;
    if (cliSessionId && cliSessionId !== s.cliSessionId) {
      patch.cliSessionId = cliSessionId;
      prev = s.cliSessionId;
    }
    if (transcript && transcript !== s.transcriptPath) {
      patch.transcriptPath = transcript;
      // A different file is a different conversation: the old offset indexes
      // bytes this file does not have.
      patch.rolloutOffset = 0;
    }
    // Either word is the launch itself answering (0.2.5): `ms adopt` and a
    // hand-written `ms codex -- resume <id>` bring the pane up ON an existing
    // conversation, so the TUI's first SessionStart carries `resume`. A row
    // that only promoted on `startup` sat in `launching` while the rescued
    // conversation was up and answering, until reconciliation parked it.
    if ((kind === "started" || kind === "resumed") && s.state === "launching") patch.state = "running";
    // A `started` adopts only when it carries the row's own id — but a Codex
    // row that has never been told an id carries null, and a first report
    // against null is the launch itself, not a resume that landed elsewhere.
    const sameId = !cliSessionId || s.cliSessionId === null || cliSessionId === s.cliSessionId;
    if (s.state === "resuming" && (kind === "resumed" || (kind === "started" && sameId))) {
      patch.state = kind === "resumed" ? "continuing" : "running";
      patch.wakeupAt = null;
    }
    if (Object.keys(patch).length) st.updateSession(session, patch);
    return prev;
  });
}

/** The first turn after a resume is what finishes a rotation (spec §9 step 7).
 * `continuing` means the replacement CLI was handed the continuation and has
 * not been seen acting on it; this is that. Any other state belongs to
 * somebody else — the worker, a stop, reconciliation. The rollout path rides
 * along because `UserPromptSubmit` carries it too, and a row that somehow
 * missed its SessionStart would otherwise never learn one. */
async function noteActivity(session: string, gen: number, transcript: string | null): Promise<void> {
  await onRow(session, gen, (st, s) => {
    const patch: Partial<SessionRow> = {};
    if (s.state === "continuing") patch.state = "running";
    if (transcript && transcript !== s.transcriptPath) { patch.transcriptPath = transcript; patch.rolloutOffset = 0; }
    if (Object.keys(patch).length) st.updateSession(session, patch);
  });
}

/**
 * `ms _codex_watch` — the fleet watchdog, woken by tmux.
 *
 * One pass over every Codex session with a turn in flight, tailing each one's
 * rollout file for that turn's `task_complete` record. It re-arms itself while
 * any turn is still in flight and clears the claim when none is.
 *
 * The whole pass runs under one lock, which is also the lock the hook takes to
 * arm: two passes could otherwise read the same bytes and act on the same
 * record twice, and the offset that prevents it is only advanced at the end.
 */
export async function codexWatch(): Promise<number> {
  try {
    const { withLock } = await import("../lock.ts");
    await withLock(WATCH_LOCK, async () => {
      const { openState } = await import("../state.ts");
      const st = openState();
      try {
        let inFlight: SessionRow | null = null;
        for (const s of st.listSessions()) {
          if (s.provider !== "codex") continue;
          if (s.state !== "running" && s.state !== "continuing") continue;
          const turn = inFlightTurn(s);
          if (!turn) continue;
          const settled = await readRollout(st, s, turn);
          if (!settled) inFlight ??= s;
        }
        // The claim is re-read before anything is decided. This pass began
        // when its own timer's claim expired, and a `UserPromptSubmit` that
        // won the lock in that gap has already armed a replacement: re-arming
        // on top of it would leave TWO timers, each renewing the other's claim
        // for as long as the fleet is busy. Somebody else's pending timer is
        // also a reason not to clear the claim out from under it.
        if (timerPending(st)) return;
        // Re-arm only while there is something to watch. `??=` above kept the
        // FIRST still-flying session, and its socket is the one the next timer
        // rides on — the watch is per tmux server, and that is a server with
        // work on it.
        if (inFlight) {
          const seconds = await watchSeconds();
          new Tmux(inFlight.socket).runShell([msBinary(), "_codex_watch"], { delaySeconds: seconds });
          claimTimer(st, seconds);
          return;
        }
        // Nothing was still flying when this pass read it — but the pass took
        // time, and a `UserPromptSubmit` that lost the 2 s lock wait appended
        // its `activity` and armed nothing. Standing down on the pre-pass
        // answer would leave that turn unwatched for good: with a single busy
        // session, its wall would never be noticed. So look again, cheaply,
        // before the claim is cleared.
        const late = firstInFlight(st);
        if (late) {
          const seconds = await watchSeconds();
          new Tmux(late.socket).runShell([msBinary(), "_codex_watch"], { delaySeconds: seconds });
          claimTimer(st, seconds);
          return;
        }
        st.delKv(ARMED_UNTIL);
      } finally {
        st.close();
      }
    });
    return 0;
  } catch {
    return 0;
  }
}

/** The turn a session is currently inside, or null.
 *
 * In flight means: the newest `activity` for the row's CURRENT generation is
 * newer than anything that would have ended it. `stop` is the ordinary ending;
 * `rate_limited` and `ended` are counted too, because a turn that walled or a
 * session that quit is just as finished and re-reading it would open a second
 * recovery for the same wall. A generation that moved means the turn belonged
 * to a process the session has left. */
function inFlightTurn(s: SessionRow): { turnId: string; activityIndex: number } | null {
  const events = readEvents(s.id);
  let act = -1;
  let end = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    // BOTH halves are filtered by generation, not just the activity. An end
    // from a generation the session has left belongs to a process that is
    // gone: a pass that listed the row before a `--force` rotate and appended
    // a stale-generation `rate_limited` after the new `activity` would
    // otherwise mask the new turn until its next prompt.
    if (e.generation !== s.generation) continue;
    if (e.kind === "activity") act = i;
    else if (e.kind === "stop" || e.kind === "rate_limited" || e.kind === "ended") end = i;
  }
  if (act < 0 || end > act) return null;
  const a = events[act];
  if (!a.turnId) return null;
  return { turnId: a.turnId, activityIndex: act };
}

/** The first Codex session with a turn in flight, or null. A pure read of the
 * rows and their event logs — no rollout is tailed and nothing is written. */
function firstInFlight(st: State): SessionRow | null {
  for (const s of st.listSessions()) {
    if (s.provider !== "codex") continue;
    if (s.state !== "running" && s.state !== "continuing") continue;
    if (inFlightTurn(s)) return s;
  }
  return null;
}

/**
 * Tail this session's rollout file for the in-flight turn's ending. Returns
 * whether the turn is now settled.
 *
 * Only the bytes past `rolloutOffset` are read, and the offset advances only
 * to the last COMPLETE line: Codex is appending to this file as we read it, so
 * the tail is routinely half a record, and re-reading that half next pass is
 * the point. Records for any other turn id are skipped without comment —
 * `codex resume` re-renders the whole conversation, so a rollout a rotation
 * reopens is full of old endings, and acting on one would rotate a session for
 * a wall it hit yesterday.
 */
async function readRollout(st: State, s: SessionRow, turn: { turnId: string }): Promise<boolean> {
  if (!s.transcriptPath) return false;
  let size: number;
  try { size = statSync(s.transcriptPath).size; } catch { return false; }
  // A file that SHRANK is not the file we measured (rotated, replaced,
  // truncated): start over rather than read from a meaningless offset.
  const from = size < s.rolloutOffset ? 0 : s.rolloutOffset;
  if (size <= from) return false;

  const want = Math.min(size - from, ROLLOUT_CHUNK_MAX);
  let buf: Buffer;
  try {
    const fd = openSync(s.transcriptPath, "r");
    try {
      buf = Buffer.alloc(want);
      const got = readSync(fd, buf, 0, want, from);
      buf = buf.subarray(0, got);
    } finally { closeSync(fd); }
  } catch { return false; }

  // The last newline is the end of the last complete record. Anything after it
  // is a partial line the writer has not finished, and belongs to the next
  // pass — so the offset stops there, not at `size`.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // A whole cap-sized read with not one newline in it is not a record being
    // written, it is a line longer than the cap — and keeping the offset would
    // stall this session for ever, re-reading the same 4 MiB every pass and
    // never seeing the turn end. Step over it. Nothing is lost that this tool
    // could have read: a `task_complete` record is a few hundred bytes.
    if (buf.length >= ROLLOUT_CHUNK_MAX) {
      st.advanceRolloutOffset(s.id, s.transcriptPath, from + buf.length);
      note(`${s.id}: skipped ${buf.length} rollout bytes with no line break`);
    }
    return false;
  }
  const complete = buf.subarray(0, lastNewline + 1).toString("utf8");

  // Every event is appended BEFORE the offset moves past the bytes it came
  // from. The other order loses a record for good: an append that throws (a
  // full disk, a bad mode) against an offset already advanced means the next
  // pass starts after the record and the turn is never settled — so the
  // watchdog re-arms for ever over a session that walled. Each append is
  // guarded for the same reason `recordWall` guards its own: one line we could
  // not write must not cost the rest of the chunk.
  let settled = false;
  let lost = false; // a record for our turn that could not be written down
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    const rec = parseTaskComplete(line);
    if (!rec || rec.turnId !== turn.turnId) continue;
    let ok: boolean;
    if (rec.usageLimited) {
      ok = await recordWall(st, s, turn.turnId);
    } else {
      try {
        appendEvent({ t: nowSeconds(), kind: "stop", session: s.id, generation: s.generation, cliSessionId: s.cliSessionId, turnId: turn.turnId,
          ...(rec.errorInfo ? { kindDetail: rec.errorInfo } : {}) });
        ok = true;
      } catch { ok = false; }
    }
    if (ok) settled = true;
    else lost = true;
  }
  // The offset moves only over bytes whose meaning is now recorded. A chunk
  // that carried nothing for this turn is fully consumed however it went; a
  // chunk whose record we could not write down is re-read next pass, which is
  // the entire reason the append comes first.
  // ...and onto THIS file only. A `/new` mid-pass has already pointed the row
  // at a fresh rollout and reset the offset to 0, without holding this lock;
  // stamping the old file's offset onto the new path would skip the first N
  // bytes of a conversation nothing has read.
  if (!lost) st.advanceRolloutOffset(s.id, s.transcriptPath, from + lastNewline + 1);
  return settled;
}

/** One line to stderr, only when asked for. `_codex_watch` runs inside the
 * tmux server, never in a CLI transcript, so a diagnostic here costs a human
 * nothing — but it is still gated, because a watchdog that chattered every
 * 45 s would drown the one line worth reading. */
function note(text: string): void {
  if (process.env.MS_VERBOSE === "1") process.stderr.write(`ms _codex_watch: ${text}\n`);
}

/** The two spellings of "the turn ended". `task_complete` is what Codex
 * 0.153.4 writes and what 85 walled rollouts on this machine carry;
 * `turn_complete` is the v2 alias the protocol names for the same event
 * (`codex-rs/protocol/src/protocol.rs`). A tailer that knew only the older
 * spelling would read a v2 rollout as a turn that never ends: the wall would
 * go unrecorded and the watchdog would re-arm over it for ever. Both are read
 * identically, because they ARE the same record. */
const TURN_END_TYPES: ReadonlySet<string> = new Set(["task_complete", "turn_complete"]);

/** One rollout line, if it is a turn's ending for some turn. Anything else —
 * another event type, a line that is not JSON, a record with no turn id — is
 * not this tool's business and returns null. The field names are snake_case,
 * as the rollout writes them. */
export function parseTaskComplete(line: string): { turnId: string; usageLimited: boolean; errorInfo: string | null } | null {
  let rec: { payload?: { type?: unknown; turn_id?: unknown; error?: { codex_error_info?: unknown } | null } };
  try { rec = JSON.parse(line) as typeof rec; } catch { return null; }
  const payload = rec?.payload;
  if (!payload || typeof payload.type !== "string" || !TURN_END_TYPES.has(payload.type)) return null;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
  if (!turnId) return null;
  const info = payload.error && typeof payload.error.codex_error_info === "string" ? payload.error.codex_error_info : null;
  return { turnId, usageLimited: info === "usage_limit_exceeded", errorInfo: info };
}

/**
 * The wall: record it, and — unless the gate has been turned off — open the
 * recovery and ask tmux to dispatch the worker, in that order and for the same
 * reasons as the Claude hook's `rateLimited`.
 *
 * The kind is `session`. The rollout record says the turn hit a usage limit
 * and not WHICH window, and inventing `weekly` from nothing would be a claim
 * the source never made; the chooser polls real usage before it picks anyway,
 * so the label is provenance, not input.
 */
async function recordWall(st: State, s: SessionRow, turnId: string): Promise<boolean> {
  const kind: RecoveryWallKind = "session";
  let recorded = false;
  try {
    appendEvent({ t: nowSeconds(), kind: "rate_limited", session: s.id, generation: s.generation, cliSessionId: s.cliSessionId, turnId, kindDetail: kind });
    recorded = true;
  } catch { /* with the flag on, the recovery below is the load-bearing record */ }

  // The gate, off only when somebody exported `MS_CODEX_AUTOROTATE=0`. The
  // event above is what `ms status` reads, and the manual verbs still move the
  // session. With the gate off it is ALSO the only record, so an append that
  // failed is a wall not yet read — the caller leaves the offset where it is
  // and the next pass tries again.
  if (!codexAutorotateEnabled(st)) return recorded;
  // Re-read: the row was listed before this file was read.
  const now = st.getSession(s.id);
  if (!now || now.generation !== s.generation || now.desired !== "running") return recorded;
  // A concurrent duplicate is one transaction, not two: either the insert or
  // its unique index tells us a recovery is already open.
  try { st.addRecovery({ sessionId: s.id, generation: now.generation, turnId, kind }); } catch { /* already pending */ }
  // `run-shell -b` runs the worker inside the tmux server, outside this
  // process's tree, so killing the pane cannot kill the recovery.
  new Tmux(now.socket).runShell([msBinary(), "_recover", s.id]);
  // The recovery row is now the record, whether or not the event line landed.
  return true;
}

/** Every byte of stdin, capped: a hook that waits forever hangs Codex's turn. */
function readStdin(ms: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = (v: string) => { clearTimeout(timer); process.stdin.pause(); resolve(v); };
    const timer = setTimeout(() => done(buf), ms); // ref'd on purpose: the cap must fire
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; if (buf.length > STDIN_MAX) done(buf); });
    process.stdin.on("end", () => done(buf));
    process.stdin.on("error", () => done(buf));
  });
}

