import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tempHome } from "./helpers.ts";

test("append and read; a torn trailing line is ignored, not fatal", async () => {
  const { home, msHome } = tempHome(); process.env.HOME = home; process.env.MS_HOME = msHome;
  const { appendEvent, readEvents, lastEvent } = await import("../src/events.ts");
  const { p } = await import("../src/paths.ts");
  appendEvent({ t: 1, kind: "started", session: "s1", generation: 1, cliSessionId: "c1" });
  appendEvent({ t: 2, kind: "rate_limited", session: "s1", generation: 1, kindDetail: "fable" });
  appendFileSync(p.eventsFile("s1"), '{"t":3,"kind":"ended","ses');   // a crash mid-write
  assert.equal(statSync(p.eventsFile("s1")).mode & 0o777, 0o600);
  assert.equal(readEvents("s1").length, 2);
  assert.equal(lastEvent("s1", "rate_limited")!.kindDetail, "fable");
  assert.equal(readEvents("nope").length, 0);
  assert.equal(readFileSync(p.eventsFile("s1"), "utf8").split("\n").length, 3);
});

test("a torn trailing fragment is isolated onto its own line so the next append is not merged with it", async () => {
  const { home, msHome } = tempHome(); process.env.HOME = home; process.env.MS_HOME = msHome;
  const { appendEvent, readEvents } = await import("../src/events.ts");
  const { p } = await import("../src/paths.ts");
  appendEvent({ t: 1, kind: "started", session: "s2", generation: 1 });
  appendFileSync(p.eventsFile("s2"), '{"t":2,"kind":"ended","ses');   // crash mid-write, no trailing newline
  appendEvent({ t: 3, kind: "resumed", session: "s2", generation: 1 });
  const events = readEvents("s2");
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.kind), ["started", "resumed"]);
  const lines = readFileSync(p.eventsFile("s2"), "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '{"t":2,"kind":"ended","ses');
});

test("a torn middle line does not block the valid lines after it, once isolated", async () => {
  const { home, msHome } = tempHome(); process.env.HOME = home; process.env.MS_HOME = msHome;
  const { appendEvent, readEvents } = await import("../src/events.ts");
  const { p } = await import("../src/paths.ts");
  appendEvent({ t: 1, kind: "started", session: "s5", generation: 1 });
  appendFileSync(p.eventsFile("s5"), '{"t":2,"kind":"ended","ses');   // crash mid-write, no trailing newline
  appendEvent({ t: 3, kind: "resumed", session: "s5", generation: 1 });
  appendEvent({ t: 4, kind: "cleared", session: "s5", generation: 1 });
  const events = readEvents("s5");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.kind), ["started", "resumed", "cleared"]);
});

test("appendEvent tightens a looser mode to 0600", async () => {
  const { home, msHome } = tempHome(); process.env.HOME = home; process.env.MS_HOME = msHome;
  const { appendEvent } = await import("../src/events.ts");
  const { p, ensureSessionDir } = await import("../src/paths.ts");
  ensureSessionDir("s3");
  const f = p.eventsFile("s3");
  writeFileSync(f, "", { mode: 0o644 });
  assert.equal(statSync(f).mode & 0o777, 0o644);
  appendEvent({ t: 1, kind: "started", session: "s3", generation: 1 });
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test("lastEvent returns null when no event matches the requested kind", async () => {
  const { home, msHome } = tempHome(); process.env.HOME = home; process.env.MS_HOME = msHome;
  const { appendEvent, lastEvent } = await import("../src/events.ts");
  appendEvent({ t: 1, kind: "started", session: "s4", generation: 1 });
  assert.equal(lastEvent("s4", "ended"), null);
});
