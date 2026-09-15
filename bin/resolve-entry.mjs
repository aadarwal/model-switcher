// Decides which entry point `bin/ms` should run: the built `dist/ms.js` or
// the TypeScript sources (`src/cli.ts`, loaded through tsx). Split out of
// bin/ms itself so it can be unit-tested without spawning a process.
//
// Four layouts exist, and every one of them has to work — this file is on the
// path of EVERY invocation, including `ms _hook claude`, whose stderr is
// rendered inside the human's Claude transcript. So it never throws:
//
//   * a released install (`bin/` + `dist/`, no sources — the brew formula)
//     runs the bundle. Walking a `src/` that is not there used to throw
//     ENOENT on every single invocation;
//   * a checkout with no bundle runs the sources through tsx;
//   * both present runs the bundle, UNLESS `MS_ENTRY=src` or the sources are
//     newer than the bundle AND tsx can actually be resolved from the package.
//     Falling back to `src/` without tsx put plain `node` in front of
//     TypeScript that Node's strip-only mode rejects outright
//     (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX on the first parameter property) —
//     a hard failure on every hook, caused by nothing but a file's mtime;
//   * neither present is null, and bin/ms says so in one line and exits 1.
//
// `MS_ENTRY=dist` / `MS_ENTRY=src` are explicit overrides, honoured whenever
// the thing they name exists.
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * @param {string} here - the directory `bin/ms` lives in (so resolution is
 *   independent of the caller's cwd).
 * @param {Record<string, string | undefined>} [env] - defaults to `process.env`.
 * @returns {string | null} absolute path to the entry module to `import()`, or
 *   null when this install has neither a bundle nor sources.
 */
export function resolveEntry(here, env = process.env) {
  const root = path.join(here, "..");
  const distFile = path.join(root, "dist", "ms.js");
  const srcFile = path.join(root, "src", "cli.ts");
  const hasDist = existsSync(distFile);
  const hasSrc = existsSync(srcFile);

  const override = env.MS_ENTRY;
  if (override === "dist" && hasDist) return distFile;
  if (override === "src" && hasSrc) return srcFile;

  if (!hasSrc) return hasDist ? distFile : null;
  if (!hasDist) return srcFile;
  // Both: the bundle is the answer unless the sources are newer AND something
  // in this install can load them. A developer who runs `npm run build` and
  // keeps editing must not silently go on testing the old bundle — but a
  // stranger's checkout whose mtimes came out of a tarball must not be sent
  // to TypeScript nothing can read.
  return srcIsNewer(root, distFile) && tsxResolvable(root) ? srcFile : distFile;
}

/** Can this install load TypeScript at all? Resolution only — nothing is
 * imported here, and a tsx that is not installed is an ordinary answer. */
export function tsxResolvable(root) {
  try {
    createRequire(path.join(root, "package.json")).resolve("tsx");
    return true;
  } catch {
    return false;
  }
}

/** Is any file under `<root>/src` newer than the bundle? Never throws: a
 * question we could not answer is answered "no", which keeps the bundle. */
function srcIsNewer(root, distFile) {
  try {
    return newestMtimeUnder(path.join(root, "src")) > statSync(distFile).mtimeMs;
  } catch {
    return false;
  }
}

/** Newest mtime (ms) of any file under `dir`, walked recursively. A
 * dev-only path — a plain `readdirSync` walk is fine here. */
function newestMtimeUnder(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true });
  } catch {
    return 0; // no such directory, or one we may not read
  }
  for (const rel of entries) {
    const full = path.join(dir, rel);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // raced with something removing the file mid-walk
    }
    if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}
