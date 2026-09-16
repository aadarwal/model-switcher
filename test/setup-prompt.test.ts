import { test } from "node:test";
import assert from "node:assert/strict";
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
