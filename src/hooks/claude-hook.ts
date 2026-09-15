import { appendEvent, type EventKind } from "../events.ts";
import { msBinary } from "../paths.ts";
import { openState, type WallKind as RecoveryWallKind } from "../state.ts";
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
    if (!session || !Number.isFinite(gen) || !socket || !pane) return 0;

    if (process.stdin.isTTY) return 0;
    let input: Record<string, unknown>;
    try { input = JSON.parse(await readStdin(STDIN_MS)) as Record<string, unknown>; } catch { return 0; }
    if (!input || typeof input !== "object") return 0;

    const name = String(input.hook_event_name ?? "");
    const cliSessionId = typeof input.session_id === "string" ? input.session_id : null;
    const t = Math.floor(Date.now() / 1000);

    if (name === "SessionStart") {
      const kind = SOURCE_KIND[String(input.source ?? "startup")] ?? "started";
      appendEvent({ t, kind, session, generation: gen, cliSessionId });
    } else if (name === "UserPromptSubmit") {
      appendEvent({ t, kind: "activity", session, generation: gen, cliSessionId });
    } else if (name === "SessionEnd") {
      appendEvent({ t, kind: "ended", session, generation: gen, cliSessionId, kindDetail: String(input.reason ?? "") });
    } else if (name === "StopFailure" && input.error === "rate_limit") {
      rateLimited({ session, gen, socket, pane, cliSessionId, t });
    }
    return 0;
  } catch {
    // A hook that throws would print through the CLI's error path and show up
    // in the human's transcript. Losing one event is the cheaper failure;
    // reconciliation reads the store and the screen on the next `ms` command.
    return 0;
  }
}

/** The wall: record it, open the recovery, and ask tmux to dispatch the worker.
 * The event is appended BEFORE the recovery and the recovery BEFORE the
 * dispatch, so a crash anywhere in here leaves evidence reconciliation can
 * repair, never a silent loss. */
function rateLimited(a: { session: string; gen: number; socket: string; pane: string; cliSessionId: string | null; t: number }): void {
  const tmux = new Tmux(a.socket);
  // Screen text only NAMES the wall; the provider's own report is the trigger.
  let kind: RecoveryWallKind = "unknown";
  try { kind = wallKindFromText(tmux.capture(a.pane, 200)) ?? "unknown"; } catch { /* a dead pane still gets its event */ }
  appendEvent({ t: a.t, kind: "rate_limited", session: a.session, generation: a.gen, cliSessionId: a.cliSessionId, kindDetail: kind });

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
