#!/usr/bin/env node
// `npm run release -- vX.Y.Z [--publish] [--tap <path>] [--dry-run]`
//
// Builds the esbuild bundle, packs a release tarball
// (model-switcher-vX.Y.Z.tar.gz, under `release/`, containing exactly
// `dist/ms.js`, `bin/ms`, `bin/resolve-entry.mjs`, `package.json`, `LICENSE`,
// `README.md` under a `model-switcher-vX.Y.Z/` prefix) and prints its
// sha256. Refuses to run against a dirty tree or a version that does not
// match `package.json`.
//
// `--publish` additionally: creates the GitHub release with `gh release
// create` (notes are the commit subjects since the previous tag), then
// renders `packaging/model-switcher.rb` into a local checkout of the tap
// (`--tap <path>`, default `../homebrew-tap`) with `url`/`sha256`/`version`
// substituted, and commits it there with the three standard co-author
// trailers. It NEVER pushes — it only prints the `git -C <tap> push`
// command for a human to run.
//
// `--dry-run` still builds and produces a real, inspectable tarball (so a
// caller can point it at a throwaway checkout and get back a real
// artifact), but skips the `--publish`-gated external effects (`gh release
// create`, writing/committing into the tap) and only describes what would
// have run.
//
// Every external command (`npm`, `tar`, `git`, `gh`) is bounded with a
// spawnSync timeout — nothing here can hang a release forever.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARBALL_ENTRIES = ["dist/ms.js", "bin/ms", "bin/resolve-entry.mjs", "package.json", "LICENSE", "README.md"];

const THREE_TRAILERS = [
  "Co-Authored-By: Claude <noreply@anthropic.com>",
  "Co-authored-by: Codex <codex@openai.com>",
  "Co-authored-by: Homi <322615700+Homi@users.noreply.github.com>",
].join("\n");

/** Pure: substitute the formula template's three placeholders. Throws
 *  nothing — a leftover placeholder is a rendering bug the caller must
 *  catch by inspecting the result, not something this function judges. */
export function renderFormula(template, { version, url, sha256 }) {
  return template.replaceAll("__VERSION__", version).replaceAll("__URL__", url).replaceAll("__SHA256__", sha256);
}

function fail(msg) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
}

/** Every subprocess this script spawns goes through here: bounded, and a
 *  non-zero exit or spawn error is reported with whatever the child said. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, ...opts });
  if (r.error) return { ok: false, status: 1, stdout: "", stderr: r.error.message };
  return { ok: r.status === 0, status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd, args) {
  return run("git", args, { cwd });
}

function parseArgs(argv) {
  const flags = { publish: false, dryRun: false, tap: "../homebrew-tap" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publish") flags.publish = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--tap") flags.tap = argv[++i];
    else positional.push(a);
  }
  flags.tag = positional[0];
  return flags;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Stages the six tarball entries under `model-switcher-<tag>/` in a scratch
 *  directory, then tars them by NAME (never a bare directory argument) so
 *  the archive holds exactly six entries — no directory entries, nothing
 *  else swept in. */
