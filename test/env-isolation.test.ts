// The suite must never see the developer's own Claude/ms configuration. See test/setup-env.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("the test script loads setup-env.mjs, which scrubs every variable that outranks HOME", async () => {
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts.test as string;
  assert.match(script, /--import \.\/test\/setup-env\.mjs/, "npm test must preload the scrubber");
  const { SCRUBBED } = await import("./setup-env.mjs");
  for (const name of ["CLAUDE_CONFIG_DIR", "MS_HOME", "CODEX_HOME", "MS_BIN"]) assert.ok(SCRUBBED.includes(name), name);
});

test("the scrubber pins MS_CODEX_BASE_CONFIG at a path that does not exist, so no test reads the developer's own ~/.codex", async () => {
  const { ABSENT_CODEX_BASE } = await import("./setup-env.mjs");
  assert.equal(process.env.MS_CODEX_BASE_CONFIG, ABSENT_CODEX_BASE);
  assert.equal(existsSync(ABSENT_CODEX_BASE), false, "the pinned base must not exist");
  assert.ok(!ABSENT_CODEX_BASE.startsWith(`${process.env.HOME}/.codex`), "and must not be the real one");
  // And a child process gets it too: helpers.run() spreads process.env.
  const r = spawnSync(process.execPath, ["--import", "./test/setup-env.mjs", "-e",
    "process.stdout.write(process.env.MS_CODEX_BASE_CONFIG ?? '')"],
    { encoding: "utf8", env: { ...process.env, MS_CODEX_BASE_CONFIG: "/real/.codex/config.toml" } });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout, "/real/.codex/config.toml", "an ambient value never survives");
});

test("with a hostile ambient environment, a test process still starts clean", () => {
  const r = spawnSync(process.execPath, ["--import", "./test/setup-env.mjs", "-e",
    "process.stdout.write(JSON.stringify([process.env.CLAUDE_CONFIG_DIR ?? null, process.env.MS_HOME ?? null, process.env.MS_CODEX_BASE_DIR ?? null, process.env.HOME ? 'home-kept' : null]))"],
    { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: "/real/config", MS_HOME: "/real/store", MS_CODEX_BASE_DIR: "/real/.codex" } });
  assert.equal(r.status, 0, r.stderr);
  const [claude, msHome, codexBase, home] = JSON.parse(r.stdout);
  assert.equal(claude, null);
  assert.equal(home, "home-kept");
  // MS_HOME and the Codex base are pinned rather than deleted: since 0.3.6 a
  // default for either is a directory `ms` WRITES to (src/codex-share.ts).
  for (const pinned of [msHome, codexBase]) {
    assert.ok(typeof pinned === "string" && pinned.startsWith(tmpdir()), `pinned under the temp dir, not ${pinned}`);
    assert.ok(!pinned.startsWith("/real"), "an ambient value never survives");
  }
});

test("the store and the Codex base are pinned in THIS process too, never the developer's own", async () => {
  const { TEST_MS_HOME, TEST_CODEX_BASE } = await import("./setup-env.mjs");
  const home = process.env.HOME ?? "";
  for (const [name, pinned] of [["MS_HOME", TEST_MS_HOME], ["MS_CODEX_BASE_DIR", TEST_CODEX_BASE]] as const) {
    assert.ok(pinned.startsWith(tmpdir()), `${name} is under the temp dir`);
    assert.ok(!pinned.startsWith(`${home}/.codex`) && !pinned.startsWith(`${home}/.config`), `${name} is not the real one`);
  }
});
