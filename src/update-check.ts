// src/update-check.ts
//
// "A newer ms is out", without adding a millisecond to any verb.
//
// The verb never talks to the network. It reads a small cache file in MS_HOME
// (`update-check.json`) and prints one line when the release recorded there is
// newer than this one. When that cache is a day old (or missing), it starts a
// DETACHED child — `node -e` with the few lines below, stdio ignored, unref'd —
// that makes ONE unauthenticated GET to GitHub's public releases API and
// rewrites the file; the verb has already moved on and never waits for it.
// What is sent is exactly that request: the URL below and a `User-Agent:
// model-switcher/<version>` header (GitHub refuses requests without one). No
// account, token, path or usage figure ever leaves the machine.
//
// At most one attempt per 24 h: the verb stamps `attemptedAt` BEFORE it starts
// the child, so a failed fetch (offline, rate-limited) waits a day like a
// successful one, and twenty panes launching at once start one child, not
// twenty. Off with MS_NO_UPDATE_CHECK=1, and on its own under CI and in the
// test suite (node:test marks its processes with NODE_TEST_CONTEXT).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compareVersions, msVersion, parseVersion, upgradeHint, writeSmallJson } from "./compat.ts";
import { msHome } from "./paths.ts";

export const RELEASES_URL = "https://api.github.com/repos/aadarwal/model-switcher/releases/latest";
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export type UpdateCache = { attemptedAt?: number; checkedAt?: number; latest?: string };

export function updateCachePath(): string {
  return path.join(msHome(), "update-check.json");
}

/** Whether `ms` may look for a newer release at all. Any non-empty value of
 *  MS_NO_UPDATE_CHECK but `0` turns it off — for an opt-out, a typo should
 *  err towards quiet. */
export function updateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const off = env.MS_NO_UPDATE_CHECK;
  if (off && off !== "0") return false;
  const ci = env.CI;
  if (ci && ci !== "0" && ci.toLowerCase() !== "false") return false;
  if (env.NODE_TEST_CONTEXT) return false;
  return true;
}

export function readUpdateCache(file = updateCachePath()): UpdateCache {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as UpdateCache) : {};
  } catch {
    return {};
  }
}

/** The line to print, from the cache alone, or null. */
export function updateNotice(cache: UpdateCache, current = msVersion(), hint = upgradeHint()): string | null {
  const latest = typeof cache.latest === "string" ? parseVersion(cache.latest) : null;
  if (!latest || compareVersions(latest, current) <= 0) return null;
  return `ms ${latest} is available (you have ${current}) — ${hint}`;
}

/** Whether the cache is old enough to try again. */
export function refreshDue(cache: UpdateCache, now = Date.now()): boolean {
  const last = Math.max(Number(cache.attemptedAt) || 0, Number(cache.checkedAt) || 0);
  return now - last >= CHECK_EVERY_MS || last > now; // a clock that went backwards retries
}

/**
 * The child, as `node --input-type=module -e` source: argv is
 * `[url, cacheFile, userAgent]`. It writes the cache only on a release it
 * could read; any failure leaves the stamp the parent wrote, so the next try
 * is a day away. Plain JavaScript — the child loads nothing of `ms`, so it
 * runs the same from the source tree and from the bundle.
 */
export const CHILD_SOURCE = `
const [url, file, ua] = process.argv.slice(1);
const fs = await import("node:fs");
try {
  const r = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(${FETCH_TIMEOUT_MS}) });
  if (!r.ok) process.exit(0);
  const tag = String((await r.json()).tag_name ?? "");
  const m = tag.match(/^v?(\\d+\\.\\d+\\.\\d+)$/);
  if (!m) process.exit(0);
  const now = Date.now();
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ attemptedAt: now, checkedAt: now, latest: m[1] }) + "\\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
} catch {}
`;

/** Start the detached refresh. Returns whether a child was started. */
export function startRefresh(opts: { url?: string; file?: string; now?: number; version?: string } = {}): boolean {
  const file = opts.file ?? updateCachePath();
  if (!existsSync(path.dirname(file))) return false; // no store yet: nowhere to write the answer
  const prev = readUpdateCache(file);
  writeSmallJson(file, { ...prev, attemptedAt: opts.now ?? Date.now() });
  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", CHILD_SOURCE, opts.url ?? RELEASES_URL, file, `model-switcher/${opts.version ?? msVersion()}`],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The whole thing for one verb: the notice from the cache, and a refresh in
 *  the background when one is due. Never throws, never waits. */
export function updateCheck(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!updateCheckEnabled(env)) return null;
  try {
    const cache = readUpdateCache();
    if (refreshDue(cache)) startRefresh();
    return updateNotice(cache);
  } catch {
    return null;
  }
}
