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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  // The cases below name `v0.1.0` throughout: pin the fixture's package.json
  // (and lock) to that version, so the real repo's version can move on a
  // release without touching every assertion here.
  for (const f of ["package.json", "package-lock.json"]) {
    const file = path.join(dir, f);
    if (!existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.version = "0.1.0";
    if (json.packages && json.packages[""]) json.packages[""].version = "0.1.0";
    writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  }
  mkdirSync(path.join(dir, ".superpowers"), { recursive: true });
  writeFileSync(path.join(dir, ".superpowers", "marker.md"), "a real, local, gitignored planning file\n");

  const nm = path.join(REAL_REPO, "node_modules");
  symlinkSync(realpathSync(nm), path.join(dir, "node_modules"));

  const env = { ...process.env, ...GIT_ENV };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"], { cwd: dir, env });
  // A LOCAL bare `origin`, pushed to: the release script's publish path
  // refuses a tag that already exists on origin and a HEAD that is on no
  // remote branch (B-I9), and both questions have to be answerable without
  // touching the network. A bare repo on disk is a real remote for every
  // git command involved (`ls-remote`, `branch --remotes`).
  const originPath = `${dir}-origin.git`;
  execFileSync("git", ["init", "-q", "--bare", originPath], { env });
  execFileSync("git", ["remote", "add", "origin", originPath], { cwd: dir, env });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: dir, env });
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: dir, env });
  return dir;
}

/** The bare `origin` `makeFixture` pushed to, for a test that needs to put
 *  something there (a tag that already exists) before the release runs. */
function originOf(dir: string): string {
  return `${dir}-origin.git`;
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

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  // MS_BIN must travel alongside MS_ENTRY=dist in the shim: msBinary()
  // (src/paths.ts) honours MS_BIN, and without it the doctor's "ms on PATH
  // is msBinary()" check resolves the wrong path against a real keg (see
  // task-4-report.md, fix round 1). It must be `opt_bin`, NOT `bin`: during
  // `def install` Homebrew's `bin` is the versioned keg path, which the next
  // `brew upgrade` deletes — taking every hook command, trust hash,
  // statusline wrapper and alias line that baked it in (B-C2).
  assert.ok(out.includes('MS_BIN="#{opt_bin}/ms"'), out);
  assert.ok(!/MS_BIN="#\{bin\}\/ms"/.test(out), out);
  // The shim must run the real launcher, and on Homebrew's own node (B-C1,
  // B-I8). `dist/ms.js` only EXPORTS `main`.
  assert.ok(out.includes('"#{libexec}/bin/ms"'), out);
  assert.ok(!/node" "#\{libexec\}\/dist\/ms\.js"/.test(out), out);
  assert.ok(out.includes('"#{Formula["node"].opt_bin}/node"'), out);
  assert.ok(out.includes('libexec.install "bin"'), out);
  // A `test do` that would actually catch a no-op shim.
  assert.ok(out.includes("ms --version"), out);
  assert.ok(out.includes("usage: ms"), out);
});

// --- reproducibility ---------------------------------------------------------

