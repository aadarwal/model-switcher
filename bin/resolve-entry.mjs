// Decides which entry point `bin/ms` should run: the built `dist/ms.js` or
// the TypeScript sources (`src/cli.ts`, loaded via tsx). Split out of
// bin/ms itself so it can be unit-tested without spawning a process.
//
// `MS_ENTRY=dist` / `MS_ENTRY=src` are explicit overrides. With neither set,
// `dist/ms.js` is used only when it exists AND is at least as new as every
// file under `src/` — otherwise a developer who runs `npm run build` and
// then keeps editing `src/` would silently keep testing the old bundle.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * @param {string} here - the directory `bin/ms` lives in (so resolution is
 *   independent of the caller's cwd).
 * @param {Record<string, string | undefined>} [env] - defaults to `process.env`.
 * @returns {string} absolute path to the entry module to `import()`.
 */
export function resolveEntry(here, env = process.env) {
  const root = path.join(here, "..");
  const distFile = path.join(root, "dist", "ms.js");
  const srcFile = path.join(root, "src", "cli.ts");

  const override = env.MS_ENTRY;
  if (override === "dist") return distFile;
  if (override === "src") return srcFile;

  if (!existsSync(distFile)) return srcFile;
  const distMtime = statSync(distFile).mtimeMs;
  if (newestMtimeUnder(path.join(root, "src")) > distMtime) return srcFile;
  return distFile;
}

/** Newest mtime (ms) of any file under `dir`, walked recursively. A
 * dev-only path — a plain `readdirSync` walk is fine here. */
function newestMtimeUnder(dir) {
  let newest = 0;
  for (const rel of readdirSync(dir, { recursive: true })) {
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
