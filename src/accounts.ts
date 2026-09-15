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
//   * every child process is bounded, by `timeout` (spawnSync) or by a killed
//     timer (spawn);
//   * a secret travels only in `env`, never on argv (argv is world-readable
//     via `ps`), and never reaches a log, a message or a forwarded line —
//     `ms accounts token` is the single verb that puts a token on stdout,
//     because that is its whole job;
//   * a credential is never *attributed* to an account it was not minted for:
//     see `locatePollCredential`, which is the delicate part of this file.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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
/** The launch token's fixed prefix, used to hold back a half-arrived token
 *  and to redact one that shares a line with something else. */
const TOKEN_PREFIX = "sk-ant-oat01-";

/** The candidate forms of the keychain `acct` string Claude Code uses for a
 *  custom CLAUDE_CONFIG_DIR. The true form is confirmed by the live matrix;
 *  until then every known shape is probed and the one that answers is recorded
 *  in `claude/<name>/keychain-account`. THIS LIST IS THE ONE EDIT POINT.
 *
 *  `scoped` is the safety property, not a detail: a scoped form embeds this
 *  account's own config dir, so an item answering under it can only be this
 *  account's. A form that does NOT (the bare macOS username) is exactly the
 *  account string the operator's ordinary `~/.claude` login already uses, so
 *  it is accepted only when it did not answer before this login created it. */
const KEYCHAIN_ACCOUNT_FORMS: { scoped: boolean; build: (user: string, dir: string) => string }[] = [
  { scoped: false, build: (user) => user },
  { scoped: true, build: (user, dir) => `${user}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}` },
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
function redact(s: string): string {
  return s.replace(new RegExp(`${TOKEN_PREFIX}[A-Za-z0-9_-]+`, "g"), `${TOKEN_PREFIX}<redacted>`);
}

/** Could this unterminated output still become a token line? Used to hold
 *  back a half-arrived token while letting a prompt without a trailing
 *  newline (`Paste the token: `) reach the human immediately. */
function couldBeTokenStart(s: string): boolean {
  const t = s.trimStart();
  if (!t) return false;
  return t.length < TOKEN_PREFIX.length ? TOKEN_PREFIX.startsWith(t) : t.startsWith(TOKEN_PREFIX);
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
 *  its prompts on either and its answer on either. Every line that is not a
 *  token is forwarded to the human's stderr AS IT ARRIVES, so the browser and
 *  paste prompts stay visible; a token line is captured and never forwarded,
 *  and anything else that happens to carry a token is redacted first. stdin
 *  stays with the human so a paste prompt still works. */
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
        return; // never forwarded
      }
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
      // An unterminated prompt reaches the human now; a half-arrived token waits.
      if (pending[which] && !couldBeTokenStart(pending[which])) {
        forward(pending[which]);
        pending[which] = "";
      }
    };
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

const keychainNoteFile = (dir: string) => path.join(dir, "keychain-account");

