// src/snapshot.ts
//
// The coalesced usage snapshot (spec §9).
//
// Many short-lived `ms` processes want the same numbers at the same moment: a
// launch choosing an account, a hook-dispatched recovery worker rotating a
// walled pane, a human running `ms status`. Sixty simultaneous walls must
// produce one poll per account, not sixty — the usage endpoint rate-limits,
// and sixty refreshes of one credential would race each other's write-back.
//
// Three mechanisms do it, and none of them is a daemon:
//
//   * across processes — the `snapshot` lock plus a freshness check. Whoever
//     takes the lock polls and writes the file; everyone else waits, then
//     finds the file fresh and returns it without a call of their own. A
//     waiter that runs out of patience serves the last file rather than
//     stampeding (a stale reading beats a duplicate poll beats an exception).
//   * inside one process — one in-flight promise per scope, so a process that
//     asks twice before the first answer arrives shares the answer.
//   * per credential — `account-<name>`, held across a refresh, because the
//     token endpoint rotates the refresh token and two processes spending one
//     grant leave the loser holding a dead one.
//
// The file (0600, written temp+rename) is the whole of the shared state:
// `{ takenAt, accounts, backoff }`. `backoff` is what keeps a rate-limited
// account from being re-asked every 20 seconds; it is bounded at 15 minutes
// both when written and when read, so neither a hostile `retry-after` nor a
// clock jump can pin an account out of the pool for a day.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";
import { Locked, withLock } from "./lock.ts";
import { loadRegistry, type Account, type Provider } from "./registry.ts";
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

export type ErrorKind = "auth" | "transient" | "other";

/** One account as the last poll left it. `observedAt` is the time of the last
 *  SUCCESSFUL read — carried over when this round failed — so `usage` and its
 *  age are always the same reading. `stale` says this round did not refresh
 *  it (a backoff, a failure, or a scoped poll that skipped it). */
export type AccountUsage = {
  name: string;
  provider: Provider;
  shared: boolean;
  usage: Usage | null;
  error: string | null;
  errorKind: ErrorKind | null;
  observedAt: number;
  stale: boolean;
};

export type Snapshot = { takenAt: number; accounts: AccountUsage[] };

export type SnapshotOptions = {
  /** Serve the cache file when it is younger than this. Default 20 s; 0
   *  forces a poll. */
  maxAgeMs?: number;
  /** Poll (and return) only these account names. Accounts left out keep their
   *  last reading in the file, marked stale. */
  only?: string[];
  /** How long to wait for another process's poll before giving up and serving
   *  the last file. Default: long enough to outlast that poll. A caller that
   *  cannot block (a launch on a hook's clock) can ask for less. */
  lockWaitMs?: number;
};

/** The cache file, which is the snapshot plus the per-account retry timers. */
type CacheFile = Snapshot & { backoff: Record<string, number> };

export const DEFAULT_MAX_AGE_MS = 20_000;
/** Per-account wall clock for the whole refresh+read, per spec §9. */
export const POLL_TIMEOUT_MS = 15_000;
/** Refresh a grant that would expire mid-flight rather than eat a 401. */
export const REFRESH_SKEW_MS = 60_000;
export const DEFAULT_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 900_000;
/** A reading older than this stops being evidence, even for a live account. */
export const ALIVE_AFTER_ERROR_MS = 600_000;
/** Long enough to outlast the holder's own poll, so waiting beats stampeding. */
const LOCK_WAIT_MS = POLL_TIMEOUT_MS + 5_000;
const LOCK = "snapshot";
const NO_POLLER = "no poller yet";
/** Key separator for the in-flight map: no account name can contain it. */
const KEY_SEP = "\u0000";

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
  if (typeof e.observedAt !== "number" || !Number.isFinite(e.observedAt)) return null;
  return {
    name: e.name,
    provider: e.provider,
    shared: e.shared === true,
    usage: e.usage && typeof e.usage === "object" ? (e.usage as Usage) : null,
    error: typeof e.error === "string" ? e.error : null,
    errorKind: isKind(e.errorKind) ? e.errorKind : null,
    observedAt: e.observedAt,
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
    for (const [name, until] of Object.entries(o.backoff as Record<string, unknown>)) {
      if (typeof until === "number" && Number.isFinite(until)) backoff[name] = until;
    }
  }
  return { takenAt: o.takenAt, accounts, backoff };
}

