// The suite must never see the developer's own Claude/ms configuration. See test/setup-env.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("the test script loads setup-env.mjs, which scrubs every variable that outranks HOME", async () => {
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts.test as string;
  assert.match(script, /--import \.\/test\/setup-env\.mjs/, "npm test must preload the scrubber");
  const { SCRUBBED } = await import("./setup-env.mjs");
  for (const name of ["CLAUDE_CONFIG_DIR", "MS_HOME", "CODEX_HOME", "MS_BIN"]) assert.ok(SCRUBBED.includes(name), name);
});

test("with a hostile ambient environment, a test process still starts clean", () => {
  const r = spawnSync(process.execPath, ["--import", "./test/setup-env.mjs", "-e",
    "process.stdout.write(JSON.stringify([process.env.CLAUDE_CONFIG_DIR ?? null, process.env.MS_HOME ?? null, process.env.HOME ? 'home-kept' : null]))"],
    { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: "/real/config", MS_HOME: "/real/store" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [null, null, "home-kept"]);
});
