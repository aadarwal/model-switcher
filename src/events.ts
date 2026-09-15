import { appendFileSync, existsSync, readFileSync, openSync, closeSync, fstatSync, readSync, statSync, chmodSync } from "node:fs";
import { ensureSessionDir, p } from "./paths.ts";

export type EventKind = "started" | "resumed" | "cleared" | "compacted" | "activity" | "rate_limited" | "ended" | "died" | "recovery" | "note";
export type Event = { t: number; kind: EventKind; session: string; generation: number; cliSessionId?: string | null; turnId?: string | null; kindDetail?: string; text?: string };

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