function writeCache(file: CacheFile): void {
  ensureStore();
  const tmp = `${p.snapshot}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
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

/** How long to leave a transiently-failed account alone. An error that names
 *  its own `retryAfterMs` is honoured up to the clamp; anything else waits a
 *  minute. The clamp is the point: an endpoint asking for a day must not take
 *  an account out of the pool for a day.
 *
 *  Note: today's provider does not surface a 429's `retry-after` header, so a
 *  real rate limit takes the one-minute default. When it learns to (Plan 2),
 *  this needs no change. */
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
 * common case costs no network call at all.
 */
async function refreshGrant(name: string, c: PollCredentials, signal: AbortSignal): Promise<PollCredentials> {
  return await withLock(`account-${name}`, async () => {
    const latest = readPollCredentials(name) ?? c;
    if (latest.expiresAt >= Date.now() + REFRESH_SKEW_MS) return latest;
    return await refreshPollCredentials(name, latest, signal);
  });
}

type Polled = { entry: AccountUsage; backoffUntil: number | null };

/** Never throws: every outcome is an entry, because one account's failure must
 *  not cost the caller the other accounts' numbers. */
async function pollOne(a: Account, prev: AccountUsage | null, backoffUntil: number): Promise<Polled> {
  const who = { name: a.name, provider: a.provider, shared: a.shared };
  const keep = (over: Partial<AccountUsage>): AccountUsage => ({
    ...(prev ?? { ...who, usage: null, error: null, errorKind: null, observedAt: 0, stale: false }),
    ...who,
    ...over,
  });

  if (a.provider !== "claude") {
    // Plan 2 adds the codex poller. Until then this is a named absence, not a
    // silent null: `ms status` should say why, and the chooser should skip it.
    return { entry: keep({ usage: null, error: NO_POLLER, errorKind: "other", stale: false }), backoffUntil: null };
  }

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
    let c = readPollCredentials(a.name);
    if (!c) {
      // Launchable-but-unpollable is the two-credential model's normal state
      // (spec §6), and the fix is a login, not a retry — so: auth, no backoff.
      return {
        entry: keep({
          error: `no poll grant (run: ms accounts login ${a.name})`,
          errorKind: "auth",
          stale: true,
        }),
        backoffUntil: null,
      };
    }
    if (c.expiresAt < Date.now() + REFRESH_SKEW_MS) c = await refreshGrant(a.name, c, signal);
    const usage = await fetchUsage(c, signal);
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

function project(file: CacheFile, scope: Account[]): Snapshot {
  const by = new Map(file.accounts.map((e) => [e.name, e]));
  const accounts: AccountUsage[] = [];
  for (const a of scope) {
    const e = by.get(a.name);
    if (e) accounts.push({ ...e, provider: a.provider, shared: a.shared });
  }
  return { takenAt: file.takenAt, accounts };
}

/** A negative age is a clock that went backwards; one poll is cheaper than a
 *  cache that can never expire. */
const isFresh = (takenAt: number, maxAgeMs: number, now: number): boolean => {
  const age = now - takenAt;
  return age >= 0 && age < maxAgeMs;
};

const covers = (file: CacheFile, scope: Account[]): boolean => {
  const names = new Set(file.accounts.map((e) => e.name));
  return scope.every((a) => names.has(a.name));
};

async function poll(maxAgeMs: number, only: string[] | null): Promise<Snapshot> {
  const now = Date.now();
  const prev = readCache();
  const { registry, parseError } = loadRegistry();
  const scope = scopeOf(only, registry.accounts);

  // A file that is fresh but silent about an account registered since it was
  // written would hide that account for a whole window.
  if (prev && isFresh(prev.takenAt, maxAgeMs, now) && covers(prev, scope)) return project(prev, scope);

  const prevByName = new Map(prev?.accounts.map((e) => [e.name, e]) ?? []);
  const backoff: Record<string, number> = {};
  for (const [name, until] of Object.entries(prev?.backoff ?? {})) {
    // Clamped on the way in too: a file written by a future version, or across
    // a clock jump, cannot strand an account for longer than the clamp allows.
    backoff[name] = Math.min(until, now + MAX_BACKOFF_MS);
  }

  const settled = await Promise.allSettled(
    scope.map((a) => pollOne(a, prevByName.get(a.name) ?? null, backoff[a.name] ?? 0)),
  );

  const polled: AccountUsage[] = [];
  settled.forEach((r, i) => {
    const a = scope[i]!;
    if (r.status === "fulfilled") {
      polled.push(r.value.entry);
      if (r.value.backoffUntil) backoff[a.name] = r.value.backoffUntil;
      else delete backoff[a.name];
      return;
    }
    // pollOne is written not to throw; if it ever does, that is this tool's
    // bug and it belongs on the account's row rather than in a swallowed
    // catch — "other", so no backoff timer pretends it is the network.
    const prevEntry = prevByName.get(a.name) ?? null;
    polled.push({
      ...(prevEntry ?? { usage: null, observedAt: 0 }),
      name: a.name,
      provider: a.provider,
      shared: a.shared,
      error: errMessage(r.reason),
      errorKind: "other",
      stale: true,
    });
    delete backoff[a.name];
  });

  // Accounts this round did not cover keep their last reading, marked stale —
  // a scoped poll must not blank the rest of the file. Rows for accounts that
  // have left the registry are dropped, but only when the registry read
  // cleanly: an unreadable accounts.json is not evidence that anything is gone.
  const inScope = new Set(scope.map((a) => a.name));
  const known = new Set(registry.accounts.map((a) => a.name));
  const kept = (name: string) => parseError !== null || known.has(name);
  const carried = (prev?.accounts ?? [])
    .filter((e) => !inScope.has(e.name) && kept(e.name))
    .map((e) => ({ ...e, stale: true }));
  for (const name of Object.keys(backoff)) if (!kept(name)) delete backoff[name];

  const file: CacheFile = { takenAt: now, accounts: [...polled, ...carried], backoff };
  writeCache(file);
  return project(file, scope);
}

/** Another process is mid-poll and we ran out of patience. Its answer is
 *  moments away but we cannot block a launch on it, so serve the last file —
 *  every row marked stale, because none of it is this moment's reading. */
function servedWhileBusy(only: string[] | null): Snapshot {
  const prev = readCache();
  const { registry } = loadRegistry();
  const scope = scopeOf(only, registry.accounts);
  const by = new Map(prev?.accounts.map((e) => [e.name, e]) ?? []);
  const accounts = scope.map((a): AccountUsage => {
    const who = { name: a.name, provider: a.provider, shared: a.shared };
    const e = by.get(a.name);
    if (e) return { ...e, ...who, stale: true };
    return {
      ...who,
      usage: null,
      error: "another process is polling usage",
      errorKind: "transient",
      observedAt: 0,
      stale: true,
    };
  });
  return { takenAt: prev?.takenAt ?? 0, accounts };
}

async function take(maxAgeMs: number, only: string[] | null, waitMs: number): Promise<Snapshot> {
  try {
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
  // Keyed by what was actually asked: a caller wanting a forced re-poll, or a
  // different set of accounts, must not be handed a narrower answer meant for
  // somebody else. (`lockWaitMs` is not part of the key — it bounds how long
  // this caller waits for a poll, not what the answer contains.)
  const key = `${maxAgeMs}${KEY_SEP}${only ? only.join(KEY_SEP) : "*"}`;
  const running = inFlight.get(key);
  if (running) return running;
  const promise = take(maxAgeMs, only, waitMs).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/**
 * The snapshot as the chooser (src/pick.ts) reads it.
 *
 * An account is alive when there is a reading AND either nothing went wrong or
 * what went wrong was transient and the reading is still recent. Everything
 * else carries an `error`, which `pickAccounts` reports as the reason it was
 * passed over — a dead account must never look like an absent one.
 */
export function toPickInputs(s: Snapshot): PickInput[] {
  const now = Date.now();
  return s.accounts.map((a): PickInput => {
    const alive =
      a.usage !== null &&
      (a.error === null || (a.errorKind === "transient" && now - a.observedAt < ALIVE_AFTER_ERROR_MS));
    return {
      name: a.name,
      provider: a.provider,
      shared: a.shared,
      session: a.usage?.session ?? null,
      weeklyAll: a.usage?.weeklyAll ?? null,
      weeklyFable: a.usage?.weeklyFable ?? null,
      error: alive ? null : (a.error ?? "no usage reading yet"),
    };
  });
}
