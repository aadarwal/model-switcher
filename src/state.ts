/**
 * State store for model-switcher, over `node:sqlite`'s `DatabaseSync`.
 * All timestamps in this module — `createdAt`, `updatedAt`, `wakeupAt`,
 * `nextAttemptAt`, and launch `createdAt` — are unix SECONDS, not
 * milliseconds (`now()` below floors `Date.now() / 1000`).
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";

export type Provider = "claude" | "codex";
export type SessionState = "launching" | "running" | "walled" | "stopping" | "resuming" | "continuing" | "parked" | "waiting" | "stopped";
export type SessionRow = { id: string; provider: Provider; cliSessionId: string | null; cwd: string; socket: string; pane: string;
  serverStart: string; need: "any" | "fable"; account: string; generation: number; state: SessionState;
  desired: "running" | "stopped"; flags: string[]; wakeupAt: number | null; createdAt: number; updatedAt: number;
  /** Codex's rollout file for this conversation, as its own hook payloads
   *  report it (`transcript_path`). It is the ONLY place a usage-limit turn
   *  leaves a record: that branch fires no hook and emits no notify, but it
   *  IS persisted here as a `task_complete` whose `error.codex_error_info` is
   *  `usage_limit_exceeded`. Null until a SessionStart has reported one. */
  transcriptPath: string | null;
  /** How many bytes of `transcriptPath` the tool has already read and acted
   *  on. The watchdog is a tailer, so this is what keeps a resumed session's
   *  re-rendered history — old failures included — from being read twice. */
  rolloutOffset: number;
  /** When rebalance (src/rebalance.ts) last moved this session, in unix
   *  SECONDS like every other time in this module, or null if it never has.
   *  It is the hysteresis record: written BEFORE the move is dispatched, so
   *  a switch that then refuses still costs the six-hour cooldown rather
   *  than leaving the rule free to try again on the very next turn. The
   *  whole guard is wider than this column — a human's `ms switch` and a
   *  wall's rotation both count as moves, and both are read out of the
   *  `launches` table by `lastAccountChangeAt` — so nothing here needs to
   *  be back-filled for an old store. */
  lastMoveAt: number | null };
export type LaunchRow = { id: string; sessionId: string; generation: number; account: string; command: string[]; env: Record<string, string>; createdAt: number };
export type WallKind = "session" | "weekly" | "fable" | "unknown";
export type RecoveryRow = { id: number; sessionId: string; generation: number; turnId: string | null; kind: WallKind;
  status: "pending" | "owned" | "done" | "obsolete" | "failed"; owner: string | null; attempts: number; nextAttemptAt: number | null; createdAt: number; updatedAt: number };
export type AttemptOutcome = "ok" | "exhausted" | "auth" | "infra" | "resume-broken" | "forced";
export type AttemptRow = { id: number; recoveryId: number; account: string; outcome: AttemptOutcome; note: string; createdAt: number };
type RecoveryInput = Omit<RecoveryRow, "id" | "status" | "owner" | "attempts" | "nextAttemptAt" | "createdAt" | "updatedAt">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, provider TEXT, cliSessionId TEXT, cwd TEXT, socket TEXT, pane TEXT,
  serverStart TEXT, need TEXT, account TEXT, generation INTEGER, state TEXT, desired TEXT, flags TEXT, wakeupAt INTEGER, createdAt INTEGER, updatedAt INTEGER,
  transcriptPath TEXT, rolloutOffset INTEGER NOT NULL DEFAULT 0, lastMoveAt INTEGER);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, sessionId TEXT, generation INTEGER, account TEXT, command TEXT, env TEXT, createdAt INTEGER);
