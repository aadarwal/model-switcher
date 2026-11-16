// What `ms restore` brings back, decided without touching anything.
//
// A tmux server that dies takes every managed pane with it. Reconciliation
// closes those rows out and stamps each with `lostAt` (src/reconcile.ts
// `stopGone`) — the one record of "this did not end, its server did". This
// module turns those rows into a plan: one launch per CONVERSATION, on the
// command line the conversation was started with, in the window it sat in.
//
// It is a pure function of the rows and three injected readers (when a
// conversation last did anything, whether a directory is still there, the
// clock is the caller's `sinceMs`). `src/restore-verb.ts` is the adapter that
// prints the plan, asks, and hands each item to the ordinary launch.

import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { flagsForResume } from "./recover.ts";
import { type Provider, type SessionRow } from "./state.ts";

/** The tmux session a row with no recorded layout goes back to: the one a
 *  bare launch makes (src/launch.ts `TOOL_SESSION`). */
export const DEFAULT_SESSION = "ms";

export type RestoreItem = {
  /** The lost row this launch stands in for — the newest of its conversation. */
  row: SessionRow;
  provider: Provider;
  conversation: string;
  cwd: string;
  need: SessionRow["need"];
  /** The CLI's own arguments, as recorded, with every resume and every prompt
   *  taken out. The restore supplies the one resume this launch is. */
  flags: string[];
  session: string;
  windowIndex: number | null;
  windowName: string | null;
  /** Epoch ms of the conversation's last model turn; null when nothing could
   *  date it (which only `--since all` lets through). */
  lastActivity: number | null;
};

export type RestoreSkip = { row: SessionRow; why: string };

/** One tmux server that died with managed sessions on it. */
export type LostServer = { socket: string; identity: string; lostAt: number; rows: number };

export type RestorePlan = {
  /** The server this plan restores; null when no row was ever lost with one. */
  server: LostServer | null;
  /** Every lost server on record, newest loss first — what `--server` chooses among. */
  servers: LostServer[];
  items: RestoreItem[];
  skipped: RestoreSkip[];
};

export type RestoreOptions = {
  /** Restore the server with this identity (`<pid>:<start_time>`) instead of
   *  the one lost most recently. */
  server?: string | null;
  /** Epoch-ms cutoff: a conversation whose last model turn is older stays
   *  down. Null restores however old (`--since all`). */
  sinceMs: number | null;
  /** When the conversation last did anything, epoch ms, or null. */
  activity: (row: SessionRow) => number | null;
  dirExists: (dir: string) => boolean;
};

const serverKey = (s: Pick<SessionRow, "socket" | "serverStart">): string => `${s.socket}\u0000${s.serverStart}`;
const conversationKey = (s: Pick<SessionRow, "provider" | "cliSessionId">): string => `${s.provider}\u0000${s.cliSessionId}`;
const isLost = (r: SessionRow): boolean => r.lostAt !== null && r.lostAt !== undefined;

/** Every server that rows were lost with, newest loss first. */
export function lostServers(rows: SessionRow[]): LostServer[] {
  const by = new Map<string, LostServer>();
  for (const r of rows) {
    if (!isLost(r) || !r.serverStart) continue;
    const k = serverKey(r);
    const have = by.get(k);
    if (have) { have.rows++; have.lostAt = Math.max(have.lostAt, r.lostAt!); }
    else by.set(k, { socket: r.socket, identity: r.serverStart, lostAt: r.lostAt!, rows: 1 });
  }
  return [...by.values()].sort((a, b) => b.lostAt - a.lostAt || a.identity.localeCompare(b.identity));
}

/**
 * Claude Code flags that take no value (`claude --help`, 2.1.x). A word after
 * one of these is not the flag's value, so it can only be a prompt.
 *
 * This list exists because `flagsForResume` cannot know it: reading argv
 * without the CLI's flag table, it keeps any word that follows a bare flag in
 * case it is that flag's value. For a rotation that is the safe side. For a
 * restore it is not: `ms claude -- --dangerously-skip-permissions "fix the
 * tests"` would come back with the old prompt submitted again, to every
 * conversation started that way. A flag missing from this list keeps the old
 * behaviour for the word after it, which is the worst a stale list can do.
 */
const CLAUDE_VALUELESS = new Set([
  "--allow-dangerously-skip-permissions", "--ax-screen-reader", "--bg", "--background", "--bare", "--brief",
  "--chrome", "-c", "--continue", "--dangerously-skip-permissions", "--desktop", "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections", "--fork-session", "--forward-subagent-text", "--ide",
  "--include-hook-events", "--include-partial-messages", "--no-chrome", "--no-session-persistence", "-p", "--print",
  "--replay-user-messages", "--restricted", "--safe-mode", "--strict-mcp-config", "--tmux", "--verbose",
]);

