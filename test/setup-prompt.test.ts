import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SetupPromptExhausted, readlinePrompter, scriptedPrompter } from "../src/setup/prompt.ts";

test("scriptedPrompter.ask returns the next scripted answer", async () => {
  const p = scriptedPrompter(["2"]);
  assert.equal(await p.ask("How many?"), "2");
});

test("scriptedPrompter.ask re-asks (consuming more answers) until one is in choices", async () => {
  const p = scriptedPrompter(["x", "1"]);
  assert.equal(await p.ask("Pick one", { choices: ["1", "2"] }), "1");
});

test("scriptedPrompter.ask returns the default on an empty scripted answer", async () => {
  const p = scriptedPrompter([""]);
  assert.equal(await p.ask("Name?", { default: "alice" }), "alice");
});

test("scriptedPrompter.ask with no default and an empty answer, plus choices, re-asks", async () => {
  const p = scriptedPrompter(["", "2"]);
  assert.equal(await p.ask("Pick", { choices: ["1", "2"] }), "2");
});

test("scriptedPrompter throws SetupPromptExhausted when answers run out", async () => {
  const p = scriptedPrompter([]);
  await assert.rejects(() => p.ask("Anything?"), SetupPromptExhausted);
});

test("scriptedPrompter throws SetupPromptExhausted mid re-ask, once choices are exhausted", async () => {
  const p = scriptedPrompter(["x"]);
  await assert.rejects(() => p.ask("Pick one", { choices: ["1", "2"] }), SetupPromptExhausted);
});

test("scriptedPrompter.confirm maps y/yes/n/no case-insensitively", async () => {
  const p = scriptedPrompter(["y", "YES", "n", "No"]);
  assert.equal(await p.confirm("ok?", false), true);
  assert.equal(await p.confirm("ok?", false), true);
  assert.equal(await p.confirm("ok?", true), false);
  assert.equal(await p.confirm("ok?", true), false);
});

test("scriptedPrompter.confirm maps an empty answer to the given default", async () => {
  const p = scriptedPrompter(["", ""]);
  assert.equal(await p.confirm("ok?", true), true);
  assert.equal(await p.confirm("ok?", false), false);
});

test("scriptedPrompter.confirm re-asks (consuming more answers) on garbage", async () => {
  const p = scriptedPrompter(["maybe", "y"]);
  assert.equal(await p.confirm("ok?", false), true);
});

test("scriptedPrompter.ask and .confirm share one answer queue, in call order", async () => {
  const p = scriptedPrompter(["alice", "y"]);
  assert.equal(await p.ask("Name?"), "alice");
  assert.equal(await p.confirm("Sure?", false), true);
});

test("readlinePrompter() returns a Prompter shape without touching stdin", () => {
  // Constructing it must be side-effect-free: importing/building a prompter
  // (e.g. to decide which one to pass a wizard) must never itself attach to
  // the real process stdin. Only calling .ask()/.confirm() may do that, and
  // this test deliberately never does — there is no scripted human here.
  const p = readlinePrompter();
  assert.equal(typeof p.ask, "function");
  assert.equal(typeof p.confirm, "function");
});

// --- B-I7: the interface is released, so the process can actually exit -----

test("a readlinePrompter that answered a question lets the process exit once closed", async () => {
  // The bug, exactly: `readline.createInterface({ input: process.stdin })`
  // keeps stdin — and therefore the event loop — referenced for ever, so
  // `ms setup` computed its exit code and then never returned. Interactively
  // that means every run ended in ctrl-C (130) and the 0-or-1 the doctor
  // decided was thrown away.
  //
  // The probe is the reviewer's own, inverted: a child asks ONE question over
  // a pipe this test HOLDS OPEN afterwards (never `end()`ed — a TTY's stdin
  // never ends either), then closes the prompter and returns. With `close()`
  // it exits at once; without it, it lives until something kills it, which is
  // what the timeout below would have to do.
  const script = `
import { readlinePrompter } from ${JSON.stringify(pathToFileURL(path.join(process.cwd(), "src/setup/prompt.ts")).href)};
const p = readlinePrompter();
const answer = await p.confirm("keep going?", false);
process.stdout.write("answered:" + answer + "\\n");
p.close?.();
process.exitCode = 7;
`;
  const dir = mkdtempSync(path.join(tmpdir(), "ms-prompt-close-"));
  const file = path.join(dir, "child.mjs");
  writeFileSync(file, script);

  const started = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", file], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write("y\n"); // written — and the pipe deliberately left OPEN

  const ended = await new Promise<{ code: number | null; killed: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, killed: true });
    }, 6_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, killed: false });
    });
  });
  try { child.stdin.end(); } catch { /* already gone */ }
  const elapsed = Date.now() - started;

  assert.equal(ended.killed, false, `the child never exited while stdin stayed open (${elapsed}ms) — the readline interface is still holding it`);
  assert.equal(ended.code, 7, `stdout:\n${out}`);
  assert.match(out, /answered:true/);
});
