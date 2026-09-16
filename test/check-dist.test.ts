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
// A re-review (rereview-C.md, defect 1) then proved the FIRST version of this
// guard passed that exact collision: it grepped whether `function esc(`
// appeared anywhere in the whole bundle, which a same-named declaration
// elsewhere in the file (the OTHER half of the collision, which keeps its
// plain name) satisfies even when the page's OWN embedded copy got renamed.
// So the guard now renders the page the way a browser receives it — runs the
// built bundle's real `dashboard` verb, fetches `GET /` — and checks only the
// served `<script>` body. Most of these tests run against fixture strings and
// need no `dist/` of their own; the two at the bottom actually build a bundle
// with esbuild (the same way `npm run build` does) to prove the real thing
// end to end, including the collider-first regression rereview-C.md asked for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { embeddedNames, missingFromBundle, extractScript, scriptDeclarationProblems, renderedPageScript } from "../scripts/check-dist.mjs";
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

// --- extractScript -----------------------------------------------------

test("extractScript: pulls the inline <script> body out of a rendered page, and refuses a page with none", () => {
  assert.equal(extractScript("<html><body></body><script>hello</script></html>"), "hello");
  assert.throws(() => extractScript("<html>no script tag here</html>"), /no <script> tag/);
});

// --- scriptDeclarationProblems -------------------------------------------
//
// Unlike missingFromBundle, this is meant to run over the SERVED PAGE'S OWN
// <script> body only — which is where defect 1 lived: run over the whole
// bundle, a same-named declaration elsewhere hides a renamed embedded copy.

test("scriptDeclarationProblems: clean when every name is declared exactly once, whatever else the script calls", () => {
  const names = ["esc", "sessionRowHtml"];
  const good = "function esc(s) {}\nfunction sessionRowHtml(s, others) { return esc(s); }\n";
  assert.deepStrictEqual(scriptDeclarationProblems(names, good), []);
});

test("scriptDeclarationProblems: a renamed declaration is reported by the original name, naming what it became", () => {
  const names = ["esc", "sessionRowHtml"];
  // The exact shape rereview-C.md found: the served page's own script has
  // `esc2`'s declaration, but the page's hand-written calls still say `esc(`.
  const renamed = "function esc2(s) {}\nfunction sessionRowHtml(s, others) { return esc(s); }\n";
  const problems = scriptDeclarationProblems(names, renamed);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^esc: not declared.*renamed it to esc2/);
});

test("scriptDeclarationProblems: a name simply absent, with no renamed sibling either, is reported too", () => {
  assert.deepStrictEqual(scriptDeclarationProblems(["esc"], "function sessionRowHtml() {}"), [
    "esc: not declared in the served page's script at all",
  ]);
});

test("scriptDeclarationProblems: a name declared twice is reported, not silently accepted", () => {
  const twice = "function esc(s) {}\nfunction esc(s) {}\n";
  assert.deepStrictEqual(scriptDeclarationProblems(["esc"], twice), ["esc: declared 2 times in the served page's script (want exactly 1)"]);
});

test("scriptDeclarationProblems: a correct declaration alongside a stray call to a renamed sibling is still reported", () => {
  // Belt and suspenders: the declaration is fine, but a leftover call to a
  // renamed sibling is exactly the fingerprint of a collision that split.
  const text = "function esc(s) {}\nvar x = esc2(s);\n";
  assert.deepStrictEqual(scriptDeclarationProblems(["esc"], text), [
    "esc: a renamed sibling (esc<digits>) is also called in the served page's script — a collision split it",
  ]);
});

// --- renderedPageScript + scriptDeclarationProblems, against real esbuild
// builds ---------------------------------------------------------------
//
// The two tests above's fixture strings prove the string-matching logic is
// correct on its own terms; these prove the whole mechanism — running the
// BUILT bundle's real dashboard verb and checking its actually-served
// <script> — catches (and doesn't catch) the right things on a real esbuild
// output, the same way `npm run build` produces one.

async function buildBundle(entry: string, outfile: string): Promise<void> {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["node:*"],
  });
}

test("renderedPageScript + scriptDeclarationProblems: a clean build of this repo's own src has nothing to report", async (t) => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ms-checkdist-clean-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const distFile = path.join(outDir, "dist.js");
  await buildBundle(path.resolve("src/cli.ts"), distFile);

  const script = await renderedPageScript(distFile);
  const problems = scriptDeclarationProblems(embeddedNames(PAGE_SOURCE), script);
  assert.deepStrictEqual(problems, [], `a clean build should have nothing to report: ${JSON.stringify(problems)}`);
});

test("collider-first regression: a real esbuild collision that renames client-logic's `esc` makes the guard fail, naming it", async (t) => {
  // A temp copy of src/, so the probe never touches the real repo's files —
  // and a real esbuild build of it, so this proves the actual bundler
  // behavior rereview-C.md found, not just this file's own string logic.
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "ms-checkdist-collider-"));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
  cpSync(path.resolve("src"), path.join(tmpRoot, "src"), { recursive: true });

  // rereview-C.md's own reproduction: a reachable top-level `esc` added to
  // src/manual.ts — a module esbuild emits BEFORE client-logic.ts in
  // cli.ts's bundle — gets esbuild to rename the LATER declaration instead:
  // client-logic's own `esc`, the one page.ts embeds by that exact name.
  const manualPath = path.join(tmpRoot, "src", "manual.ts");
  const original = readFileSync(manualPath, "utf8");
  writeFileSync(
    manualPath,
    original +
      "\n// check-dist.test.ts collider probe: a reachable top-level `esc`, colliding with client-logic.ts's own.\n" +
      'function esc(x: unknown): string {\n  return String(x);\n}\nvoid esc("collider-probe");\n',
  );

  const distFile = path.join(tmpRoot, "dist.js");
  await buildBundle(path.join(tmpRoot, "src", "cli.ts"), distFile);
  const built = readFileSync(distFile, "utf8");

  // Sanity: the probe actually reproduced the collision. If esbuild ever
  // changes how it resolves same-named top-level declarations, this is the
  // assertion that should fail first, loudly, rather than the real one below
  // silently proving nothing.
  assert.match(built, /function esc2\s*\(/, "the probe did not reproduce the collision — esbuild did not rename client-logic's esc");

  const names = embeddedNames(PAGE_SOURCE);

  // The OLD approach — grepping whether `function esc(` appears ANYWHERE in
  // the whole bundle — passes this exact collision: the collider itself kept
  // the plain name `esc`, so the whole-bundle text still "has" it.
  assert.deepStrictEqual(
    missingFromBundle(names, built),
    [],
    "sanity: the naive whole-bundle check should still (wrongly) see nothing missing here — that IS the bug this guard now closes",
  );

  // The NEW approach — the served page's own <script> — must not be fooled.
  const script = await renderedPageScript(distFile);
  const problems = scriptDeclarationProblems(names, script);
  const escProblem = problems.find((p) => p.startsWith("esc:"));
  assert.ok(escProblem, `the guard did not catch the collision it exists to catch: ${JSON.stringify(problems)}`);
  assert.match(escProblem!, /esc2/, "the failure message should name the function esbuild renamed it to");
});
