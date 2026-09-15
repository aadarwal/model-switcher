import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { tempHome } from "./helpers.ts";

const SAMPLE_TOKEN = "sk-ant-oat01-AbCdEfGh12345678_-ijklmnop0123456789";

test("saveLaunchToken then readLaunchToken round-trips", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { saveLaunchToken, readLaunchToken } = await import("../src/launch-credentials.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);
  assert.equal(readLaunchToken("gmail"), SAMPLE_TOKEN);
});

test("saveLaunchToken writes the file mode 0600", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  const { p } = await import("../src/paths.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);
  const mode = statSync(p.launchToken("gmail")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("saveLaunchToken writes atomically, leaving no temp file behind", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { saveLaunchToken } = await import("../src/launch-credentials.ts");
  const { p } = await import("../src/paths.ts");
  const path = await import("node:path");
  const { readdirSync } = await import("node:fs");
  saveLaunchToken("gmail", SAMPLE_TOKEN);
  const files = readdirSync(path.dirname(p.launchToken("gmail")));
  assert.deepEqual(files, ["gmail.token"]);
});

test("readLaunchToken on a missing account returns null", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { readLaunchToken } = await import("../src/launch-credentials.ts");
  assert.equal(readLaunchToken("nobody"), null);
});

test("deleteLaunchToken removes the file and is idempotent", async () => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { saveLaunchToken, readLaunchToken, deleteLaunchToken } = await import("../src/launch-credentials.ts");
  const { p } = await import("../src/paths.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);
  deleteLaunchToken("gmail");
  assert.equal(existsSync(p.launchToken("gmail")), false);
  assert.equal(readLaunchToken("gmail"), null);
  // idempotent: deleting again (and deleting an account that never existed) never throws
  assert.doesNotThrow(() => deleteLaunchToken("gmail"));
  assert.doesNotThrow(() => deleteLaunchToken("never-existed"));
});

test("looksLikeSetupToken accepts a real-shaped setup token", async () => {
  const { looksLikeSetupToken } = await import("../src/launch-credentials.ts");
  assert.equal(looksLikeSetupToken(SAMPLE_TOKEN), true);
});

test("looksLikeSetupToken rejects an API key of a similar shape", async () => {
  const { looksLikeSetupToken } = await import("../src/launch-credentials.ts");
  assert.equal(looksLikeSetupToken("sk-ant-api03-AbCdEfGh12345678_-ijklmnop0123456789"), false);
});

test("looksLikeSetupToken rejects a too-short token and garbage", async () => {
  const { looksLikeSetupToken } = await import("../src/launch-credentials.ts");
  assert.equal(looksLikeSetupToken("sk-ant-oat01-tooshort"), false);
  assert.equal(looksLikeSetupToken("not-a-token-at-all"), false);
  assert.equal(looksLikeSetupToken(""), false);
});
