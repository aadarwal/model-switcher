// src/snapshot.ts
//
// The coalesced usage snapshot (spec §9).
//
// Many short-lived `ms` processes want the same numbers at the same moment: a
// launch choosing an account, a hook-dispatched recovery worker rotating a
// walled pane, a human running `ms status`. Sixty simultaneous walls must
// produce one poll per account, not sixty — the usage endpoint rate-limits,
// and sixty refreshes of one credential would spend each other's grant.
//
// Three mechanisms do it, and none of them is a daemon:
//
//   * across processes — the `snapshot` lock plus a freshness check. Whoever
//     takes the lock polls and writes the file; everyone else waits, then
//     finds the file fresh and returns it without a call of their own. A
//     waiter that runs out of patience serves the last file rather than
//     stampeding (a stale reading beats a duplicate poll beats an exception).
//   * inside one process — one in-flight promise per request shape, so a
//     process that asks twice before the first answer arrives shares it.
//   * per credential — `account-<provider>-<name>`, held across a refresh,
//     because the token endpoint rotates the refresh token and two processes
//     spending one grant leave the loser holding a dead one.
//
// LOCK ORDERING: `snapshot` is always taken BEFORE `account-<provider>-<name>`,
// never the other way round. Anything that holds an account lock (`ms accounts
// login`) must not then ask for the snapshot. Both locks are bounded waits, so
// a violation degrades to a `Locked` — classified transient here — rather than
// hanging, but the order is the contract.
//
// IDENTITY: an account is `(provider, name)`, never `name` alone — the registry
// deliberately allows `claude:work` and `codex:work` to coexist. Every map and
// every key in this file, including the cache file's `backoff` record, is
// `"<provider>:<name>"`. Keying on the bare name silently merged the two rows
// and dropped a live Claude account out of the pool.
//
// The file (0600, written temp+rename) is the whole of the shared state:
// `{ takenAt, accounts, backoff }`, where `backoff` maps `"<provider>:<name>"`
// to the epoch-millisecond instant that account may be polled again. That
// window is bounded at 15 minutes when written AND when read, so neither a
// hostile `retry-after` nor a clock jump can pin an account out for a day.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";
import { Locked, withLock } from "./lock.ts";
import { loadRegistry, type Account, type Provider } from "./registry.ts";
import { openState } from "./state.ts";
import type { PickInput } from "./pick.ts";
import {
  AuthError,
  TransientError,
  fetchUsage,
  readPollCredentials,
  refreshPollCredentials,
  type PollCredentials,
  type Usage,
} from "./providers/claude-usage.ts";
import { CodexAuthError, codexAccessTokenExpiryMs, fetchCodexUsage, readCodexCredentials, refreshCodexCredentials, type CodexAuth } from "./providers/codex-usage.ts";

export type ErrorKind = "auth" | "transient" | "other";

/** One account as the last poll left it.
 *
 *  `observedAt` is the time of the last SUCCESSFUL read — carried over when
 *  this round failed — so `usage` and its age are always the same reading, and
 *  null when there has never been one. `stale` says this round did not refresh
 *  the row: a backoff, a failed poll, a scoped poll that skipped it, or a
 *  snapshot served while another process held the lock. A stale row is not
 *  wrong, it is old, and `toPickInputs` is where that stops being good enough. */
export type AccountUsage = {
  name: string;
  provider: Provider;
  shared: boolean;
  usage: Usage | null;
  error: string | null;
  errorKind: ErrorKind | null;
  observedAt: number | null;
  stale: boolean;
};

/** `takenAt` is null only when nothing has ever been written: a snapshot
 *  served while another process polls, with no cache file to serve from.
 *  `registryError` is accounts.json being unreadable — the one condition
 *  under which an empty `accounts` means "could not look", not "none". */
export type Snapshot = {
  takenAt: number | null;
  accounts: AccountUsage[];
  registryError: string | null;
};

