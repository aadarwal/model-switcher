// `ms calendar`: every account's upcoming limit resets as calendar events — a terminal
// table, an iCalendar (.ics) document, and an "Add to Google Calendar" link per event.
// The core (src/calendar.ts) is pure: accounts + a clock in, events and text out. Nothing
// here polls, opens the store or touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const at = (h: number): string => new Date(NOW + h * 3600_000).toISOString();

type Acct = { name: string; provider: "claude" | "codex"; label: string; usage: unknown };
const acct = (name: string, provider: "claude" | "codex", usage: unknown, label = ""): Acct => ({ name, provider, label, usage });
const win = (usedPercent: number, resetsAt: string | null) => ({ usedPercent, resetsAt });

test("resetEvents: one event per window that has a FUTURE reset inside the horizon, soonest first", async () => {
  const { resetEvents } = await import("../src/calendar.ts");
  const accounts = [
    acct("work", "claude", { session: win(62, at(3)), weeklyAll: win(40, at(50)), weeklyFable: win(10, at(90)) }, "Work Max"),
    acct("mit", "codex", { session: win(12, at(1)), weeklyAll: win(5, at(400)), weeklyFable: null }),
  ];
  const ev = resetEvents(accounts as never, NOW, 8);
  assert.deepEqual(ev.map((e) => `${e.account}:${e.windows.join("+")}`), ["mit:5h", "work:5h", "work:week", "work:fable"]);
  assert.equal(ev[0]!.at, at(1));
  assert.equal(ev[1]!.usedPercent, 62);
  assert.equal(ev[1]!.label, "Work Max");
});

test("resetEvents: a past reset, a window that has not started (null), and an account with no usage are not events", async () => {
  const { resetEvents } = await import("../src/calendar.ts");
  const accounts = [
    acct("stale", "claude", { session: win(100, at(-2)), weeklyAll: win(0, null), weeklyFable: null }),
    acct("never-polled", "claude", null),
    acct("garbage", "claude", { session: win(5, "not a date"), weeklyAll: null, weeklyFable: null }),
  ];
  assert.deepEqual(resetEvents(accounts as never, NOW, 8), []);
});

test("resetEvents: windows of one account that reset at the same instant are ONE event, carrying the worse percentage", async () => {
  const { resetEvents } = await import("../src/calendar.ts");
  const ev = resetEvents([acct("work", "claude", { session: null, weeklyAll: win(30, at(24)), weeklyFable: win(80, at(24)) })] as never, NOW, 8);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0]!.windows, ["week", "fable"]);
  assert.equal(ev[0]!.usedPercent, 80);
});

test("eventTitle says whose limit, which window, and the provider — it is all a calendar entry shows", async () => {
  const { resetEvents, eventTitle } = await import("../src/calendar.ts");
  const [e] = resetEvents([acct("work", "claude", { session: win(62, at(3)), weeklyAll: null, weeklyFable: null })] as never, NOW, 8);
  assert.equal(eventTitle(e!), "ms: work (claude) 5h limit resets");
});

test("googleCalendarUrl is Google's own event-template link, UTC basic format, every value percent-encoded", async () => {
  const { resetEvents, googleCalendarUrl } = await import("../src/calendar.ts");
  const [e] = resetEvents([acct("R&D team", "claude", { session: win(62, "2026-09-18T15:04:05.000Z"), weeklyAll: null, weeklyFable: null })] as never, NOW, 8);
  const u = new URL(googleCalendarUrl(e!));
  assert.equal(u.origin + u.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(u.searchParams.get("action"), "TEMPLATE");
  assert.equal(u.searchParams.get("text"), "ms: R&D team (claude) 5h limit resets");
  assert.equal(u.searchParams.get("dates"), "20260918T150400Z/20260918T151900Z", "a 15-minute block starting at the reset, snapped to the minute");
  assert.match(u.searchParams.get("details") ?? "", /62% used/);
  assert.ok(!googleCalendarUrl(e!).includes("R&D"), "a raw & would end the text parameter");
});

test("toIcs: a valid RFC 5545 calendar — CRLF lines, stable UIDs, escaped text, lines folded at 75 octets", async () => {
  const { resetEvents, toIcs } = await import("../src/calendar.ts");
  const long = "an-account-name-that-is-long-enough-to-force-a-fold-in-the-summary-line-of-the-event";
  const ev = resetEvents([
    acct("a,b;c", "claude", { session: win(62, at(3)), weeklyAll: null, weeklyFable: null }),
    acct(long, "codex", { session: win(1, at(4)), weeklyAll: null, weeklyFable: null }),
  ] as never, NOW, 8);
  const ics = toIcs(ev, NOW);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:"), "header");
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends CRLF");
  assert.equal(ics.match(/BEGIN:VEVENT/g)!.length, 2);
  assert.ok(ics.includes(String.raw`SUMMARY:ms: a\,b\;c (claude) 5h limit resets`), "commas and semicolons escaped");
  assert.ok(ics.includes("DTSTART:20260918T150000Z") && ics.includes("DTSTAMP:20260918T120000Z"));
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `unfolded line: ${line}`);
  assert.ok(ics.includes("\r\n "), "the long summary is folded with a leading space");
  assert.equal(toIcs(ev, NOW + 5000).match(/^UID:.*$/gm)!.join(), ics.match(/^UID:.*$/gm)!.join(), "re-importing later updates events instead of duplicating them");
});

