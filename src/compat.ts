// src/compat.ts
//
// Which Claude Code and Codex versions this release of `ms` has been checked
// against — the ONE place that says so. `ms doctor` reports both CLIs against
// it, every user-facing verb prints one line when the CLI on PATH is newer,
// and the nightly canary (scripts/canary.mjs, .github/workflows/canary.yml)
// installs the newest of each from npm and compares them with it.
//
// Why a table at all: `ms` leans on things neither CLI promises to keep — the
// hook events and their JSON, Codex's hook TOML and trust hash, the rollout
// record that carries `usage_limit_exceeded`, Codex's per-home daemon state,
// the wall text `ms status` names a wall by. Other people run `ms` against
// versions nobody here has seen, and both CLIs update themselves. A newer
// version is NOT a failure (most releases change nothing `ms` touches); it is
// a version nobody has verified yet, and the human deserves to know that
// before they spend an afternoon on a rotation that silently stopped working.
//
// Updating it: bump `testedUpTo` in the same change that verifies a new
// version (the canary run, plus a real session through `ms`), and record the
// day in `VERIFIED_ON`. `incompatibleBelow` is for a version `ms` is KNOWN not
// to work with — evidence, never a guess; none is recorded today. The oldest
// versions this tool was built against are Codex 0.153.4 (the hook spike
// record, 2026-09-16) and the Claude Code of the same week, and nothing has
// shown either to be broken since.

import { readFileSync, renameSync, statSync, writeFileSync, existsSync, realpathSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { msHome } from "./paths.ts";

export type Cli = "codex" | "claude";
export type Compat = {
  /** The name a human knows it by, for every line this table prints. */
  name: string;
  /** The newest version `ms` is verified against. */
  testedUpTo: string;
  /** Versions below this are KNOWN not to work with `ms`; null when none is. */
  incompatibleBelow: string | null;
};

export const COMPAT: Readonly<Record<Cli, Compat>> = {
  codex: { name: "Codex", testedUpTo: "0.160.0", incompatibleBelow: null },
  claude: { name: "Claude Code", testedUpTo: "2.1.289", incompatibleBelow: null },
};
/** The day `COMPAT`'s `testedUpTo` versions were last verified. */
export const VERIFIED_ON = "2026-10-04";

/** Where a human reports a version that misbehaves. */
export const ISSUES_URL = "https://github.com/aadarwal/model-switcher/issues";

/** `ms`'s own version, from the `package.json` beside the source tree or the
 *  bundle (`<repo>/src/..` and `<libexec>/dist/..` both hold one; the formula
 *  installs it for exactly this). */
export function msVersion(): string {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(pkg, "utf8")).version;
}

// --- Versions ---------------------------------------------------------------

/**
 * The first `MAJOR.MINOR.PATCH` in a `--version` line: `codex-cli 0.160.0`,
 * `2.1.289 (Claude Code)`, `v0.3.10`. A pre-release suffix is ignored
 * (`0.162.0-alpha.13` reads as 0.162.0) — for "is this newer than what was
 * tested" the numbers are what matter, and an alpha of a newer minor is newer.
 */
export function parseVersion(text: string): string | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** Numeric MAJOR.MINOR.PATCH comparison: negative, zero or positive. A side
 *  that does not parse compares as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => (parseVersion(v) ?? "0.0.0").split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Where a version stands against the table: within what was verified, newer
 *  than it (unverified, not broken), or below a known-incompatible floor. */
export type Standing = "tested" | "newer" | "incompatible";

export function standing(cli: Cli, version: string, table: Readonly<Record<Cli, Compat>> = COMPAT): Standing {
  const c = table[cli];
  if (c.incompatibleBelow && compareVersions(version, c.incompatibleBelow) < 0) return "incompatible";
  return compareVersions(version, c.testedUpTo) > 0 ? "newer" : "tested";
}

// --- The probe, cached --------------------------------------------------------
//
// A launch must not spawn `claude --version` every time: it is a second CLI
// start before the real one. So the answer is cached in MS_HOME, keyed by the
// binary's REAL path plus its inode, size, mtime and ctime. Both CLIs install
// each version as a new file (Claude Code's `~/.local/share/claude/versions/
// <v>`, Codex's standalone `releases/<v>/bin/codex`), which changes the real
// path; an npm install rewrites the file in place, which changes the ctime
// even though npm pins every packed file's mtime to 1985 — mtime and size
// alone would read an npm-upgraded launcher as unchanged for ever.

