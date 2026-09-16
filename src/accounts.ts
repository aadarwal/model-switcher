// src/accounts.ts
//
// `ms accounts` — the account book, and the Claude half of it. Every verb is
// dispatched from here; a row whose provider is `codex` is handed to
// src/accounts-codex.ts, which keeps that provider's one-credential,
// one-CODEX_HOME shape out of the two-credential logic below. Names are unique
// PER PROVIDER (src/registry.ts), so `--provider` disambiguates a name both
// providers hold and is needed for nothing else.
//
// A Claude account carries TWO independent credentials, both minted by Claude
// Code itself (spec §6):
//
//   poll grant    `claude auth login` into this tool's own CLAUDE_CONFIG_DIR
//                 (`claude/<name>/`). Profile-scoped; the only credential
//                 that can read usage and the organisation.
//   launch grant  `claude setup-token`. Inference-scope only: it can RUN the
//                 CLI as the account and can never poll usage.
//
// Identity is the organisation id from the poll grant's profile — never the
// nickname the human typed, which is why two rows resolving to one org are
// refused at `login`.
//
// Rules this file keeps, everywhere:
//   * every child process is bounded, by `timeout` (spawnSync) or by a killed
//     timer (spawn);
//   * a secret travels only in `env`, never on argv (argv is world-readable
//     via `ps`), and never reaches a log, a message or a forwarded line —
//     `ms accounts token` is the single verb that puts a token on stdout,
//     because that is its whole job;
//   * a credential is never *attributed* to an account it was not minted for:
//     the poll grant is addressed by a keychain service derived from this
//     account's own config dir (src/providers/claude-usage.ts), so the
//     operator's ordinary `~/.claude` login — which lives under the UNSCOPED
//     service — is never read, bound, written or deleted here.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withLock } from "./lock.ts";
import { ensureStore, p } from "./paths.ts";
import { type Account, findAccount, loadRegistry, NAME_PATTERN, type Provider, saveRegistry } from "./registry.ts";
import { addCodex, CODEX_RESERVED_NAMES, codexCells, loginCodex, removeCodex, verifyCodex } from "./accounts-codex.ts";
import { deleteLaunchToken, looksLikeSetupToken, readLaunchToken, saveLaunchToken } from "./launch-credentials.ts";
import {
  AuthError,
  deleteKeychainItem,
  fetchProfile,
  keychainItemExists,
  keychainItemFor,
  type PollCredentials,
  type Profile,
  readPollCredentials,
  refreshPollCredentials,
  writeKeychainNote,
} from "./providers/claude-usage.ts";
import { wallKindFromText } from "./wall.ts";

// --- Bounds ------------------------------------------------------------
/** A browser login and a token mint both wait on the human. */
const INTERACTIVE_TIMEOUT_MS = 600_000;
/** The headless one-shot that proves the launch token runs the CLI. */
const PROBE_TIMEOUT_MS = 90_000;
/** `claude auth status --json` is a local read. */
const AUTH_STATUS_TIMEOUT_MS = 15_000;
/** The two HTTP reads (profile, and a refresh before it if needed). */
const HTTP_TIMEOUT_MS = 20_000;
/** A grant that would expire mid-flight is refreshed rather than 401'd —
 *  src/snapshot.ts's REFRESH_SKEW_MS, and the same number. */
const REFRESH_SKEW_MS = 60_000;
/** How long to wait for whoever else holds this account's credential lock.
 *  Test-tunable, like manual.ts's bounds; nothing else depends on the value. */
const lockWaitMs = (): number => Number(process.env.MS_LOCK_WAIT_MS) || HTTP_TIMEOUT_MS;

/** The cheapest model that can answer the probe — the brief's `<cheapest>`.
 *  One constant so the live matrix is one edit. */
const CHEAPEST_MODEL = "haiku";
const PROBE_PROMPT = "Reply with the single word ok.";
/** The launch token's fixed prefix, used to hold back a half-arrived token
 *  and to redact one that shares a line with something else. */
const TOKEN_PREFIX = "sk-ant-oat01-";

/** Where `claude auth status --json` may name the organisation. Also a single
 *  edit point: the CLI's JSON shape is not a contract we control. */
const ORG_ID_PATHS: string[][] = [
  ["orgId"], // the real shape (Claude Code 2.1.273, verified live): top-level orgId/email/orgName
  ["organization", "uuid"],
  ["organization", "id"],
  ["org", "uuid"],
  ["organizationUuid"],
  ["organization_uuid"],
];

