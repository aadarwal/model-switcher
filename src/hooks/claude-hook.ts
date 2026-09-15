import { appendEvent, type EventKind } from "../events.ts";
import { msBinary } from "../paths.ts";
// type-only: erased, so naming them here never loads node:sqlite
import type { SessionRow, State, WallKind as RecoveryWallKind } from "../state.ts";
import { Tmux } from "../tmux.ts";
import { wallKindFromText } from "../wall.ts";

/** Total budget for the whole hook. Claude waits on us, so nothing here is
 * unbounded: stdin is capped, and every tmux call is a bounded subprocess. */
const STDIN_MS = 3_000;
/** A hook payload is a few hundred bytes; anything past this is not one. */
const STDIN_MAX = 1 << 20;

const SOURCE_KIND: Record<string, EventKind> = { startup: "started", resume: "resumed", clear: "cleared", compact: "compacted" };

/**
 * `ms _hook claude` — the tool's only trigger.
 *
 * It reads Claude Code's hook JSON on stdin and appends one event to the
 * session's log. It never prints (Claude would render it), never blocks, and
 * never acts for a pane the tool did not launch: `MS_SESSION`/`MS_GENERATION`/
 * `MS_SOCKET`/`MS_PANE` are inherited from `ms _exec`, so a pane launched by
 * hand simply has none of them and the hook exits 0.
 *
 * The generation is the INHERITED one, never the store's latest: a late event
 * from a replaced generation must stay attributable to the process that sent it.
 */
export async function claudeHook(): Promise<number> {
  try {
    const session = process.env.MS_SESSION;
    const gen = Number(process.env.MS_GENERATION);
    const socket = process.env.MS_SOCKET;
    const pane = process.env.MS_PANE;
    // A generation is a positive counter. `Number("")` is 0 and `Number(" ")`
    // is 0 too, so "finite" is not enough to tell a real one from a blank.
    if (!session || !Number.isInteger(gen) || gen <= 0 || !socket || !pane) return 0;

    if (process.stdin.isTTY) return 0;
    let input: Record<string, unknown>;
    try { input = JSON.parse(await readStdin(STDIN_MS)) as Record<string, unknown>; } catch { return 0; }
    if (!input || typeof input !== "object") return 0;

    const name = String(input.hook_event_name ?? "");
    const cliSessionId = typeof input.session_id === "string" ? input.session_id : null;
    const t = Math.floor(Date.now() / 1000);

    if (name === "SessionStart") {
      const kind = SOURCE_KIND[String(input.source ?? "startup")] ?? "started";
      // The store first, so the event can record BOTH ids when the id moved.
      const prev = await noteSessionStart(session, gen, kind, cliSessionId);
      appendEvent({ t, kind, session, generation: gen, cliSessionId, ...(prev !== undefined ? { prevCliSessionId: prev } : {}) });
    } else if (name === "UserPromptSubmit") {
      appendEvent({ t, kind: "activity", session, generation: gen, cliSessionId });
    } else if (name === "SessionEnd") {
      const reason = typeof input.reason === "string" && input.reason ? input.reason : null;
      appendEvent({ t, kind: "ended", session, generation: gen, cliSessionId, ...(reason ? { kindDetail: reason } : {}) });
    } else if (name === "StopFailure" && input.error === "rate_limit") {
      await rateLimited({ session, gen, socket, pane, cliSessionId, t });
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
 * Read the session's row and let `fn` decide what to do about it, or do
 * nothing at all. Never throws, and never touches a row that is not this
 * report's: the generation compared is the INHERITED one, so a late event from
 * a replaced generation can never move the row its replacement now owns.
 *
 * `state.ts` is imported here rather than at module scope for the same reason
 * `rateLimited` does it: it pulls in `node:sqlite`, and an unmanaged pane must
 * return long before any of that is loaded.
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
    // The event is already on disk; a store we could not write is worth less
    // than a hook that prints an error into the human's transcript.
    return undefined;
  }
}

/**
 * What a SessionStart means for the ROW (spec §8's table).
 *
 * The CLI's session id can change inside one process: a `/clear` starts a new
 * conversation, and an interactive `/resume` or a fork moves to another one.
 * The row's `cliSessionId` is what a rotation resumes and what its readiness
 * check compares against — so a row left on the old id would silently bring
 * back the conversation the human had deliberately left, and call that a good
 * resume. The id we were told replaces the one we had, and the caller records
 * both on the event.
 *
 * A `compacted` report is not that: compaction keeps the conversation and its
 * id, so nothing moves.
 *
 * Returns the id the row USED to carry when it changed, `undefined` when it
 * did not.
 */
async function noteSessionStart(session: string, gen: number, kind: EventKind, cliSessionId: string | null): Promise<string | null | undefined> {
  if (kind === "compacted") return undefined;
  return await onRow(session, gen, (st, s) => {
    const patch: Partial<SessionRow> = {};
    let prev: string | null | undefined;
    if (cliSessionId && cliSessionId !== s.cliSessionId) {
      patch.cliSessionId = cliSessionId;
      prev = s.cliSessionId;
    }
    if (Object.keys(patch).length) st.updateSession(session, patch);
    return prev;
  });
}

/** The wall: record it, open the recovery, and ask tmux to dispatch the worker.
 * The event is appended BEFORE the recovery and the recovery BEFORE the
 * dispatch, so a crash anywhere in here leaves evidence reconciliation can
 * repair, never a silent loss. */
async function rateLimited(a: { session: string; gen: number; socket: string; pane: string; cliSessionId: string | null; t: number }): Promise<void> {
  const tmux = new Tmux(a.socket);
  // Screen text only NAMES the wall; the provider's own report is the trigger.
  let kind: RecoveryWallKind = "unknown";
  try { kind = wallKindFromText(tmux.capture(a.pane, 200)) ?? "unknown"; } catch { /* a dead pane still gets its event */ }
  // A log-write failure (full disk, bad perms) must not cost the rotation:
  // the recovery in the store is what the worker acts on, not this line.
  try { appendEvent({ t: a.t, kind: "rate_limited", session: a.session, generation: a.gen, cliSessionId: a.cliSessionId, kindDetail: kind }); } catch { /* the recovery below is the load-bearing record */ }

  // Loaded here, not at module scope: `state.ts` pulls in `node:sqlite`, whose
  // ExperimentalWarning would print on EVERY hook invocation — including the
  // unmanaged-pane early return — straight into the human's transcript.
  const { openState } = await import("../state.ts");
  const st = openState();
  try {
    const s = st.getSession(a.session);
    // Not ours, superseded, or already stopping: record, do not act.
    if (!s || s.generation !== a.gen || s.desired !== "running") return;
    // A concurrent duplicate for the same turn is one transaction, not two:
    // either the insert or its unique index tells us a recovery is already open.
    try { st.addRecovery({ sessionId: a.session, generation: a.gen, turnId: null, kind }); } catch { /* already pending */ }
    // `run-shell -b` runs the worker inside the tmux server, outside this
    // CLI's process tree, so killing the pane cannot kill the recovery.
    tmux.runShell([msBinary(), "_recover", a.session]);
  } finally {
    st.close();
  }
}

/** Every byte of stdin, capped: a hook that waits forever hangs Claude's turn. */
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
