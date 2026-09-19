// `ms calendar` — every account's upcoming limit resets, as calendar events.
//
// A usage window's `resetsAt` is the one future-dated fact `ms` holds: when an
// account that is short of room gets it back. `ms status` prints the earliest
// weekly one as a timestamp; this lays all of them out in time, and hands them
// to a calendar:
//
//   ms calendar                  a table grouped by local day
//   ms calendar --ics            an iCalendar document (import it, or subscribe
//                                a local calendar app to the dashboard's feed)
//   ms calendar --all            also windows with nothing used (hidden by default)
//   ms calendar --days N         the horizon, 1-60 (default 8)
//   ms calendar --json           the events, each with an "Add to Google
//                                Calendar" link
//
// Google Calendar cannot subscribe to a feed on 127.0.0.1 — it fetches feeds
// from Google's servers — so the Google path is the per-event template link
// (or importing the .ics). Nothing here talks to Google: a link is only a URL,
// and the account name leaves this machine when a human clicks it.
//
// Everything above `calendar` (the verb) is pure: accounts and a clock in,
// events and text out. It reads the same coalesced snapshot `ms status` does
// and never polls on its own account.

import type { Verb } from "./cli.ts";
import type { Provider } from "./registry.ts";
import type { Window } from "./pick.ts";

export type ResetWindow = "5h" | "week" | "fable";

export type ResetEvent = {
  account: string;
  provider: Provider;
  /** The registry's display label; "" when the row has none of its own. */
  label: string;
  /** Which limits come back at this instant. More than one when they coincide. */
  windows: ResetWindow[];
  /** ISO 8601, UTC — the provider's own `resetsAt`, normalised. */
  at: string;
  /** How used the window is now; the worst of `windows` when several coincide. */
  usedPercent: number;
};

/** What `/api/calendar` and `--json` serve: an event plus the two strings a
 *  client would otherwise have to rebuild. */
export type ResetEventView = ResetEvent & { title: string; googleUrl: string };

type CalendarAccount = {
  name: string;
  provider: Provider;
  label?: string;
  usage: { session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null } | null;
};

export const DEFAULT_CALENDAR_DAYS = 8; // a full weekly window, plus the day it lands on
const EVENT_MINUTES = 15;
const PRODID = "-//model-switcher//ms calendar//EN";

const WINDOW_KEYS: readonly [keyof NonNullable<CalendarAccount["usage"]>, ResetWindow][] = [
  ["session", "5h"],
  ["weeklyAll", "week"],
  ["weeklyFable", "fable"],
];

/** Upcoming resets inside `(now, now + days]`, soonest first. A past reset, a
 *  window that has not started (`resetsAt: null`), an unparseable date and an
 *  account that has never been polled are all simply not events. */
export function resetEvents(accounts: CalendarAccount[], nowMs: number, days: number, opts: { includeIdle?: boolean } = {}): ResetEvent[] {
  const horizon = nowMs + days * 86_400_000;
  const out: ResetEvent[] = [];
  for (const a of accounts) {
    if (!a.usage) continue;
    const byInstant = new Map<number, ResetEvent>();
    for (const [key, name] of WINDOW_KEYS) {
      const w = a.usage[key];
      // Snapped to the minute: a provider reports the same reset a fraction of a
      // second differently from poll to poll (13:59:59.87, then 14:00:00.12), and
      // an unsnapped instant would split one reset into two rows and give each
      // poll's event a new UID -- a duplicate on every re-import.
      const raw = w?.resetsAt ? Date.parse(w.resetsAt) : NaN;
      const t = Math.round(raw / 60_000) * 60_000;
      if (!w || !Number.isFinite(t) || t <= nowMs || t > horizon) continue;
      // A window with nothing used has nothing to give back; by default it is not an event.
      if (!opts.includeIdle && !(w.usedPercent > 0)) continue;
      const seen = byInstant.get(t);
      if (seen) {
        seen.windows.push(name);
        seen.usedPercent = Math.max(seen.usedPercent, w.usedPercent);
      } else {
        byInstant.set(t, { account: a.name, provider: a.provider, label: a.label && a.label !== a.name ? a.label : "",
          windows: [name], at: new Date(t).toISOString(), usedPercent: w.usedPercent });
      }
    }
    out.push(...byInstant.values());
  }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || x.account.localeCompare(y.account));
}

export function windowsPhrase(windows: ResetWindow[]): string {
  return windows.join(" + ");
}

export function eventTitle(e: ResetEvent): string {
  return `ms: ${e.account} (${e.provider}) ${windowsPhrase(e.windows)} limit resets`;
}

export function eventDetails(e: ResetEvent): string {
  const who = e.label ? `${e.account} — ${e.label}` : e.account;
  return `${who}: the ${windowsPhrase(e.windows)} usage window resets. ${Math.round(e.usedPercent)}% used when this was written. From model-switcher (ms calendar).`;
}

