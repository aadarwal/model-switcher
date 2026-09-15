// bin/ms must not silently prefer a stale dist/ms.js over edited sources.
// The decision lives in bin/resolve-entry.mjs's resolveEntry(here, env) so
// it can be exercised directly, against a temp copy of the bin/dist/src
// layout, without spawning a process or needing a real esbuild bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveEntry } from "../bin/resolve-entry.mjs";

const HOUR = 3600;

/** A temp `<root>/{bin,dist,src}` layout. `distAgeS`/`srcAgeS` are seconds
 * *before now* for each file's mtime — smaller means newer. `dist: false`
 * skips creating dist/ms.js entirely. */
function layout(opts: { dist?: false | { ageS: number }; srcFiles?: Record<string, number> }) {
  const root = mkdtempSync(path.join(tmpdir(), "ms-bin-test-"));
  const binDir = path.join(root, "bin");
  const srcDir = path.join(root, "src");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(binDir, "ms"), "");

  const now = Date.now() / 1000;
  const touch = (file: string, ageS: number) => {
    writeFileSync(file, "");
    utimesSync(file, now - ageS, now - ageS);
  };

  if (opts.dist !== false) {
    const distDir = path.join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    touch(path.join(distDir, "ms.js"), opts.dist?.ageS ?? 0);
  }
  const srcFiles = opts.srcFiles ?? { "cli.ts": 0 };
  for (const [rel, ageS] of Object.entries(srcFiles)) {
    const full = path.join(srcDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    touch(full, ageS);
  }
  return { root, binDir, distFile: path.join(root, "dist", "ms.js"), srcCliFile: path.join(srcDir, "cli.ts") };
}

test("dist/ms.js is used when it is at least as new as every file under src/", () => {
  // dist built an hour ago, sources untouched since (older than the build).
  const { binDir, distFile } = layout({ dist: { ageS: HOUR }, srcFiles: { "cli.ts": 2 * HOUR, "state.ts": 3 * HOUR } });
  assert.equal(resolveEntry(binDir, {}), distFile);
});

test("a source file edited after the build makes the shim fall back to the sources", () => {
  // dist built an hour ago; state.ts was edited 10 minutes ago — newer than the build.
  const { binDir, srcCliFile } = layout({ dist: { ageS: HOUR }, srcFiles: { "cli.ts": 2 * HOUR, "state.ts": 600 } });
  assert.equal(resolveEntry(binDir, {}), srcCliFile);
});

test("no dist/ms.js at all resolves straight to the sources", () => {
  const { binDir, srcCliFile } = layout({ dist: false });
  assert.equal(resolveEntry(binDir, {}), srcCliFile);
});

test("MS_ENTRY=src forces the sources even when dist is freshly built", () => {
  const { binDir, srcCliFile } = layout({ dist: { ageS: 1 }, srcFiles: { "cli.ts": HOUR } });
  assert.equal(resolveEntry(binDir, { MS_ENTRY: "src" }), srcCliFile);
});

test("MS_ENTRY=dist forces dist/ms.js even when it is stale", () => {
  const { binDir, distFile } = layout({ dist: { ageS: HOUR }, srcFiles: { "cli.ts": 1 } });
  assert.equal(resolveEntry(binDir, { MS_ENTRY: "dist" }), distFile);
});

test("dist and the newest src file at the same mtime counts as 'at least as new' (dist wins)", () => {
  const { binDir, distFile } = layout({ dist: { ageS: 100 }, srcFiles: { "cli.ts": 100 } });
  assert.equal(resolveEntry(binDir, {}), distFile);
});