export type SnapshotOptions = {
  /** Serve the cache file when it is younger than this. Default 20 s; 0
   *  forces a poll. */
  maxAgeMs?: number;
  /** Poll (and return) only accounts with these NAMES — both providers' rows
   *  when a name is registered twice. Accounts left out keep their last
   *  reading in the file, marked stale. */
  only?: string[];
  /** How long to wait for another process's poll before giving up and serving
   *  the last file. Default: long enough to outlast that poll. A caller that
   *  cannot block (a launch on a hook's clock) can ask for less. */
  lockWaitMs?: number;
};

/** The cache file: the rows plus the per-account retry timers. `registryError`
 *  is deliberately NOT persisted — it describes this moment's read of
 *  accounts.json, and a fixed registry must not keep reporting an old fault. */
type CacheFile = { takenAt: number; accounts: AccountUsage[]; backoff: Record<string, number> };

export const DEFAULT_MAX_AGE_MS = 20_000;
/** Per-account wall clock for the whole refresh+read, per spec §9. */
export const POLL_TIMEOUT_MS = 15_000;
/** Refresh a grant that would expire mid-flight rather than eat a 401. */
export const REFRESH_SKEW_MS = 60_000;
export const DEFAULT_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 900_000;
/** How long a reading goes on being evidence once it stops being current —
 *  whether it stopped because a poll failed or because nothing re-read it. */
export const MAX_READING_AGE_MS = 600_000;
/** Long enough to outlast the holder's own poll, so waiting beats stampeding. */
const LOCK_WAIT_MS = POLL_TIMEOUT_MS + 5_000;
const LOCK = "snapshot";

/** The identity of an account, everywhere: provider first, then name. */
const keyOf = (a: { provider: Provider; name: string }): string => `${a.provider}:${a.name}`;
/** The credential lock's name. `-` not `:`, because src/lock.ts's name pattern
 *  admits only `[A-Za-z0-9_-]` — a name it rejects would throw, not lock. */
const lockOf = (a: { provider: Provider; name: string }): string => `account-${a.provider}-${a.name}`;
const whoOf = (a: Account) => ({ name: a.name, provider: a.provider, shared: a.shared });

// --- The cache file ----------------------------------------------------

function isKind(v: unknown): v is ErrorKind {
  return v === "auth" || v === "transient" || v === "other";
}

/** The file is ours and 0600, but it can still be torn by a crash mid-write on
 *  a filesystem that does not give us the rename atomically, or be left over
 *  from an older shape. Anything unrecognisable reads as "no cache", which
 *  costs a poll and never an exception. */
function parseEntry(v: unknown): AccountUsage | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (typeof e.name !== "string") return null;
  if (e.provider !== "claude" && e.provider !== "codex") return null;
  const seen = e.observedAt;
  if (seen !== null && (typeof seen !== "number" || !Number.isFinite(seen))) return null;
  return {
    name: e.name,
    provider: e.provider,
    shared: e.shared === true,
    usage: e.usage && typeof e.usage === "object" ? (e.usage as Usage) : null,
    error: typeof e.error === "string" ? e.error : null,
    errorKind: isKind(e.errorKind) ? e.errorKind : null,
    observedAt: seen,
    stale: e.stale === true,
  };
}

function readCache(): CacheFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p.snapshot, "utf8"));
  } catch {
    return null; // absent, unreadable or torn — all mean "poll"
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.takenAt !== "number" || !Number.isFinite(o.takenAt)) return null;
  if (!Array.isArray(o.accounts)) return null;
  const accounts: AccountUsage[] = [];
  for (const row of o.accounts) {
    const e = parseEntry(row);
    if (e) accounts.push(e);
  }
  const backoff: Record<string, number> = {};
  if (o.backoff && typeof o.backoff === "object" && !Array.isArray(o.backoff)) {
    for (const [k, until] of Object.entries(o.backoff as Record<string, unknown>)) {
      if (typeof until === "number" && Number.isFinite(until)) backoff[k] = until;
    }
  }
  return { takenAt: o.takenAt, accounts, backoff };
}

