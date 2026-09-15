import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { tempHome } from "./helpers.ts";

test("loadRegistry on a missing file returns an empty registry with no error", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { loadRegistry } = await import("../src/registry.ts");
  const r = loadRegistry();
  assert.deepEqual(r.registry, { version: 1, accounts: [] });
  assert.equal(r.parseError, null);
});

test("a malformed registry is reported, never rewritten", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { loadRegistry, saveRegistry } = await import("../src/registry.ts");
  const file = path.join(msHome, "accounts.json");
  writeFileSync(file, '{"version":1,"accounts":[{"name":"a",}]}');
  const r = loadRegistry();
  assert.match(r.parseError ?? "", /JSON/);
  assert.throws(() => saveRegistry({ version: 1, accounts: [] }, r), /unreadable/);
  assert.equal(readFileSync(file, "utf8"), '{"version":1,"accounts":[{"name":"a",}]}');
});

test("validateRegistry skips bad rows by position and reports each problem", async () => {
  const { validateRegistry } = await import("../src/registry.ts");
  const v = validateRegistry({ version: 1, accounts: [
    { name: "ok", provider: "claude", label: "OK", orgId: null, shared: false, identityVerified: false },
    null,
    { name: "bad provider", provider: "gemini", label: "x" },
    { name: "ok", provider: "claude", label: "dupe" },
  ]});
  assert.equal(v.registry.accounts.length, 1);
  assert.equal(v.problems.length, 3);
  assert.match(v.problems[0], /accounts\[1\]/);
  assert.match(v.problems[1], /provider/);
  assert.match(v.problems[2], /duplicate name/);
});

test("saveRegistry writes 0600 atomically and round-trips", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { loadRegistry, saveRegistry } = await import("../src/registry.ts");
  const r = loadRegistry();
  r.registry.accounts.push({ name: "gmail", provider: "claude", label: "Gmail", orgId: "org-1", shared: false, identityVerified: true });
  saveRegistry(r.registry, r);
  const file = path.join(msHome, "accounts.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadRegistry().registry.accounts[0].orgId, "org-1");
});

test("msBinary() honors MS_BIN override", async () => {
  const { msBinary } = await import("../src/paths.ts");
  const prev = process.env.MS_BIN;
  process.env.MS_BIN = "/custom/ms";
  try {
    assert.equal(msBinary(), "/custom/ms");
  } finally {
    if (prev === undefined) delete process.env.MS_BIN; else process.env.MS_BIN = prev;
  }
});