test("two builds of the same commit, seconds apart, are byte-identical", () => {
  const dir = makeFixture();

  const r1 = runRelease(dir, ["v0.1.0", "--dry-run"]);
  assert.equal(r1.status, 0, r1.stderr);
  const tarball1 = extractTarballPath(r1.stdout);
  const sha1 = extractSha(r1.stdout);
  const bytes1 = readFileSync(tarball1);

  // Actually wait a few real seconds — not just rely on the gzip -n / pinned
  // mtime logic being right on paper. rmSync + a fresh dry-run forces a
  // completely new tar+gzip pass at a different wall-clock time.
  rmSync(path.dirname(tarball1), { recursive: true, force: true });
  execFileSync("sleep", ["2"]);

  const r2 = runRelease(dir, ["v0.1.0", "--dry-run"]);
  assert.equal(r2.status, 0, r2.stderr);
  const tarball2 = extractTarballPath(r2.stdout);
  const sha2 = extractSha(r2.stdout);
  const bytes2 = readFileSync(tarball2);

  assert.equal(sha1, sha2, "printed sha256 must match across builds");
  assert.equal(sha256Hex(bytes1), sha1);
  assert.ok(bytes1.equals(bytes2), "the two tarballs must be byte-identical, not just same-shaped");
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

// --- B-I9: the release pre-checks ------------------------------------------

test("a tag that already exists locally is refused before anything is built", () => {
  const dir = makeFixture();
  execFileSync("git", ["tag", "v0.1.0"], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
  const r = runRelease(dir, ["v0.1.0", "--dry-run"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /already exists locally/);
  assert.ok(!existsSync(path.join(dir, "release")), "must refuse before building anything");
});

test("a tag that exists only on origin is refused on the publish path", () => {
  const dir = makeFixture();
  const env = { ...process.env, ...GIT_ENV };
  // On the remote and NOT locally — invisible to `git tag --list`, which is
  // exactly why `git ls-remote` has to be asked.
  execFileSync("git", ["tag", "v0.1.0"], { cwd: dir, env });
  execFileSync("git", ["push", "-q", "origin", "v0.1.0"], { cwd: dir, env });
  execFileSync("git", ["tag", "-d", "v0.1.0"], { cwd: dir, env });

  const gh = stubDir();
  const ghLog = path.join(gh.dir, "gh.log");
  gh.stub("gh", `echo "$@" >> "${ghLog}"\nexit 0\n`);
  const tap = mkdtempSync(path.join(tmpdir(), "ms-release-tap-"));

  const r = runRelease(dir, ["v0.1.0", "--publish", "--tap", tap], { PATH: `${gh.dir}:${process.env.PATH}` });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /already exists on origin/);
  assert.ok(!existsSync(ghLog), "gh must never be reached once a pre-check has failed");
  assert.ok(!existsSync(path.join(dir, "release")), "must refuse before building anything");
});

test("a HEAD that is on no remote branch is refused on the publish path", () => {
  const dir = makeFixture();
  const env = { ...process.env, ...GIT_ENV };
  writeFileSync(path.join(dir, "NOTES.md"), "an unpushed commit\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "unpushed"], { cwd: dir, env });

  const gh = stubDir();
  const ghLog = path.join(gh.dir, "gh.log");
  gh.stub("gh", `echo "$@" >> "${ghLog}"\nexit 0\n`);
  const tap = mkdtempSync(path.join(tmpdir(), "ms-release-tap-"));

  const r = runRelease(dir, ["v0.1.0", "--publish", "--tap", tap], { PATH: `${gh.dir}:${process.env.PATH}` });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /on no remote branch/);
  assert.ok(!existsSync(ghLog), "gh must never be reached once a pre-check has failed");
});

test("`gh release create` carries --target with the sha the tarball was built from", () => {
  const dir = makeFixture();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();

  const gh = stubDir();
  const ghLog = path.join(gh.dir, "gh.log");
  gh.stub("gh", `echo "$@" >> "${ghLog}"\nexit 0\n`);
  const tap = mkdtempSync(path.join(tmpdir(), "ms-release-tap-"));
  const env = { ...process.env, ...GIT_ENV };
  execFileSync("git", ["init", "-q"], { cwd: tap, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "tap init"], { cwd: tap, env });

  const r = runRelease(dir, ["v0.1.0", "--publish", "--tap", tap], { PATH: `${gh.dir}:${process.env.PATH}` });
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const call = readFileSync(ghLog, "utf8").trim();
  // Without --target, `gh` tags the REMOTE DEFAULT BRANCH's head — not this
  // commit — so the formula's sha256 would describe a tarball the tag does
  // not contain.
  assert.match(call, new RegExp(`--target ${head}\\b`), call);
});

test("buildTarball leaves no scratch directory behind when tar fails", () => {
  const dir = makeFixture();
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("ms-release-stage-"));
  const broken = stubDir();
  broken.stub("tar", `echo "no tar for you" >&2\nexit 3\n`);

  const r = runRelease(dir, ["v0.1.0", "--dry-run"], { PATH: `${broken.dir}:${process.env.PATH}` });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /tar failed/);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("ms-release-stage-"));
  assert.deepEqual(after, before, `a scratch directory leaked: ${after.filter((n) => !before.includes(n)).join(", ")}`);
});

// --- B-C1/B-C2: the shim, run against a real unpacked tarball --------------

