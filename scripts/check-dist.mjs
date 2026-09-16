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
// A re-review (rereview-C.md, defect 1) proved the first version of this
// guard passed the EXACT collision it exists to catch: it asked whether
// `function esc(` appeared ANYWHERE in dist/ms.js, not whether the PAGE'S OWN
// embedded copy still declares it. A colliding `esc` added anywhere upstream
// of client-logic.ts in the bundle gets ITS declaration renamed instead (the
// later one esbuild sees), which leaves an unrelated `function esc(` sitting
// elsewhere in the same file — a false match the naive whole-bundle grep
// happily accepted while the actually-served page shipped `function esc2(`
// and a ReferenceError on first render.
//
// So this now renders the page the way a browser would receive it: it runs
// the BUILT bundle's own `dashboard` verb (GET /, the built binary's real
// page route — `main()` is dist/ms.js's only relevant export) against a
// fresh, disposable HOME/MS_HOME, fetches `/`, and checks the SERVED
// `<script>` body — not the whole bundle — for exactly the declarations the
// page's hand-written calls depend on.
//
// So the build checks its own output. Run from `npm run build` (and therefore
// from the release script, which builds through it).

import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join("src", "dashboard", "page.ts");
const DIST = path.join("dist", "ms.js");

/** How long a built dashboard gets to print its URL before this gives up on
 *  it. Generous — this is a build-time check, not a hot path, and a slow CI
 *  box starting node + sqlite is still nowhere near this. */
const RENDER_TIMEOUT_MS = 15_000;

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

/** Which of `names` the given text no longer declares under that exact name.
 *  Kept as a small, direct string-matcher — still correct on its own terms —
 *  but `main()` below now calls it on the served page's OWN `<script>` body,
 *  never on the whole bundle: run over the whole bundle it can pass on a
 *  match that belongs to an unrelated, same-named declaration elsewhere in
 *  the file (rereview-C.md, defect 1). */
export function missingFromBundle(names, bundle) {
  return names.filter((name) => !new RegExp(`function\\s+${name}\\s*\\(`).test(bundle));
}

/** Pulls the inline `<script>...</script>` body out of a rendered dashboard
 *  page. Throws rather than returning something empty — a page with no
 *  script tag is not a page this check can pass on. */
export function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("the rendered dashboard page has no <script> tag");
  return m[1];
}

/**
 * The real check: does the served page's OWN `<script>` body still declare
 * each embedded name exactly once, under that exact name — and, the specific
 * fingerprint of the collision this guard exists to catch, is a RENAMED
 * sibling (`<name><digit>`) present too, which would mean the declaration
 * moved but a call site (literal text in page.ts's template string, which no
 * bundler ever touches) still says the original name.
 *
 * Returns one human-readable problem string per broken name; empty means
 * clean.
 */
export function scriptDeclarationProblems(names, scriptText) {
  const problems = [];
  for (const name of names) {
    const declPattern = new RegExp(`function\\s+${name}\\s*\\(`, "g");
    const declared = scriptText.match(declPattern) ?? [];
    if (declared.length === 0) {
      const renamedPattern = new RegExp(`function\\s+(${name}\\d+)\\s*\\(`);
      const renamed = scriptText.match(renamedPattern);
      problems.push(
        renamed
          ? `${name}: not declared in the served page's script — esbuild renamed it to ${renamed[1]}, but the page's own hand-written calls still say ${name}(...)`
          : `${name}: not declared in the served page's script at all`,
      );
      continue;
    }
    if (declared.length > 1) {
      problems.push(`${name}: declared ${declared.length} times in the served page's script (want exactly 1)`);
      continue;
    }
    const strayRenamedCall = new RegExp(`\\b${name}\\d+\\s*\\(`).test(scriptText);
    if (strayRenamedCall) {
      problems.push(`${name}: a renamed sibling (${name}<digits>) is also called in the served page's script — a collision split it`);
    }
  }
  return problems;
}

/**
 * Runs the BUILT bundle's `dashboard` verb (its `main()` export is the only
 * thing dist/ms.js exports) against a fresh, disposable HOME/MS_HOME, fetches
 * `GET /` — the built binary's real page route — and returns the served
 * page's `<script>` body.
 *
 * Hermetic: a brand-new temp HOME/MS_HOME (nothing here touches a real
 * install or a real session), `--no-open`, port 0 (so this never collides
 * with anything else on the machine), and no seeded accounts or sessions —
 * `GET /` only ever calls `renderDashboardPage()`, which touches neither the
 * store nor tmux, so an absent/stub tmux is never in the picture. The process
 * is killed explicitly the moment the page has been fetched rather than left
 * to idle out on its own.
 */
export async function renderedPageScript(distFile, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
  const home = mkdtempSync(path.join(tmpdir(), "ms-checkdist-home-"));
  const runDir = mkdtempSync(path.join(tmpdir(), "ms-checkdist-run-"));
  try {
    const msHome = path.join(home, ".config", "model-switcher");
    mkdirSync(msHome, { recursive: true, mode: 0o700 });

    // A tiny launcher rather than `node -e`: it has to hold a `file://` URL
    // that may contain characters a shell would mangle if this were built as
    // a one-line `-e` argument instead.
    const launcherFile = path.join(runDir, "launch.mjs");
    const distUrl = pathToFileURL(path.resolve(distFile)).href;
    writeFileSync(
      launcherFile,
      `import { main } from ${JSON.stringify(distUrl)};\n` + `process.exitCode = await main(["dashboard", "--no-open", "--port", "0"]);\n`,
    );

    const child = spawn(process.execPath, [launcherFile], {
      env: {
        ...process.env,
        HOME: home,
        MS_HOME: msHome,
        NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderrBuf = "";
    let settled = false;
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`the built dashboard never printed its URL within ${timeoutMs}ms; stderr so far:\n${stderrBuf}`));
      }, timeoutMs);
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
        const m = stderrBuf.match(/ms dashboard: (http:\/\/127\.0\.0\.1:\d+)/);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`the built dashboard exited (code ${code}) before printing its URL; stderr:\n${stderrBuf}`));
      });
    });

    try {
      const res = await fetch(`${url}/`);
      if (res.status !== 200) throw new Error(`GET / on the built dashboard answered ${res.status}, not 200`);
      const html = await res.text();
      return extractScript(html);
    } finally {
      child.kill("SIGKILL");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
}

async function main() {
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

  let script;
  try {
    script = await renderedPageScript(distPath);
  } catch (e) {
    process.stderr.write(`check-dist: could not render ${DIST}'s dashboard page to check it: ${e.message}\n`);
    return 1;
  }

  const problems = scriptDeclarationProblems(names, script);
  if (problems.length) {
    process.stderr.write(
      `check-dist: the dashboard page ${DIST} actually serves does not cleanly declare ${problems.length} of the ${names.length} function(s) it calls by name:\n` +
        problems.map((p) => `  - ${p}\n`).join("") +
        "  This is checked against the served page's OWN <script> body (rendered through the built binary), not the whole\n" +
        "  bundle — a same-named declaration elsewhere in dist/ms.js can no longer hide this.\n" +
        "  Rename the colliding declaration, or rename the one in src/dashboard/client-logic.ts.\n",
    );
    return 1;
  }
  process.stdout.write(`check-dist: the served dashboard page still declares all ${names.length} functions it calls by name\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
