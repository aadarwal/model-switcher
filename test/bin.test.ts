// bin/ms has to start in every layout this tool ships in, and the decision
// lives in bin/resolve-entry.mjs's resolveEntry(here, env) so it can be
// exercised directly against a temp bin/dist/src tree. The four layouts:
//
//   dist only   a released install (the brew formula ships bin/ + dist/).
//               Walking a src/ that is not there threw ENOENT on EVERY
//               invocation — including every `ms _hook claude`, whose stderr
//               is rendered inside the human's Claude transcript.
//   src only    a checkout with no bundle: the sources, through tsx.
//   both        the bundle, unless the human said MS_ENTRY=src or the sources
//               are newer AND tsx can actually be resolved. Falling back to
//               src/ on mtime alone put plain `node` in front of TypeScript
//               its strip-only mode rejects outright.
//   neither     one line on stderr and exit 1 — never a stack trace.
//
// The last two tests spawn the real thing: temp layouts for the released and
// empty ones, and this very checkout (pinned with MS_ENTRY=src, and with no
// `--import tsx` in front of it) for the sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveEntry } from "../bin/resolve-entry.mjs";
import { tempHome } from "./helpers.ts";

const HOUR = 3600;

/** A temp `<root>/{bin,dist,src}` layout. `distAgeS`/`srcAgeS` are seconds
 * *before now* for each file's mtime — smaller means newer. `dist: false`
 * skips creating dist/ms.js entirely, `src: false` skips src/ entirely, and
 * `tsx: true` plants a resolvable tsx in the layout's own node_modules. */
function layout(opts: {
  dist?: false | { ageS: number };
  src?: false;
  srcFiles?: Record<string, number>;
  tsx?: boolean;
  /** Real bin/ms + resolve-entry.mjs, for the tests that spawn it. */
  real?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "ms-bin-test-"));
  const binDir = path.join(root, "bin");
  const srcDir = path.join(root, "src");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "model-switcher", type: "module" }));
  if (opts.real) {
    for (const f of ["ms", "resolve-entry.mjs"]) cpSync(path.resolve("bin", f), path.join(binDir, f));
  } else {
    writeFileSync(path.join(binDir, "ms"), "");
  }

  const now = Date.now() / 1000;
  const touch = (file: string, ageS: number, body = "") => {
    writeFileSync(file, body);
    utimesSync(file, now - ageS, now - ageS);
  };

  if (opts.dist !== false) {
    const distDir = path.join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    touch(path.join(distDir, "ms.js"), opts.dist?.ageS ?? 0, 'export async function main(){ process.stdout.write("the bundle ran\\n"); return 0; }\n');
  }
  if (opts.src !== false) {
    mkdirSync(srcDir, { recursive: true });
    for (const [rel, ageS] of Object.entries(opts.srcFiles ?? { "cli.ts": 0 })) {
      const full = path.join(srcDir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      touch(full, ageS);
    }
  }
  if (opts.tsx) {
    const tsxDir = path.join(root, "node_modules", "tsx");
    mkdirSync(tsxDir, { recursive: true });
    writeFileSync(path.join(tsxDir, "package.json"), JSON.stringify({ name: "tsx", version: "0.0.0", main: "index.js" }));
    writeFileSync(path.join(tsxDir, "index.js"), "");
  }
  return { root, binDir, distFile: path.join(root, "dist", "ms.js"), srcCliFile: path.join(srcDir, "cli.ts") };
}

test("a released install — bin/ + dist/, no sources — runs the bundle instead of throwing", () => {
  const { binDir, distFile } = layout({ src: false });
  assert.equal(resolveEntry(binDir, {}), distFile);
  // Even when asked for the sources by name: they are not there to run.
  assert.equal(resolveEntry(binDir, { MS_ENTRY: "src" }), distFile);
});