/** Claude flags a restore never re-applies: `--continue`/`-c` means "the most
 *  recent conversation in this directory", which after a server death is
 *  whichever one was written last, and `--fork-session` would resume the
 *  recorded id into a NEW one the row does not name. */
const CLAUDE_DROPPED = new Set(["--continue", "-c", "--fork-session"]);

/**
 * The CLI arguments a restored launch re-applies: what the launch was given,
 * minus anything that names a conversation or is a prompt.
 *
 * `flagsForResume` (src/recover.ts) is the rule a rotation already uses and it
 * does most of this: it drops a recorded `--resume`/`-r`/`resume` with the
 * word after it — an id, or the NAME a human resumed by, which may no longer
 * resolve — and every word it can tell is a positional. Before it, for
 * Claude, a word that follows a flag known to take no value is dropped as the
 * prompt it must be (`CLAUDE_VALUELESS`); after it, the flags a restore must
 * not repeat (`CLAUDE_DROPPED`). The recorded id is what the launch resumes.
 */
export function restoreFlags(provider: Provider, flags: string[]): string[] {
  if (provider !== "claude") return flagsForResume(flags, provider);
  const end = flags.indexOf("--") < 0 ? flags.length : flags.indexOf("--");
  const own = flags.slice(0, end).filter((a, i, all) => i === 0 || a.startsWith("-") || !CLAUDE_VALUELESS.has(all[i - 1]!));
  return flagsForResume(own, provider).filter((a) => !CLAUDE_DROPPED.has(a));
}

/**
 * The plan. Nothing here reads tmux, the store or a clock.
 *
 * In order, for the server being restored:
 *
 *   1. only rows lost WITH it, that nobody had asked to stop;
 *   2. one per conversation — a conversation that was rotated or relaunched
 *      has several rows, and the newest is the one that was running;
 *   3. not one that is running again, or was brought back since: any row for
 *      the same conversation created on ANOTHER server at or after the loss
 *      means a human or an earlier restore already answered, whatever became
 *      of that row;
 *   4. not one that was idle before `sinceMs`, and not one whose directory is
 *      gone.
 *
 * Every row that falls out is in `skipped` with the reason, except rule 2's
 * duplicates and rows that were being stopped: those are not conversations a
 * human is missing.
 */
export function planRestore(rows: SessionRow[], opts: RestoreOptions): RestorePlan {
  const servers = lostServers(rows);
  const server = opts.server ? servers.find((s) => s.identity === opts.server) ?? null : servers[0] ?? null;
  if (!server) return { server: null, servers, items: [], skipped: [] };

  const here = serverKey({ socket: server.socket, serverStart: server.identity });
  const lost = rows.filter((r) => isLost(r) && serverKey(r) === here && r.desired === "running");
  const skipped: RestoreSkip[] = [];
  const newest = new Map<string, SessionRow>();
  for (const r of lost) {
    if (!r.cliSessionId) { skipped.push({ row: r, why: "no conversation id was ever recorded for it" }); continue; }
    const k = conversationKey(r);
    const have = newest.get(k);
    if (!have || r.createdAt >= have.createdAt) newest.set(k, r);
  }

  const items: RestoreItem[] = [];
  for (const row of newest.values()) {
    // `>=`, not `>`: both stamps are whole seconds, and a restore run in the
    // second reconciliation stamped the loss writes rows that are no later.
    // The lost rows themselves are told apart by the server they were on.
    const since = rows.find((o) => o.id !== row.id && conversationKey(o) === conversationKey(row) && serverKey(o) !== here && o.createdAt >= row.lostAt!);
    if (since) {
      skipped.push({ row, why: since.state === "stopped" ? `already brought back since (session ${since.id})` : `already running in pane ${since.pane || "?"} (session ${since.id})` });
      continue;
    }
    if (!opts.dirExists(row.cwd)) { skipped.push({ row, why: `its directory is gone: ${row.cwd}` }); continue; }
    const lastActivity = opts.activity(row);
    if (opts.sinceMs !== null) {
      if (lastActivity === null) { skipped.push({ row, why: "nothing dates its last turn (--since all restores it anyway)" }); continue; }
      if (lastActivity < opts.sinceMs) { skipped.push({ row, why: `idle since ${stamp(lastActivity)}` }); continue; }
    }
    items.push({
      row, provider: row.provider, conversation: row.cliSessionId!, cwd: row.cwd, need: row.need,
      flags: restoreFlags(row.provider, row.flags),
      session: row.tmuxSession || DEFAULT_SESSION,
      windowIndex: row.windowIndex ?? null,
      windowName: row.windowName ?? null,
      lastActivity,
    });
  }
  // The order windows are made in: session by session, then by the index each
  // window had, so a window whose index is taken lands after its neighbours
  // rather than among them. Rows with no index keep the order they started in.
  items.sort((a, b) =>
    a.session.localeCompare(b.session)
    || (a.windowIndex ?? Number.MAX_SAFE_INTEGER) - (b.windowIndex ?? Number.MAX_SAFE_INTEGER)
    || a.row.createdAt - b.row.createdAt);
  return { server, servers, items, skipped };
}

