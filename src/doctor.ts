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
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Verb } from "./cli.ts";
import { claudeSettingsPath, msBinary, msHome, p } from "./paths.ts";
import { claudeHooksInstalled, installClaudeHooks } from "./hooks/install.ts";
import { codexConfigPath, codexHooksInstalled, installCodexHooks } from "./hooks/codex-install.ts";
import { loadRegistry, organisationClaimedBy, sameOrganisationAs, type Account } from "./registry.ts";
import {
  AuthError,
  fetchProfile,
  type PollCredentials,
  TransientError,
  readPollGrant,
  refreshPollCredentials,
} from "./providers/claude-usage.ts";
import { fetchCodexUsage, readCodexCredentials } from "./providers/codex-usage.ts";
import { readLaunchToken } from "./launch-credentials.ts";
import { codexAutorotateEnabled, codexAutorotateLine } from "./autorotate.ts";
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
/** The MAJOR.MINOR family the spike record (2026-09-16) proved live. A
 *  different minor is never a failure — Codex's own compatibility is not
 *  this tool's to judge — just a line worth a human's eye. */
const CODEX_TESTED_MINOR = "0.153";
/** Bounded, and never a refresh: `ms doctor` proves a Codex credential with
 *  the access token already on disk, exactly as it never refreshes a Claude
 *  poll grant outside `--fix` (see `checkClaudeAccount` below). */
const CODEX_USAGE_TIMEOUT_MS = 10_000;
/** The profile read behind the identity line, on the same terms as the Codex
 *  usage probe beside it: bounded, and never a refresh. */
const IDENTITY_TIMEOUT_MS = 10_000;

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

/** The Claude CLI's version — gated on there being a Claude account at all,
 *  exactly as `checkCodexBinary` is gated on a Codex one. A ChatGPT-only
 *  human has no reason to have Claude Code installed; failing their doctor
 *  for ever over a binary this tool would never run for them is not a fault
 *  report, it is noise that also makes `ms setup` unable to finish. */
export function checkClaudeBinary(hasClaudeAccounts = true): Result {
  const what = "claude --version";
  if (!hasClaudeAccounts) return { ok: true, what: `${what} — not needed (no claude accounts)` };
  const r = runBounded("claude", ["--version"], 10_000);
  return r.ok ? { ok: true, what: `${what} (${r.stdout.trim() || "ok"})` } : { ok: false, what, why: r.stderr };
}

/** Report the Codex CLI's own version; never fail on it. A different minor
 *  than the tested `0.153.x` family is worth a note in the ✓ line — this
 *  tool's Codex support (hook TOML shape, wall text, rollout record fields)
 *  was verified against that range, not proven broken on another one, so a
 *  ✗ here would be a guess this tool has no business making.
 *
 *  `hasCodexAccounts` gates whether this even SPAWNS `codex`. A Claude-only
 *  machine has no reason to have the Codex CLI installed at all — the tool
 *  runs no Codex account without one, so a missing binary there is not a
 *  fault to report, let alone one that fails `ms doctor` forever. Only a
 *  registry that actually names a Codex account makes this check real. */
export function checkCodexBinary(hasCodexAccounts: boolean): Result {
  const what = "codex --version";
  if (!hasCodexAccounts) return { ok: true, what: `${what} — not needed (no codex accounts)` };
  const r = runBounded("codex", ["--version"], 10_000);
  if (!r.ok) return { ok: false, what, why: r.stderr };
  const out = r.stdout.trim() || "ok";
  const m = out.match(/(\d+)\.(\d+)\.\d+/);
  const minor = m ? `${m[1]}.${m[2]}` : null;
  if (minor && minor !== CODEX_TESTED_MINOR) {
    return { ok: true, what: `${what} (${out}) — tested range is ${CODEX_TESTED_MINOR}.x, this is a different minor` };
  }
  return { ok: true, what: `${what} (${out})` };
}

// --- Claude hooks ----------------------------------------------------------

/** Claude Code's settings file — where its hooks and its statusline live.
 *  Re-exported (it lives in ./paths.ts, beside every other path this tool
 *  knows) because `ms setup` installs into the very file this checks, and two
 *  spellings of one path is how an installer and its check drift apart. It
 *  honours `CLAUDE_CONFIG_DIR` exactly as `ms _statusline` does. */