function buildTarball(repoRoot, tag) {
  const versionDir = `model-switcher-${tag}`;
  const scratch = mkdtempSync(path.join(tmpdir(), "ms-release-stage-"));
  try {
    for (const rel of TARBALL_ENTRIES) {
      const dest = path.join(scratch, versionDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(path.join(repoRoot, rel), dest);
    }
    const releaseDir = path.join(repoRoot, "release");
    mkdirSync(releaseDir, { recursive: true });
    const tarballPath = path.join(releaseDir, `${versionDir}.tar.gz`);
    const args = ["-czf", tarballPath, "-C", scratch, ...TARBALL_ENTRIES.map((rel) => path.join(versionDir, rel))];
    const r = run("tar", args, { timeout: 60_000 });
    if (!r.ok) fail(`tar failed: ${r.stderr || r.stdout}`);
    return tarballPath;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The latest `v*` tag by semver order, or null when there is none yet —
 *  the boundary for "commit subjects since the previous tag". */
function previousTag(repoRoot) {
  const r = git(repoRoot, ["tag", "--list", "v*", "--sort=-v:refname"]);
  if (!r.ok) return null;
  const tags = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return tags[0] ?? null;
}

function releaseNotes(repoRoot) {
  const prev = previousTag(repoRoot);
  const range = prev ? `${prev}..HEAD` : "HEAD";
  const r = git(repoRoot, ["log", range, "--pretty=%s"]);
  if (!r.ok) fail(`git log failed: ${r.stderr}`);
  return r.stdout.trim() || "(no commits)";
}

function main() {
  const { tag, publish, dryRun, tap } = parseArgs(process.argv.slice(2));
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    fail("usage: release.mjs vX.Y.Z [--publish] [--tap <path>] [--dry-run]");
  }
  const version = tag.slice(1);

  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  if (version !== pkg.version) {
    fail(`${tag} does not match package.json version ${pkg.version}`);
  }

  const status = git(REPO_ROOT, ["status", "--porcelain"]);
  if (!status.ok) fail(`git status failed: ${status.stderr}`);
  if (status.stdout.trim() !== "") {
    fail(`working tree is dirty — commit or stash first:\n${status.stdout}`);
  }

  const build = run("npm", ["run", "build"], { cwd: REPO_ROOT, timeout: 180_000 });
  if (!build.ok) fail(`npm run build failed:\n${build.stdout}${build.stderr}`);

  const tarballPath = buildTarball(REPO_ROOT, tag);
  const sha256 = sha256File(tarballPath);
  process.stdout.write(`release: wrote ${tarballPath}\n`);
  process.stdout.write(`sha256  ${sha256}\n`);

  if (!publish) return;
  if (dryRun) {
    process.stdout.write("release: --dry-run — skipping gh release create and the tap commit\n");
    return;
  }

  const notes = releaseNotes(REPO_ROOT);
  const notesDir = mkdtempSync(path.join(tmpdir(), "ms-release-notes-"));
  const notesFile = path.join(notesDir, "notes.md");
  writeFileSync(notesFile, notes + "\n");

  const ghArgs = ["release", "create", tag, tarballPath, "--title", `model-switcher ${tag}`, "--notes-file", notesFile];
  const ghResult = run("gh", ghArgs, { cwd: REPO_ROOT, timeout: 120_000 });
  rmSync(notesDir, { recursive: true, force: true });
  if (!ghResult.ok) fail(`gh release create failed:\n${ghResult.stdout}${ghResult.stderr}`);
  if (ghResult.stdout.trim()) process.stdout.write(ghResult.stdout);

  const tapPath = path.resolve(REPO_ROOT, tap);
  const url = `https://github.com/aadarwal/model-switcher/releases/download/${tag}/${path.basename(tarballPath)}`;
  const template = readFileSync(path.join(REPO_ROOT, "packaging", "model-switcher.rb"), "utf8");
  const rendered = renderFormula(template, { version, url, sha256 });
  const formulaPath = path.join(tapPath, "Formula", "model-switcher.rb");
  mkdirSync(path.dirname(formulaPath), { recursive: true });
  writeFileSync(formulaPath, rendered);

  const add = git(tapPath, ["add", "Formula/model-switcher.rb"]);
  if (!add.ok) fail(`git -C ${tapPath} add failed: ${add.stderr}`);

  const commitMessage = `model-switcher ${tag}: update formula\n\n${THREE_TRAILERS}`;
  const commit = git(tapPath, ["-c", "commit.gpgsign=false", "commit", "-m", commitMessage]);
  if (!commit.ok) fail(`git -C ${tapPath} commit failed: ${commit.stderr}${commit.stdout}`);

  process.stdout.write(`release: formula written to ${formulaPath}\n`);
  process.stdout.write(`release: run this yourself — it is never run automatically:\n`);
  process.stdout.write(`  git -C ${tapPath} push\n`);
}

// Only run when executed directly (`node scripts/release.mjs ...`), not
// when imported for `renderFormula` (as the tests do). Compared through
// realpath on both sides — a plain path.resolve() comparison silently never
// matches when the temp dir a test runs from sits behind a symlink (e.g.
// macOS's /var -> /private/var), which would make `main()` never run at all.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  main();
}