/** `20260918T150405Z` — the UTC "basic" form both Google's template link and iCalendar use. */
export function utcBasic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Google Calendar's own "create event" template link. Only a URL: nothing is
 *  sent anywhere until a human opens it, signed in to their own calendar. */
export function googleCalendarUrl(e: ResetEvent): string {
  const start = Date.parse(e.at);
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: eventTitle(e),
    dates: `${utcBasic(start)}/${utcBasic(start + EVENT_MINUTES * 60_000)}`,
    details: eventDetails(e),
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function toEventViews(events: ResetEvent[]): ResetEventView[] {
  return events.map((e) => ({ ...e, title: eventTitle(e), googleUrl: googleCalendarUrl(e) }));
}

/** RFC 5545 §3.3.11 TEXT: backslash, semicolon, comma and newline are escaped. */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545 §3.1: a content line is at most 75 OCTETS; a longer one continues
 *  on the next line after CRLF + one space. Split on code points, so a
 *  multi-byte character is never cut in half. */
export function icsFold(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    const limit = parts.length === 0 ? 75 : 74; // continuation lines spend one octet on the leading space
    if (bytes + n > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/** A UID that depends only on WHAT resets and WHEN, so importing a newer file
 *  updates the same events instead of stacking duplicates. */
export function eventUid(e: ResetEvent): string {
  return `${e.provider}-${e.account}-${e.windows.join("-")}-${utcBasic(Date.parse(e.at))}@model-switcher`;
}

export function toIcs(events: ResetEvent[], nowMs: number): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${PRODID}`, "CALSCALE:GREGORIAN", "X-WR-CALNAME:model-switcher resets"];
  for (const e of events) {
    const start = Date.parse(e.at);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(eventUid(e))}`,
      `DTSTAMP:${utcBasic(nowMs)}`,
      `DTSTART:${utcBasic(start)}`,
      `DTEND:${utcBasic(start + EVENT_MINUTES * 60_000)}`,
      `SUMMARY:${icsEscape(eventTitle(e))}`,
      `DESCRIPTION:${icsEscape(eventDetails(e))}`,
      "TRANSP:TRANSPARENT", // a reset is information, not a meeting: it must not mark the owner busy
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

const pad = (n: number): string => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Fri 2026-09-18` in LOCAL time — the day a human will look for it under. */
export function localDayHeading(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function calendarText(events: ResetEvent[], days: number): string {
  if (!events.length) return `no limit resets in the next ${days} days (nothing polled yet, or every window is idle)\n`;
  const wName = Math.max(7, ...events.map((e) => e.account.length));
  const wWin = Math.max(6, ...events.map((e) => windowsPhrase(e.windows).length));
  const out: string[] = [];
  let day = "";
  for (const e of events) {
    const t = Date.parse(e.at);
    const heading = localDayHeading(t);
    if (heading !== day) {
      if (day) out.push("");
      out.push(heading);
      day = heading;
    }
    const d = new Date(t);
    out.push(`  ${pad(d.getHours())}:${pad(d.getMinutes())}  ${e.account.padEnd(wName)}  ${e.provider.padEnd(6)}  ${windowsPhrase(e.windows).padEnd(wWin)}  ${String(Math.round(e.usedPercent)).padStart(3)}% used`);
  }
  return out.join("\n") + "\n";
}

function parseDays(argv: string[]): number | string {
  const i = argv.indexOf("--days");
  if (i < 0) return DEFAULT_CALENDAR_DAYS;
  const n = Number(argv[i + 1]);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : "ms calendar: --days takes a whole number from 1 to 60";
}

/** The events `ms calendar`, `/api/calendar` and `/calendar.ics` all serve —
 *  one reading of the same snapshot `ms status` uses, so none of them can
 *  disagree with the accounts table beside it. */
export async function upcomingResets(days: number, nowMs: number = Date.now(), opts: { includeIdle?: boolean } = {}): Promise<ResetEvent[]> {
  const { statusJson } = await import("./status.ts");
  const s = await statusJson();
  return resetEvents(s.accounts, nowMs, days, opts);
}

export const calendar: Verb = async (argv) => {
  const days = parseDays(argv);
  if (typeof days === "string") {
    process.stderr.write(days + "\n");
    return 2;
  }
  const now = Date.now();
  const events = await upcomingResets(days, now, { includeIdle: argv.includes("--all") });
  if (argv.includes("--ics")) process.stdout.write(toIcs(events, now));
  else if (argv.includes("--json")) process.stdout.write(JSON.stringify({ days, events: toEventViews(events) }, null, 2) + "\n");
  else process.stdout.write(calendarText(events, days));
  return 0;
};
