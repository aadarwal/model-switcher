import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";

/** A fresh MS_HOME per test; every path these tests touch is under it. */
function useTempHome(): { home: string; msHome: string } {
  const h = tempHome();
  process.env.HOME = h.home;
  process.env.MS_HOME = h.msHome;
  return h;
}

function captureStderr<T>(fn: () => T): { value: T; err: string } {
  const orig = process.stderr.write;
  let err = "";
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), err };
  } finally {
    process.stderr.write = orig;
  }
}

test("loadSetup on an empty MS_HOME returns the fresh shape and does not write", async () => {
  const { msHome } = useTempHome();
  const { loadSetup } = await import("../src/setup/state.ts");
  const s = loadSetup();
  assert.equal(s.version, 1);
  assert.deepEqual(s.done, []);
  assert.deepEqual(s.claude, []);
  assert.deepEqual(s.codex, []);
  assert.deepEqual(s.optIns, { statusline: false, alias: false });
  assert.equal(typeof s.startedAt, "string");
  assert.equal(s.startedAt, s.updatedAt);
  assert.equal(existsSync(path.join(msHome, "setup.json")), false);
});

test("saveSetup writes 0600 and loadSetup round-trips", async () => {
  const { msHome } = useTempHome();
  const { loadSetup, saveSetup } = await import("../src/setup/state.ts");
  const s = loadSetup();
  s.done.push("prereqs");
  s.claude.push("work");
  s.optIns.statusline = true;
  saveSetup(s);
  const file = path.join(msHome, "setup.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const back = loadSetup();
  assert.deepEqual(back.done, ["prereqs"]);
  assert.deepEqual(back.claude, ["work"]);
  assert.equal(back.optIns.statusline, true);
});

test("markDone is idempotent and persists immediately", async () => {
  useTempHome();
  const { loadSetup, markDone } = await import("../src/setup/state.ts");
  let s = loadSetup();
  s = markDone(s, "prereqs");
  const afterFirst = s.updatedAt;
  assert.deepEqual(s.done, ["prereqs"]);
  s = markDone(s, "claude-accounts");
  assert.deepEqual(s.done, ["prereqs", "claude-accounts"]);
  // Marking an already-done step again does not duplicate it…
  s = markDone(s, "prereqs");
  assert.deepEqual(s.done, ["prereqs", "claude-accounts"]);
  // …but it is not a no-op either: updatedAt still advances, and the write
  // is durable without a separate saveSetup call.
  assert.ok(s.updatedAt >= afterFirst);
  assert.deepEqual(loadSetup().done, ["prereqs", "claude-accounts"]);
});

test("a corrupt setup.json (bad JSON) is renamed aside and a fresh state is returned, with one warning", async () => {
  const { msHome } = useTempHome();
  const file = path.join(msHome, "setup.json");
  writeFileSync(file, "{not json");
  const { loadSetup } = await import("../src/setup/state.ts");
  const { value: s, err } = captureStderr(() => loadSetup());
  assert.deepEqual(s.done, []);
  assert.equal(existsSync(file), false);
  const entries = readdirSync(msHome).filter((f) => f.startsWith("setup.json.corrupt-"));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^setup\.json\.corrupt-\d+$/);
  const lines = err.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /corrupt/);
});

test("a corrupt setup.json (wrong shape, valid JSON) is quarantined the same way", async () => {
  const { msHome } = useTempHome();
  const file = path.join(msHome, "setup.json");
  writeFileSync(file, JSON.stringify({ version: 2, done: [], claude: [], codex: [], optIns: {}, startedAt: "x", updatedAt: "x" }));
  const { loadSetup } = await import("../src/setup/state.ts");
  const { value: s, err } = captureStderr(() => loadSetup());
  assert.deepEqual(s.done, []);
  assert.match(err, /corrupt/);
  assert.equal(readdirSync(msHome).filter((f) => f.startsWith("setup.json.corrupt-")).length, 1);
});

test("a future/other version number is corrupt even when every other field is otherwise well-formed", async () => {
  const { msHome } = useTempHome();
  const file = path.join(msHome, "setup.json");
  writeFileSync(file, JSON.stringify({
    version: 2, done: ["prereqs"], claude: [], codex: [],
    optIns: { statusline: false, alias: false }, startedAt: "x", updatedAt: "x",
  }));
  const { loadSetup } = await import("../src/setup/state.ts");
  const { value: s, err } = captureStderr(() => loadSetup());
  assert.deepEqual(s.done, []);
  assert.match(err, /corrupt/);
  assert.equal(readdirSync(msHome).filter((f) => f.startsWith("setup.json.corrupt-")).length, 1);
});

test("an unknown step inside done also counts as corrupt", async () => {
  const { msHome } = useTempHome();
  const file = path.join(msHome, "setup.json");
  writeFileSync(file, JSON.stringify({
    version: 1, done: ["not-a-real-step"], claude: [], codex: [],
    optIns: { statusline: false, alias: false }, startedAt: "x", updatedAt: "x",
  }));
  const { loadSetup } = await import("../src/setup/state.ts");
  const { value: s } = captureStderr(() => loadSetup());
  assert.deepEqual(s.done, []);
  assert.equal(readdirSync(msHome).filter((f) => f.startsWith("setup.json.corrupt-")).length, 1);
});

test("resetSetup deletes setup.json only, leaving the rest of MS_HOME alone", async () => {
  const { msHome } = useTempHome();
  const { loadSetup, saveSetup, resetSetup } = await import("../src/setup/state.ts");
  const s = loadSetup();
  saveSetup(s);
  const sentinel = path.join(msHome, "accounts.json");
  writeFileSync(sentinel, "{}");
  assert.equal(existsSync(path.join(msHome, "setup.json")), true);
  resetSetup();
  assert.equal(existsSync(path.join(msHome, "setup.json")), false);
  assert.equal(existsSync(sentinel), true);
  assert.deepEqual(loadSetup().done, []);
});

test("resetSetup on a MS_HOME that never had setup.json is a no-op, not an error", async () => {
  useTempHome();
  const { resetSetup } = await import("../src/setup/state.ts");
  assert.doesNotThrow(() => resetSetup());
});
