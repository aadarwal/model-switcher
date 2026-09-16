// scripts/release.mjs packs a GitHub release tarball and, with --publish,
// creates the release and commits a rendered Homebrew formula into a tap
// checkout. Every test here runs the real script against a throwaway git
// repo copy of this project (never the actual worktree — `npm run build`
// must never run against this checkout's own dist/ during a test run), with
// the real `git`/`tar`/`shasum`/`npm` and a logging stub for `gh` (and, for
// the --publish test, a logging *forwarder* for `git` so we can prove no
// `push` subcommand ever ran while still letting every other git call
// through to the real binary).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stubDir, tempHome } from "./helpers.ts";
import { renderFormula, REPO_ROOT as REAL_REPO_ROOT } from "../scripts/release.mjs";
import { resolveOnPath } from "../src/exec.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_REPO = path.resolve(HERE, "..");
// Sanity: the module under test resolves its own repo root the same way we
// do here — if this ever drifts, every path below would silently point at
// the wrong tree.
assert.equal(REAL_REPO_ROOT, REAL_REPO);

// A HOME with no `.config/git/config` of its own: this machine's real HOME
// wires a global `core.hooksPath` (a prepare-commit-msg hook that adds any
// of the three co-author trailers missing by email). Without this override
// every git commit in these tests — including the ones scripts/release.mjs
// itself makes — would go through that hook too, and it would silently
// paper over a release.mjs that got a trailer wrong (proven live: mutating
// the Homi trailer's email here without this override still left the commit
// with a correct line, added by the ambient hook, not by the code under
// test). Isolating HOME is what makes the trailer assertions below actually
// prove something about this script rather than about this machine.
const { home: GIT_HOME } = tempHome();
const GIT_ENV = { HOME: GIT_HOME, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

/** A fresh, minimal git checkout of this project in a temp dir: everything
 *  the release script and its build need (bin/, src/, scripts/, packaging/,
 *  package.json, LICENSE, README.md), a symlinked node_modules (esbuild
 *  lives there — copying 30+MB per test would be its own kind of slow), a
 *  `test/` and `.superpowers/` directory so the "not in the tarball"
 *  assertions are proving something, and its own from-scratch git history
 *  so `git status`/`git log` are real. */
function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ms-release-fixture-"));
  for (const entry of ["bin", "src", "scripts", "packaging", "test", "package.json", "package-lock.json", "README.md", "LICENSE", "tsconfig.json", ".gitignore"]) {
    const from = path.join(REAL_REPO, entry);
    if (existsSync(from)) execFileSync("cp", ["-R", from, path.join(dir, entry)]);
  }
  mkdirSync(path.join(dir, ".superpowers"), { recursive: true });
  writeFileSync(path.join(dir, ".superpowers", "marker.md"), "a real, local, gitignored planning file\n");

  const nm = path.join(REAL_REPO, "node_modules");
  symlinkSync(realpathSync(nm), path.join(dir, "node_modules"));

  const env = { ...process.env, ...GIT_ENV };
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"], { cwd: dir, env });
  return dir;
}