const PROVIDERS: Provider[] = ["claude", "codex"];

const USAGE = `usage: ms accounts <command>
  add <name> [--provider claude|codex] [--label L] [--shared]
                                      register an account (no credentials yet)
  login <name> [--provider P] [--device-auth]
                                      mint the credentials and record the identity
  verify <name> [--provider P]        re-check an account's credentials and identity
  remove <name> [--provider P]        delete the row and everything it names
  token <name>                        print the launch token (claude only)
  ls                                  list the accounts

--provider is needed only when one name is held by BOTH providers; names are
unique per provider, so a claude "work" and a codex "work" are two accounts.`;

const out = (s: string) => process.stdout.write(s);
const warn = (s: string) => process.stderr.write(`ms accounts: ${s}\n`);

/** Thrown for anything about HOW the command was invoked — an unusable name,
 *  an account that is not registered, a name already taken. Exits 2, so a
 *  mistyped command never looks like a failed operation. */
class UsageError extends Error {
  override name = "UsageError";
  constructor(message: string, readonly showUsage = false) {
    super(message);
  }
}

/** Anything matching a launch token is scrubbed before a line is forwarded to
 *  the human, so a CLI that ever prints a token beside other text still cannot
 *  leak it through this process. */
function tokenPattern(): RegExp {
  return new RegExp(`${TOKEN_PREFIX}[A-Za-z0-9_-]+`, "g");
}

/** Exported for src/accounts-codex.ts, which forwards `codex login`'s device
 *  code and URL to the human and must scrub those lines with the SAME scrubber
 *  the Claude mint uses — a second copy could drift from this one. (That makes
 *  the two modules a cycle; it is safe, and stays safe: nothing crosses it but
 *  this hoisted function declaration, and only from inside a function body.) */
export function redact(s: string): string {
  return s.replace(tokenPattern(), `${TOKEN_PREFIX}<redacted>`);
}

/** May this UNTERMINATED fragment be part of a token, either already or once
 *  the next chunk lands? Redaction only works on text it can see whole, and a
 *  chunk boundary falls wherever the pipe says: `Your token is sk-ant-oat01-`
 *  has nothing for the regex to scrub and leaves no prefix for the next chunk
 *  to match, and `…is sk-ant-` is the same trap one character earlier. So a
 *  fragment carrying the prefix, or ending in any part of it, waits for its
 *  newline; everything else — a prompt with no newline, which the human needs
 *  to SEE while the mint waits — goes straight out.
 *
 *  Exported for src/accounts-codex.ts alongside `redact`: `codex login` streams
 *  a device code the same way, and the holdback rule has to be the SAME rule on
 *  both sides, or one of them leaks on a chunk boundary the other survives. */
export function mightCarryToken(fragment: string): boolean {
  if (fragment.includes(TOKEN_PREFIX)) return true;
  for (let n = Math.min(fragment.length, TOKEN_PREFIX.length - 1); n > 0; n--) {
    if (fragment.endsWith(TOKEN_PREFIX.slice(0, n))) return true;
  }
  return false;
}

// --- Registry helpers --------------------------------------------------

/** A row `validateRegistry` skipped is dropped the next time the file is
 *  rewritten, so it must never be silent — but it must also not be shouted
 *  once per read within a single command. */
let problemsWarned = false;
function noteProblems(problems: string[]): void {
  if (problemsWarned) return;
  problemsWarned = true;
  for (const problem of problems) {
    warn(`warning: accounts.json ${problem} — that row is skipped, and will be dropped if the file is rewritten`);
  }
}

/** Load the registry, refusing to go on when it cannot be read: a write from
 *  an unparsed state would erase every row. */
function load(): ReturnType<typeof loadRegistry> {
  const r = loadRegistry();
  if (r.parseError) throw new Error(r.parseError);
  noteProblems(r.problems);
  return r;
}

function mustFind(name: string): Account {
  const a = findAccount(load().registry, name, "claude");
  if (!a) throw new UsageError(`no such Claude account: ${name} (add it with: ms accounts add ${name})`);
  return a;
}

/** Re-read, patch the row, write. The registry is re-read here because
 *  `login` holds the human for minutes between the first read and the save. */
