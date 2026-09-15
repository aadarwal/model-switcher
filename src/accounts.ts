// src/accounts.ts
//
// `ms accounts` — the Claude account book. A Claude account carries TWO
// independent credentials, both minted by Claude Code itself (spec §6):
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
//   * every spawnSync is bounded by an explicit `timeout`;
//   * a secret is passed only in `env`, never on argv (argv is world-readable
//     via `ps`), and never printed — `ms accounts token` is the single verb
//     that puts a token on stdout, because that is its whole job.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { ensureStore, p } from "./paths.ts";
import { type Account, findAccount, loadRegistry, NAME_PATTERN, saveRegistry } from "./registry.ts";
import { deleteLaunchToken, looksLikeSetupToken, readLaunchToken, saveLaunchToken } from "./launch-credentials.ts";
import {
  AuthError,
  fetchProfile,
  type PollCredentials,
  type Profile,
  readPollCredentials,
  refreshPollCredentials,
} from "./providers/claude-usage.ts";

// --- Bounds ------------------------------------------------------------
/** A browser login and a token mint both wait on the human. */
const INTERACTIVE_TIMEOUT_MS = 600_000;
/** The headless one-shot that proves the launch token runs the CLI. */
const PROBE_TIMEOUT_MS = 90_000;
/** `claude auth status --json` is a local read. */
const AUTH_STATUS_TIMEOUT_MS = 15_000;
/** `security` can block forever on a locked keychain (a GUI prompt nobody
 *  will answer); bounded exactly as src/providers/claude-usage.ts bounds it. */
const KEYCHAIN_TIMEOUT_MS = 3_000;
/** The two HTTP reads (profile, and a refresh before it if needed). */
const HTTP_TIMEOUT_MS = 20_000;

/** The keychain service Claude Code stores its OAuth credentials under. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** The cheapest model that can answer the probe — the brief's `<cheapest>`.
 *  One constant so the live matrix is one edit. */
const CHEAPEST_MODEL = "haiku";
const PROBE_PROMPT = "Reply with the single word ok.";

/** The candidate forms of the keychain `acct` string Claude Code uses for a
 *  custom CLAUDE_CONFIG_DIR. The true form is confirmed by the live matrix;
 *  until then both known shapes are probed, cheaply and in order, and the one
 *  that answers is recorded in `claude/<name>/keychain-account` so nothing
 *  downstream ever has to guess again. THIS LIST IS THE ONE EDIT POINT. */
const KEYCHAIN_ACCOUNT_FORMS: ((user: string, dir: string) => string)[] = [
  (user) => user,
  (user, dir) => `${user}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`,
];

/** Where `claude auth status --json` may name the organisation. Also a single
 *  edit point: the CLI's JSON shape is not a contract we control. */
const ORG_ID_PATHS: string[][] = [
  ["organization", "uuid"],
  ["organization", "id"],
  ["org", "uuid"],
  ["organizationUuid"],
  ["organization_uuid"],
];

const USAGE = `usage: ms accounts <command>
  add <name> [--label L] [--shared]   register a Claude account (no credentials yet)
  login <name>                        mint both credentials and record the organisation
  verify <name>                       re-check an account's credentials and identity
  remove <name>                       delete the row, the launch token and the config dir
  token <name>                        print the launch token
  ls                                  list the accounts`;

const out = (s: string) => process.stdout.write(s);
const warn = (s: string) => process.stderr.write(`ms accounts: ${s}\n`);

// --- Registry helpers --------------------------------------------------

/** Load the registry, refusing to go on when it cannot be read (a write from
 *  an unparsed state would erase every row) and naming any row the validator
 *  skipped — a skipped row is dropped the next time the file is rewritten, so
 *  it must never be silent. */
function load(): ReturnType<typeof loadRegistry> {
  const r = loadRegistry();
  if (r.parseError) throw new Error(r.parseError);
  for (const problem of r.problems) {
    warn(`warning: accounts.json ${problem} — that row is skipped, and will be dropped if the file is rewritten`);
  }
  return r;
}

function mustFind(name: string): Account {
  const a = findAccount(load().registry, name, "claude");
  if (!a) throw new Error(`no such Claude account: ${name} (add it with: ms accounts add ${name})`);
  return a;
}

/** Re-read, patch the row, write. The registry is re-read here because
 *  `login` holds the human for minutes between the first read and the save. */
