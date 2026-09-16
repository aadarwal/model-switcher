// src/providers/claude-usage.ts
//
// The Claude **poll grant**: the profile-scoped OAuth credential a
// `claude auth login` mints into this tool's own CLAUDE_CONFIG_DIR
// (`claude/<name>/`, see src/paths.ts). It is the only credential that can
// read usage — a `claude setup-token` (the *launch* grant) is inference-scope
// only and 403s `oauth_scope_insufficient` on both endpoints below (verified
// live by the author's dashboard, 2026-09-14). This module reads that
// credential, refreshes it (writing the rotated token back to the credentials
// FILE — see `runSecurity` for why never to the keychain), and reads the
// account's usage windows and organisation.
//
// Endpoints, token URL, client id and the header set are COPIED VERBATIM from
// the author's working poller at data/lib/providers/claude.ts — the versions
// proven against these endpoints. Nothing here is invented, and this tool
// carries no OAuth client code of its own (spec §6).
//
// Error contract, for the callers that have to decide what to do next:
//   AuthError      the credential is dead — re-login (400/401/403, invalid_grant)
//   TransientError try again later (429, 5xx, timeouts, network, non-JSON);
//                  carries `retryAfterMs` when the response said how long
//   Error          anything else: neither retryable nor a reason to re-login
// No token or credential value ever appears in a message or a log line here;
// error text carries only a status and a URL path.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { p } from "../paths.ts";
import type { Window } from "../pick.ts";

