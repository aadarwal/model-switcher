// test/check-dist.test.ts
//
// The post-build guard (scripts/check-dist.mjs), which `npm run build` runs
// after esbuild — and which the release script therefore runs too, since it
// builds through `npm run build`.
//
// Whole-branch review, area C (minor): src/dashboard/page.ts embeds each
// client function's own runtime source via `fn.toString()`, and the page's
// hand-written JS calls those functions by name from inside a template STRING
// — text no bundler renames. The moment a second top-level `esc` appears
// anywhere in the bundle, esbuild renames one of them and `fn.toString()`
// emits `function esc2(...)` while the string still calls `esc(...)`. Every
// test passes (they run the TypeScript sources, where nothing was renamed);
// only the shipped dashboard breaks, in the browser, on the first click.
//
// These run against fixture strings, so they need no `dist/` of their own —
// the real bundle is checked by the build itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { embeddedNames, missingFromBundle } from "../scripts/check-dist.mjs";
import { EMBEDDED_FUNCTION_NAMES } from "../src/dashboard/page.ts";

const PAGE_SOURCE = readFileSync(path.resolve("src/dashboard/page.ts"), "utf8");

test("embeddedNames reads page.ts's own EMBEDDED list — the same names the module exports at runtime", () => {
  assert.deepStrictEqual(embeddedNames(PAGE_SOURCE), [...EMBEDDED_FUNCTION_NAMES]);
});

test("embeddedNames refuses a page.ts it cannot read the list out of, rather than passing an empty check", () => {
  // A guard that silently found nothing to check would be worse than none:
  // the build would go green on a bundle it never looked at.
  assert.throws(() => embeddedNames("const OTHER = [esc];"), /could not find/);
  assert.throws(() => embeddedNames("const EMBEDDED = [\n];"), /is empty/);
  assert.throws(() => embeddedNames("const EMBEDDED = [\n  esc(),\n];"), /not an identifier/);
});

test("missingFromBundle names exactly the functions a bundle no longer declares", () => {
  const names = ["esc", "sessionRowHtml"];
  const good = "function esc(s) {}\nfunction sessionRowHtml(s, others) {}\n";
  assert.deepStrictEqual(missingFromBundle(names, good), []);

  // The real failure: esbuild renamed one of them past a collision. The page
  // still calls `esc(...)` as literal text inside its template string.
  const renamed = "function esc2(s) {}\nfunction sessionRowHtml(s, others) {}\n";
  assert.deepStrictEqual(missingFromBundle(names, renamed), ["esc"]);

  // A mention is not a declaration: the name has to be DECLARED.
  assert.deepStrictEqual(missingFromBundle(["esc"], "var x = esc;\n// esc(\n"), ["esc"]);
  // …and the bundler's own formatting of the same declaration still counts.
  assert.deepStrictEqual(missingFromBundle(["esc"], "function  esc (s) {}"), []);
});
