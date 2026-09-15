import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, statSync } from "node:fs";
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
