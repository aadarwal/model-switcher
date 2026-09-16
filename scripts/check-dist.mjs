// scripts/check-dist.mjs
//
// The one thing a bundler can silently break about the dashboard page.
//
// src/dashboard/page.ts builds its inline <script> by re-emitting each client
// function's own runtime source (`fn.toString()`), and the page's hand-written
// JS — which lives in a template STRING, so no tool ever renames anything in
// it — calls those functions by name: `buildRotateBody(id)`,
// `sessionRowHtml(...)`, `formatSwitchAll(...)`. The two halves agree only as
// long as the emitted source still declares the name the string calls.
//
// esbuild guarantees no such thing. The moment a second top-level `esc` (or
// `localTime`, or `nextPollState`) appears anywhere in the bundle, one of them
// is renamed — `esc` becomes `esc2` — and `fn.toString()` faithfully emits
// `function esc2(...)`. Every test passes: `MS_ENTRY=src npm test` runs the
// TypeScript sources, where nothing was renamed. Only the built bundle is
// broken, and only in the browser, where the first click on Rotate is a
// ReferenceError nobody sees.
//
// So the build checks its own output. Run from `npm run build` (and therefore
// from the release script, which builds through it).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join("src", "dashboard", "page.ts");
const DIST = path.join("dist", "ms.js");

/**
 * The names page.ts embeds, read from its own `EMBEDDED` array rather than
 * kept as a second list here — a list this file maintained by hand would be
 * one more thing to forget, which is the failure it exists to catch.
 */
export function embeddedNames(pageSource) {
  const m = pageSource.match(/const EMBEDDED = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error(`could not find \`const EMBEDDED = [...]\` in ${PAGE}`);
  const names = m[1]
    .replace(/\/\/[^\n]*/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) throw new Error(`\`EMBEDDED\` in ${PAGE} is empty`);
  for (const name of names) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`\`EMBEDDED\` in ${PAGE} holds something that is not an identifier: ${JSON.stringify(name)}`);
  }
  return names;
}

/** Which of `names` the bundle no longer declares under that exact name. */
export function missingFromBundle(names, bundle) {
  return names.filter((name) => !new RegExp(`function\\s+${name}\\s*\\(`).test(bundle));
}

function main() {
  const distPath = path.join(ROOT, DIST);
  if (!existsSync(distPath)) {
    process.stderr.write(`check-dist: ${DIST} is not there — run \`npm run build\` first\n`);
    return 1;
  }
  let names;
  try {
    names = embeddedNames(readFileSync(path.join(ROOT, PAGE), "utf8"));
  } catch (e) {
    process.stderr.write(`check-dist: ${e.message}\n`);
    return 1;
  }
  const missing = missingFromBundle(names, readFileSync(distPath, "utf8"));
  if (missing.length) {
    process.stderr.write(
      `check-dist: ${DIST} no longer declares ${missing.length} function(s) the dashboard page calls by name: ${missing.join(", ")}\n` +
        "  The bundler renamed them (a second top-level declaration of the same name, most likely).\n" +
        `  The page's inline script calls these names as literal text, so the built dashboard is broken.\n` +
        `  Rename the colliding declaration, or rename the one in src/dashboard/client-logic.ts.\n`,
    );
    return 1;
  }
  process.stdout.write(`check-dist: dist/ms.js still declares all ${names.length} functions the dashboard page embeds\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
