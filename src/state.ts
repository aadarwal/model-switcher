import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";

export type Provider = "claude" | "codex";
export type SessionState = "launching" | "running" | "walled" | "stopping" | "resuming" | "continuing" | "parked" | "waiting" | "stopped";
export type SessionRow = { id: string; provider: Provider; cliSessionId: string | null; cwd: string; socket: string; pane: string;
  serverStart: string; need: "any" | "fable"; account: string; generation: number; state: SessionState;
  desired: "running" | "stopped"; flags: string[]; createdAt: number; updatedAt: number };
export type LaunchRow = { id: string; sessionId: string; generation: number; account: string; command: string[]; env: Record<string, string>; createdAt: number };
export type WallKind = "session" | "weekly" | "fable" | "unknown";
export type RecoveryRow = { id: number; sessionId: string; generation: number; turnId: string | null; kind: WallKind;
  status: "pending" | "owned" | "done" | "obsolete"; owner: string | null; attempts: number; nextAttemptAt: number | null; createdAt: number; updatedAt: number };
export type AttemptOutcome = "ok" | "exhausted" | "auth" | "infra" | "resume-broken" | "forced";
export type AttemptRow = { id: number; recoveryId: number; account: string; outcome: AttemptOutcome; note: string; createdAt: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, provider TEXT, cliSessionId TEXT, cwd TEXT, socket TEXT, pane TEXT,
  serverStart TEXT, need TEXT, account TEXT, generation INTEGER, state TEXT, desired TEXT, flags TEXT, wakeupAt INTEGER, createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, sessionId TEXT, generation INTEGER, account TEXT, command TEXT, env TEXT, createdAt INTEGER);
CREATE TABLE IF NOT EXISTS recoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT, generation INTEGER, turnId TEXT, kind TEXT,
  status TEXT, owner TEXT, attempts INTEGER DEFAULT 0, nextAttemptAt INTEGER, createdAt INTEGER, updatedAt INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_recovery ON recoveries(sessionId) WHERE status IN ('pending','owned');
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, recoveryId INTEGER, account TEXT, outcome TEXT, note TEXT, createdAt INTEGER);
`;
const now = () => Math.floor(Date.now() / 1000);

export class State {
  constructor(private db: DatabaseSync) { db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); db.exec(SCHEMA); }
  private rowToSession(r: Record<string, unknown> | undefined): SessionRow | null {
    if (!r) return null;
    return { ...(r as unknown as SessionRow), flags: JSON.parse(String(r.flags ?? "[]")) };
  }
  createSession(s: Omit<SessionRow, "createdAt" | "updatedAt">): void {
    const t = now();
    this.db.prepare(`INSERT INTO sessions (id,provider,cliSessionId,cwd,socket,pane,serverStart,need,account,generation,state,desired,flags,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id, s.provider, s.cliSessionId, s.cwd, s.socket, s.pane, s.serverStart, s.need, s.account, s.generation, s.state, s.desired, JSON.stringify(s.flags), t, t);
  }
  getSession(id: string): SessionRow | null { return this.rowToSession(this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined); }
  listSessions(): SessionRow[] { return (this.db.prepare("SELECT * FROM sessions ORDER BY createdAt").all() as Record<string, unknown>[]).map((r) => this.rowToSession(r)!); }
  updateSession(id: string, patch: Partial<SessionRow>): void {
    const cols = Object.keys(patch).filter((k) => k !== "id");
    if (!cols.length) return;
    const vals = cols.map((k) => (k === "flags" ? JSON.stringify((patch as Record<string, unknown>)[k]) : (patch as Record<string, unknown>)[k]));
    this.db.prepare(`UPDATE sessions SET ${cols.map((c) => `${c}=?`).join(",")}, updatedAt=? WHERE id=?`).run(...(vals as (string | number | null)[]), now(), id);
  }
  createLaunch(l: LaunchRow): void {
    this.db.prepare("INSERT INTO launches (id,sessionId,generation,account,command,env,createdAt) VALUES (?,?,?,?,?,?,?)")
      .run(l.id, l.sessionId, l.generation, l.account, JSON.stringify(l.command), JSON.stringify(l.env), l.createdAt);
  }
  getLaunch(id: string): LaunchRow | null {
    const r = this.db.prepare("SELECT * FROM launches WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as LaunchRow), command: JSON.parse(String(r.command)), env: JSON.parse(String(r.env)) } : null;
  }
  addRecovery(r: { sessionId: string; generation: number; turnId: string | null; kind: WallKind }): number {
    const open = this.pendingRecovery(r.sessionId);
    if (open) return open.id;
    const t = now();
    const res = this.db.prepare("INSERT INTO recoveries (sessionId,generation,turnId,kind,status,createdAt,updatedAt) VALUES (?,?,?,?,'pending',?,?)")
      .run(r.sessionId, r.generation, r.turnId, r.kind, t, t);
    return Number(res.lastInsertRowid);
  }
  pendingRecovery(sessionId: string): RecoveryRow | null {
    return (this.db.prepare("SELECT * FROM recoveries WHERE sessionId=? AND status IN ('pending','owned') LIMIT 1").get(sessionId) as RecoveryRow | undefined) ?? null;
  }
  ownRecovery(id: number, owner: string): boolean {
    const res = this.db.prepare("UPDATE recoveries SET status='owned', owner=?, updatedAt=? WHERE id=? AND status='pending'").run(owner, now(), id);
    return Number(res.changes) === 1;
  }
  finishRecovery(id: number, status: "done" | "obsolete"): void { this.db.prepare("UPDATE recoveries SET status=?, updatedAt=? WHERE id=?").run(status, now(), id); }
  releaseRecovery(id: number): void { this.db.prepare("UPDATE recoveries SET status='pending', owner=NULL, updatedAt=? WHERE id=?").run(now(), id); }
  addAttempt(a: { recoveryId: number; account: string; outcome: AttemptOutcome; note: string }): void {
    this.db.prepare("INSERT INTO attempts (recoveryId,account,outcome,note,createdAt) VALUES (?,?,?,?,?)").run(a.recoveryId, a.account, a.outcome, a.note, now());
    this.db.prepare("UPDATE recoveries SET attempts=attempts+1, updatedAt=? WHERE id=?").run(now(), a.recoveryId);
  }
  attempts(recoveryId: number): AttemptRow[] { return this.db.prepare("SELECT * FROM attempts WHERE recoveryId=? ORDER BY id").all(recoveryId) as AttemptRow[]; }
  setWakeup(sessionId: string, at: number | null): void { this.db.prepare("UPDATE sessions SET wakeupAt=?, updatedAt=? WHERE id=?").run(at, now(), sessionId); }
  dueWakeups(t: number): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE wakeupAt IS NOT NULL AND wakeupAt<=? ORDER BY wakeupAt").all(t) as Record<string, unknown>[]).map((r) => this.rowToSession(r)!);
  }
  close(): void { this.db.close(); }
}

export function openState(): State {
  ensureStore();
  const fresh = !existsSync(p.state);
  const db = new DatabaseSync(p.state);
  if (fresh) chmodSync(p.state, 0o600);
  return new State(db);
}