function readKeychainNote(dir: string): string | null {
  const f = keychainNoteFile(dir);
  if (!existsSync(f)) return null;
  try {
    return readFileSync(f, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Does an item exist under this account string? An EXISTENCE probe: no `-w`,
 *  so the secret is never asked for and never lands in this process. */
function keychainItemExists(acct: string): boolean {
  const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", acct], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: KEYCHAIN_TIMEOUT_MS,
  });
  return !r.error && r.status === 0;
}

function candidateAccounts(dir: string): { acct: string; scoped: boolean }[] {
  const user = userInfo().username;
  const all = KEYCHAIN_ACCOUNT_FORMS.map((f) => ({ acct: f.build(user, dir), scoped: f.scoped }));
  // Scoped forms first: an item that names this dir is attributable outright,
  // so it should win over one that merely appeared at the right moment.
  return [...all.filter((c) => c.scoped), ...all.filter((c) => !c.scoped)];
}

/** Which UNATTRIBUTABLE candidates already answer, taken BEFORE
 *  `claude auth login`. The bare-username form is the same account string the
 *  operator's own default Claude Code login uses: without this snapshot a new
 *  account would silently bind to that pre-existing credential — polling the
 *  wrong organisation's usage, or being refused as a duplicate of an account
 *  it has nothing to do with. */
function snapshotAmbientAccounts(dir: string): Set<string> {
  const seen = new Set<string>();
  for (const c of candidateAccounts(dir)) if (!c.scoped && keychainItemExists(c.acct)) seen.add(c.acct);
  return seen;
}

/** Point this account at the credential its login actually produced.
 *
 *  `ambient` is the pre-login snapshot (null when no login was run, as in
 *  `verify`). A candidate is accepted when it is scoped to this config dir,
 *  or when it did not answer before this login and does now. An existing note
 *  that still answers is honoured untouched — it may record a form the live
 *  CLI uses that `KEYCHAIN_ACCOUNT_FORMS` does not know. */
function locatePollCredential(name: string, dir: string, ambient: Set<string> | null): void {
  if (existsSync(path.join(dir, ".credentials.json"))) return;
  const note = readKeychainNote(dir);
  if (note && keychainItemExists(note)) return;
  let unattributable: string | null = null;
  for (const c of candidateAccounts(dir)) {
    if (!keychainItemExists(c.acct)) continue;
    if (c.scoped || (ambient !== null && !ambient.has(c.acct))) {
      writeFileSync(keychainNoteFile(dir), `${c.acct}\n`, { mode: 0o600 });
      return;
    }
    unattributable ??= c.acct;
  }
  const why = unattributable
    ? `the only keychain item that answered under "${KEYCHAIN_SERVICE}" (account ${unattributable}) ` +
      `already existed before this login, so it cannot be attributed to ${dir} — it is almost certainly ` +
      `your ordinary Claude Code login, and binding ${name} to it would poll the wrong account`
    : `neither ${path.join(dir, ".credentials.json")} nor any known keychain account under "${KEYCHAIN_SERVICE}"`;
  throw new Error(`could not locate the poll credential for ${name} — ${why}`);
}

/** Is there a poll grant on disk for this account? Existence only — `ls` has
 *  no business pulling a secret out of the keychain to fill in a column. */
function hasPollGrant(name: string): boolean {
  const dir = p.claudeConfigDir(name);
  try {
    if (statSync(path.join(dir, ".credentials.json")).isFile()) return true;
  } catch {
    /* no file; try the recorded keychain account */
  }
  const note = readKeychainNote(dir);
  return note !== null && keychainItemExists(note);
}

/** The organisation behind the poll grant. Refreshes when the access token is
 *  spent, and once more if the profile read says the credential is stale. */
async function readProfile(name: string): Promise<Profile> {
  let c: PollCredentials | null = readPollCredentials(name);
  if (!c) throw new Error(`no poll grant for ${name} — run: ms accounts login ${name}`);
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
function checkLaunchToken(
  name: string,
  token: string,
  profile: Profile,
): { verified: boolean; probe: { ok: boolean; detail: string } } {
  const scratch = scratchConfigDir();
  try {
    const probe = probeLaunchToken(token, scratch);
    if (!probe.ok) return { verified: false, probe };
    const org = organisationFromLaunchToken(token, scratch);
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
    else if (a.startsWith("-")) throw new UsageError(`add: unknown option ${a}`, true);
    else if (name === null) name = a;
    else throw new UsageError(`add: unexpected argument ${a}`, true);
  }
  if (!name) throw new UsageError("add needs an account name", true);
  if (!NAME_PATTERN.test(name)) {
    throw new UsageError(`'${name}' is not a usable account name (lower-case letters, digits, '-' and '_', up to 32)`);
  }
  if (label !== null && !label.trim()) throw new UsageError("--label needs a value", true);
  const r = load();
  if (findAccount(r.registry, name, "claude")) throw new UsageError(`${name} is already registered`);
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
  // Before the login, so "which keychain item is new?" is answerable after it.
  const ambient = snapshotAmbientAccounts(dir);
  let profile: Profile;
  try {
    runAuthLogin(name, dir);
    locatePollCredential(name, dir, ambient);
    // Identity (and the duplicate refusal) before a token is ever minted: a
    // refused account must leave nothing behind.
    profile = await identifyOrRefuse(name);
  } catch (e) {
    // A refusal undoes this run's own work: without this, the credential the
    // browser login just wrote would keep answering, and `ms accounts ls`
    // would report a poll grant for an account that was turned away. Only a
    // dir this run created is ours to delete. (A keychain-held credential
    // survives: deleting the item could revoke the very grant the OTHER
    // account polls with — the recorded `keychain-account` note goes, which
    // is what makes it unreadable here.)
    if (e instanceof DuplicateOrganisation && created) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  // The organisation is a fact about the grant now on disk: record it before
  // the mint, and never leave a stale verdict standing beside a fresh org.
  update(name, { orgId: profile.orgId, identityVerified: false });
  const token = await mintLaunchToken(name, dir);
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
  // created, and with no login to bracket there is no ambient snapshot — so
  // only a dir-scoped form, or a note that still answers, is acceptable.
  const dir = p.claudeConfigDir(name);
  if (existsSync(dir)) locatePollCredential(name, dir, null);
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
  if (i < 0) throw new UsageError(`no such Claude account: ${name}`);
  // Credentials first: a row is what NAMES them, so dropping the row before
  // the files could strand a token and a config dir nothing points at.
  deleteLaunchToken(name);
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

function cmdLs(): number {
  const r = load();
  const claude = r.registry.accounts.filter((a) => a.provider === "claude");
  const rows = [["NAME", "LABEL", "ORG", "POLL", "TOKEN", "VERIFIED"]];
  for (const a of claude) {
    rows.push([
      a.name,
      a.label,
      a.orgId ?? "-",
      hasPollGrant(a.name) ? "yes" : "no",
      existsSync(p.launchToken(a.name)) ? "yes" : "no",
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

export async function accountsVerb(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const name = rest[0];
  try {
    if (sub && sub !== "add" && sub !== "ls" && !name) {
      throw new UsageError(`${sub} needs an account name`, true);
    }
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
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`ms accounts: ${e.message}\n${e.showUsage ? `${USAGE}\n` : ""}`);
    return 2;
  }
}
