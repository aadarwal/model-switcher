import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stubDir, tempHome } from "./helpers.ts";
import {
  COMPAT,
  cliVersion,
  compareVersions,
  compatNotices,
  parseVersion,
  probeCachePath,
  standing,
  upgradeHint,
  type Cli,
  type Compat,
} from "../src/compat.ts";

// The tested-version table (src/compat.ts) and everything that reads it,
// except `ms doctor`'s two lines, which test/doctor.test.ts covers beside the
// rest of the checklist. Nothing here touches a real CLI: every `--version` is
// a stub, every cache a temp MS_HOME.

test("parseVersion reads both CLIs' --version lines, and ignores a pre-release suffix", () => {
  assert.equal(parseVersion("codex-cli 0.160.0"), "0.160.0");
  assert.equal(parseVersion("2.1.289 (Claude Code)\n"), "2.1.289");
  assert.equal(parseVersion("v0.3.10"), "0.3.10");
  assert.equal(parseVersion("codex-cli 0.162.0-alpha.13"), "0.162.0");
  assert.equal(parseVersion("codex-cli dev"), null);
});

test("compareVersions is numeric, not lexical", () => {
  assert.ok(compareVersions("0.160.0", "0.99.9") > 0);
  assert.ok(compareVersions("2.1.289", "2.1.290") < 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});

const TABLE: Record<Cli, Compat> = {
  codex: { name: "Codex", testedUpTo: "0.160.0", incompatibleBelow: "0.150.0" },
  claude: { name: "Claude Code", testedUpTo: "2.1.289", incompatibleBelow: null },
};

test("standing: tested at or below the tested version, newer above it, incompatible only below a recorded floor", () => {
  assert.equal(standing("codex", "0.160.0", TABLE), "tested");
  assert.equal(standing("codex", "0.153.4", TABLE), "tested");
  assert.equal(standing("codex", "0.160.1", TABLE), "newer");
  assert.equal(standing("codex", "0.149.9", TABLE), "incompatible");
  assert.equal(standing("claude", "0.0.1", TABLE), "tested"); // no floor recorded
});

test("the shipped table names a version for both CLIs, and no floor without evidence", () => {
  for (const cli of ["codex", "claude"] as const) {
    assert.ok(parseVersion(COMPAT[cli].testedUpTo), cli);
    assert.equal(COMPAT[cli].incompatibleBelow, null, `${cli}: a floor needs evidence (see the header of src/compat.ts)`);
  }
});

test("compatNotices: nothing when every CLI is within what was tested", () => {
  assert.deepEqual(compatNotices([{ cli: "codex", version: "0.160.0" }, { cli: "claude", version: "2.1.1" }], { ms: "0.3.11", hint: "H", table: TABLE }), []);
});

test("compatNotices: ONE line naming the tested version, the found one, and what to do", () => {
  const lines = compatNotices([{ cli: "codex", version: "0.162.0" }], { ms: "0.3.11", hint: "brew upgrade model-switcher", table: TABLE });
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    "ms 0.3.11 is tested up to Codex 0.160.0; you have 0.162.0 — if anything misbehaves: brew upgrade model-switcher, or report it with `ms doctor` output at https://github.com/aadarwal/model-switcher/issues",
  );
});

test("compatNotices: two newer CLIs are still one line", () => {
  const lines = compatNotices(
    [{ cli: "codex", version: "0.162.0" }, { cli: "claude", version: "2.1.300" }],
    { ms: "0.3.11", hint: "H", table: TABLE },
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /tested up to Codex 0\.160\.0 and Claude Code 2\.1\.289; you have Codex 0\.162\.0 and Claude Code 2\.1\.300 — /);
});

test("compatNotices: below a known-incompatible floor says so, separately from 'newer'", () => {
  const lines = compatNotices([{ cli: "codex", version: "0.140.0" }], { ms: "0.3.11", hint: "H", table: TABLE });
  assert.deepEqual(lines, ["ms 0.3.11 does not work with Codex below 0.150.0 (you have 0.140.0) — upgrade it, or H"]);
});

test("upgradeHint: the formula's name for a Homebrew install, the releases page otherwise", () => {
  assert.equal(upgradeHint({ MS_BIN: "/opt/homebrew/opt/model-switcher/bin/ms" }, "/x/dist/ms.js"), "brew upgrade model-switcher");
  assert.equal(upgradeHint({}, "/opt/homebrew/Cellar/model-switcher/0.3.10/libexec/dist/ms.js"), "brew upgrade model-switcher");
  assert.match(upgradeHint({}, "/home/me/src/model-switcher/src/compat.ts"), /releases/);
});

