import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { flagsWithLiveSettings, readLiveSettings, settingsFromRecords } from "../src/live-settings.ts";
import { tempHome } from "./helpers.ts";

const json = JSON.stringify;
const turn = (model: unknown, effort: unknown, extra = {}) => json({ type: "assistant", sessionId: "parent", message: { model }, effort, ...extra });

test("Claude takes the latest real parent turn, skipping synthetic, sidechain and foreign records", () => {
  const records = [turn("old", "medium"), turn("claude-opus-5-5", "xhigh"), turn("<synthetic>", "low"), turn(null, null),
    turn("child", "low", { isSidechain: true }), turn("foreign", "low", { sessionId: "elsewhere" }), "{partial"];
  assert.deepEqual(settingsFromRecords("claude", records, "parent"), { model: "claude-opus-5-5", effort: "xhigh" });
});

test("Claude uses perTurnEffort when the session effort is absent, and never invents effort", () => {
  assert.deepEqual(settingsFromRecords("claude", [turn("opus", null, { perTurnEffort: "max" })], "parent"), { model: "opus", effort: "max" });
  assert.deepEqual(settingsFromRecords("claude", [turn("old", "high"), turn("new", null)], "parent"), { model: "new", effort: null });
});

test("Codex reads the latest turn_context rather than message contents", () => {
  assert.deepEqual(settingsFromRecords("codex", [json({ type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "ultra" } }), turn("quoted", "low")], "id"),
    { model: "gpt-6.1-sol", effort: "ultra" });
});

test("missing, unreadable, malformed and non-file transcripts retain launch settings", () => {
  const { home } = tempHome();
  const file = path.join(home, "transcript.jsonl");
  writeFileSync(file, "junk\nnull\n[]\n{}\n");
  for (const candidate of [null, path.join(home, "absent"), home, file]) {
    assert.deepEqual(readLiveSettings("claude", candidate, "parent"), { model: null, effort: null });
  }
});

test("a bounded tail handles large transcripts and a truncated final record", () => {
  const { home } = tempHome();
  const file = path.join(home, "large.jsonl");
  writeFileSync(file, `${"x".repeat(9 * 1024 * 1024)}\n${turn("opus", "max")}\n{"partial":`);
  assert.deepEqual(readLiveSettings("claude", file, "parent"), { model: "opus", effort: "max" });
});

test("live Claude settings replace each spelling exactly once and retain other flags", () => {
  assert.deepEqual(flagsWithLiveSettings("claude", ["--model", "sonnet", "--model=old", "--effort", "low", "--effort=medium", "--permission-mode", "plan"],
    { model: "opus", effort: "xhigh" }, true), ["--permission-mode", "plan", "--model", "opus", "--effort", "xhigh"]);
  assert.deepEqual(flagsWithLiveSettings("claude", ["--model", "sonnet"], { model: "opus", effort: "xhigh" }, false), ["--model", "opus"]);
  assert.deepEqual(flagsWithLiveSettings("claude", ["--effort", "high"], { model: "opus", effort: null }, true), ["--effort", "high", "--model", "opus"]);
});

test("Codex replaces model/effort overrides and keeps unrelated config", () => {
  const flags = ["-m", "old", "--model=older", "-c", 'model="oldest"', '-c=model="older"', "--config=model_reasoning_effort=\"low\"", "-cmodel_reasoning_effort=\"medium\"", "--config", 'sandbox_mode="read-only"', "--no-daemon"];
  assert.deepEqual(flagsWithLiveSettings("codex", flags, { model: "gpt-6.1-sol", effort: "ultra" }, false),
    ["--config", 'sandbox_mode="read-only"', "--no-daemon", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="ultra"']);
});