// --- Proven constants (data/lib/providers/claude.ts) -------------------
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** The usage endpoint expects Claude Code's UA; other UAs land in an
 *  aggressively rate-limited bucket (anthropics/claude-code#31637) — copied
 *  from the dashboard provider along with the value. */
const USER_AGENT = "claude-code/2.1.220";
/** The OAuth beta header both endpoints and the token endpoint require. */
const OAUTH_BETA = "oauth-2025-04-20";
/** The service Claude Code stores the operator's OWN, unscoped login under.
 *  It is named here only so that nothing can ever ask `security` for it: that
 *  item is the human's ordinary `~/.claude` credential, and this tool has no
 *  business reading, writing or deleting it (`runSecurity` refuses). */
const UNSCOPED_KEYCHAIN_SERVICE = "Claude Code-credentials";
/** `security` can block forever on a locked keychain — a GUI prompt nobody
 *  will answer. Bounded exactly as data/lib/keychain.ts bounds it: a call that
 *  has not answered in time reads as "no keychain credential". */
const KEYCHAIN_TIMEOUT_MS = 3_000;

export class AuthError extends Error {
  override name = "AuthError";
}
export class TransientError extends Error {
  override name = "TransientError";
  /** What the endpoint asked us to wait, in milliseconds, when it said so
   *  (`retry-after` on a 429 or a 503). Advisory and unbounded-by-us beyond a
   *  day: a caller decides how long it is actually willing to sit out, and
   *  src/snapshot.ts clamps it to 15 minutes. Absent when the response carried
   *  no usable advice. */
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Nothing past this is advice worth carrying; `retry-after` is attacker- and
 *  accident-reachable, and a header must never be able to park an account for
 *  longer than the caller's own clamp would. */
const RETRY_AFTER_MAX_MS = 86_400_000;

/** `retry-after`, per RFC 9110 §10.2.3: either delta-seconds or an HTTP-date.
 *  Bounded parse — absent, malformed, non-positive or absurd all read as "no
 *  advice" (undefined) rather than as zero, so a caller can tell "wait this
 *  long" from "it did not say". */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const raw = value.trim();
  if (raw === "") return undefined;
  let ms: number;
  if (/^\d{1,9}$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return undefined;
    ms = at - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

const retryAfterOf = (res: Response): number | undefined => parseRetryAfter(res.headers.get("retry-after"));

export type PollCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  source: "file" | "keychain";
};
export type Usage = { session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null };
export type Profile = { email: string; orgId: string; orgName: string; tier: string | null };

// --- The scoped keychain item -----------------------------------------
//
// A `claude auth login` run with CLAUDE_CONFIG_DIR=<dir> writes NO
// `.credentials.json` in that dir: on macOS it stores the OAuth credential in
// the login keychain, as a generic password whose SERVICE is derived from the
// config dir and whose ACCOUNT is the macOS username. Verified live on this
// machine (2026-09-15): a login into `<MS_HOME>/claude/tulp` produced service
// `Claude Code-credentials-4f3610a9`, account `aadarwal`, and a `.claude.json`
// carrying the `oauthAccount` object beside it.
//
// So there is nothing to guess and nothing to attribute: the service NAMES the
// config dir, and this tool's config dirs are its own. A scoped service can
// never be the human's own item, and the unscoped service is never queried.

/** The scoped service for a config dir: the unscoped service name, a hyphen,
 *  and the first 8 lower-case hex characters of sha256 of the dir's absolute
 *  path — hashed exactly as the path is handed to CLAUDE_CONFIG_DIR (absolute,
 *  no trailing slash). Pure, and the one place this derivation exists. */
export function keychainServiceFor(configDir: string): string {
  return `${UNSCOPED_KEYCHAIN_SERVICE}-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

/** The generic-password item one account's poll grant lives in. */
export type KeychainItem = { service: string; account: string };

/** Is this service one of ours? Only a scoped one can be. The unscoped
 *  service is the human's own login; a service that is not scoped is never
 *  queried, written or deleted by this tool. */
export function isScopedKeychainService(service: string): boolean {
  return service.startsWith(`${UNSCOPED_KEYCHAIN_SERVICE}-`) && service.length > UNSCOPED_KEYCHAIN_SERVICE.length + 1;
}

/** Where `ms accounts login` records the item it found, so every reader, the
 *  refresh write-back and `remove` address exactly the same one. */
const keychainNoteFile = (dir: string) => path.join(dir, "keychain-item.json");

/** The recorded item for this config dir, or null. A note naming the unscoped
 *  service is not a note: it is refused HERE rather than at the call, so no
 *  file on disk can ever point a reader at the human's own credential. */
export function readKeychainNote(dir: string): KeychainItem | null {
  try {
    const j = JSON.parse(readFileSync(keychainNoteFile(dir), "utf8")) as Partial<KeychainItem>;
    if (typeof j.service !== "string" || typeof j.account !== "string" || !j.account) return null;
    if (!isScopedKeychainService(j.service)) return null;
    return { service: j.service, account: j.account };
  } catch {
    return null;
  }
}

/** Record it, 0600. Best-effort: a note that could not be written costs
 *  nothing, because the same pair is derivable from the dir. */
export function writeKeychainNote(dir: string, item: KeychainItem): boolean {
  try {
    writeFileSync(keychainNoteFile(dir), `${JSON.stringify(item)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The item this account's poll grant lives in: what `login` recorded, else
 *  the derivation. Never the unscoped service, by construction. */
export function keychainItemFor(name: string): KeychainItem {
  const dir = p.claudeConfigDir(name);
  return readKeychainNote(dir) ?? { service: keychainServiceFor(dir), account: userInfo().username };
}

/**
 * Every `security` call this tool makes goes through here, so the service is
 * checked exactly once: addressing the unscoped item is a programming error,
 * not a runtime condition, and throws rather than quietly reading the human's
 * own login. Bounded like every other call here — a locked keychain puts up a
 * GUI prompt nobody will answer.
 *
 * READS AND DELETES ONLY. Nothing here writes a secret to the keychain, and
 * nothing should, because there is no way to do it safely:
 *
 *   * `security add-generic-password -w <value>` (and `-X`) puts the secret on
 *     ARGV, where `ps` shows it to every process on the box;
 *   * `-w` given as the last option with no value makes `security` PROMPT and
 *     read the password off stdin instead — invisible to `ps`, but the prompt
 *     TRUNCATES AT 128 BYTES. Measured live on the author's Mac, 2026-09-16:
 *     a 300-byte value came back 128 bytes.
 *
 * A Claude poll grant is ~600 bytes, so ms 0.2.0's write-back through that
 * prompt destroyed every grant it refreshed — and because the token endpoint
 * rotates the refresh token, the value it replaced was already spent. Four
 * real grants went that way under one `ms doctor --fix`. A refreshed grant now
 * goes to the credentials file (`writeCredFile`), which `readPollCredentials`
 * prefers anyway, and the spent item is DELETED — addressed by service and
 * account, with no secret on the argv that does it.
 */
function runSecurity(verb: string, item: KeychainItem, extra: string[] = []) {
  if (!isScopedKeychainService(item.service)) {
    throw new Error(`refusing to address the keychain service "${item.service}": it is not scoped to a config dir`);
  }
  return spawnSync("security", [verb, "-s", item.service, "-a", item.account, ...extra], {
    encoding: "utf8",
    timeout: KEYCHAIN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `security`'s errSecItemNotFound — the ONLY status that means absent. */
const KEYCHAIN_NOT_FOUND = 44;

/** Tri-state on purpose: a spawn failure, or a timeout on a locked keychain,
 *  is "could not tell", which is not the same answer as "there is no item". */
export type KeychainProbe = "present" | "absent" | "unknown";

/** Is there an item? An EXISTENCE probe: no `-w`, so the secret is never asked
 *  for and never lands in this process. */
export function probeKeychainItem(item: KeychainItem): KeychainProbe {
  const r = runSecurity("find-generic-password", item);
  if (r.error) return "unknown";
  if (r.status === 0) return "present";
  if (r.status === KEYCHAIN_NOT_FOUND) return "absent";
  return "unknown";
}

/** The boolean the readers want: only a definite "present" is an item. */
export function keychainItemExists(item: KeychainItem): boolean {
  return probeKeychainItem(item) === "present";
}

/** The item's stored value, or null when it cannot be read. */
function readKeychainBlob(item: KeychainItem): string | null {
  const r = runSecurity("find-generic-password", item, ["-w"]);
  if (r.status !== 0 || !r.stdout?.trim()) return null;
  return r.stdout.trim();
}

/** Delete the scoped item — `ms accounts remove`'s last piece of cleanup.
 *  Best-effort: an item that was not there is not a failure to report. And it
 *  can only ever be this account's own item, never the human's login. */
export function deleteKeychainItem(item: KeychainItem): boolean {
  const r = runSecurity("delete-generic-password", item);
  return !r.error && r.status === 0;
}

// --- Reading the credential -------------------------------------------

function parseCredFile(txt: string): PollCredentials | null {
  const j = JSON.parse(txt) as {
    claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number };
  };
  const o = j.claudeAiOauth;
  if (!o?.accessToken || !o.refreshToken) return null;
  return { accessToken: o.accessToken, refreshToken: o.refreshToken, expiresAt: o.expiresAt ?? 0, source: "file" };
}

const credFile = (name: string) => path.join(p.claudeConfigDir(name), ".credentials.json");

/**
 * What a read of this account's poll grant found.
 *
 * `unreadable` is the third answer, and the one `readPollCredentials` cannot
 * give: the grant IS there, and what is in it is not the credentials JSON. ms
 * 0.2.0 made that state common — its keychain write-back went through
 * `security`'s 128-byte prompt (see `runSecurity`) — and it needs a different
 * word from the human than a grant that was never minted. One is a login to
 * redo; the other is a login never done.
 */
export type PollGrantRead =
  | { state: "ok"; cred: PollCredentials }
  | { state: "unreadable"; where: "file" | "keychain" }
  | { state: "absent" };

/** The poll grant for `name`: the credentials file first, then the SCOPED
 *  keychain item.
 *
 *  A login into a custom CLAUDE_CONFIG_DIR writes no file on macOS — the
 *  credential is a generic password whose service is derived from that dir
 *  (`keychainServiceFor`) and whose account is the macOS username. Both are
 *  derived, so there is no account string to guess and no way to read the
 *  human's own unscoped item. Never throws. */
export function readPollGrant(name: string): PollGrantRead {
  const f = credFile(name);
  if (existsSync(f)) {
    // The tool owns that dir: a present-but-unusable file is this account's
    // answer, never a reason to go looking in the keychain as well.
    try {
      const c = parseCredFile(readFileSync(f, "utf8"));
      return c ? { state: "ok", cred: c } : { state: "unreadable", where: "file" };
    } catch {
      return { state: "unreadable", where: "file" };
    }
  }
  const blob = readKeychainBlob(keychainItemFor(name));
  // Nothing readable under the item is "no grant": an absent item, a locked
  // keychain and a spawn failure all land here, and none of them is a payload
  // to call truncated.
  if (blob === null) return { state: "absent" };
  try {
    const c = parseCredFile(blob);
    return c ? { state: "ok", cred: { ...c, source: "keychain" } } : { state: "unreadable", where: "keychain" };
  } catch {
    return { state: "unreadable", where: "keychain" };
  }
}

/** The usable grant, or null — for every caller that has nothing different to
 *  do about an unreadable one than about a missing one. */
export function readPollCredentials(name: string): PollCredentials | null {
  const r = readPollGrant(name);
  return r.state === "ok" ? r.cred : null;
}

// --- Refresh, with write-back -----------------------------------------

/** One line on stderr under MS_VERBOSE, never a token. The write-back is a
 *  note, not an error (the dashboard learned this — an errored account drops
 *  out of the pool), but a credential that moved, or one that could not, is
 *  worth saying when someone asked to be told. */
function verbose(text: string): void {
  if (process.env.MS_VERBOSE === "1") console.error(`ms: ${text} (No token value is ever logged.)`);
}

/**
 * Put the refreshed credential back — in the CREDENTIALS FILE, always.
 *
 * Best-effort, never throws: a refresh that landed must not be lost to a write
 * problem. The caller holds the fresh credential in memory either way.
 *
 * Not writing it back at all is what a resident process can afford and a
 * one-shot `ms` cannot: the token endpoint ROTATES the refresh token, so the
 * credential we were handed is spent the moment we exit, and the next poll
 * reads the old one, gets `invalid_grant`, and the account drops out of the
 * pool until a re-login.
 *
 * The file — not the keychain item it may have come from — because there is no
 * safe way to write a ~600-byte secret through `security` (see `runSecurity`:
 * argv is world-readable, and the stdin prompt truncates at 128 bytes). The
 * file is not a second-best copy: it is what `readPollCredentials` prefers, so
 * it is where the credential now lives. Once it is there and reads back, the
 * item it came from holds nothing but a spent grant, and is deleted.
 */
function writeBack(name: string, c: PollCredentials): boolean {
  if (!writeCredFile(name, c)) {
    // The keychain item is left exactly as it was. Its grant is spent, but a
    // spent grant a re-login can replace beats no grant at all, and this run
    // still has the fresh credential in memory. `writeCredFile` has already
    // said so on stderr.
    if (c.source === "keychain") {
      verbose(
        `the refreshed Claude poll grant for ${name} could not be written to ${credFile(name)}, ` +
          `so the keychain item it came from is left untouched and the refreshed credentials are ` +
          `used in memory for this run only.`,
      );
    }
    return false;
  }
  if (c.source === "keychain") retireKeychainItem(name, c);
  return true;
}

/**
 * Delete the keychain item this grant came from, once the file it moved to
 * reads back as the credential we just wrote.
 *
 * Re-reading first is the whole safety of it: a delete on an unverified write
 * takes the only copy with it. Once the file answers, the item holds a SPENT
 * refresh token and nothing will read it again on purpose — but a spent
 * credential that can still be read is one that can still be sent to the token
 * endpoint, so it goes. Best effort: an item that would not delete is not a
 * refresh to fail over.
 */
function retireKeychainItem(name: string, c: PollCredentials): void {
  const back = readPollGrant(name);
  if (back.state !== "ok" || back.cred.source !== "file") return;
  if (back.cred.refreshToken !== c.refreshToken || back.cred.accessToken !== c.accessToken) return;
  deleteKeychainItem(keychainItemFor(name));
  verbose(
    `the refreshed Claude poll grant for ${name} now lives in ${credFile(name)} (0600), ` +
      `where the poller looks first; the spent keychain item has been removed.`,
  );
}

/** Atomic (temp + rename), 0600, never throws. */
function writeCredFile(name: string, c: PollCredentials): boolean {
  const f = credFile(name);
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    // The dir may not exist yet for a keychain-held grant that has never been
    // written to a file. 0700 on creation only — an existing dir's mode is the
    // store's business (`ensureStore`), not this write's.
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    // Keep every other key in the file (Claude Code owns the rest of it).
    let j: Record<string, unknown> = {};
    if (existsSync(f)) {
      const parsed: unknown = JSON.parse(readFileSync(f, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
    }
    const prev = (j.claudeAiOauth ?? {}) as Record<string, unknown>;
    j.claudeAiOauth = { ...prev, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt };
    writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
    renameSync(tmp, f);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* nothing more to do */
    }
    // The path is the operator's own machine, not a secret; the token is never
    // named. One line on stderr so a stranded refresh token is not silent.
    console.error(
      `ms: could not write refreshed Claude credentials back to ${f} — ` +
        `using them in memory for this run only. (No token value is ever logged.)`,
    );
    return false;
  }
}

/** The token endpoint's success body, as far as this file uses it. */
type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

/** `invalid_grant` anywhere in a token-endpoint body means the refresh token is
 *  spent or revoked — an auth failure whatever the status says. The body is
 *  only ever inspected, never echoed. */
function isInvalidGrant(body: string): boolean {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    return j?.error === "invalid_grant";
  } catch {
    return false;
  }
}

/** Classifies a thrown `fetch`. Deadline reached ⇒ TransientError; a network
 *  fault ⇒ TransientError; but a caller-initiated abort is **cancellation**,
 *  not a transient failure, so its own reason is rethrown here (returning a
 *  TransientError would tell the caller "try again" about a call it cancelled
 *  itself, and would hide its reason). */
function transientFromFetchError(err: unknown, what: string, signal: AbortSignal): TransientError {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    const reasonName = reason instanceof Error ? reason.name : "";
    if (reasonName !== "TimeoutError") throw reason ?? err;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new TransientError(`${what} timed out`);
  return new TransientError(`${what} could not be reached`);
}

/** Exchange the refresh token for a fresh access token and write the result to
 *  the credentials file, retiring the keychain item it came from (see
 *  `writeBack`).
 *  Throws AuthError when the grant is dead, TransientError when it is worth
 *  trying again. */
export async function refreshPollCredentials(
  name: string,
  c: PollCredentials,
  signal: AbortSignal,
): Promise<PollCredentials> {
  let res: Response;
  try {
    res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      signal,
      // Header set copied from data/lib/providers/claude.ts.
      headers: { "Content-Type": "application/json", "anthropic-beta": OAUTH_BETA },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: c.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw transientFromFetchError(err, "the token endpoint", signal);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (isInvalidGrant(body)) throw new AuthError("refresh rejected: invalid_grant");
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AuthError(`refresh rejected (${res.status})`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TransientError(`refresh failed (${res.status})`, retryAfterOf(res));
    }
    throw new Error(`refresh failed (${res.status})`);
  }

  // A 200 whose body isn't JSON (a captive portal, a proxy's error page) is a
  // transient network condition, not a dead grant. The body is never surfaced.
  const raw = await res.text().catch(() => "");
  let j: TokenResponse;
  try {
    j = JSON.parse(raw) as TokenResponse;
  } catch {
    throw new TransientError("token endpoint returned non-JSON");
  }
  if (j.error === "invalid_grant") throw new AuthError("refresh rejected: invalid_grant");
  // A 200 with no access_token would mint a credential the next usage call
  // rejects with a 401 — which is exactly what happened before the dashboard
  // named this shape.
  if (!j.access_token) throw new TransientError("token endpoint returned no access token");

  const next: PollCredentials = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? c.refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    source: c.source,
  };
  writeBack(name, next);
  return next;
}

// --- The two authenticated reads --------------------------------------

async function authed(url: string, c: PollCredentials, signal: AbortSignal): Promise<unknown> {
  const where = new URL(url).pathname;
  let res: Response;
  try {
    // Header set copied from data/lib/providers/claude.ts, per endpoint: there
    // the usage call alone also carries Content-Type. Both sets are the proven
    // ones, so neither is "tidied" here.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${c.accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": USER_AGENT,
    };
    if (url === CLAUDE_USAGE_URL) headers["Content-Type"] = "application/json";
    res = await fetch(url, { signal, headers });
  } catch (err) {
    throw transientFromFetchError(err, where, signal);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new AuthError(`${res.status} from ${where}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new TransientError(`${res.status} from ${where}`, retryAfterOf(res));
  }
  if (!res.ok) throw new Error(`${res.status} from ${where}`);
  const raw = await res.text().catch(() => "");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TransientError(`non-JSON body from ${where}`);
  }
}

/** One limit as the endpoint reports it. The live API names the fields
 *  `percent` and `scope.model.display_name` (what the author's dashboard
 *  reads); `used_percent`/`display_name` are the flatter form. Both are
 *  accepted — reading only one would report every window as 0 %, which the
 *  chooser reads as "plenty of room". */
type RawLimit = {
  kind?: string;
  percent?: number;
  used_percent?: number;
  display_name?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
  resets_at?: string | null;
};

// The attested names come first: `percent` and `scope.model.display_name` are
// what the author's working poller reads off the live endpoint today.
// `used_percent`/`display_name` are unattested aliases (the brief's flatter
// form) and are only consulted when the attested field is absent.
const limitPercent = (l: RawLimit): number => Number(l.percent ?? l.used_percent ?? NaN);
const limitDisplayName = (l: RawLimit): string => l.scope?.model?.display_name ?? l.display_name ?? "";

/** The three windows the chooser needs, raw: `usedPercent` is never rounded
 *  (99.6 is not 100 — src/pick.ts gates on exactly 100). A window the account
 *  does not have stays null; pick.ts has its own reasons for that. */
export async function fetchUsage(c: PollCredentials, signal: AbortSignal): Promise<Usage> {
  const j = (await authed(CLAUDE_USAGE_URL, c, signal)) as { limits?: RawLimit[] };
  const u: Usage = { session: null, weeklyAll: null, weeklyFable: null };
  // A `limits` that is not an array (an older or unexpected shape) is "no
  // windows", never a crash: pick.ts already has reasons for a missing window.
  const limits = Array.isArray(j?.limits) ? j.limits : [];
  for (const l of limits) {
    const w: Window = { usedPercent: limitPercent(l), resetsAt: l.resets_at ?? null };
    if (l.kind === "session") u.session = w;
    else if (l.kind === "weekly_all") u.weeklyAll = w;
    else if (l.kind === "weekly_scoped" && /fable/i.test(limitDisplayName(l))) u.weeklyFable = w;
  }
  return u;
}

/** The account behind this grant. `orgId` is the identity the registry keys on
 *  (spec §6: "identity is the organisation id"); an email can span orgs. */
export async function fetchProfile(c: PollCredentials, signal: AbortSignal): Promise<Profile> {
  const j = (await authed(CLAUDE_PROFILE_URL, c, signal)) as {
    account?: { email?: string };
    organization?: { uuid?: string; name?: string; rate_limit_tier?: string };
  };
  return {
    email: j?.account?.email ?? "",
    orgId: j?.organization?.uuid ?? "",
    orgName: j?.organization?.name ?? "",
    tier: j?.organization?.rate_limit_tier ?? null,
  };
}