test("the formula's own shim command line runs `main` out of a real tarball", () => {
  const dir = makeFixture();
  const r = runRelease(dir, ["v0.1.0", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const tarballPath = extractTarballPath(r.stdout);

  // Unpack it the way `brew install` would, then lay out the keg exactly as
  // `def install` does: libexec/{dist,bin,package.json}, a versioned keg, the
  // stable `opt` link at it, and the shim in `<prefix>/bin`.
  const keg = mkdtempSync(path.join(tmpdir(), "ms-keg-"));
  const unpacked = path.join(keg, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", unpacked]);
  const src = path.join(unpacked, "model-switcher-v0.1.0");
  assert.ok(existsSync(path.join(src, "bin", "ms")), "the tarball must ship bin/ms — `files` in package.json decides");
  assert.ok(existsSync(path.join(src, "bin", "resolve-entry.mjs")));

  const cellar = path.join(keg, "Cellar", "model-switcher", "0.1.0");
  const libexec = path.join(cellar, "libexec");
  mkdirSync(path.join(cellar, "bin"), { recursive: true });
  mkdirSync(path.join(keg, "opt"), { recursive: true });
  mkdirSync(libexec, { recursive: true });
  execFileSync("cp", ["-R", path.join(src, "dist"), path.join(libexec, "dist")]);
  execFileSync("cp", ["-R", path.join(src, "bin"), path.join(libexec, "bin")]);
  execFileSync("cp", [path.join(src, "package.json"), path.join(libexec, "package.json")]);
  symlinkSync(cellar, path.join(keg, "opt", "model-switcher"));

  const optBin = path.join(keg, "opt", "model-switcher", "bin", "ms");
  const shim = path.join(cellar, "bin", "ms");
  // The shim is taken FROM THE FORMULA, not retyped here — a copy would
  // prove only that this test's idea of a shim works. Homebrew's own
  // interpolations are filled in against the keg laid out above; this
  // process's node stands in for Homebrew's.
  const formulaText = readFileSync(path.join(REAL_REPO, "packaging", "model-switcher.rb"), "utf8");
  const heredoc = /\(bin\/"ms"\)\.write <<~SHIM\n([\s\S]*?)\n\s*SHIM\n/.exec(formulaText);
  assert.ok(heredoc, `no SHIM heredoc in the formula:\n${formulaText}`);
  const shimBody = heredoc![1]!
    .split("\n")
    .map((l) => l.replace(/^\s{6}/, "")) // <<~ strips the common indent
    .join("\n")
    .replaceAll('#{opt_bin}', path.dirname(optBin))
    .replaceAll("#{libexec}", libexec)
    .replaceAll('#{Formula["node"].opt_bin}/node', process.execPath);
  assert.ok(!shimBody.includes("#{"), `an interpolation this test does not know about: ${shimBody}`);
  writeFileSync(shim, `${shimBody}\n`, { mode: 0o755 });

  const msHome = mkdtempSync(path.join(tmpdir(), "ms-keg-home-"));
  // The keg's OWN `ms` goes in front of PATH for every spawn below. Without
  // this the doctor's "ms on PATH is msBinary()" check resolves whatever `ms`
  // the developer's machine has installed — on a machine with the real
  // Homebrew formula, /opt/homebrew/bin/ms — and compares that binary against
  // this temp keg. The test passed here only until `brew install model-switcher`
  // put one there. That is a hermeticity gap in the test, not a defect in the
  // product, and a test about a keg must see nothing but that keg.
  //
  // `opt/model-switcher/bin` is the STABLE link `def install` points `bin` at
  // (and the one the shim exports as MS_BIN), so putting it on PATH is also
  // exactly how a real installation is reached.
  const kegBin = path.dirname(optBin);
  const runShim = (args: string[], pathValue = `${kegBin}:${process.env.PATH}`) =>
    spawnSync(shim, args, {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: pathValue, HOME: msHome, MS_HOME: path.join(msHome, "store"), MS_BIN: undefined, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
    });

  // This is the check the old shim could never pass: `node dist/ms.js` only
  // EXPORTS main, so every verb printed nothing and exited 0.
  const version = runShim(["--version"]);
  assert.equal(version.status, 0, `stdout:${version.stdout} stderr:${version.stderr}`);
  assert.equal(version.stdout.trim(), "0.1.0", `an empty --version is the silent no-op shim: ${JSON.stringify(version.stdout)}`);
  assert.equal(version.stderr, "", version.stderr);

  const help = runShim(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stderr, /usage: ms/);

  // And `msBinary()` inside the real bundle resolves to the stable opt path
  // the shim exported — the exact string every hook command, trust hash,
  // statusline wrapper and alias line is written with (B-C2).
  //
  // Two facts, and the doctor only ever prints the second one on a ✗ line, so
  // they take two runs: that the `ms` PATH gives and the one `msBinary()`
  // names are THE SAME FILE, and that the string `msBinary()` hands out is the
  // stable `opt` path rather than the versioned Cellar one the next `brew
  // upgrade` deletes.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineWith = (r: { stdout: string; stderr: string }, re: RegExp): string | undefined =>
    `${r.stdout}${r.stderr}`.split("\n").find((l) => re.test(l));

  const doctor = runShim(["doctor"]);
  const pathLine = lineWith(doctor, /ms on PATH is msBinary/);
  assert.ok(pathLine, doctor.stdout + doctor.stderr);
  // ✓, and nothing else: a ✗ here names both binaries, and the keg's own is
  // the only one this run can see.
  assert.equal(pathLine, "✓ ms on PATH is msBinary()", doctor.stdout + doctor.stderr);

  // With no `ms` on PATH at all the doctor prints the string itself. Only the
  // SIP-protected system directories, where a Homebrew keg cannot be, so this
  // run cannot find one either; `/bin` is there because the shim is a bash
  // script that execs `env`.
  const bare = runShim(["doctor"], "/usr/bin:/bin");
  const binLine = lineWith(bare, /msBinary\(\) is/);
  assert.ok(binLine, bare.stdout + bare.stderr);
  assert.match(binLine!, new RegExp(`msBinary\\(\\) is ${escapeRe(optBin)}$`), binLine);
  assert.ok(!/Cellar/.test(binLine!), binLine);
});
