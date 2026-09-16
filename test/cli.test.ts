import { test } from "node:test";
import assert from "node:assert/strict";
import { run, tempHome } from "./helpers.ts";

test("ms --version prints the package version", () => {
  const { home, msHome } = tempHome();
  const r = run(["--version"], { HOME: home, MS_HOME: msHome });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("an unknown verb exits 2 with usage", () => {
  const { home, msHome } = tempHome();
  const r = run(["frobnicate"], { HOME: home, MS_HOME: msHome });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: ms/);
});
