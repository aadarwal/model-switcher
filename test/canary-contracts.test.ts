import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stubDir } from "./helpers.ts";
import { checkCodexHooks, codexHookList } from "../scripts/canary-contracts.mjs";

const COMMAND = "/test/ms _hook codex";
const CONFIG = "/private/test/config.toml";
const expected = [{ eventName: "sessionStart", key: `${CONFIG}:session_start:0:0`, timeout: 600, hash: "sha256:test" }];
const hook = { ...expected[0], timeoutSec: 600, currentHash: "sha256:test", command: COMMAND, handlerType: "command", enabled: true, isManaged: false, async: false, sourcePath: CONFIG, trustStatus: "trusted" };
const inventory = (hooks = [hook], errors: unknown[] = []) => ({ data: [{ hooks, errors, warnings: [] }] });

test("the provider's hook inventory confirms parsed ownership, trust hash and timeout", () => {
  const checks = checkCodexHooks(inventory(), expected, COMMAND, CONFIG);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.ok));
});

test("present hook names cannot hide changed hash recipes, defaults, sources or disabled trust", () => {
  for (const changed of [
    { currentHash: "sha256:changed" }, { timeoutSec: 1 }, { key: `${CONFIG}:session_start:1:0` },
    { sourcePath: "/different/config.toml" }, { trustStatus: "modified" }, { enabled: false },
    { isManaged: true }, { async: true }, { handlerType: "prompt" },
  ]) {
    const checks = checkCodexHooks(inventory([{ ...hook, ...changed }]), expected, COMMAND, CONFIG);
    assert.equal(checks[1]!.ok, false, JSON.stringify(changed));
  }
  assert.equal(checkCodexHooks(inventory([hook, hook]), expected, COMMAND, CONFIG)[1]!.ok, false);
  assert.equal(checkCodexHooks(inventory([], [{ message: "invalid config" }]), expected, COMMAND, CONFIG)[0]!.ok, false);
  for (const malformed of [null, {}, { data: [] }, { data: [{}] }]) {
    assert.equal(checkCodexHooks(malformed, expected, COMMAND, CONFIG)[0]!.ok, false);
  }
});

function appServer(body: string): { bin: string; dir: string } {
  const { dir } = stubDir();
  const bin = path.join(dir, "codex");
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return { dir, bin };
}

test("hook inventory initializes the owned child and only requests hook metadata", async () => {
  const { bin, dir } = appServer(`
    const fs = require('node:fs');
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', line => {
      const message = JSON.parse(line);
      fs.appendFileSync(process.env.REQUESTS, line + '\\n');
      if (message.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: 'test' } }));
      if (message.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [] } }));
    });
  `);
  const requests = path.join(dir, "requests.jsonl");
  assert.deepEqual(await codexHookList(bin, { cwd: dir, env: { ...process.env, REQUESTS: requests } }), { data: [] });
  const messages = readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.method), ["initialize", "initialized", "hooks/list"]);
  assert.deepEqual(messages[2].params, { cwds: [dir] });
});

test("hook inventory rejects malformed output, provider errors, missing binaries and early exits", async () => {
  for (const [body, error] of [
    ["console.log('bad json'); setInterval(() => {}, 1000)", /malformed JSON/],
    ["console.log(JSON.stringify({ id: 1, error: { message: 'unknown method' } })); setInterval(() => {}, 1000)", /unknown method/],
    ["process.exit(2)", /exited before replying/],
  ] as const) {
    const { bin, dir } = appServer(body);
    await assert.rejects(codexHookList(bin, { cwd: dir, env: process.env }), error);
  }
  await assert.rejects(codexHookList("/no-such-canary-codex", { cwd: "/tmp", env: process.env }), /ENOENT/);
});

test("an unresponsive owned app-server is bounded even when it ignores SIGTERM", async () => {
  const { bin, dir } = appServer("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  const before = Date.now();
  await assert.rejects(codexHookList(bin, { cwd: dir, env: process.env, timeoutMs: 150 }), /timed out/);
  assert.ok(Date.now() - before < 5_000);
});
