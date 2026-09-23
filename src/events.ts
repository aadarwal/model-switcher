import { appendFileSync, existsSync, readFileSync, openSync, closeSync, fstatSync, readSync, statSync, chmodSync } from "node:fs";
import { ensureSessionDir, p } from "./paths.ts";

/** `stop` is Codex's: it records that ONE turn finished, from either of the
 * two places that can say so — the Stop hook, which fires only on success,
 * and `ms _codex_watch` reading the turn's `task_complete` out of the
 * rollout. The fleet watchdog reads its presence for a turn id as "that turn
 * is settled, stop watching it". Claude Code has no equivalent, because its
 * wall arrives as a StopFailure: recording the END of a turn is only
 * load-bearing where the SIGNAL is a turn that never ended. */
export type EventKind = "started" | "resumed" | "cleared" | "compacted" | "activity" | "stop" | "rate_limited" | "ended" | "died" | "recovery" | "note" | "rebalance";
/** `cliSessionId` is the CLI's own id as the hook reported it. When a
 * SessionStart moves the session onto a NEW id — a `/clear`, an interactive
 * `/resume`, a fork — `prevCliSessionId` carries the one it left, so the
 * audit log records the change itself and not merely its result.
 *
 * `turnId` is the CLI's own id for ONE turn (Codex reports it on
 * UserPromptSubmit and again on Stop). It is what lets a watchdog armed for
 * a turn recognise that very turn's ending, rather than any later one.
 *
 * `from`/`to` are a `rebalance`'s two accounts, and its `kindDetail` is the
 * condition that moved it (`imminent-wall` | `better-budget`) — the same
 * place a `rate_limited` records which window walled. Naming the accounts
 * rather than only the destination is what makes the log answer "where was
 * this session before the rule touched it" without a join. */
export type Event = { t: number; kind: EventKind; session: string; generation: number; cliSessionId?: string | null; prevCliSessionId?: string | null; turnId?: string | null; kindDetail?: string; text?: string; from?: string; to?: string };

/** True if the file is non-empty and its last byte is not '\n' — a torn
 * fragment left by a crash mid-write. Bounded: opens the file, checks its
 * size, reads only the last byte, never the whole file. */
function endsWithoutNewline(f: string): boolean {
  const fd = openSync(f, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function appendEvent(e: Event): void {
  ensureSessionDir(e.session);
  const f = p.eventsFile(e.session);
  if (!existsSync(f)) closeSync(openSync(f, "a", 0o600));
  const torn = endsWithoutNewline(f);
  const line = (torn ? "\n" : "") + JSON.stringify(e) + "\n";
  appendFileSync(f, line, { mode: 0o600 });
  if ((statSync(f).mode & 0o777) !== 0o600) chmodSync(f, 0o600);
}
export function readEvents(session: string): Event[] {
  const f = p.eventsFile(session);
  if (!existsSync(f)) return [];
  const out: Event[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Event); } catch { /* torn trailing line: ignore */ }
  }
  return out;
}
export function lastEvent(session: string, kind?: EventKind): Event | null {
  const ev = readEvents(session).filter((e) => !kind || e.kind === kind);
  return ev.length ? ev[ev.length - 1] : null;
}