CREATE TABLE IF NOT EXISTS recoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, generation INTEGER, turnId TEXT, kind TEXT,
  status TEXT, owner TEXT, attempts INTEGER DEFAULT 0, nextAttemptAt INTEGER, createdAt INTEGER, updatedAt INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_recovery ON recoveries(sessionId) WHERE status IN ('pending','owned');
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, recoveryId INTEGER, account TEXT, outcome TEXT, note TEXT, createdAt INTEGER);
`;
const now = () => Math.floor(Date.now() / 1000);

/** Columns `updateSession` is allowed to write. `id` is immutable,
 * `createdAt` is set once at creation, and `updatedAt` is always stamped
 * by this class from its own clock, never from the caller's patch — so
 * none of the three are listed here. Whitelisting instead of trusting
 * `Object.keys(patch)` also closes an injection hole: a patch key that is
 * itself a SQL fragment (e.g. `"account=99, state"`, which the old
 * `${cols.map(c => \`${c}=?\`)}` template would have spliced straight into
 * the SET clause) can never become a column reference, because it simply
 * isn't in this set. */
const SESSION_COLUMNS = new Set<string>([
  "provider", "cliSessionId", "cwd", "socket", "pane", "serverStart", "need",
  "account", "generation", "state", "desired", "flags", "wakeupAt",
  "transcriptPath", "rolloutOffset", "lastMoveAt",
]);

/**
 * Columns added to `sessions` after the table shipped, newest last.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a store written by an older build keeps the old shape and every query naming
 * a new column fails — not at install time, but the first time a hook runs.
 * The constructor therefore asks the table what columns it HAS and adds only
 * the missing ones. `ALTER TABLE … ADD COLUMN` is the one schema change SQLite
 * does in place and without rewriting rows, and a NOT NULL column is legal
 * there precisely because it carries a DEFAULT — which is also what gives
 * every pre-existing row an honest value.
 */
const ADDED_SESSION_COLUMNS: readonly [string, string][] = [
  ["transcriptPath", "transcriptPath TEXT"],
  ["rolloutOffset", "rolloutOffset INTEGER NOT NULL DEFAULT 0"],
  ["lastMoveAt", "lastMoveAt INTEGER"],
];

function isUniqueConstraintError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return code === "ERR_SQLITE_ERROR" && /UNIQUE constraint failed/.test(e.message);
}