function update(name: string, patch: Partial<Account>): void {
  const r = loadRegistry();
  if (r.parseError) throw new Error(r.parseError);
  const a = findAccount(r.registry, name, "claude");
  if (!a) throw new Error(`no such Claude account: ${name}`);
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

/** This tool's own CLAUDE_CONFIG_DIR for `name`. `created` says whether THIS
 *  run made it, which is the only case in which a refusal may delete it: a
 *  dir that was already there may hold a working poll grant. */
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

/** `claude setup-token`: stdin and stderr stay with the human (it prompts),
 *  stdout is captured so the token never reaches the terminal. The token is
 *  the first stdout line that looks like one — nothing else about the CLI's
 *  chatter is assumed. */
function mintLaunchToken(name: string, dir: string): string {
  const r = spawnSync("claude", ["setup-token"], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    timeout: INTERACTIVE_TIMEOUT_MS,
  });
  if (r.error) throw new Error(`could not run claude setup-token: ${r.error.message}`);
  for (const line of (r.stdout ?? "").split("\n")) {
    const t = line.trim();
    if (looksLikeSetupToken(t)) return t;
  }
  throw new Error(`claude setup-token printed no launch token for ${name}`);
}

/** Does this launch token actually run the CLI? One headless, cheapest-model
 *  turn. The token goes in the environment, never on argv. */
function probeLaunchToken(token: string): { ok: boolean; detail: string } {
  const r = spawnSync("claude", ["-p", PROBE_PROMPT, "--model", CHEAPEST_MODEL], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
    timeout: PROBE_TIMEOUT_MS,
  });
  if (r.error) return { ok: false, detail: r.error.message };
  if (r.status !== 0) return { ok: false, detail: `claude -p exited ${r.status ?? "on a signal"}` };
  if (!(r.stdout ?? "").toLowerCase().includes("ok")) return { ok: false, detail: "the headless turn did not answer ok" };
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
 *  names none. Run under the token env so it describes THAT credential. */
function organisationFromLaunchToken(token: string): string | null {
  const r = spawnSync("claude", ["auth", "status", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
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

/** After a login, find where the credential actually landed. A file in the
 *  config dir needs nothing further; otherwise the credential is in the
 *  macOS keychain under an account string keyed to the dir, and the one that
 *  answers is recorded so `readPollCredentials` never has to guess. */
function locatePollCredential(name: string, dir: string): void {
  if (existsSync(path.join(dir, ".credentials.json"))) return;
  const user = userInfo().username;
  for (const form of KEYCHAIN_ACCOUNT_FORMS) {
    const acct = form(user, dir);
    // No `-w`: this is a probe. Asking for the value would print the secret.
    const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", acct], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: KEYCHAIN_TIMEOUT_MS,
    });
    if (!r.error && r.status === 0) {
      writeFileSync(path.join(dir, "keychain-account"), `${acct}\n`, { mode: 0o600 });
      return;
    }
  }
  throw new Error(
    `could not locate the poll credential for ${name} — neither ${path.join(dir, ".credentials.json")} ` +
      `nor any known keychain account under "${KEYCHAIN_SERVICE}"`,
  );
}

/** The organisation behind the poll grant. Refreshes first when the access
 *  token is spent, and once more if the profile read says it is stale. */
async function readProfile(name: string): Promise<Profile> {
  let c: PollCredentials | null = readPollCredentials(name);
  if (!c) {
    throw new Error(`no poll grant for ${name} — run: ms accounts login ${name}`);
  }
  if (c.expiresAt && c.expiresAt <= Date.now() + 60_000) {
    c = await refreshPollCredentials(name, c, AbortSignal.timeout(HTTP_TIMEOUT_MS));
  }
  try {
    return await fetchProfile(c, AbortSignal.timeout(HTTP_TIMEOUT_MS));
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    const fresh = await refreshPollCredentials(name, c, AbortSignal.timeout(HTTP_TIMEOUT_MS));
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

/** Steps 3–4's checks on a launch token that is already on disk: it runs the
 *  CLI, and the organisation it reports is the one the poll grant reported.
 *  A token that cannot answer is an error; an identity that cannot be
 *  confirmed is recorded as false with a warning, never assumed true. */
function checkLaunchToken(name: string, token: string, profile: Profile): { verified: boolean; probe: { ok: boolean; detail: string } } {
  const probe = probeLaunchToken(token);
  if (!probe.ok) return { verified: false, probe };
  const org = organisationFromLaunchToken(token);
  if (!org) {
    warn(`warning: claude auth status named no organisation for ${name}; identity is recorded as unverified`);
    return { verified: false, probe };
  }
  if (org !== profile.orgId) {
    warn(
      `warning: ${name}'s launch token reports organisation ${org}, but its poll grant reports ${profile.orgId}; ` +
        `identity is recorded as unverified`,
    );
    return { verified: false, probe };
  }
  return { verified: true, probe };
}

function report(name: string, profile: Profile, verified: boolean): void {
  out(
    `${name}: organisation ${profile.orgId}${profile.orgName ? ` (${profile.orgName})` : ""}` +
      `${profile.email ? `, ${profile.email}` : ""} — poll grant ok, launch token ok, ` +
      `identity ${verified ? "verified" : "unverified"}\n`,
  );
}

// --- The verbs ---------------------------------------------------------

function cmdAdd(args: string[]): number {
  let name: string | null = null;
  let label: string | null = null;
  let shared = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--shared") shared = true;
    else if (a === "--label") label = args[++i] ?? "";
    else if (a.startsWith("--label=")) label = a.slice("--label=".length);
    else if (a.startsWith("-")) return usageError(`add: unknown option ${a}`);
    else if (name === null) name = a;
    else return usageError(`add: unexpected argument ${a}`);
  }
  if (!name) return usageError("add needs an account name");
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`'${name}' is not a usable account name (lower-case letters, digits, '-' and '_', up to 32)`);
  }
  if (label !== null && !label.trim()) throw new Error("--label needs a value");
  const r = load();
  if (findAccount(r.registry, name, "claude")) throw new Error(`${name} is already registered`);
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
    runAuthLogin(name, dir);
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
    // account polls with — the recorded `keychain-account` file goes, which
    // is what makes it unreadable here.)
    if (e instanceof DuplicateOrganisation && created) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  // The organisation is a fact about the grant now on disk: record it before
  // the mint, and never leave a stale verdict standing beside a fresh org.
  update(name, { orgId: profile.orgId, identityVerified: false });
  const token = mintLaunchToken(name, dir);
  saveLaunchToken(name, token);
  const { verified, probe } = checkLaunchToken(name, token, profile);
  update(name, { identityVerified: verified });
  if (!probe.ok) {
    throw new Error(`the launch token for ${name} did not answer the headless check (${probe.detail})`);
  }
  report(name, profile, verified);
  return 0;
}

