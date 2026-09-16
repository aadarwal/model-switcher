// src/doctor.ts
//
// `ms doctor [--fix]`: a fixed checklist over the things that make `ms`
// actually work end to end — the runtime, tmux, claude, the Claude hooks,
// store permissions, the registry itself, every Claude account's two
// credentials, orphaned session state, and the `ms` binary on PATH.
// Read-only by default; `--fix` repairs what it safely can (hooks, store
// permissions, a due poll-grant refresh, orphaned state via Task 18's
// `reconcile()`) and reports the rest. A malformed registry, a dead
// account credential, and a stray `ms` shadowing this one are never
// auto-fixed — there is nothing safe to do about any of them except tell
// the human.
//
// Each check prints exactly one line: `✓ <what>` (plus ` → fixed` when this
// run just repaired it) or `✗ <what> — <why>`. Exit 1 iff any check is still
// a ✗ once fixes (if requested) have been applied.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { msBinary, msHome, p } from "./paths.ts";
import { claudeHooksInstalled, installClaudeHooks } from "./hooks/install.ts";
import { loadRegistry, type Account } from "./registry.ts";
import { AuthError, TransientError, readPollCredentials, refreshPollCredentials } from "./providers/claude-usage.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { openState, type SessionRow } from "./state.ts";
import { Tmux } from "./tmux.ts";
import { resolveOnPath } from "./exec.ts";
import { reconcile } from "./reconcile.ts";

export type Result = { ok: boolean; what: string; why?: string; fixed?: boolean };

const MIN_TMUX = [3, 3] as const;
const MIN_NODE = [22, 15, 0] as const;
/** A poll grant due to expire within this window is worth refreshing now;
 *  one further out is left alone — `ms doctor` should not spend an account's
 *  refresh token just to look at it. */
const REFRESH_DUE_MS = 60_000;
const REFRESH_TIMEOUT_MS = 10_000;

export function renderLine(r: Result): string {
  if (r.ok) return r.fixed ? `✓ ${r.what} → fixed` : `✓ ${r.what}`;
  return `✗ ${r.what} — ${r.why ?? "failed"}`;
}

function runBounded(cmd: string, args: string[], timeoutMs: number): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  if (r.error || r.status !== 0) {
    return { ok: false, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() || r.error?.message || `exit ${r.status ?? "timeout"}` };
  }
  return { ok: true, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// --- Runtime -------------------------------------------------------------

/** `"22.15.0" >= [22, 15, 0]` — a plain MAJOR.MINOR.PATCH comparison (no
 *  pre-release handling; Node's own `process.versions.node` never carries
 *  one). Exported so the comparison itself is testable without needing an
 *  actual old Node runtime to prove the ✗ branch. */
export function nodeVersionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i]! > min[i]!) return true;
    if (parts[i]! < min[i]!) return false;
  }
  return true; // exactly equal
}

export function checkNode(): Result {
  const what = "Node ≥ 22.15 with process.execve";
  const versionOk = nodeVersionAtLeast(process.versions.node, MIN_NODE);
  const execveOk = typeof process.execve === "function";
  if (versionOk && execveOk) return { ok: true, what };
  const missing = execveOk ? "" : ", no process.execve";
  return { ok: false, what, why: `running ${process.version}${missing}` };
}

export function checkTmux(): Result {
  const what = "tmux ≥ 3.3";
  const r = runBounded("tmux", ["-V"], 5_000);
  if (!r.ok) return { ok: false, what, why: r.stderr };
  const m = r.stdout.match(/(\d+)\.(\d+)/);
  if (!m) return { ok: false, what, why: `could not parse a version from "${r.stdout.trim()}"` };
  const found: [number, number] = [Number(m[1]), Number(m[2])];
  const ok = found[0] > MIN_TMUX[0] || (found[0] === MIN_TMUX[0] && found[1] >= MIN_TMUX[1]);
  return ok ? { ok: true, what: `${what} (found ${r.stdout.trim()})` } : { ok: false, what, why: `found ${r.stdout.trim()}` };
}

export function checkClaudeBinary(): Result {
  const what = "claude --version";
  const r = runBounded("claude", ["--version"], 10_000);
  return r.ok ? { ok: true, what: `${what} (${r.stdout.trim() || "ok"})` } : { ok: false, what, why: r.stderr };
}

// --- Claude hooks ----------------------------------------------------------

function claudeSettingsPath(): string {
  return path.join(process.env.HOME || homedir(), ".claude", "settings.json");
}