function runRelease(cwd: string, args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [path.join(cwd, "scripts", "release.mjs"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    // GIT_ENV's isolated HOME always applies (the script's own internal git
    // calls need it exactly as much as the test's setup calls do); callers
    // can still layer more on top (e.g. a PATH prefix for stubs).
    env: { ...process.env, ...GIT_ENV, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function extractTarballPath(stdout: string): string {
  const m = stdout.match(/^release: wrote (.+)$/m);
  assert.ok(m, `no tarball path in stdout:\n${stdout}`);
  return m![1]!;
}

function extractSha(stdout: string): string {
  const m = stdout.match(/^sha256\s+([0-9a-f]{64})$/m);
  assert.ok(m, `no sha256 in stdout:\n${stdout}`);
  return m![1]!;
}

// --- --dry-run: tarball contents and layout -------------------------------

test("--dry-run produces the tarball with exactly the six entries", () => {
  const dir = makeFixture();
  const r = runRelease(dir, ["v0.1.0", "--dry-run"]);
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const tarballPath = extractTarballPath(r.stdout);
  assert.ok(existsSync(tarballPath));
  assert.equal(path.basename(tarballPath), "model-switcher-v0.1.0.tar.gz");
  // Compared through realpath: the script resolves its own repo root via
  // import.meta.url, which follows symlinks (e.g. macOS's /var ->
  // /private/var for the OS temp dir) — `dir` itself is the unresolved form.
  assert.equal(realpathSync(path.dirname(tarballPath)), realpathSync(path.join(dir, "release")));

  const listing = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" }).trim().split("\n").sort();
  const expected = [
    "model-switcher-v0.1.0/LICENSE",
    "model-switcher-v0.1.0/README.md",
    "model-switcher-v0.1.0/bin/ms",
    "model-switcher-v0.1.0/bin/resolve-entry.mjs",
    "model-switcher-v0.1.0/dist/ms.js",
    "model-switcher-v0.1.0/package.json",
  ].sort();
  assert.deepEqual(listing, expected, `tar -tzf listing:\n${listing.join("\n")}`);

  for (const forbidden of ["src/", "test/", ".superpowers/", "node_modules/"]) {
    assert.ok(!listing.some((l) => l.includes(forbidden)), `should not contain ${forbidden}: ${listing.join(", ")}`);
  }
});

test("the printed sha256 matches `shasum -a 256` of the tarball", () => {
  const dir = makeFixture();
  const r = runRelease(dir, ["v0.1.0", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);

  const tarballPath = extractTarballPath(r.stdout);
  const printed = extractSha(r.stdout);
  const real = execFileSync("shasum", ["-a", "256", tarballPath], { encoding: "utf8" }).trim().split(/\s+/)[0];
  assert.equal(printed, real);
});

// --- refusals --------------------------------------------------------------

test("a dirty tree is refused", () => {
  const dir = makeFixture();
  writeFileSync(path.join(dir, "README.md"), "uncommitted edit\n");
  const r = runRelease(dir, ["v0.1.0", "--dry-run"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dirty/i);
  assert.ok(!existsSync(path.join(dir, "release")), "must refuse before building anything");
});

test("a version that does not match package.json is refused", () => {
  const dir = makeFixture();
  const r = runRelease(dir, ["v9.9.9", "--dry-run"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /version/i);
  assert.match(r.stderr, /0\.1\.0/);
  assert.ok(!existsSync(path.join(dir, "release")), "must refuse before building anything");
});

// --- renderFormula (pure) ---------------------------------------------------

test("renderFormula substitutes all three fields and leaves no placeholder", () => {
  const template = readFileSync(path.join(REAL_REPO, "packaging", "model-switcher.rb"), "utf8");
  const out = renderFormula(template, {
    version: "1.2.3",
    url: "https://github.com/aadarwal/model-switcher/releases/download/v1.2.3/model-switcher-v1.2.3.tar.gz",
    sha256: "d".repeat(64),
  });
  assert.ok(out.includes('version "1.2.3"'), out);
  assert.ok(out.includes("https://github.com/aadarwal/model-switcher/releases/download/v1.2.3/model-switcher-v1.2.3.tar.gz"), out);
  assert.ok(out.includes(`sha256 "${"d".repeat(64)}"`), out);
  assert.ok(!out.includes("__VERSION__"), out);
  assert.ok(!out.includes("__URL__"), out);
  assert.ok(!out.includes("__SHA256__"), out);
});

// --- --publish ---------------------------------------------------------------

test("--publish records `gh release create`, writes+commits the formula into the tap, and only prints (never runs) the push", () => {
  const dir = makeFixture();
  const realGit = resolveOnPath("git");
  assert.ok(realGit, "git must be resolvable on PATH for this test to forward to it");

  const gh = stubDir();
  const ghLog = path.join(gh.dir, "gh.log");
  gh.stub("gh", `echo "$@" >> "${ghLog}"\nexit 0\n`);

  // A forwarding stub: every `git` invocation (by the release script,
  // against BOTH the source repo and the tap) is logged here, then handed
  // to the real git — so the assertions below can prove `push` never ran
  // while every actual git operation the script needs still works for real.
  const gitStub = stubDir();
  const gitLog = path.join(gitStub.dir, "git.log");
  gitStub.stub("git", `echo "$@" >> "${gitLog}"\nexec "${realGit}" "$@"\n`);

  const tap = mkdtempSync(path.join(tmpdir(), "ms-release-tap-"));
  const env = { ...process.env, ...GIT_ENV };
  execFileSync("git", ["init", "-q"], { cwd: tap, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "tap init"], { cwd: tap, env });

  const r = runRelease(dir, ["v0.1.0", "--publish", "--tap", tap], {
    PATH: `${gh.dir}:${gitStub.dir}:${process.env.PATH}`,
    ...GIT_ENV,
  });
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const ghCalls = readFileSync(ghLog, "utf8").trim().split("\n");
  assert.ok(ghCalls.some((l) => l.startsWith("release create v0.1.0") && l.includes("--notes-file")), ghCalls.join("\n"));

  const formulaPath = path.join(tap, "Formula", "model-switcher.rb");
  assert.ok(existsSync(formulaPath));
  const formula = readFileSync(formulaPath, "utf8");
  assert.ok(!formula.includes("__VERSION__") && !formula.includes("__URL__") && !formula.includes("__SHA256__"), formula);
  assert.ok(formula.includes('version "0.1.0"'), formula);

  const commitBody = execFileSync(realGit, ["-C", tap, "log", "-1", "--format=%B"], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.match(commitBody, /Co-Authored-By: Claude <noreply@anthropic\.com>/);
  assert.match(commitBody, /Co-authored-by: Codex <codex@openai\.com>/);
  assert.match(commitBody, /Co-authored-by: Homi <322615700\+Homi@users\.noreply\.github\.com>/);

  assert.match(r.stdout, new RegExp(`git -C ${tap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} push`));

  // The whole point of the forwarding stub: prove `push` never actually ran,
  // against the real, ground-truth git invocation log — not a guess.
  const gitCalls = readFileSync(gitLog, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(gitCalls.length > 0, "the stub should have seen real git calls");
  for (const line of gitCalls) {
    const argv = line.split(" ");
    assert.ok(!argv.includes("push"), `a git call ran push: ${line}`);
  }
});