test("a checkout with no bundle runs the sources", () => {
  const { binDir, srcCliFile } = layout({ dist: false, tsx: true });
  assert.equal(resolveEntry(binDir, {}), srcCliFile);
  assert.equal(resolveEntry(binDir, { MS_ENTRY: "dist" }), srcCliFile, "a bundle that is not there cannot be forced");
});

test("neither a bundle nor sources is null, not a guess", () => {
  const { binDir } = layout({ dist: false, src: false });
  assert.equal(resolveEntry(binDir, {}), null);
  assert.equal(resolveEntry(binDir, { MS_ENTRY: "src" }), null);
});

test("with both, the bundle wins unless the sources are newer AND tsx can load them", () => {
  // Newer sources, and a tsx in the install: the developer's case.
  const dev = layout({ dist: { ageS: HOUR }, srcFiles: { "cli.ts": 2 * HOUR, "state.ts": 600 }, tsx: true });
  assert.equal(resolveEntry(dev.binDir, {}), dev.srcCliFile);

  // The same tree without tsx. Nothing here can read TypeScript — Node's own
  // strip-only mode rejects the first parameter property — so a file's mtime
  // must not be allowed to break every invocation.
  const bare = layout({ dist: { ageS: HOUR }, srcFiles: { "cli.ts": 2 * HOUR, "state.ts": 600 } });
  assert.equal(resolveEntry(bare.binDir, {}), bare.distFile);

  // Sources older than the build: the bundle, tsx or no tsx.
  const built = layout({ dist: { ageS: HOUR }, srcFiles: { "cli.ts": 2 * HOUR }, tsx: true });
  assert.equal(resolveEntry(built.binDir, {}), built.distFile);

  // Same mtime counts as "at least as new" (the bundle wins).
  const tie = layout({ dist: { ageS: 100 }, srcFiles: { "cli.ts": 100 }, tsx: true });
  assert.equal(resolveEntry(tie.binDir, {}), tie.distFile);
});

test("MS_ENTRY names the entry outright, tsx or no tsx", () => {
  const { binDir, srcCliFile, distFile } = layout({ dist: { ageS: 1 }, srcFiles: { "cli.ts": HOUR } });
  assert.equal(resolveEntry(binDir, { MS_ENTRY: "src" }), srcCliFile, "the human asked for the sources");
  const stale = layout({ dist: { ageS: HOUR }, srcFiles: { "cli.ts": 1 }, tsx: true });
  assert.equal(resolveEntry(stale.binDir, { MS_ENTRY: "dist" }), stale.distFile, "…and here for the bundle");
  assert.notEqual(distFile, srcCliFile);
});

test("a released install actually starts: bin/dist with no src/ runs, and an empty one says so once", () => {
  const released = layout({ src: false, real: true });
  const { home, msHome } = tempHome();
  const env = { ...process.env, HOME: home, MS_HOME: msHome, NODE_OPTIONS: "" };
  const r = spawnSync(process.execPath, [path.join(released.binDir, "ms")], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "the bundle ran\n");
  assert.equal(r.stderr, "", "not one byte: this runs on every hook invocation");

  const empty = layout({ dist: false, src: false, real: true });
  const r2 = spawnSync(process.execPath, [path.join(empty.binDir, "ms")], { encoding: "utf8", env, timeout: 30_000 });
  assert.equal(r2.status, 1);
  assert.equal(r2.stderr.split("\n").filter(Boolean).length, 1, `one line, not a stack trace:\n${r2.stderr}`);
  assert.match(r2.stderr, /^ms: no entry point/);
});

test("the sources run under a plain `node bin/ms`, with no --import tsx in front of it", () => {
  // The installed hook command is `<repo>/bin/ms _hook claude`, run by Claude
  // Code with whatever node is on PATH — never with a loader flag. This very
  // checkout is the src layout; MS_ENTRY pins it so a stray dist/ cannot make
  // the test vacuous.
  const { home, msHome } = tempHome();
  const r = spawnSync(process.execPath, [path.resolve("bin/ms"), "--version"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, MS_HOME: msHome, MS_ENTRY: "src", NODE_OPTIONS: "" },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
