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

/** root reads a 0000 file, so the EACCES half of the test below means nothing there. */
const CAN_DENY_READ = process.getuid?.() !== 0;

test("readLaunchToken treats a file it cannot read like one that is not there", { skip: !CAN_DENY_READ }, async () => {
  // Live: `chmod 000` on one account's token threw EACCES out of the middle of
  // a recovery transaction. "Can this account be launched right now" is
  // answered `no` by an unreadable file exactly as by an absent one, and the
  // other accounts — which were fine — were never tried.
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { chmodSync, mkdirSync } = await import("node:fs");
  const { saveLaunchToken, readLaunchToken } = await import("../src/launch-credentials.ts");
  const { p } = await import("../src/paths.ts");

  saveLaunchToken("gmail", SAMPLE_TOKEN);
  chmodSync(p.launchToken("gmail"), 0o000);
  try {
    assert.equal(readLaunchToken("gmail"), null, "EACCES");
  } finally {
    chmodSync(p.launchToken("gmail"), 0o600);
  }
  assert.equal(readLaunchToken("gmail"), SAMPLE_TOKEN, "and the file itself is untouched");

  // Anything else the path can be instead of a readable file.
  mkdirSync(p.launchToken("work"), { recursive: true });
  assert.equal(readLaunchToken("work"), null, "EISDIR");
});

test("an unreadable token says so once under MS_VERBOSE, and never prints a byte of the file", { skip: !CAN_DENY_READ }, async (t) => {
  const { home, msHome } = tempHome();
  process.env.HOME = home; process.env.MS_HOME = msHome;
  const { chmodSync } = await import("node:fs");
  const { saveLaunchToken, readLaunchToken } = await import("../src/launch-credentials.ts");
  const { p } = await import("../src/paths.ts");
  saveLaunchToken("gmail", SAMPLE_TOKEN);
  chmodSync(p.launchToken("gmail"), 0o000);
  t.after(() => chmodSync(p.launchToken("gmail"), 0o600));

  let out = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  delete process.env.MS_VERBOSE;
  assert.equal(readLaunchToken("gmail"), null);
  assert.equal(out, "", "quiet by default: a skipped candidate is the worker's line to write, not this one's");

  process.env.MS_VERBOSE = "1";
  t.after(() => {
    delete process.env.MS_VERBOSE;
  });
  assert.equal(readLaunchToken("gmail"), null);
  assert.equal(out.trim().split("\n").length, 1, "one note, not a line per attempt");
  assert.match(out, /gmail/);
  assert.match(out, /EACCES/);
  assert.doesNotMatch(out, /sk-ant-/, "a note about a credential is not a place to print one");

  // A token that is merely absent is the ordinary case and says nothing at all.
  out = "";
  assert.equal(readLaunchToken("nobody"), null);
  assert.equal(out, "");
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