export function checkHooks(fix: boolean): Result {
  const what = "Claude hooks installed";
  const settingsPath = claudeSettingsPath();
  const msBin = msBinary();
  if (claudeHooksInstalled(settingsPath, msBin)) return { ok: true, what };
  if (!fix) return { ok: false, what, why: `not all four present in ${settingsPath} for ${msBin}` };
  try {
    installClaudeHooks(settingsPath, msBin);
  } catch (e) {
    return { ok: false, what, why: `not installed in ${settingsPath} — --fix failed: ${(e as Error).message}` };
  }
  return claudeHooksInstalled(settingsPath, msBin)
    ? { ok: true, what, fixed: true }
    : { ok: false, what, why: `still not installed in ${settingsPath} after --fix` };
}

// --- Store permissions -----------------------------------------------------
//
// The walk covers ONLY paths `ms` itself owns and writes — never Claude
// Code's or codex's own config directories. Reviewed and scoped after a
// blanket recursive walk over all of MS_HOME was found to report (and,
// under --fix, chmod) ~15k files inside a live CLAUDE_CONFIG_DIR, including
// plugin executables, breaking Claude Code for that account. The only
// exception carved out of `claude/<name>/` is `.credentials.json` itself,
// which `ms` reads and rewrites (src/providers/claude-usage.ts).

type PermIssue = { path: string; wantMode: number; foundMode: number; symlink?: boolean };

function octal(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}

/** Records an issue for `entryPath` if it is a symlink (never followed,
 *  never fixed), or if it exists with the wrong mode. A missing path is not
 *  an issue — the next command to need it creates it correctly. Returns the
 *  freshly-`lstat`ed entry so callers that care about type (dir vs file)
 *  don't stat twice, or `null` when absent/symlinked/unreadable. */
function checkEntry(entryPath: string, wantMode: number, issues: PermIssue[]): Stats | null {
  let st: Stats;
  try {
    st = lstatSync(entryPath);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    issues.push({ path: entryPath, wantMode: -1, foundMode: -1, symlink: true });
    return null;
  }
  const found = st.mode & 0o777;
  if (found !== wantMode) issues.push({ path: entryPath, wantMode, foundMode: found });
  return st;
}

/** Recursively walks an ms-owned directory (dirs 0700, files 0600). When
 *  `fix` is set, a bad directory mode is repaired immediately — before this
 *  same call tries to `readdirSync` it — so a subtree a bad permission was
 *  blocking gets walked (and its own issues found and fixed) in this same
 *  run; bounded to that one immediate repair per directory, never a retry
 *  loop. */
function walkOwnedDir(dir: string, fix: boolean, issues: PermIssue[]): void {
  const st = checkEntry(dir, 0o700, issues);
  if (!st) return; // absent, or a symlink — either way, nothing to recurse into
  if (!st.isDirectory()) return;
  if ((st.mode & 0o777) !== 0o700 && fix) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already recorded as an issue; the fix pass below reports the failure */
    }
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // still unreadable even after the repair attempt above — bounded, stop
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let est;
    try {
      est = lstatSync(full);
    } catch {
      continue;
    }
    if (est.isSymbolicLink()) {
      issues.push({ path: full, wantMode: -1, foundMode: -1, symlink: true });
      continue;
    }
    if (est.isDirectory()) {
      walkOwnedDir(full, fix, issues);
    } else if (est.isFile()) {
      const found = est.mode & 0o777;
      if (found !== 0o600) issues.push({ path: full, wantMode: 0o600, foundMode: found });
    }
  }
}

/** `claude/`: the directory itself (0700), each `claude/<name>` account
 *  directory (0700), and ONLY `claude/<name>/.credentials.json` (0600)
 *  inside it — never anything else under an account directory. That
 *  directory is Claude Code's own CLAUDE_CONFIG_DIR; `ms` does not own its
 *  contents and must not report on, let alone chmod, the rest of them. */