const PROBE_TIMEOUT_MS = 5_000;
/** Plenty for a human with a few installs; old keys go first. */
const PROBE_CACHE_MAX = 16;

type ProbeEntry = { key: string; version: string | null; at: number };

export function probeCachePath(): string {
  return path.join(msHome(), "cli-versions.json");
}

function fileKey(real: string): string | null {
  try {
    const st = statSync(real);
    return `${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}:${Math.trunc(st.ctimeMs)}`;
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** A small JSON file in MS_HOME, written whole (tmp + rename) at 0600, and
 *  never the reason a verb fails: a store that is not there yet (before the
 *  first `ms setup`) or not writable just means nothing is cached. */
export function writeSmallJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) return;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
  }
}

/**
 * The version of the CLI at `bin` (an absolute path), from the cache when the
 * file is the one that answered last time, else from one bounded `--version`.
 * A binary that does not answer is cached as `null` too — a CLI that hangs on
 * `--version` should cost one timeout, not one per launch. Never throws.
 */
export function cliVersion(bin: string, cacheFile = probeCachePath()): string | null {
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    return null;
  }
  const key = fileKey(real);
  if (!key) return null;
  const raw = readJson(cacheFile);
  const cache: Record<string, ProbeEntry> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, ProbeEntry>) : {};
  const hit = cache[real];
  if (hit && hit.key === key) return hit.version;
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  const version = !r.error && r.status === 0 ? parseVersion(r.stdout ?? "") : null;
  cache[real] = { key, version, at: Date.now() };
  const kept = Object.entries(cache)
    .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))
    .slice(0, PROBE_CACHE_MAX);
  writeSmallJson(cacheFile, Object.fromEntries(kept));
  return version;
}

// --- The line a human sees --------------------------------------------------

/** How to get a newer `ms`: the formula's name when this is the Homebrew
 *  install (its shim sets MS_BIN to `…/opt/model-switcher/bin/ms`), the
 *  releases page otherwise. */
export function upgradeHint(env: NodeJS.ProcessEnv = process.env, here = fileURLToPath(import.meta.url)): string {
  const brew = /\/(?:opt|Cellar)\/model-switcher\//;
  if (brew.test(env.MS_BIN ?? "") || brew.test(here)) return "brew upgrade model-switcher";
  return "see https://github.com/aadarwal/model-switcher/releases";
}

export type Found = { cli: Cli; version: string };

/**
 * At most ONE line for the CLIs found newer than tested, and one for any
 * below a known-incompatible floor — or nothing. Pure, so the wording is
 * testable without a CLI on PATH.
 */
export function compatNotices(found: Found[], opts: { ms?: string; hint?: string; table?: Readonly<Record<Cli, Compat>> } = {}): string[] {
  const table = opts.table ?? COMPAT;
  const ms = opts.ms ?? msVersion();
  const hint = opts.hint ?? upgradeHint();
  const lines: string[] = [];
  const bad = found.filter((f) => standing(f.cli, f.version, table) === "incompatible");
  if (bad.length) {
    const what = bad.map((f) => `${table[f.cli].name} below ${table[f.cli].incompatibleBelow} (you have ${f.version})`).join(" or ");
    lines.push(`ms ${ms} does not work with ${what} — upgrade it, or ${hint}`);
  }
  const newer = found.filter((f) => standing(f.cli, f.version, table) === "newer");
  if (newer.length) {
    const tested = newer.map((f) => `${table[f.cli].name} ${table[f.cli].testedUpTo}`).join(" and ");
    // One CLI reads "you have 0.162.0"; two name which is which.
    const have = newer.length === 1 ? newer[0]!.version : newer.map((f) => `${table[f.cli].name} ${f.version}`).join(" and ");
    lines.push(`ms ${ms} is tested up to ${tested}; you have ${have} — if anything misbehaves: ${hint}, or report it with \`ms doctor\` output at ${ISSUES_URL}`);
  }
  return lines;
}