export class State {
  private closed = false;
  constructor(private db: DatabaseSync) {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    db.exec(SCHEMA);
    this.migrate();
  }
  /** Bring a store written by an older build up to the current shape. Additive
   * only: it never drops or rewrites a column, so downgrading is survivable
   * and a half-applied migration simply finishes on the next open. */
  private migrate(): void {
    const have = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((r) => r.name));
    for (const [col, ddl] of ADDED_SESSION_COLUMNS) if (!have.has(col)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
  }
  private rowToSession(r: Record<string, unknown> | undefined): SessionRow | null {
    if (!r) return null;
    return { ...(r as unknown as SessionRow), flags: JSON.parse(String(r.flags ?? "[]")) };
  }
  /** `transcriptPath` and `rolloutOffset` are deliberately NOT creation inputs:
   * nothing knows a Codex rollout path before the CLI has reported one, and the
   * offset starts at zero by definition. Both take their column defaults and
   * are written later through `updateSession`. `lastMoveAt` joins them for the
   * same reason: a session that was only just created has never been moved. */
  createSession(s: Omit<SessionRow, "wakeupAt" | "createdAt" | "updatedAt" | "transcriptPath" | "rolloutOffset" | "lastMoveAt">): void {
    const t = now();
    this.db.prepare(`INSERT INTO sessions (id,provider,cliSessionId,cwd,socket,pane,serverStart,need,account,generation,state,desired,flags,wakeupAt,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, s.provider, s.cliSessionId, s.cwd, s.socket, s.pane, s.serverStart, s.need, s.account, s.generation, s.state, s.desired, JSON.stringify(s.flags), null, t, t);
  }
  getSession(id: string): SessionRow | null { return this.rowToSession(this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined); }
  listSessions(): SessionRow[] { return (this.db.prepare("SELECT * FROM sessions ORDER BY createdAt").all() as Record<string, unknown>[]).map((r) => this.rowToSession(r)!); }
  updateSession(id: string, patch: Partial<SessionRow>): void {
    const cols = Object.keys(patch).filter((k) => SESSION_COLUMNS.has(k));
    if (!cols.length) return;
    const vals = cols.map((k) => (k === "flags" ? JSON.stringify((patch as Record<string, unknown>)[k]) : (patch as Record<string, unknown>)[k]));
    this.db.prepare(`UPDATE sessions SET ${cols.map((c) => `${c}=?`).join(",")}, updatedAt=? WHERE id=?`).run(...(vals as (string | number | null)[]), now(), id);
  }
  createLaunch(l: LaunchRow): void {
    this.db.prepare("INSERT INTO launches (id,sessionId,generation,account,command,env,createdAt) VALUES (?,?,?,?,?,?,?)")
      .run(l.id, l.sessionId, l.generation, l.account, JSON.stringify(l.command), JSON.stringify(l.env), l.createdAt);
  }
  /**
   * How many times this session has been handed to another account since
   * `since` (unix seconds).
   *
   * Every respawn a recovery makes writes a launch row, and the only launch
   * with generation 1 is the one the session was BORN on — so "generation > 1"
   * is exactly "a change", with no join and no interpretation. This is the
   * record `src/recover.ts`'s rate cap reads: it spans recoveries, where the
   * attempts of any one of them cannot.
   */
  accountChangesSince(sessionId: string, since: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM launches WHERE sessionId=? AND generation>1 AND createdAt>=?").get(sessionId, since) as { n: number } | undefined;
    return Number(r?.n ?? 0);
  }
  /**
   * WHEN this session was last handed to another account, or null — the other
   * half of `accountChangesSince` above, and the clock rebalance's six-hour
   * hysteresis reads for moves it did not make itself.
   *
   * Same evidence, same rule: every respawn a handoff makes writes a launch
   * row, and the only launch with generation 1 is the one the session was
   * born on, so `generation > 1` is exactly "a change of account" — a
   * human's `ms switch`, a wall's rotation and a rebalance alike. Reading it
   * here means rebalance does not have to trust a column only rebalance
   * writes, and a store that predates that column still answers honestly.
   */
  lastAccountChangeAt(sessionId: string): number | null {
    const r = this.db.prepare("SELECT MAX(createdAt) AS t FROM launches WHERE sessionId=? AND generation>1").get(sessionId) as { t: number | null } | undefined;
    const t = r?.t ?? null;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  }
  getLaunch(id: string): LaunchRow | null {
    const r = this.db.prepare("SELECT * FROM launches WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as LaunchRow), command: JSON.parse(String(r.command)), env: JSON.parse(String(r.env)) } : null;
  }
  /** Raw insert of a new pending recovery row, with no pre-check — this is
   * the fix for the addRecovery TOCTOU race: two processes (e.g. a
   * StopFailure hook and a tmux-dispatched worker, or two hooks) can both
   * observe `pendingRecovery` return null and both reach here. The
   * `one_open_recovery` partial unique index lets only one INSERT win;
   * the loser catches the constraint error and returns the winner's id
   * instead of throwing — a hook must never fail loudly, and the losing
   * process still gets a valid recovery id to act on. Exposed (not
   * private) so this race can be exercised directly: calling it twice for
   * the same session is exactly what two racing processes look like from
   * the database's point of view. */
  insertRecovery(r: RecoveryInput): number {
    const t = now();
    try {
      const res = this.db.prepare("INSERT INTO recoveries (sessionId,generation,turnId,kind,status,createdAt,updatedAt) VALUES (?,?,?,?,'pending',?,?)")
        .run(r.sessionId, r.generation, r.turnId, r.kind, t, t);
      return Number(res.lastInsertRowid);
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        const winner = this.pendingRecovery(r.sessionId);
        if (winner) return winner.id;
      }
      throw e;
    }
  }
  addRecovery(r: RecoveryInput): number {
    const open = this.pendingRecovery(r.sessionId);
    if (open) return open.id;
    return this.insertRecovery(r);
  }
  pendingRecovery(sessionId: string): RecoveryRow | null {
    return (this.db.prepare("SELECT * FROM recoveries WHERE sessionId=? AND status IN ('pending','owned') LIMIT 1").get(sessionId) as RecoveryRow | undefined) ?? null;
  }
  ownRecovery(id: number, owner: string): boolean {
    const res = this.db.prepare("UPDATE recoveries SET status='owned', owner=?, updatedAt=? WHERE id=? AND status='pending'").run(owner, now(), id);
    return Number(res.changes) === 1;
  }
  finishRecovery(id: number, status: "done" | "obsolete" | "failed"): void { this.db.prepare("UPDATE recoveries SET status=?, updatedAt=? WHERE id=?").run(status, now(), id); }
  releaseRecovery(id: number): void { this.db.prepare("UPDATE recoveries SET status='pending', owner=NULL, updatedAt=? WHERE id=?").run(now(), id); }
  /**
   * Release a recovery ONLY if it is still the exact row the caller judged
   * abandoned — same `owner`, same `updatedAt`. Returns whether it moved.
   *
   * Reconciliation decides a worker is dead by reading a row and then asking
   * the kernel about a pid, which takes time; a real worker can claim the row
   * in that window, and an unconditional `releaseRecovery` would erase a live
   * owner (or drag a finished recovery back to `pending`). The WHERE clause is
   * the compare-and-set that makes the judgement and the write one decision:
   * `status='owned'` bounds it to a row still in that state, and `owner IS ?`
   * compares NULL as a value rather than as SQL's unknown.
   */
  releaseRecoveryIf(id: number, expect: { owner: string | null; updatedAt: number }): boolean {
    const res = this.db.prepare("UPDATE recoveries SET status='pending', owner=NULL, updatedAt=? WHERE id=? AND status='owned' AND owner IS ? AND updatedAt=?")
      .run(now(), id, expect.owner, expect.updatedAt);
    return Number(res.changes) === 1;
  }
  /**
   * Stamp a recovery as acted on, without changing what it says. Reconciliation
   * dispatches a worker at an orphaned `pending` row and writes nothing else;
   * without this the row stays exactly as old as it was and the NEXT invocation
   * dispatches a second worker at it. `updatedAt` is "when someone last did
   * something about this", so moving it is the whole record of the dispatch.
   */
  touchRecovery(id: number): void { this.db.prepare("UPDATE recoveries SET updatedAt=? WHERE id=?").run(now(), id); }
  addAttempt(a: { recoveryId: number; account: string; outcome: AttemptOutcome; note: string }): void {
    const t = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO attempts (recoveryId,account,outcome,note,createdAt) VALUES (?,?,?,?,?)").run(a.recoveryId, a.account, a.outcome, a.note, t);
      this.db.prepare("UPDATE recoveries SET attempts=attempts+1, updatedAt=? WHERE id=?").run(t, a.recoveryId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  attempts(recoveryId: number): AttemptRow[] { return this.db.prepare("SELECT * FROM attempts WHERE recoveryId=? ORDER BY id").all(recoveryId) as AttemptRow[]; }
  /** A tiny key/value side table for state that belongs to the TOOL rather
   * than to any one session — currently just the Codex watchdog's single
   * armed-until epoch, which is what makes one timer per tmux server instead
   * of one per turn. */
  getKv(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
    return r ? r.v : null;
  }
  setKv(k: string, v: string): void { this.db.prepare("INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v); }
  delKv(k: string): void { this.db.prepare("DELETE FROM kv WHERE k=?").run(k); }
  /**
   * Move a session's rollout offset, but ONLY while it still names the file
   * the offset was measured in.
   *
   * The Codex watch reads a row at the start of a pass and stamps the offset
   * at the end of it. In between, a `/new` in that pane fires a SessionStart
   * whose hook points the row at a fresh rollout and resets the offset to 0 —
   * and that hook does not hold the watch's lock. A plain `updateSession`
   * would then stamp the OLD file's offset onto the NEW path, and the watch
   * would skip the first N bytes of a conversation it has never read (it
   * self-heals only while the new file happens to be shorter). The path in
   * the WHERE clause is what makes the write a no-op instead.
   */
  advanceRolloutOffset(sessionId: string, transcriptPath: string, offset: number): void {
    this.db.prepare("UPDATE sessions SET rolloutOffset=?, updatedAt=? WHERE id=? AND transcriptPath=?").run(offset, now(), sessionId, transcriptPath);
  }
  setWakeup(sessionId: string, at: number | null): void { this.db.prepare("UPDATE sessions SET wakeupAt=?, updatedAt=? WHERE id=?").run(at, now(), sessionId); }
  /**
   * Clear a wake-up ONLY if it is still the exact deadline being consumed.
   * Returns whether it cleared.
   *
   * A wake-up is a promise with a time on it. Whoever acts on a due deadline
   * clears that deadline — not "the wake-up", which by then may be a NEWER one
   * a recovery worker scheduled in the meantime. Clearing that would drop a
   * scheduled retry on the floor and leave the session waiting forever.
   */
  clearWakeupIf(sessionId: string, deadline: number): boolean {
    const res = this.db.prepare("UPDATE sessions SET wakeupAt=NULL, updatedAt=? WHERE id=? AND wakeupAt=?").run(now(), sessionId, deadline);
    return Number(res.changes) === 1;
  }
  dueWakeups(t: number): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE wakeupAt IS NOT NULL AND wakeupAt<=? ORDER BY wakeupAt").all(t) as Record<string, unknown>[]).map((r) => this.rowToSession(r)!);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function openState(): State {
  ensureStore();
  // Create the file ourselves, at 0600, before SQLite can — exactly as
  // src/lock.ts does for locks.sqlite. Letting SQLite create it means it is
  // born 0644 (minus umask) and stays world-readable until the chmod below
  // lands: a window, however short, in which every session's id, account and
  // cwd is readable by anything on the box. `open(…, "a")` on a file that is
  // already there changes nothing about it.
  closeSync(openSync(p.state, "a", 0o600));
  const db = new DatabaseSync(p.state);
  // Chmod unconditionally all the same — a pre-existing file (created by an
  // older build, or anything else) may be 0644 — and do it BEFORE enabling
  // WAL: SQLite copies the main db file's permissions onto the -wal/-shm
  // sidecar files at the moment it creates them, so chmodding first means
  // those sidecars are born 0600 rather than inheriting umask.
  chmodSync(p.state, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const f = `${p.state}${suffix}`;
    if (existsSync(f)) chmodSync(f, 0o600);
  }
  const state = new State(db);
  // Belt-and-suspenders: the constructor's PRAGMA is what actually creates
  // the sidecars on a brand-new file, so chmod them again now that they
  // exist, in case the copy-on-create behavior above didn't apply.
  for (const suffix of ["-wal", "-shm"]) {
    const f = `${p.state}${suffix}`;
    if (existsSync(f)) chmodSync(f, 0o600);
  }
  return state;
}