async function cmdVerify(name: string): Promise<number> {
  mustFind(name);
  // Step 2's check, re-run: where the credential lives can change under us
  // (Claude Code re-minting it into the keychain, a lost `keychain-account`
  // note), and repairing that here is the whole point of `verify`. No dir is
  // created — an account that never logged in has nothing to locate.
  const dir = p.claudeConfigDir(name);
  if (existsSync(dir)) locatePollCredential(name, dir);
  const profile = await identifyOrRefuse(name);
  const token = readLaunchToken(name);
  if (!token) throw new Error(`no launch token for ${name} — run: ms accounts login ${name}`);
  const { verified, probe } = checkLaunchToken(name, token, profile);
  update(name, { orgId: profile.orgId, identityVerified: verified });
  if (!probe.ok) {
    throw new Error(`the launch token for ${name} did not answer the headless check (${probe.detail})`);
  }
  report(name, profile, verified);
  return 0;
}

function cmdRemove(name: string): number {
  const r = load();
  const i = r.registry.accounts.findIndex((a) => a.name === name && a.provider === "claude");
  if (i < 0) throw new Error(`no such Claude account: ${name}`);
  r.registry.accounts.splice(i, 1);
  saveRegistry(r.registry, r);
  deleteLaunchToken(name);
  rmSync(p.claudeConfigDir(name), { recursive: true, force: true });
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

function cmdLs(): number {
  const r = load();
  const claude = r.registry.accounts.filter((a) => a.provider === "claude");
  const rows = [["NAME", "LABEL", "ORG", "POLL", "TOKEN", "VERIFIED"]];
  for (const a of claude) {
    rows.push([
      a.name,
      a.label,
      a.orgId ?? "-",
      readPollCredentials(a.name) ? "yes" : "no",
      readLaunchToken(a.name) ? "yes" : "no",
      a.identityVerified ? "yes" : "no",
    ]);
  }
  out(table(rows));
  // This verb is the Claude account book; a codex row belongs to its own
  // provider's columns, so it is named here rather than silently hidden.
  const others = r.registry.accounts.length - claude.length;
  if (others > 0) out(`(${others} non-Claude account${others === 1 ? "" : "s"} not shown)\n`);
  return 0;
}

function usageError(msg: string): number {
  process.stderr.write(`ms accounts: ${msg}\n${USAGE}\n`);
  return 2;
}

export async function accountsVerb(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const name = rest[0];
  if (sub && sub !== "add" && sub !== "ls" && !name) return usageError(`${sub} needs an account name`);
  switch (sub) {
    case "add":
      return cmdAdd(rest);
    case "login":
      return await cmdLogin(name!);
    case "verify":
      return await cmdVerify(name!);
    case "remove":
      return cmdRemove(name!);
    case "token":
      return cmdToken(name!);
    case "ls":
      return cmdLs();
    default:
      process.stderr.write(`${sub ? `ms accounts: unknown command '${sub}'\n` : ""}${USAGE}\n`);
      return 2;
  }
}