export { claudeSettingsPath };

export function checkHooks(fix: boolean, hasClaudeAccounts = true): Result {
  const what = "Claude hooks installed";
  if (!hasClaudeAccounts) return { ok: true, what: `${what} — not needed (no claude accounts)` };
  const settingsPath = claudeSettingsPath();
  const msBin = msBinary();
  if (claudeHooksInstalled(settingsPath, msBin)) return { ok: true, what };
  // "for `msBin`" covers both halves of what installed now means: the four
  // entries present, AND no OTHER `_hook claude` entry left behind by an `ms`
  // that moved. `--fix` repairs either, by re-running the installer, which
  // replaces every ms-owned entry rather than adding beside it.
  if (!fix) return { ok: false, what, why: `not all four present (or a stale ms entry remains) in ${settingsPath} for ${msBin}` };
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

/** The name `fsx.ts`'s `backupThroughLink(file, "bak-ms-")` gives a
 *  `config.toml` backup: the target's own name, the family suffix, and a
 *  millisecond timestamp (plus a `-<n>` counter on a same-millisecond
 *  collision). Matched by this PREFIX only — never a full listing of the
 *  account home, and never a suffix/extension guess — so a human's own
 *  `config.toml.orig` or similar is never swept in by accident. */
const CODEX_CONFIG_BACKUP_PREFIX = "config.toml.bak-ms-";

/** `codex/`: the directory itself (0700), the shared rollout store
 *  `codex/sessions` (0700 — its CONTENTS are never walked or chmod'ed;
 *  Codex owns them, exactly as `claude/<name>/` is not walked above), and
 *  each `codex/<name>` account home (0700). Inside an account home, two
 *  entries are checked BY NAME — `auth.json` and `config.toml`, both 0600 —
 *  plus, by PREFIX (`CODEX_CONFIG_BACKUP_PREFIX`, fix-A-report.md A-M4's
 *  "not done" half; fix-R), every `config.toml.bak-ms-*` backup this tool
 *  itself wrote there (`installCodexHooks`'s `composeCodexHooks`, via
 *  `backupThroughLink`) — new ones are already 0600 at creation, but one
 *  written before that landed, or touched by something else afterward, is
 *  fixed by nothing else. Nothing else under an account home is ever
 *  examined: unlike `codex/sessions`' parent or an ms-owned dir
 *  (`walkOwnedDir`), this is not a full `readdirSync`'d WALK — a third file
 *  placed inside one (by a human, or by Codex itself) that does not match a
 *  known name or this one prefix is neither reported nor touched.
 *
 *  A home's own `sessions` entry is ALWAYS a symlink — `ensureCodexHome`
 *  (src/accounts-codex.ts) puts it there on purpose, pointing at the shared
 *  store above — and is one of the things this function deliberately never
 *  names: every OTHER symlink found under an ms-owned, walked directory is
 *  a stray to report, this one is the expected shape and must never be. */
function checkCodexTree(home: string, fix: boolean, issues: PermIssue[]): void {
  const codexDir = path.join(home, "codex");
  const st = checkEntry(codexDir, 0o700, issues);
  if (!st || !st.isDirectory()) return;
  if ((st.mode & 0o777) !== 0o700 && fix) {
    try {
      chmodSync(codexDir, 0o700);
    } catch {
      /* recorded already */
    }
  }

  checkEntry(path.join(codexDir, "sessions"), 0o700, issues);

  let entries;
  try {
    entries = readdirSync(codexDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "sessions") continue; // the shared store, checked above
    const accountDir = path.join(codexDir, e.name);
    const ast = checkEntry(accountDir, 0o700, issues);
    if (!ast || !ast.isDirectory()) continue;
    checkEntry(path.join(accountDir, "auth.json"), 0o600, issues);
    checkEntry(path.join(accountDir, "config.toml"), 0o600, issues);
    // accountDir/sessions is the per-home symlink — intentionally never
    // checked; see the doc comment above. The one thing this DOES still read
    // the account home's own listing for: our own config.toml backups, named
    // by prefix only, so a stray file with any other name is still untouched.
    let acctEntries: string[];
    try {
      acctEntries = readdirSync(accountDir);
    } catch {
      continue;
    }
    for (const name of acctEntries) {
      if (name.startsWith(CODEX_CONFIG_BACKUP_PREFIX)) checkEntry(path.join(accountDir, name), 0o600, issues);
    }
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
  checkCodexTree(home, fix, issues);

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

/**
 * The identity line — and the organisation check `ms accounts verify` runs.
 *
 * Live on 2026-09-16: a refused `ms accounts login dirk` left the WRONG
 * organisation's grant in dirk's keychain item. `ms accounts verify dirk`
 * failed with "resolves to the same organisation as kratuvak", while this line
 * read the registry's `identityVerified: true` — a verdict earned by an
 * earlier, different credential — and printed ✓. A book and a doctor must
 * never disagree about one credential, so the question is asked of the GRANT,
 * through the same `organisationClaimedBy` the refusal uses and in the same
 * words (`sameOrganisationAs`).
 *
 * The read is only made when it could change the answer. An organisation
 * collides only with ANOTHER registered account's, so a book with no other
 * claimed organisation costs no network call at all — exactly what `verify`
 * would conclude, for free. A grant whose access token is due is not refreshed
 * (`ms doctor` without `--fix` is read-only, and the line above already says
 * it is due), and a read that fails says nothing: "could not tell" is not a
 * collision. There is no `--fix` branch here, and there should not be: an
 * identity is repaired by a human at a browser tab.
 */
async function checkClaudeIdentity(a: Account, book: Account[], cred: PollCredentials | null): Promise<Result> {
  const tag = `claude account ${a.name}`;
  const rivals = book.filter((x) => x.provider === "claude" && x.name !== a.name && x.orgId);
  let checked = false;
  if (cred && rivals.length > 0 && cred.expiresAt - Date.now() > REFRESH_DUE_MS) {
    try {
      const profile = await fetchProfile(cred, AbortSignal.timeout(IDENTITY_TIMEOUT_MS));
      checked = true;
      const other = profile.orgId ? organisationClaimedBy(rivals, a.name, profile.orgId) : null;
      if (other) {
        return {
          ok: false,
          what: `${tag}: identity`,
          why: `${sameOrganisationAs(other)}; run ms accounts login ${a.name} --relogin`,
        };
      }
    } catch {
      /* could not tell — never a collision, and never a ✓ this run did not earn */
    }
  }
  // A line says what was actually CHECKED. When the grant was read, "identity
  // verified" is this run's own finding. When it was not — nothing to collide
  // with, an access token inside the refresh window, a read that failed — the
  // only thing true is the verdict `login`/`verify` recorded, and the line
  // must not borrow the authority of a check that never ran. That overclaim is
  // how the live dirk case read ✓ beside a `verify` that was failing.
  const what = `${tag}: identity ${checked ? "verified" : "verified at login (not re-checked)"}`;
  return a.identityVerified
    ? { ok: true, what }
    : { ok: false, what, why: "identityVerified is false in the registry" };
}

export async function checkClaudeAccount(a: Account, fix: boolean, book: Account[] = []): Promise<Result[]> {
  const tag = `claude account ${a.name}`;
  const out: Result[] = [];

  // Three answers, not two. A grant that is THERE and holds nothing parseable
  // is a different report from one that was never minted — and ms 0.2.0 made
  // the first one common, by writing every refreshed grant back through
  // `security`'s 128-byte prompt (src/providers/claude-usage.ts). There is no
  // refresh to attempt on it either: whatever is in it is not a refresh token,
  // so --fix would spend a call to be told `invalid_grant`.
  const grant = readPollGrant(a.name);
  if (grant.state === "unreadable") {
    out.push({
      ok: false,
      what: `${tag}: poll grant`,
      why:
        grant.where === "keychain"
          ? `unreadable (a truncated keychain write from ms 0.2.0); run ms accounts login ${a.name}`
          : `unreadable (${path.join(p.claudeConfigDir(a.name), ".credentials.json")} is not the credentials JSON); run ms accounts login ${a.name}`,
    });
  } else if (grant.state === "absent") {
    out.push({ ok: false, what: `${tag}: poll grant readable`, why: `no credentials file or keychain entry (ms accounts login ${a.name})` });
  } else {
    const cred = grant.cred;
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

  out.push(await checkClaudeIdentity(a, book, grant.state === "ok" ? grant.cred : null));

  return out;
}

// --- Codex accounts ------------------------------------------------------
//
// Codex carries one credential, not two (src/accounts-codex.ts): `auth.json`
// in the account's own CODEX_HOME both runs `codex` as the account and reads
// its usage, so there is no launch-token/poll-grant split to check here —
// just whether that one file is readable, whether it still answers the
// usage endpoint, whether the account's hooks are installed and trusted,
// and whether its home's `sessions` entry still points at the shared
// rollout store. `--fix` never refreshes the credential (there is no
// refresh call here at all, unlike the Claude side) and never touches an
// existing `sessions` entry — only a missing one is ever created.

function checkCodexHooksLine(a: Account, home: string, fix: boolean): Result {
  const what = `codex account ${a.name}: hooks installed`;
  const msBin = msBinary();
  if (codexHooksInstalled(home, msBin)) return { ok: true, what };
  if (!fix) return { ok: false, what, why: `not installed in ${codexConfigPath(home)}` };
  const res = installCodexHooks(home, msBin);
  // A refusal (a home this installer cannot safely rewrite) is never
  // "nothing to do" — it is reported verbatim, the same way `res.problem`
  // itself is worded: a reason a human can act on, not a guess papered over.
  if (res.problem) return { ok: false, what, why: res.problem };
  return codexHooksInstalled(home, msBin)
    ? { ok: true, what, fixed: true }
    : { ok: false, what, why: `still not installed in ${codexConfigPath(home)} after --fix` };
}

/** Whether `link` is a symlink that resolves to the same place as `target`. */
function symlinksTo(link: string, target: string): boolean {
  let st: Stats;
  try {
    st = lstatSync(link);
  } catch {
    return false;
  }
  if (!st.isSymbolicLink()) return false;
  try {
    return realpathSync(link) === realpathSync(target);
  } catch {
    return false; // dangling — points somewhere that no longer exists
  }
}

function checkCodexSessionsLink(a: Account, fix: boolean): Result {
  const what = `codex account ${a.name}: sessions store linked`;
  const link = p.codexSessionsLink(a.name);
  const target = p.codexSessions();

  if (symlinksTo(link, target)) return { ok: true, what };

  let st: Stats | null = null;
  try {
    st = lstatSync(link);
  } catch {
    /* missing entirely — the ordinary "recreate the link" case, below */
  }

  if (st?.isSymbolicLink()) {
    // A symlink sits here, but `symlinksTo` above still said no. Two very
    // different situations share that one fact, and only one of them is
    // ours to repair: the link's own TEXT names the shared store by path
    // and that store directory is simply the thing that's missing right
    // now (fixable — recreate the STORE, never the link, which is already
    // correct), or the link genuinely points somewhere else entirely (not
    // ours to touch, `--fix` or not — it might be deliberate).
    let rawTarget: string | null = null;
    try {
      rawTarget = readlinkSync(link);
    } catch {
      /* a readlink failing right after a successful lstat would be bizarre;
         fall through to "points elsewhere" below either way */
    }
    if (rawTarget !== null && path.resolve(rawTarget) === path.resolve(target)) {
      if (!fix) return { ok: false, what, why: `shared store missing — ${link} points at ${target}, which does not exist` };
      try {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        chmodSync(target, 0o700); // mkdir's mode is masked by umask; this is not
      } catch (e) {
        return { ok: false, what, why: `shared store missing — --fix failed: ${(e as Error).message}` };
      }
      return symlinksTo(link, target)
        ? { ok: true, what, fixed: true }
        : { ok: false, what, why: "shared store missing — still missing after --fix" };
    }
    return {
      ok: false,
      what,
      why: `${link} is a symlink but points elsewhere (${rawTarget ?? "unreadable"}), not at ${target} — never touched automatically`,
    };
  }

  if (st) {
    // A real directory (moved or created before the link existed,
    // ensureCodexHome's own doc comment on this exact case) or a plain
    // file. Neither is ours to replace: doing so could throw away real
    // sessions.
    const shape = st.isDirectory() ? "a real directory" : "a file";
    return { ok: false, what, why: `${link} exists and is ${shape}, not a symlink to ${target} — never touched automatically` };
  }

  if (!fix) return { ok: false, what, why: `${link} is missing (want a symlink to ${target})` };
  try {
    symlinkSync(target, link, "dir");
  } catch (e) {
    return { ok: false, what, why: `missing — --fix failed: ${(e as Error).message}` };
  }
  return symlinksTo(link, target) ? { ok: true, what, fixed: true } : { ok: false, what, why: "still not linked after --fix" };
}

export async function checkCodexAccount(a: Account, fix: boolean): Promise<Result[]> {
  const tag = `codex account ${a.name}`;
  const out: Result[] = [];
  const home = p.codexHome(a.name);

  const cred = readCodexCredentials(home);
  out.push(
    cred
      ? { ok: true, what: `${tag}: credentials readable` }
      : {
          ok: false,
          what: `${tag}: credentials readable`,
          why: `no readable auth.json in ${home} (ms accounts login ${a.name} --provider codex)`,
        },
  );

  if (!cred) {
    out.push({ ok: false, what: `${tag}: usage fetch ok`, why: "no credentials to fetch with" });
  } else {
    try {
      // Bounded, and never a refresh — the stored access token is used as
      // is, exactly as `ms doctor` (without --fix) never refreshes a Claude
      // poll grant either; a stale token simply reads as `auth` below.
      await fetchCodexUsage(cred, AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS));
      out.push({ ok: true, what: `${tag}: usage fetch ok` });
    } catch (e) {
      const kind = e instanceof AuthError ? "auth" : e instanceof TransientError ? "transient" : "error";
      const msg = e instanceof Error ? e.message : String(e);
      const why = kind === "auth" ? `auth: ${msg} (ms accounts login ${a.name} --provider codex)` : `${kind}: ${msg}`;
      out.push({ ok: false, what: `${tag}: usage fetch ok`, why });
    }
  }

  out.push(checkCodexHooksLine(a, home, fix));
  out.push(checkCodexSessionsLink(a, fix));

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

  // The registry is read here, ahead of its own ✓/✗ line below, so (a) a
  // Codex row still gets its checks even when this same registry later turns
  // out to have an unrelated bad entry (checkRegistry reports that
  // separately, by index), and (b) both CLI checks — and the Claude hook
  // check, which writes into Claude Code's own settings file — know whether
  // there is any account of that provider to ask the question for at all.
  const { registry, parseError, problems } = loadRegistry();
  const codexAccounts = registry.accounts.filter((a) => a.provider === "codex");
  const claudeAccounts = registry.accounts.filter((a) => a.provider === "claude");
  // A parse error empties `registry.accounts` the same way a truly empty
  // registry would (loadRegistry's documented behaviour), so
  // `claudeAccounts.length > 0` alone cannot tell "no claude accounts" apart
  // from "no idea — the file did not parse". Only the FORMER earns a "not
  // needed" — the latter must run the real check rather than print two
  // green lines (`claude --version`, `Claude hooks installed`) that assert
  // something this doctor run never actually knew. `checkRegistry` below
  // still reports the parse error itself as its own ✗, so nothing goes
  // silent either way.
  const hasClaudeAccounts = claudeAccounts.length > 0 || parseError !== null;

  results.push(checkClaudeBinary(hasClaudeAccounts));
  results.push(checkHooks(fix, hasClaudeAccounts));
  results.push(checkCodexBinary(codexAccounts.length > 0));
  // The Codex auto-recovery gate, stated rather than left to be guessed at:
  // it ships ON since 0.2.4, it is a stored setting (src/autorotate.ts)
  // because the processes that read it are dispatched by tmux, and each half
  // of the line names the export that would flip it, in the shell that runs
  // `codex`. Never a ✗ — off is somebody's deliberate choice, not a fault.
  if (codexAccounts.length > 0) {
    const st = openState();
    try { results.push({ ok: true, what: codexAutorotateLine(codexAutorotateEnabled(st)) }); } finally { st.close(); }
  }
  for (const a of codexAccounts) {
    results.push(...(await checkCodexAccount(a, fix)));
  }

  results.push(...checkStorePermissions(fix));

  results.push(...checkRegistry(parseError, problems));
  for (const a of claudeAccounts) {
    results.push(...(await checkClaudeAccount(a, fix, claudeAccounts)));
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