/** A stub CLI that counts its `--version` calls in a file beside it. */
function countingCli(t: TestContext, version: string): { bin: string; count: string; calls: () => number; rewrite: (v: string) => void } {
  const { home, msHome } = tempHome();
  const saved = process.env.MS_HOME;
  process.env.MS_HOME = msHome;
  t.after(() => { process.env.MS_HOME = saved; });
  const { dir, stub } = stubDir();
  const count = path.join(home, "calls");
  const body = (v: string) => `echo x >> '${count}'\necho "codex-cli ${v}"`;
  stub("codex", body(version));
  return {
    bin: path.join(dir, "codex"),
    count,
    calls: () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0),
    rewrite: (v) => stub("codex", body(v)),
  };
}

test("cliVersion: probes once, then answers from the cache in MS_HOME", (t) => {
  const cli = countingCli(t, "0.160.0");
  assert.equal(cliVersion(cli.bin), "0.160.0");
  assert.equal(cliVersion(cli.bin), "0.160.0");
  assert.equal(cliVersion(cli.bin), "0.160.0");
  assert.equal(cli.calls(), 1);
  assert.ok(existsSync(probeCachePath()));
});

test("cliVersion: an upgrade in place (same path, new file) is probed again", (t) => {
  const cli = countingCli(t, "0.160.0");
  assert.equal(cliVersion(cli.bin), "0.160.0");
  cli.rewrite("0.162.0");
  assert.equal(cliVersion(cli.bin), "0.162.0");
  assert.equal(cli.calls(), 2);
});

test("cliVersion: a CLI that fails --version is cached as unknown, not re-spawned on every launch", (t) => {
  const cli = countingCli(t, "0.160.0");
  writeFileSync(cli.bin, `#!/bin/bash\necho x >> '${cli.count}'\nexit 3\n`);
  assert.equal(cliVersion(cli.bin), null);
  assert.equal(cliVersion(cli.bin), null);
  assert.equal(cli.calls(), 1);
});

test("cliVersion: a missing binary or an unwritable store is no version, never a throw", (t) => {
  const cli = countingCli(t, "0.160.0");
  assert.equal(cliVersion("/nonexistent/codex"), null);
  assert.equal(cliVersion(cli.bin, "/nonexistent-dir/cli-versions.json"), "0.160.0");
});

// --- the notice, as a verb prints it -----------------------------------------

async function notices(t: TestContext, verb: string, versions: Partial<Record<Cli, string>>, isTTY = true): Promise<string> {
  const { msHome } = tempHome();
  const saved = { MS_HOME: process.env.MS_HOME, PATH: process.env.PATH };
  t.after(() => { process.env.MS_HOME = saved.MS_HOME; process.env.PATH = saved.PATH; });
  process.env.MS_HOME = msHome;
  const { dir, stub } = stubDir();
  for (const [cli, v] of Object.entries(versions)) stub(cli, cli === "codex" ? `echo "codex-cli ${v}"` : `echo "${v} (Claude Code)"`);
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  const { startupNotices } = await import("../src/cli.ts");
  let out = "";
  startupNotices(verb, { isTTY, write: (s: string) => { out += s; } });
  return out;
}

test("startupNotices: `ms codex` with a newer Codex prints one line naming it", async (t) => {
  const out = await notices(t, "codex", { codex: "99.0.0", claude: "99.0.0" });
  assert.equal(out.split("\n").filter(Boolean).length, 1);
  assert.match(out, /tested up to Codex .*; you have 99\.0\.0 — /);
  assert.doesNotMatch(out, /Claude Code/); // a launch is about its own CLI
});

test("startupNotices: other user-facing verbs report both CLIs, still in one line", async (t) => {
  const out = await notices(t, "status", { codex: "99.0.0", claude: "99.0.0" });
  assert.equal(out.split("\n").filter(Boolean).length, 1);
  assert.match(out, /you have (Codex|Claude Code) 99\.0\.0 and (Codex|Claude Code) 99\.0\.0 — /);
});

test("startupNotices: silent within the tested versions", async (t) => {
  assert.equal(await notices(t, "claude", { claude: COMPAT.claude.testedUpTo }), "");
});

test("startupNotices: never for an internal verb (hooks, the statusline), for doctor, or when stderr is not a terminal", async (t) => {
  for (const verb of ["_hook", "_statusline", "_exec", "_codex_watch", "doctor"]) {
    assert.equal(await notices(t, verb, { codex: "99.0.0", claude: "99.0.0" }), "", verb);
  }
  assert.equal(await notices(t, "claude", { claude: "99.0.0" }, false), "");
});