function update(name: string, patch: Partial<Account>): void {
  const r = load();
  const a = findAccount(r.registry, name, "claude");
  if (!a) throw new UsageError(`no such Claude account: ${name}`);
  Object.assign(a, patch);
  saveRegistry(r.registry, r);
}

/** The other account already claiming this organisation, if any. Identity is
 *  the org id (spec §6), so this is what makes two nicknames for one
 *  subscription an error rather than a silently doubled pool entry. */
function organisationClaimedBy(name: string, orgId: string): string | null {
  const other = load().registry.accounts.find(
    (a) => a.provider === "claude" && a.name !== name && a.orgId === orgId,
  );
  return other ? other.name : null;
}

// --- The `claude` CLI --------------------------------------------------

function claudeConfigDir(name: string): { dir: string; created: boolean } {
  ensureStore();
  const dir = p.claudeConfigDir(name);
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, created };
}

/** `claude auth login` into this tool's own config dir: fully interactive
 *  (it opens a browser and waits for the human), so all three streams are
 *  inherited and the bound is generous. */
function runAuthLogin(name: string, dir: string): void {
  const r = spawnSync("claude", ["auth", "login"], {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    timeout: INTERACTIVE_TIMEOUT_MS,
  });
  if (r.error) throw new Error(`could not run claude: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`claude auth login exited ${r.status ?? "on a signal"} for ${name}`);
}

/** `claude setup-token`, streamed.
 *
 *  Both output streams are piped and scanned, because a CLI is free to put
 *  its prompts on either and its answer on either. The unit of forwarding is
 *  a LINE: a line that is a token is captured and dropped, and every other one
 *  is redacted and written to the human's stderr as soon as its newline
 *  arrives. The single exception is a trailing fragment that cannot be part of
 *  a token (see `mightCarryToken`) — an unterminated `Paste code: ` is
 *  forwarded at once, because a prompt nobody sees is a hang. stdin stays with
 *  the human so that prompt still works. */
async function mintLaunchToken(name: string, dir: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", ["setup-token"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    });
    let token: string | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, INTERACTIVE_TIMEOUT_MS);
    timer.unref?.();

    const forward = (line: string) => process.stderr.write(redact(line));
    const handleLine = (line: string) => {
      const t = line.trim();
      if (looksLikeSetupToken(t)) {
        token ??= t;
        return; // a line that is nothing but the token: captured, never forwarded
      }
      // A token can also arrive INSIDE a line (`Paste code: sk-ant-oat01-…`).
      // Capture it there too, then let the line through redacted: which of
      // those two shapes we see must not depend on where a chunk boundary
      // happened to fall, or the mint fails on pipe scheduling alone.
      for (const m of line.match(tokenPattern()) ?? []) if (looksLikeSetupToken(m)) token ??= m;
      forward(`${line}\n`);
    };
    const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const consume = (which: "stdout" | "stderr", chunk: string) => {
      pending[which] += chunk;
      for (let i = pending[which].indexOf("\n"); i >= 0; i = pending[which].indexOf("\n")) {
        const line = pending[which].slice(0, i);
        pending[which] = pending[which].slice(i + 1);
        handleLine(line);
      }
      // What is left has no newline yet. A fragment that could be carrying a
      // token — or could become one when the next chunk lands — waits for it;
      // anything else is a prompt the human needs now, so it goes out and the
      // remainder of the line is handled as its own when the newline arrives.
      if (pending[which] && !mightCarryToken(pending[which])) {
        forward(pending[which]);
        pending[which] = "";
      }
    };
    // At exit there will be no newline coming: the trailing partial line is
    // handled exactly like a complete one — captured if it is a token,
    // redacted and forwarded otherwise.
    const flush = () => {
      for (const which of ["stdout", "stderr"] as const) {
        if (!pending[which]) continue;
        handleLine(pending[which]);
        pending[which] = "";
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => consume("stdout", c));
    child.stderr?.on("data", (c: string) => consume("stderr", c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run claude setup-token: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      flush();
      if (token) return resolve(token);
      if (timedOut) return reject(new Error(`claude setup-token timed out for ${name}`));
      reject(
        new Error(
          `claude setup-token printed no launch token for ${name}` +
            (code === 0 ? "" : ` (it exited ${code ?? "on a signal"})`),
        ),
      );
    });
  });
}

/** A config dir with nothing in it, for the two calls made under the launch
 *  token. Without it an ambient login (the operator's own `~/.claude`) could
 *  answer instead of the token, and `identityVerified` would be measuring the
 *  wrong credential. */
function scratchConfigDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ms-probe-"));
}

/** Does this launch token actually run the CLI? One headless, cheapest-model
 *  turn. The token goes in the environment, never on argv. */
function probeLaunchToken(token: string, scratch: string): { ok: boolean; detail: string } {
  const r = spawnSync("claude", ["-p", PROBE_PROMPT, "--model", CHEAPEST_MODEL], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: scratch },
    timeout: PROBE_TIMEOUT_MS,
  });
  if (r.error) return { ok: false, detail: r.error.message };
  // A usage wall is an AUTHENTICATED answer: the account is merely out of
  // room right now (seen live: "You've hit your session limit · resets …").
  const wall = wallKindFromText(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  if (r.status !== 0 && wall) return { ok: true, detail: `walled (${wall})` };
  if (r.status !== 0) return { ok: false, detail: `claude -p exited ${r.status ?? "on a signal"}` };
  if (!/\bok\b/i.test(r.stdout ?? "")) return { ok: false, detail: "the headless turn did not answer ok" };
  return { ok: true, detail: "" };
}

function pick(j: unknown, keys: string[]): unknown {
  let cur: unknown = j;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** The first parseable JSON object in some output — the CLI is free to print
 *  a banner line above its `--json`. */
function parseJsonish(s: string): unknown {
  for (const candidate of [s.trim(), ...s.split("\n").map((l) => l.trim())]) {
    if (!candidate.startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next line */
    }
  }
  return null;
}

/** The organisation the launch token itself reports, or null when the CLI
 *  names none. Run under the token env and an empty config dir so it can only
 *  be describing THAT credential. */
function organisationFromLaunchToken(token: string, scratch: string): string | null {
  const r = spawnSync("claude", ["auth", "status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: scratch },
    timeout: AUTH_STATUS_TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) return null;
  const j = parseJsonish(r.stdout ?? "");
  if (!j) return null;
  for (const keys of ORG_ID_PATHS) {
    const v = pick(j, keys);
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// --- The poll grant ----------------------------------------------------

/** Point this account at the credential its login actually produced.
 *
 *  There is nothing to attribute any more: the keychain SERVICE is derived
 *  from this account's own config dir (`keychainServiceFor`), so an item
 *  answering under it was written by a login into that dir and can only be
 *  this account's. The human's ordinary Claude Code login lives under the
 *  unscoped service, which this tool never queries. An existing note that
 *  still answers is honoured untouched — it may record an item this
 *  derivation would not have produced. */
function locatePollCredential(name: string, dir: string): void {
  if (existsSync(path.join(dir, ".credentials.json"))) return;
  const item = keychainItemFor(name);
  if (keychainItemExists(item)) {
    writeKeychainNote(dir, item);
    return;
  }
  throw new Error(
    `could not locate the poll credential for ${name} — neither ${path.join(dir, ".credentials.json")} ` +
      `nor a keychain item under the service a login into ${dir} writes ("${item.service}")`,
  );
}

/** Is there a poll grant on disk for this account? Existence only — `ls` has
 *  no business pulling a secret out of the keychain to fill in a column. */
function hasPollGrant(name: string): boolean {
  const dir = p.claudeConfigDir(name);
  try {
    if (statSync(path.join(dir, ".credentials.json")).isFile()) return true;
  } catch {
    /* no file; the scoped keychain item is the other place it can be */
  }
  return keychainItemExists(keychainItemFor(name));
}

/** Does this account ALREADY hold a usable poll grant? `claude auth status`
 *  under the account's own config dir, with any ambient launch token removed
 *  from the environment so the answer can only describe the credential in that
 *  dir. Cheap, bounded, and read-only — and it saves the human a second
 *  browser flow for a login they already did (`cmdLogin`). */
function pollGrantUsable(name: string, dir: string): boolean {
  if (!hasPollGrant(name)) return false;
  const { CLAUDE_CODE_OAUTH_TOKEN: _launchToken, ...env } = process.env;
  const r = spawnSync("claude", ["auth", "status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...env, CLAUDE_CONFIG_DIR: dir },
    timeout: AUTH_STATUS_TIMEOUT_MS,
  });
  return !r.error && r.status === 0;
}

/**
 * Refresh this account's poll grant under its own credential lock — the
 * `account-<provider>-<name>` name src/snapshot.ts's `refreshGrant` takes, and
 * for the same reason: the token endpoint ROTATES the refresh token, so an
 * `ms accounts verify` running beside a poll (or beside another `ms`) would
 * have the two spend each other's grant, and whoever lost would read
 * `invalid_grant` — a live account that now looks dead and needs a re-login.
 *
 * Re-read inside the lock, as snapshot.ts does: whoever we waited for has just
 * written a fresh credential where we found a stale one, so the common case
 * costs no network call at all. `force` is the after-an-AuthError path, where
 * the credential we hold was rejected and only a DIFFERENT one is any use.
 *
 * Bounded by the same budget as the calls around it; a lock we cannot get in
 * that time throws `Locked`, which the verb reports, rather than waiting on.
 */
async function refreshUnderLock(name: string, c: PollCredentials, opts: { force?: boolean } = {}): Promise<PollCredentials> {
  return await withLock(
    `account-claude-${name}`,
    async () => {
      const latest = readPollCredentials(name) ?? c;
      const someoneElseDidIt = opts.force ? latest.refreshToken !== c.refreshToken : latest.expiresAt >= Date.now() + REFRESH_SKEW_MS;
      if (someoneElseDidIt) return latest;
      return await refreshPollCredentials(name, latest, AbortSignal.timeout(HTTP_TIMEOUT_MS));
    },
    { waitMs: lockWaitMs() },
  );
}

/** The organisation behind the poll grant. Refreshes when the access token is
 *  spent, and once more if the profile read says the credential is stale. */
async function readProfile(name: string): Promise<Profile> {
  let c: PollCredentials | null = readPollCredentials(name);
  if (!c) throw new Error(`no poll grant for ${name} — run: ms accounts login ${name}`);
  if (c.expiresAt && c.expiresAt <= Date.now() + REFRESH_SKEW_MS) {
    c = await refreshUnderLock(name, c);
  }
  try {
    return await fetchProfile(c, AbortSignal.timeout(HTTP_TIMEOUT_MS));
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    const fresh = await refreshUnderLock(name, c, { force: true });
    return await fetchProfile(fresh, AbortSignal.timeout(HTTP_TIMEOUT_MS));
  }
}

/** Two rows resolving to one organisation. Its own type because `login`
 *  answers it by undoing the credential it just minted — and nothing else. */
class DuplicateOrganisation extends Error {
  override name = "DuplicateOrganisation";
}

/** The profile, plus the duplicate-organisation refusal. Shared by `login`
 *  and `verify`, and always run BEFORE anything is written. */
async function identifyOrRefuse(name: string): Promise<Profile> {
  const profile = await readProfile(name);
  if (!profile.orgId) throw new Error(`the poll grant for ${name} reported no organisation`);
  const other = organisationClaimedBy(name, profile.orgId);
  if (other) throw new DuplicateOrganisation(`${name} resolves to the same organisation as ${other}`);
  return profile;
}

/** Runs the launch token headlessly (the probe) — the one thing that proves
 *  it is USABLE. The organisation `claude auth status --json` names under it
 *  is only ever a bonus, verified live not to exist on 2.1.273 (a setup-token
 *  is inference-scope only, so it 403s the profile/usage endpoints and never
 *  writes `oauthAccount` locally): when the CLI does name one and it
 *  disagrees with the poll grant's own organisation, that is the one signal
 *  worth refusing on; naming none, or agreeing, is silent either way. */
function checkLaunchToken(
  name: string,
  token: string,
  profile: Profile,
): { verified: boolean; probe: { ok: boolean; detail: string }; mismatchOrg: string | null } {
  const scratch = scratchConfigDir();
  try {
    const probe = probeLaunchToken(token, scratch);
    if (!probe.ok) return { verified: false, probe, mismatchOrg: null };
    const org = organisationFromLaunchToken(token, scratch);
    if (org && org !== profile.orgId) return { verified: false, probe, mismatchOrg: org };
    return { verified: true, probe, mismatchOrg: null };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function report(name: string, profile: Profile, verified: boolean): void {
  out(
    `${name}: organisation ${profile.orgId}${profile.orgName ? ` (${profile.orgName})` : ""}` +
      `${profile.email ? `, ${profile.email}` : ""} — poll grant ok, launch token ok, ` +
      `identity ${verified ? "verified (both credentials usable)" : "unverified"}\n`,
  );
}

// --- The verbs ---------------------------------------------------------

/** `--provider claude|codex`, from either spelling. Anything else is a typo
 *  worth naming, not a row to invent a provider for. */
function asProvider(verb: string, value: string | undefined): Provider {
  if (value && (PROVIDERS as string[]).includes(value)) return value as Provider;
  throw new UsageError(`${verb}: --provider takes claude|codex${value ? `, not '${value}'` : ""}`, true);
}

function cmdAdd(args: string[]): number {
  let name: string | null = null;
  let label: string | null = null;
  let provider: Provider = "claude";
  let shared = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--shared") shared = true;
    else if (a === "--label") label = args[++i] ?? "";
    else if (a.startsWith("--label=")) label = a.slice("--label=".length);
    else if (a === "--provider") provider = asProvider("add", args[++i]);
    else if (a.startsWith("--provider=")) provider = asProvider("add", a.slice("--provider=".length));
    else if (a.startsWith("-")) throw new UsageError(`add: unknown option ${a}`, true);
    else if (name === null) name = a;
    else throw new UsageError(`add: unexpected argument ${a}`, true);
  }
  if (!name) throw new UsageError("add needs an account name", true);
  if (!NAME_PATTERN.test(name)) {
    throw new UsageError(`'${name}' is not a usable account name (lower-case letters, digits, '-' and '_', up to 32)`);
  }
  if (label !== null && !label.trim()) throw new UsageError("--label needs a value", true);
  if (provider === "codex" && CODEX_RESERVED_NAMES.includes(name)) {
    throw new UsageError(`'${name}' is reserved: MS_HOME/codex/${name} is the shared rollout store, not an account home`);
  }
  const r = load();
  // Names are unique PER PROVIDER (src/registry.ts): a claude "work" and a
  // codex "work" are two accounts, and only a clash within one is a duplicate.
  if (findAccount(r.registry, name, provider)) throw new UsageError(`${name} is already registered (${provider})`);
  if (provider === "codex") return addCodex(name, label ?? name, shared);
  r.registry.accounts.push({
    name,
    provider: "claude",
    label: label ?? name,
    orgId: null,
    shared,
    identityVerified: false,
  });
  saveRegistry(r.registry, r);
  out(`added ${name} — next: ms accounts login ${name}\n`);
  return 0;
}

async function cmdLogin(name: string): Promise<number> {
  mustFind(name);
  const { dir, created } = claudeConfigDir(name);
  let profile: Profile;
  try {
    // A poll grant already in this dir is the login: sending the human back
    // through a browser flow they completed this morning is repeating work,
    // not confirming it. `login` is still the verb that mints the LAUNCH
    // token, so the rest of it runs either way.
    if (pollGrantUsable(name, dir)) {
      out(`${name}: a usable poll grant is already in place — skipping claude auth login\n`);
    } else {
      runAuthLogin(name, dir);
    }
    locatePollCredential(name, dir);
    // Identity (and the duplicate refusal) before a token is ever minted: a
    // refused account must leave nothing behind.
    profile = await identifyOrRefuse(name);
  } catch (e) {
    // A refusal undoes this run's own work: without this, the credential the
    // browser login just wrote would keep answering, and `ms accounts ls`
    // would report a poll grant for an account that was turned away. Only a
    // dir this run created is ours to delete. (A keychain-held credential
    // survives: deleting the item could revoke the very grant the OTHER
    // account polls with — the dir, and the note in it, go.)
    if (e instanceof DuplicateOrganisation && created) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  // The organisation is a fact about the grant now on disk: record it before
  // the mint, and never leave a stale verdict standing beside a fresh org.
  update(name, { orgId: profile.orgId, identityVerified: false, identityMethod: undefined });
  // The browser flow that opens next (`claude setup-token`) is a SEPARATE
  // sign-in from the one that just produced the poll grant, and this tool has
  // no way to check the human used the same account for both — the probe only
  // proves the launch token can run the CLI, never whose account it is.
  out(`${name}: sign in as the SAME account in the next browser tab\n`);
  const token = await mintLaunchToken(name, dir);
  saveLaunchToken(name, token);
  const { verified, probe, mismatchOrg } = checkLaunchToken(name, token, profile);
  update(name, { identityVerified: verified, identityMethod: verified ? "both-usable" : undefined });
  if (!probe.ok) {
    throw new Error(`the launch token for ${name} did not answer the headless check (${probe.detail})`);
  }
  if (mismatchOrg) {
    throw new Error(
      `${name}: the launch token belongs to a different organisation (it reports ${mismatchOrg}, but the poll grant reports ${profile.orgId})`,
    );
  }
  report(name, profile, verified);
  return 0;
}

async function cmdVerify(name: string): Promise<number> {
  mustFind(name);
  // Step 2's check, re-run: where the credential lives can change under us
  // (Claude Code re-minting it into the keychain, a lost note), and repairing
  // that here is the whole point of `verify`. No dir is created.
  const dir = p.claudeConfigDir(name);
  if (existsSync(dir)) locatePollCredential(name, dir);
  const profile = await identifyOrRefuse(name);
  const token = readLaunchToken(name);
  if (!token) throw new Error(`no launch token for ${name} — run: ms accounts login ${name}`);
  const { verified, probe, mismatchOrg } = checkLaunchToken(name, token, profile);
  update(name, { orgId: profile.orgId, identityVerified: verified, identityMethod: verified ? "both-usable" : undefined });
  if (!probe.ok) {
    throw new Error(`the launch token for ${name} did not answer the headless check (${probe.detail})`);
  }
  if (mismatchOrg) {
    throw new Error(
      `${name}: the launch token belongs to a different organisation (it reports ${mismatchOrg}, but the poll grant reports ${profile.orgId})`,
    );
  }
  report(name, profile, verified);
  return 0;
}

function cmdRemove(name: string): number {
  const r = load();
  const i = r.registry.accounts.findIndex((a) => a.name === name && a.provider === "claude");
  if (i < 0) throw new UsageError(`no such Claude account: ${name}`);
  // Credentials first: a row is what NAMES them, so dropping the row before
  // the files could strand a token and a config dir nothing points at. The
  // keychain item goes before the dir, because the dir is what names it — and
  // it is this account's own scoped item, never the human's own login.
  deleteLaunchToken(name);
  deleteKeychainItem(keychainItemFor(name));
  rmSync(p.claudeConfigDir(name), { recursive: true, force: true });
  r.registry.accounts.splice(i, 1);
  saveRegistry(r.registry, r);
  out(`removed ${name}\n`);
  return 0;
}

function cmdToken(name: string): number {
  mustFind(name);
  const token = readLaunchToken(name);
  if (!token) throw new Error(`no launch token for ${name} — run: ms accounts login ${name}`);
  out(`${token}\n`);
  return 0;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return `${rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd())
    .join("\n")}\n`;
}

/**
 * The TOKEN column: three values, because there are three states and only two
 * of them used to have a word.
 *
 * `existsSync` alone said `yes` for a file nothing can read — while every other
 * reader of the same file (`ms doctor`, `ms status`, the recovery worker, which
 * all go through `readLaunchToken`) treated it as absent. A `chmod 000` token
 * therefore had the account book saying it was there and the doctor saying it
 * was not, which is the one thing a book like this must never do.
 *
 * `unreadable` is the honest third answer: the file is on disk, and the value
 * is not usable — a permission to fix, not a login to redo.
 */
function tokenCell(name: string): string {
  if (readLaunchToken(name)) return "yes";
  return existsSync(p.launchToken(name)) ? "unreadable" : "no";
}

/** At most this many usage probes in flight at once while `ls` fills the POLL
 *  column. A book of codex accounts is a book of bounded HTTP reads, and firing
 *  all of them at one endpoint the instant someone types `ls` is how a listing
 *  earns a 429 — the very answer that would then read `unknown`. Four keeps the
 *  table fast without making the request pattern a burst. */
const LS_PROBE_CONCURRENCY = 4;

/**
 * `items.map(work)`, with at most `limit` of them running at once.
 *
 * A fixed set of workers pulling from one shared cursor: no dependency, no
 * queue, and each result lands back at its own index, so the caller still gets
 * an array in input order however the work interleaved.
 */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Every account, in registry order, under one set of columns.
 *
 * PROVIDER earns its column the moment two providers share the book: names are
 * unique PER PROVIDER, so a claude `work` and a codex `work` are two different
 * accounts and a table that showed only the name would print the same row
 * twice with no way to tell which is which.
 *
 * The cells themselves are per-provider (`codexCells`, and the Claude pair
 * below), because the same word means a different check on each side. Codex
 * rows are probed CONCURRENTLY — a book of them must not cost the sum of their
 * timeouts — but never more than `LS_PROBE_CONCURRENCY` of them at a time.
 */
async function cmdLs(): Promise<number> {
  const r = load();
  const cells = await mapLimit(r.registry.accounts, LS_PROBE_CONCURRENCY, async (a) =>
    a.provider === "codex"
      ? await codexCells(a)
      : {
          poll: hasPollGrant(a.name) ? "yes" : "no",
          token: tokenCell(a.name),
          verified: a.identityVerified ? "yes" : "no",
        },
  );
  const rows = [["NAME", "PROVIDER", "LABEL", "ORG", "POLL", "TOKEN", "VERIFIED"]];
  r.registry.accounts.forEach((a, i) => {
    rows.push([a.name, a.provider, a.label, a.orgId ?? "-", cells[i].poll, cells[i].token, cells[i].verified]);
  });
  out(table(rows));
  return 0;
}

/** The verbs that act on ONE existing account, and so share a target. */
const TARGET_VERBS = ["login", "verify", "remove", "token"];

/** A target verb's arguments: the name, plus its flags. */
function parseTarget(verb: string, args: string[]): { name: string; provider: Provider | null; deviceAuth: boolean } {
  let name: string | null = null;
  let provider: Provider | null = null;
  let deviceAuth = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--provider") provider = asProvider(verb, args[++i]);
    else if (a.startsWith("--provider=")) provider = asProvider(verb, a.slice("--provider=".length));
    else if (a === "--device-auth" && verb === "login") deviceAuth = true;
    else if (a.startsWith("-")) throw new UsageError(`${verb}: unknown option ${a}`, true);
    else if (name === null) name = a;
    else throw new UsageError(`${verb}: unexpected argument ${a}`, true);
  }
  if (!name) throw new UsageError(`${verb} needs an account name`, true);
  return { name, provider, deviceAuth };
}

/**
 * The row a target verb acts on.
 *
 * `--provider` is REQUIRED only when one name is held by both providers. Most
 * books have no collision at all, and making every command carry the flag
 * would be a tax everyone pays for a case almost nobody has — but guessing
 * which of two accounts the human meant is the one thing that must not happen,
 * so an ambiguous name is refused, naming the flag that resolves it.
 */
function resolveTarget(name: string, provider: Provider | null): Account {
  const rows = load().registry.accounts.filter((a) => a.name === name && (!provider || a.provider === provider));
  if (rows.length === 0) {
    throw new UsageError(
      provider
        ? `no such ${provider} account: ${name} (add it with: ms accounts add ${name} --provider ${provider})`
        : `no such account: ${name} (add it with: ms accounts add ${name})`,
    );
  }
  if (rows.length > 1) {
    throw new UsageError(
      `${name} names both a ${rows.map((a) => a.provider).join(" and a ")} account — say which with --provider`,
    );
  }
  return rows[0];
}

export async function accountsVerb(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "add") return cmdAdd(rest);
    if (sub === "ls") return await cmdLs();
    if (sub && TARGET_VERBS.includes(sub)) {
      const t = parseTarget(sub, rest);
      const row = resolveTarget(t.name, t.provider);
      const codex = row.provider === "codex";
      if (t.deviceAuth && !codex) throw new UsageError("login: --device-auth is a codex option", true);
      if (sub === "login") return codex ? await loginCodex(row.name, { deviceAuth: t.deviceAuth }) : await cmdLogin(row.name);
      if (sub === "verify") return codex ? await verifyCodex(row.name) : await cmdVerify(row.name);
      if (sub === "remove") return codex ? removeCodex(row.name) : cmdRemove(row.name);
      // `token` is the launch grant, and only Claude has a second credential to
      // print: a codex account IS its CODEX_HOME. Exits 1, not 2 — the command
      // was well formed, there is simply nothing of that kind to hand over.
      if (codex) {
        throw new Error(`codex accounts have no launch token; the CLI reads CODEX_HOME (${p.codexHome(row.name)})`);
      }
      return cmdToken(row.name);
    }
    process.stderr.write(`${sub ? `ms accounts: unknown command '${sub}'\n` : ""}${USAGE}\n`);
    return 2;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`ms accounts: ${e.message}\n${e.showUsage ? `${USAGE}\n` : ""}`);
    return 2;
  }
}