function checkClaudeTree(home: string, fix: boolean, issues: PermIssue[]): void {
  const claudeDir = path.join(home, "claude");
  const st = checkEntry(claudeDir, 0o700, issues);
  if (!st || !st.isDirectory()) return;
  if ((st.mode & 0o777) !== 0o700 && fix) {
    try {
      chmodSync(claudeDir, 0o700);
    } catch {
      /* recorded already */
    }
  }
  let entries;
  try {
    entries = readdirSync(claudeDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const accountDir = path.join(claudeDir, e.name);
    const ast = checkEntry(accountDir, 0o700, issues);
    if (!ast || !ast.isDirectory()) continue;
    checkEntry(path.join(accountDir, ".credentials.json"), 0o600, issues);
  }
}

export function checkStorePermissions(fix: boolean): Result[] {
  const home = msHome();
  const issues: PermIssue[] = [];

  checkEntry(home, 0o700, issues);
  checkEntry(p.registry, 0o600, issues);
  checkEntry(p.state, 0o600, issues);
  checkEntry(`${p.state}-wal`, 0o600, issues);
  checkEntry(`${p.state}-shm`, 0o600, issues);
  checkEntry(path.join(home, "locks.sqlite"), 0o600, issues);
  checkEntry(p.snapshot, 0o600, issues);
  checkEntry(p.lastPick, 0o600, issues);

  // "locks" is deliberately absent here: locking moved to one file,
  // locks.sqlite (checked above), and the locks/ directory no longer exists.
  for (const sub of ["launch", "sessions", "hooks"]) walkOwnedDir(path.join(home, sub), fix, issues);
  checkClaudeTree(home, fix, issues);

  if (issues.length === 0) return [{ ok: true, what: "store permissions (0700 dirs, 0600 files) under MS_HOME" }];

  return issues.map((iss): Result => {
    const rel = path.relative(home, iss.path) || ".";
    const what = `store permission: ${rel}`;
    if (iss.symlink) return { ok: false, what, why: "symlink in store (never followed, never fixed)" };
    const why = `is 0${octal(iss.foundMode)}, want 0${octal(iss.wantMode)}`;
    if (!fix) return { ok: false, what, why };
    try {
      chmodSync(iss.path, iss.wantMode);
      return { ok: true, what, fixed: true };
    } catch (e) {
      return { ok: false, what, why: `${why} — --fix failed: ${(e as Error).message}` };
    }
  });
}

// --- The registry itself ---------------------------------------------------

/** A malformed `accounts.json`, or rows `validateRegistry` skipped, are
 *  never fixed here (there is no safe rewrite doctor could apply — see
 *  `npm run accounts:doctor` for that) but must count toward exit 1: a
 *  registry that can't be read silently drops every account check, which
 *  used to report a clean, empty, green run. */
function checkRegistry(parseError: string | null, problems: string[]): Result[] {
  const out: Result[] = [];
  if (parseError) {
    out.push({ ok: false, what: "accounts.json", why: parseError });
  } else if (problems.length === 0) {
    out.push({ ok: true, what: "accounts.json" });
  }
  problems.forEach((problem, i) => out.push({ ok: false, what: `accounts.json entry ${i}`, why: problem }));
  return out;
}

// --- Claude accounts ---------------------------------------------------

export async function checkClaudeAccount(a: Account, fix: boolean): Promise<Result[]> {
  const tag = `claude account ${a.name}`;
  const out: Result[] = [];

  const cred = readPollCredentials(a.name);
  if (!cred) {
    out.push({ ok: false, what: `${tag}: poll grant readable`, why: `no credentials file or keychain entry (ms accounts login ${a.name})` });
  } else {
    out.push({ ok: true, what: `${tag}: poll grant readable` });
    const due = cred.expiresAt - Date.now() <= REFRESH_DUE_MS;
    if (!due) {
      out.push({ ok: true, what: `${tag}: poll grant refresh not due` });
    } else if (!fix) {
      // Never refresh (and so never rotate a live credential) without
      // --fix: a plain `ms doctor` must be read-only.
      out.push({ ok: false, what: `${tag}: poll grant`, why: "refresh due (run ms doctor --fix)" });
    } else {
      try {
        await refreshPollCredentials(a.name, cred, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
        out.push({ ok: true, what: `${tag}: poll grant`, fixed: true });
      } catch (e) {
        const kind = e instanceof AuthError ? "auth" : e instanceof TransientError ? "transient" : "error";
        // e.message is drawn from claude-usage.ts's own error contract, which
        // never includes a token or credential value — see its tests.
        const msg = e instanceof Error ? e.message : String(e);
        out.push({ ok: false, what: `${tag}: poll grant`, why: `refresh failed: ${kind}: ${msg}` });
      }
    }
  }

  // A file that is there but unreadable is a different repair from a file that
  // is absent: `chmod 600` on the one, a fresh login for the other. Both read
  // as null through `readLaunchToken`, which is why the existence check is
  // asked separately rather than inferred from it.
  out.push(
    readLaunchToken(a.name)
      ? { ok: true, what: `${tag}: launch token present` }
      : {
          ok: false,
          what: `${tag}: launch token present`,
          why: existsSync(p.launchToken(a.name))
            ? `unreadable (chmod 600 ${p.launchToken(a.name)})`
            : `no launch token (ms accounts login ${a.name})`,
        },
  );

  out.push(
    a.identityVerified
      ? { ok: true, what: `${tag}: identity verified` }
      : { ok: false, what: `${tag}: identity verified`, why: "identityVerified is false in the registry" },
  );

  return out;
}

// --- Orphaned session state -------------------------------------------

/** The live pane ids on one tmux socket, memoized for the run: with many
 *  sessions sharing a socket, `checkOrphaned` used to spawn one
 *  `tmux list-panes -a` per session. */
function livePanes(socket: string, cache: Map<string, Set<string>>): Set<string> {
  const key = socket;
  const cached = cache.get(key);
  if (cached) return cached;
  const panes = new Set(
    new Tmux(socket || null).run(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.split("\n").filter(Boolean),
  );
  cache.set(key, panes);
  return panes;
}

function findOrphaned(sessions: SessionRow[], cache: Map<string, Set<string>>): SessionRow[] {
  return sessions.filter((s) => s.state !== "stopped" && !livePanes(s.socket, cache).has(s.pane));
}

export async function checkOrphaned(fix: boolean): Promise<Result[]> {
  const st = openState();
  let sessions: SessionRow[];
  try {
    sessions = st.listSessions();
  } finally {
    st.close();
  }
  let orphaned = findOrphaned(sessions, new Map());
  if (orphaned.length === 0) return [{ ok: true, what: "orphaned session state" }];

  if (fix) {
    // Reconciliation is the repair; a throw inside it must still leave the
    // orphans reported (unfixed) rather than crash `ms doctor --fix`.
    try {
      reconcile();
      const st2 = openState();
      try {
        sessions = st2.listSessions();
      } finally {
        st2.close();
      }
      orphaned = findOrphaned(sessions, new Map());
      if (orphaned.length === 0) return [{ ok: true, what: "orphaned session state", fixed: true }];
    } catch {
      // reconcile threw — fall through and report whatever is still
      // orphaned, unfixed.
    }
  }

  return orphaned.map((s) => ({ ok: false, what: `orphaned session ${s.id}`, why: `pane ${s.pane} is gone on ${s.socket || "(no socket)"}` }));
}

// --- ms on PATH ----------------------------------------------------------

export function checkPathBinary(): Result {
  const what = "ms on PATH is msBinary()";
  const onPath = resolveOnPath("ms");
  const wanted = msBinary();
  if (!onPath) return { ok: false, what, why: `ms not found on PATH; msBinary() is ${wanted}` };
  let realOnPath: string;
  let realWanted: string;
  try {
    realOnPath = realpathSync(onPath);
  } catch (e) {
    return { ok: false, what, why: `could not resolve ${onPath}: ${(e as Error).message}` };
  }
  try {
    realWanted = realpathSync(wanted);
  } catch (e) {
    return { ok: false, what, why: `could not resolve ${wanted}: ${(e as Error).message}` };
  }
  if (realOnPath === realWanted) return { ok: true, what };
  // Never "fixed": there is no safe automatic repair for a PATH that shadows
  // this binary with another one — just show both paths.
  return { ok: false, what, why: `PATH gives ${onPath} (${realOnPath}); msBinary() is ${wanted} (${realWanted})` };
}

// --- Putting it together -------------------------------------------------

export async function runDoctor(fix: boolean): Promise<{ results: Result[]; lines: string[]; exitCode: number }> {
  const results: Result[] = [];
  results.push(checkNode());
  results.push(checkTmux());
  results.push(checkClaudeBinary());
  results.push(checkHooks(fix));
  results.push(...checkStorePermissions(fix));

  const { registry, parseError, problems } = loadRegistry();
  results.push(...checkRegistry(parseError, problems));
  for (const a of registry.accounts.filter((a) => a.provider === "claude")) {
    results.push(...(await checkClaudeAccount(a, fix)));
  }

  results.push(...(await checkOrphaned(fix)));
  results.push(checkPathBinary());

  const lines = results.map(renderLine);
  const exitCode = results.some((r) => !r.ok) ? 1 : 0;
  return { results, lines, exitCode };
}

export const doctor: Verb = async (args) => {
  const fix = args.includes("--fix");
  const { lines, exitCode } = await runDoctor(fix);
  for (const l of lines) process.stdout.write(l + "\n");
  return exitCode;
};