/**
 * The last reading on disk, and nothing else: no lock, no registry read, no
 * poll, no network. Returns `[]` when the cache is absent, unreadable or torn.
 *
 * This exists for callers that want to know how close to a wall the fleet was
 * the last time anybody looked, but must not cause a look. `getSnapshot` is
 * not that: even `maxAgeMs: Infinity` polls when the file does not cover an
 * account the registry has since gained, and it takes the snapshot lock to
 * find out. The Codex watchdog uses this to choose how often to wake up, on a
 * hook's clock and inside the tmux server — neither of which may block on the
 * network. It is deliberately NOT how anything DECIDES: `toPickInputs` and its
 * ten-minute age rule are still the only way a reading becomes a choice.
 */
export function cachedAccounts(): AccountUsage[] {
  return readCache()?.accounts ?? [];
}

function writeCache(file: CacheFile): void {
  ensureStore();
  const tmp = `${p.snapshot}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    // Only ever percentages, reset times and error strings: no credential of
    // any kind reaches this file (test/snapshot.test.ts pins that).
    writeFileSync(tmp, JSON.stringify(file) + "\n", { mode: 0o600 });
    renameSync(tmp, p.snapshot);
  } catch {
    // A snapshot we cannot persist is still a snapshot this process can use;
    // the only cost is that the next process polls again. Nothing here is
    // worth failing a launch for.
    rmSync(tmp, { force: true });
  }
}

// --- Error classification and backoff ----------------------------------

const errName = (err: unknown): string => {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : "";
};

const errMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)) || "poll failed";

/** A socket-level failure: undici reports these as a TypeError whose `cause`
 *  carries the errno. Worth retrying, and never a reason to re-login. */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const own = (err as NodeJS.ErrnoException).code;
  const caused = (err.cause as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof own === "string" ? own : caused;
  if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return true;
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** The provider already sorts its own failures into AuthError/TransientError;
 *  this also matches on `name`, so an error that crossed a module boundary is
 *  not silently demoted to "other". */
export function classify(err: unknown): ErrorKind {
  if (err instanceof AuthError) return "auth";
  if (err instanceof TransientError) return "transient";
  const n = errName(err);
  if (n === "AuthError") return "auth";
  // `Locked`: another process holds this account's credential lock. Busy is
  // temporary, and never a reason to tell the human to log in again.
  if (n === "TransientError" || n === "AbortError" || n === "TimeoutError" || n === "Locked") return "transient";
  if (isNetworkError(err)) return "transient";
  return "other";
}

/** How long to leave a transiently-failed account alone. A 429 or 503 that
 *  named a `retry-after` is honoured up to the clamp (the provider parses the
 *  header onto `TransientError.retryAfterMs`); anything else waits a minute.
 *  The clamp is the point: an endpoint asking for a day must not take an
 *  account out of the pool for a day. */
export function backoffMs(err: unknown): number {
  const raw = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  const asked = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKOFF_MS;
  return Math.min(asked, MAX_BACKOFF_MS);
}

// --- Polling one account -----------------------------------------------

/**
 * Refresh under the per-account credential lock (spec §9's pool coordination).
 *
 * The token endpoint ROTATES the refresh token, so two processes refreshing
 * one grant spend each other's: the loser gets `invalid_grant` back, which
 * reads as a dead account needing a login. The snapshot lock already keeps two
 * pollers apart; this one also covers everything else that refreshes the same
 * grant outside a poll (`ms accounts login`, a launch warming a token).
 *
 * Re-reading inside the lock is the other half of it: whoever we waited for
 * has just written a fresh credential where we found the stale one, so the
 * common case costs no network call at all. The wait is bounded by this
 * account's own poll budget — sitting longer than the poll may run would be
 * spending a deadline we do not have.
 */
async function refreshGrant(a: Account, c: PollCredentials, signal: AbortSignal): Promise<PollCredentials> {
  return await withLock(
    lockOf(a),
    async () => {
      const latest = readPollCredentials(a.name) ?? c;
      if (latest.expiresAt >= Date.now() + REFRESH_SKEW_MS) return latest;
      return await refreshPollCredentials(a.name, latest, signal);
    },
    { waitMs: POLL_TIMEOUT_MS },
  );
}

async function pollClaudeUsage(a: Account, signal: AbortSignal): Promise<Usage> {
  let c = readPollCredentials(a.name);
  if (!c) {
    // Launchable-but-unpollable is the two-credential model's normal state
    // (spec §6), and the fix is a login, not a retry — so: auth, no backoff.
    throw new AuthError(`no poll grant (run: ms accounts login ${a.name})`);
  }
  if (c.expiresAt < Date.now() + REFRESH_SKEW_MS) c = await refreshGrant(a, c, signal);
  return await fetchUsage(c, signal);
}

// --- Polling one Codex account ------------------------------------------

/**
 * How close to its own expiry an access token has to be before a poll spends
 * the refresh token on it. Sixty seconds, from the proven poller
 * (data/lib/providers/openai.ts): `if (expiry !== null && expiry < Date.now()
 * + 60_000)`.
 *
 * The trigger is the TOKEN'S OWN `exp`, never how long ago it was last
 * refreshed. A 55-minute age test refreshed every idle account on the first
 * poll after 55 minutes — from `status --watch`, from every launch, from
 * every recovery, roughly 26 times a day each — for a token that was valid
 * for days, and each of those rotates the refresh token under every other
 * copy of the same `auth.json`. A token that carries no readable `exp` is
 * left alone: "the token does not say" is answered by a 401, below, not by a
 * clock.
 */
export const CODEX_REFRESH_SKEW_MS = 60_000;

function codexRefreshDue(auth: CodexAuth): boolean {
  const exp = codexAccessTokenExpiryMs(auth);
  return exp !== null && exp < Date.now() + CODEX_REFRESH_SKEW_MS;
}

/** The session states in which a `codex` process is actually holding this
 *  account's `auth.json`. `launching` (a pane about to start `codex` against
 *  this grant) and `walled` (a CLI sitting at its wall, not yet handed off)
 *  both still hold the file, exactly like `running`/`continuing`/`resuming`/
 *  `stopping` — fix-A-report.md's A-I3 flag. `parked` and `waiting` are NOT
 *  among them — both are sessions with nothing running — and counting them
 *  as live is how one lingering parked row used to block every refresh for
 *  an account until its token died and the account read `auth`. (`stopped`
 *  was never counted.) */
const CODEX_LIVE_STATES: ReadonlySet<string> = new Set([
  "running",
  "continuing",
  "resuming",
  "stopping",
  "launching",
  "walled",
]);

/** True when no managed Codex session for this account is still using its
 *  grant. A state read that fails (locked db, anything) answers false — the
 *  conservative side, since spending the one-shot refresh token on a guess is
 *  worse than polling one round on a slightly stale access token.
 *
 *  The G2 spike (whether a running `codex` tolerates its on-disk grant
 *  rotating under it) has not run yet; this guard is what stands in for its
 *  verdict, and a PASS deletes it. */
function codexRefreshAllowed(name: string): boolean {
  try {
    const state = openState();
    try {
      return !state.listSessions().some((s) => s.provider === "codex" && s.account === name && CODEX_LIVE_STATES.has(s.state));
    } finally {
      state.close();
    }
  } catch {
    return false;
  }
}

/**
 * Rotate this account's grant under its own credential lock.
 *
 * Re-reading inside the lock is half the point: whoever we waited for has
 * just written a fresh credential where we found the stale one. The session
 * guard is re-checked in there too when it applies — the caller's check runs
 * BEFORE the lock is even requested, so a session can start in the gap, and
 * only a re-check made while holding the lock can see it.
 */
async function refreshCodexGrant(a: Account, dir: string, auth: CodexAuth, signal: AbortSignal): Promise<CodexAuth> {
  return await withLock(
    lockOf(a),
    async () => {
      const latest = readCodexCredentials(dir) ?? auth;
      if (!codexRefreshDue(latest) || !codexRefreshAllowed(a.name)) return latest;
      return await refreshCodexCredentials(dir, latest, signal);
    },
    { waitMs: POLL_TIMEOUT_MS },
  );
}

/**
 * The 401 answer: refresh once, and once only.
 *
 * The live-session guard deliberately does NOT apply here. It exists to avoid
 * pulling a working token out from under a running `codex`, and a token the
 * endpoint has just refused is not a working token — whoever is holding it is
 * holding the same dead credential. Under the lock, a credential somebody else
 * has already replaced is taken as the retry's token rather than refreshed
 * again, so a fleet of pollers that all hit the same 401 spends exactly one
 * refresh between them.
 */
async function refreshAfterUnauthorized(a: Account, dir: string, used: CodexAuth, signal: AbortSignal): Promise<CodexAuth> {
  return await withLock(
    lockOf(a),
    async () => {
      const latest = readCodexCredentials(dir);
      if (latest && latest.tokens.access_token !== used.tokens.access_token) return latest;
      return await refreshCodexCredentials(dir, latest ?? used, signal);
    },
    { waitMs: POLL_TIMEOUT_MS },
  );
}

async function pollCodexUsage(a: Account, signal: AbortSignal): Promise<Usage> {
  const dir = p.codexHome(a.name);
  let auth = readCodexCredentials(dir);
  if (!auth) throw new AuthError(`no credentials (ms accounts login ${a.name})`);
  // The cheap pre-filter: a token nowhere near its expiry costs no lock.
  if (codexRefreshDue(auth) && codexRefreshAllowed(a.name)) auth = await refreshCodexGrant(a, dir, auth, signal);

  try {
    return await fetchCodexUsage(auth, signal);
  } catch (err) {
    // Exactly the proven poller's second trigger: a 401 earns one refresh and
    // one retry. A 403 does not (no refresh changes a scope), and every other
    // failure travels untouched.
    if (!(err instanceof CodexAuthError) || err.status !== 401) throw err;
    const refreshed = await refreshAfterUnauthorized(a, dir, auth, signal);
    if (refreshed.tokens.access_token === auth.tokens.access_token) throw err; // nothing new to retry with
    return await fetchCodexUsage(refreshed, signal);
  }
}

type Polled = { entry: AccountUsage; backoffUntil: number | null };

/** Never throws: every outcome is an entry, because one account's failure must
 *  not cost the caller the other accounts' numbers. */
async function pollOne(a: Account, prev: AccountUsage | null, backoffUntil: number): Promise<Polled> {
  const who = whoOf(a);
  const keep = (over: Partial<AccountUsage>): AccountUsage => ({
    ...(prev ?? { ...who, usage: null, error: null, errorKind: null, observedAt: null, stale: false }),
    ...who,
    ...over,
  });

  if (backoffUntil > Date.now()) {
    const until = new Date(backoffUntil).toISOString();
    return {
      entry: keep({
        error: prev?.error ?? `backing off until ${until}`,
        errorKind: prev?.errorKind ?? "transient",
        stale: true,
      }),
      backoffUntil,
    };
  }

  const signal = AbortSignal.timeout(POLL_TIMEOUT_MS);
  try {
    const usage = a.provider === "codex" ? await pollCodexUsage(a, signal) : await pollClaudeUsage(a, signal);
    return {
      entry: { ...who, usage, error: null, errorKind: null, observedAt: Date.now(), stale: false },
      backoffUntil: null,
    };
  } catch (err) {
    const errorKind = classify(err);
    // The last good reading is kept alongside the error: `toPickInputs` is
    // what decides whether it is still evidence, and `ms status` can show the
    // numbers it last saw rather than a hole.
    return {
      entry: keep({ error: errMessage(err), errorKind, stale: true }),
      backoffUntil: errorKind === "transient" ? Date.now() + backoffMs(err) : null,
    };
  }
}

// --- The snapshot ------------------------------------------------------

const inFlight = new Map<string, Promise<Snapshot>>();

function scopeOf(only: string[] | null, accounts: Account[]): Account[] {
  return only ? accounts.filter((a) => only.includes(a.name)) : accounts;
}

function project(file: CacheFile, scope: Account[], registryError: string | null): Snapshot {
  const by = new Map(file.accounts.map((e) => [keyOf(e), e]));
  // Total by construction: the fresh path is gated on `covers()`, and the poll
  // path emits exactly one row per scoped account before calling this.
  const accounts = scope.map((a): AccountUsage => ({ ...by.get(keyOf(a))!, ...whoOf(a) }));
  return { takenAt: file.takenAt, accounts, registryError };
}

/** A negative age is a clock that went backwards; one poll is cheaper than a
 *  cache that can never expire. */
const isFresh = (takenAt: number, maxAgeMs: number, now: number): boolean => {
  const age = now - takenAt;
  return age >= 0 && age < maxAgeMs;
};

const covers = (file: CacheFile, scope: Account[]): boolean => {
  const keys = new Set(file.accounts.map(keyOf));
  return scope.every((a) => keys.has(keyOf(a)));
};

async function poll(maxAgeMs: number, only: string[] | null): Promise<Snapshot> {
  const startedAt = Date.now();
  const prev = readCache();
  const { registry, parseError } = loadRegistry();
  const scope = scopeOf(only, registry.accounts);

  // A file that is fresh but silent about an account registered since it was
  // written would hide that account for a whole window.
  if (prev && isFresh(prev.takenAt, maxAgeMs, startedAt) && covers(prev, scope)) {
    return project(prev, scope, parseError);
  }

  const prevByKey = new Map(prev?.accounts.map((e) => [keyOf(e), e]) ?? []);
  const backoff: Record<string, number> = {};
  for (const [k, until] of Object.entries(prev?.backoff ?? {})) {
    // Clamped on the way in too: a file written by a future version, or across
    // a clock jump, cannot strand an account for longer than the clamp allows.
    backoff[k] = Math.min(until, startedAt + MAX_BACKOFF_MS);
  }

  const settled = await Promise.allSettled(
    scope.map((a) => pollOne(a, prevByKey.get(keyOf(a)) ?? null, backoff[keyOf(a)] ?? 0)),
  );

  const polled: AccountUsage[] = [];
  settled.forEach((r, i) => {
    const a = scope[i]!;
    const k = keyOf(a);
    if (r.status === "fulfilled") {
      polled.push(r.value.entry);
      if (r.value.backoffUntil) backoff[k] = r.value.backoffUntil;
      else delete backoff[k];
      return;
    }
    // pollOne is written not to throw; if it ever does, that is this tool's
    // bug and it belongs on the account's row rather than in a swallowed
    // catch — "other", so no backoff timer pretends it is the network.
    const prevEntry = prevByKey.get(k) ?? null;
    polled.push({
      ...(prevEntry ?? { usage: null, observedAt: null }),
      ...whoOf(a),
      error: errMessage(r.reason),
      errorKind: "other",
      stale: true,
    });
    delete backoff[k];
  });

  // Accounts this round did not cover keep their last reading, marked stale —
  // a scoped poll must not blank the rest of the file. Rows for accounts that
  // have left the registry are dropped, but only when the registry read
  // cleanly: an unreadable accounts.json is not evidence that anything is gone.
  const inScope = new Set(scope.map(keyOf));
  const known = new Set(registry.accounts.map(keyOf));
  const kept = (k: string) => parseError !== null || known.has(k);
  const carried = (prev?.accounts ?? [])
    .filter((e) => !inScope.has(keyOf(e)) && kept(keyOf(e)))
    .map((e) => ({ ...e, stale: true }));
  for (const k of Object.keys(backoff)) if (!kept(k)) delete backoff[k];

  // Stamped at the END of the poll: `takenAt` says how old the readings are,
  // and the newest of them is this instant, not the instant we started.
  const file: CacheFile = { takenAt: Date.now(), accounts: [...polled, ...carried], backoff };
  writeCache(file);
  return project(file, scope, parseError);
}

/** Another process is mid-poll and we ran out of patience. Its answer is
 *  moments away but we cannot block a launch on it, so serve the last file —
 *  every row marked stale, because none of it is this moment's reading, and
 *  `toPickInputs` will retire whatever has gone cold. */
function servedWhileBusy(only: string[] | null): Snapshot {
  const prev = readCache();
  const { registry, parseError } = loadRegistry();
  const scope = scopeOf(only, registry.accounts);
  const by = new Map(prev?.accounts.map((e) => [keyOf(e), e]) ?? []);
  const accounts = scope.map((a): AccountUsage => {
    const who = whoOf(a);
    const e = by.get(keyOf(a));
    if (e) return { ...e, ...who, stale: true };
    return {
      ...who,
      usage: null,
      error: "another process is polling usage",
      errorKind: "transient",
      observedAt: null,
      stale: true,
    };
  });
  return { takenAt: prev?.takenAt ?? null, accounts, registryError: parseError };
}

async function take(maxAgeMs: number, only: string[] | null, waitMs: number): Promise<Snapshot> {
  try {
    // The snapshot lock is the OUTER one; `refreshGrant` takes the account
    // lock beneath it. Never the reverse (see LOCK ORDERING at the top).
    return await withLock(LOCK, () => poll(maxAgeMs, only), { waitMs });
  } catch (err) {
    if (!(err instanceof Locked) && errName(err) !== "Locked") throw err;
    return servedWhileBusy(only);
  }
}

/**
 * The usage numbers, as fresh as `maxAgeMs` asks for and as cheap as the
 * fleet can make them. Concurrent callers — in this process or any other —
 * share one poll per account.
 */
export function getSnapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const waitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const only = opts.only ? [...new Set(opts.only)].sort() : null;
  // Keyed by everything the caller asked for, `lockWaitMs` included: a caller
  // that can only spare 50 ms must not be joined to somebody else's 20-second
  // wait, any more than it should be handed a narrower set of accounts or a
  // staler answer than it asked for.
  const key = JSON.stringify([maxAgeMs, waitMs, only]);
  const running = inFlight.get(key);
  if (running) return running;
  const promise = take(maxAgeMs, only, waitMs).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Rounded, human-sized, and never precise: this only ever lands in an error
 *  string a person reads. */
function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The snapshot as the chooser (src/pick.ts) reads it.
 *
 * An account is alive when there is a reading, AND that reading is either
 * current or under ten minutes old, AND nothing went wrong beyond a transient
 * failure over a reading that is itself still that recent. The age test covers
 * BOTH ways a row goes cold — a failed poll and a row nothing re-read (a
 * scoped poll, or a snapshot served while another process held the lock) —
 * because an errorless row that is four hours old is four hours old, and
 * feeding those percentages to the chooser is how a walled account gets picked.
 *
 * Everything else carries an `error`, which `pickAccounts` reports as the
 * reason it was passed over: a dead account must never look like an absent
 * one. An unreadable registry yields no inputs at all — `registryError` is
 * there so `ms status` can say why rather than print "no accounts".
 */
export function toPickInputs(s: Snapshot): PickInput[] {
  if (s.registryError !== null) return [];
  const now = Date.now();
  return s.accounts.map((a): PickInput => {
    const seen = a.observedAt;
    const recent = seen !== null && now - seen < MAX_READING_AGE_MS;
    const alive =
      a.usage !== null &&
      (!a.stale || recent) &&
      (a.error === null || (a.errorKind === "transient" && recent));
    return {
      name: a.name,
      provider: a.provider,
      shared: a.shared,
      session: a.usage?.session ?? null,
      weeklyAll: a.usage?.weeklyAll ?? null,
      weeklyFable: a.usage?.weeklyFable ?? null,
      error: alive ? null : deadReason(a, now),
    };
  });
}

function deadReason(a: AccountUsage, now: number): string {
  if (a.error !== null) return a.error;
  if (a.usage === null) return "no usage reading yet";
  // Nothing went wrong; the reading simply aged out while nothing refreshed it.
  return a.observedAt === null
    ? "usage stale (never read)"
    : `usage stale (${ageLabel(now - a.observedAt)})`;
}
