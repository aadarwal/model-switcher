import { appendFileSync, existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { ensureSessionDir, p } from "./paths.ts";

export type EventKind = "started" | "resumed" | "cleared" | "compacted" | "activity" | "rate_limited" | "ended" | "died" | "recovery" | "note";
export type Event = { t: number; kind: EventKind; session: string; generation: number; cliSessionId?: string | null; turnId?: string | null; kindDetail?: string; text?: string };

export function appendEvent(e: Event): void {
  ensureSessionDir(e.session);
  const f = p.eventsFile(e.session);
  if (!existsSync(f)) closeSync(openSync(f, "a", 0o600));
  appendFileSync(f, JSON.stringify(e) + "\n", { mode: 0o600 });
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