test("toIcs: no events is still a valid calendar — RFC 5545 requires a component, so one informational all-day VEVENT stands in for an empty body", async () => {
  const { toIcs } = await import("../src/calendar.ts");
  assert.equal(
    toIcs([], NOW),
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//model-switcher//ms calendar//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:model-switcher resets\r\n" +
      "BEGIN:VEVENT\r\nUID:nothing-upcoming-20260918@model-switcher\r\nDTSTAMP:20260918T120000Z\r\nDTSTART;VALUE=DATE:20260918\r\n" +
      "SUMMARY:ms calendar: no limit resets upcoming\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\n" +
      "END:VCALENDAR\r\n",
  );
});

test("calendarText: grouped by local day, one line per reset; an empty horizon says so instead of printing nothing", async () => {
  const { resetEvents, calendarText } = await import("../src/calendar.ts");
  const ev = resetEvents([acct("work", "claude", { session: win(62, at(3)), weeklyAll: win(40, at(50)), weeklyFable: null })] as never, NOW, 8);
  const text = calendarText(ev, 8);
  assert.match(text, /work\s+claude\s+5h\s+62%/);
  assert.match(text, /work\s+claude\s+week\s+40%/);
  assert.equal(text.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("work")).length >= 1, true, "day headings");
  assert.match(calendarText([], 8), /no limit resets in the next 8 days/);
});

test("resetEvents: provider timestamps jitter by a second between polls — events snap to the minute, so coinciding windows merge and UIDs stay stable", async () => {
  const { resetEvents, eventUid } = await import("../src/calendar.ts");
  // Measured on a real account: weekly 13:59:59.87, Fable 14:00:00.12 — one reset, reported a quarter second apart.
  const poll1 = [acct("work", "claude", { session: null, weeklyAll: win(90, "2026-09-19T13:59:59.870Z"), weeklyFable: win(85, "2026-09-19T14:00:00.120Z") })];
  const poll2 = [acct("work", "claude", { session: null, weeklyAll: win(90, "2026-09-19T14:00:00.310Z"), weeklyFable: win(85, "2026-09-19T13:59:59.640Z") })];
  const a = resetEvents(poll1 as never, NOW, 8);
  const b = resetEvents(poll2 as never, NOW, 8);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.at, "2026-09-19T14:00:00.000Z");
  assert.deepEqual(a[0]!.windows, ["week", "fable"]);
  assert.equal(eventUid(a[0]!), eventUid(b[0]!), "a re-import after the next poll must update, not duplicate");
});

test("resetEvents: a window with nothing used has nothing to give back — hidden unless asked for", async () => {
  const { resetEvents } = await import("../src/calendar.ts");
  const accounts = [acct("idle", "claude", { session: win(0, at(2)), weeklyAll: win(0.4, at(30)), weeklyFable: null }), acct("busy", "claude", { session: win(3, at(2)), weeklyAll: null, weeklyFable: null })];
  assert.deepEqual(resetEvents(accounts as never, NOW, 8).map((e) => `${e.account}:${e.windows}`), ["busy:5h", "idle:week"]);
  assert.equal(resetEvents(accounts as never, NOW, 8, { includeIdle: true }).length, 3);
});

// --- The verb, end to end through the real `ms` binary -------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, tempHome } from "./helpers.ts";

function seeded(): Record<string, string> {
  const { home, msHome } = tempHome();
  mkdirSync(msHome, { recursive: true });
  const now = Date.now();
  writeFileSync(path.join(msHome, "accounts.json"), JSON.stringify({ version: 1, accounts: [{ name: "work", provider: "claude", label: "Work Max", shared: false }] }), { mode: 0o600 });
  writeFileSync(path.join(msHome, "snapshot.json"), JSON.stringify({
    takenAt: now, backoff: {},
    accounts: [{ name: "work", provider: "claude", shared: false, error: null, errorKind: null, observedAt: now, stale: false,
      usage: { session: { usedPercent: 62, resetsAt: new Date(now + 3 * 3600_000).toISOString() }, weeklyAll: { usedPercent: 40, resetsAt: new Date(now + 50 * 3600_000).toISOString() }, weeklyFable: null } }],
  }), { mode: 0o600 });
  return { HOME: home, MS_HOME: msHome };
}

test("ms calendar: the table, --json with Google links, --ics, and a refused --days", () => {
  const env = seeded();
  const table = run(["calendar"], env);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /work\s+claude\s+5h\s+62% used/);
  assert.match(table.stdout, /work\s+claude\s+week\s+40% used/);

  const json = JSON.parse(run(["calendar", "--json"], env).stdout) as { days: number; events: { googleUrl: string }[] };
  assert.equal(json.events.length, 2);
  assert.ok(json.events.every((e) => e.googleUrl.startsWith("https://calendar.google.com/calendar/render?")));

  const ics = run(["calendar", "--ics"], env).stdout;
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);

  assert.equal(JSON.parse(run(["calendar", "--json", "--days", "1"], env).stdout).events.length, 1, "--days narrows the horizon");
  assert.equal(JSON.parse(run(["calendar", "--json", "--all"], env).stdout).events.length, 2, "--all is accepted (nothing idle here to add)");
  const bad = run(["calendar", "--days", "0"], env);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--days takes a whole number/);
});

test("ms --help lists calendar", () => {
  assert.match(run(["--help"]).stderr + run(["--help"]).stdout, /\bcalendar\b/);
});