/** An epoch-ms instant as `2026-10-03 14:05Z`: minutes are all a human needs
 *  to recognise when they last touched something. */
export const stamp = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

/**
 * `ms <provider> …` for one item, as argv after the verb: the same command a
 * human would type to bring this one conversation back by hand, and exactly
 * what the restore runs.
 *
 * Claude's resume is its own flag and goes on the CLI's side of `--`. Codex's
 * is NOT in here: it travels as `LaunchExtras.resumeId`, the way `ms adopt`
 * hands one over, so the row is created on the id and the flags it records
 * carry no `resume` for a later rotation to re-append (src/launch.ts).
 */
export function launchArgv(item: RestoreItem, continueAfter: boolean): string[] {
  const ours = [...(continueAfter ? ["--continue"] : []), ...(item.provider === "claude" ? ["--need", item.need] : [])];
  const theirs = item.provider === "claude" ? [...item.flags, "--resume", item.conversation] : item.flags;
  return [...ours, "--", ...theirs];
}

// --- When a conversation last did anything --------------------------------

/** How far back from the end of a transcript the last model turn is looked
 *  for. One turn with a large tool result can run to megabytes. */
const TAIL_BYTES = 8 * 1024 * 1024;

/** Is this transcript line a turn the MODEL took? Claude Code writes
 *  `type: "assistant"`; a Codex rollout wraps each item in `payload`. */
function isModelTurn(o: Record<string, unknown>): boolean {
  if (o.type === "assistant") return true;
  const payload = o.payload as Record<string, unknown> | undefined;
  return !!payload && (payload.role === "assistant" || payload.type === "agent_message" || payload.type === "task_complete");
}

/**
 * Epoch ms of the last model turn in a transcript, read from its tail; null
 * when there is no file or its tail holds no dated turn.
 *
 * Never the mtime, which `ms import` can use because it looks at
 * conversations that are open right now. A transcript is also appended to by
 * things that are not the conversation doing anything — a title, a mode
 * change, a hook's note, a resume that re-renders history — and after a server
 * death every row's own `updatedAt` is the second reconciliation ran. Measured
 * on the store this was written against: 40 transcripts all modified within
 * two minutes of each other one morning, their last model turns spread over
 * five weeks, and seven of them two-kilobyte files of metadata records with no
 * turn in them at all. Falling back on the mtime called those seven active.
 */
export function lastTurnAt(file: string): number | null {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString("utf8").split("\n");
    // The first line of a tail that does not start at byte 0 is a fragment.
    for (let i = lines.length - 1; i >= (length < size ? 1 : 0); i--) {
      const line = lines[i]!;
      if (!line || !line.includes('"timestamp"')) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (!isModelTurn(o)) continue;
      const t = Date.parse(String(o.timestamp ?? ""));
      if (Number.isFinite(t)) return t;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Claude Code's own name for a project directory: every character that is
 *  not a letter or a digit becomes `-`. */
const claudeProjectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** Where a row's transcript is: what its own hooks reported, else — for
 *  Claude, whose path is a function of the directory and the id — where Claude
 *  Code would have written it. Null for a Codex row that never reported one. */
export function transcriptOf(row: SessionRow, env: NodeJS.ProcessEnv = process.env): string | null {
  if (row.transcriptPath && existsSync(row.transcriptPath)) return row.transcriptPath;
  if (row.provider !== "claude" || !row.cliSessionId) return null;
  const root = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const file = join(root, "projects", claudeProjectDir(row.cwd), `${row.cliSessionId}.jsonl`);
  return existsSync(file) ? file : null;
}

export function defaultActivity(row: SessionRow): number | null {
  const file = transcriptOf(row);
  return file ? lastTurnAt(file) : null;
}

export function defaultDirExists(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}
