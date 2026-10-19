import { roomAfterReset } from "./pick.ts";
import type { Provider } from "./registry.ts";
import type { AccountUsage } from "./snapshot.ts";
import { reportedResetCount, usageRequestsBlocked, usedPercentText, windowLimitLabel, windowPeriod, type DisplayUsage } from "./usage-display.ts";

export type PoolReset = { account: string; resetsAt: string; windows: string[] };
export type PoolSummary = {
  withRoom: number;
  total: number;
  /** Known window resets, grouped by account and instant; not a provider's
   *  count of discretionary resets or a claim that each restores room. */
  resetsNext24h: PoolReset[];
  nextRoom: { account: string; resetsAt: string } | null;
  lastAccount: { account: string; sessionUsedPercent: number | null; sessionWindow?: string } | null;
  /** Complete fresh-provider coverage only. Partial reports are separate. */
  resetsAvailable?: number;
  reportedResetsAvailable?: { count: number; accounts: number; total: number };
};
export type PoolSummaries = Partial<Record<Provider, PoolSummary>>;
type PoolAccount = Pick<AccountUsage, "name" | "provider" | "usage" | "shared"> & { state: string; reservePercent: number; stale?: boolean; error?: string | null; errorKind?: string | null };

/** The table's computed state is authoritative for room counts. Scheduled
 *  resets are reported separately from capacity recovery, which requires
 *  every exhausted gate to clear and a usable credential/reading. */
export function poolSummaries(accounts: readonly PoolAccount[], now: number): PoolSummaries {
  const pools: PoolSummaries = {};
  for (const provider of ["claude", "codex"] as const) {
    const members = accounts.filter((a) => a.provider === provider);
    if (!members.length) continue;
    const ready = members.filter((a) => a.state === "ok");
    const resets = new Map<string, PoolReset>();
    let nextRoom: PoolSummary["nextRoom"] = null;
    for (const a of members) {
      for (const [key, label] of [["session", "5h"], ["weeklyAll", "week"], ["weeklyFable", "fable"]] as const) {
        const at = Date.parse(a.usage?.[key]?.resetsAt ?? "");
        if (!Number.isFinite(at) || at <= now || at > now + 24 * 3_600_000) continue;
        const id = JSON.stringify([a.name, at]);
        const event = resets.get(id) ?? { account: a.name, resetsAt: new Date(at).toISOString(), windows: [] };
        event.windows.push(windowLimitLabel(a.usage?.[key], label));
        resets.set(id, event);
      }
      if (a.state !== "no room" && a.state !== "reserved") continue;
      if (usageRequestsBlocked(a.usage)) continue;
      const facts: DisplayUsage | null = a.usage;
      const at = roomAfterReset({
        name: a.name, provider, shared: a.shared, reservePercent: a.reservePercent,
        ...{ requestsAllowed: facts?.requestsAllowed, limitReached: facts?.limitReached },
        session: a.usage?.session ?? null, weeklyAll: a.usage?.weeklyAll ?? null,
        weeklyFable: a.usage?.weeklyFable ?? null, error: null,
      }, "any", now);
      if (at !== null && (nextRoom === null || at < Date.parse(nextRoom.resetsAt))) nextRoom = { account: a.name, resetsAt: new Date(at).toISOString() };
    }
    const last = ready.length === 1 ? ready[0]! : null;
    const used = last?.usage?.session?.usedPercent;
    const knownCredits = members.map((a) => !a.stale && !a.error && !a.errorKind && ["ok", "no room", "reserved"].includes(a.state) ? reportedResetCount(a.usage) : null).filter((n): n is number => n !== null);
    const creditTotal = knownCredits.reduce((sum, n) => sum + n, 0);
    const sessionWindow = windowPeriod(last?.usage?.session, "");
    pools[provider] = {
      withRoom: ready.length, total: members.length,
      resetsNext24h: [...resets.values()].sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt) || a.account.localeCompare(b.account)),
      nextRoom,
      lastAccount: last ? { account: last.name, sessionUsedPercent: used !== undefined && Number.isFinite(used) ? used : null, ...(sessionWindow ? { sessionWindow } : {}) } : null,
      ...(knownCredits.length && Number.isSafeInteger(creditTotal) ? knownCredits.length === members.length
        ? { resetsAvailable: creditTotal }
        : { reportedResetsAvailable: { count: creditTotal, accounts: knownCredits.length, total: members.length } } : {}),
    };
  }
  return pools;
}

/** Also embedded in the browser alongside poolSummaryText. */
export function poolResetTime(iso: string): string {
  var d = new Date(iso);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/** Shared by status text and the browser. page.ts embeds this function and
 *  poolResetTime into its inline script. */
export function poolSummaryText(provider: string, pool: PoolSummary, now: number): string {
  var line = provider + ": " + pool.withRoom + "/" + pool.total + " with room · resets in next 24 h: " + pool.resetsNext24h.length;
  if (pool.resetsNext24h.length) {
    line += " (" + pool.resetsNext24h.map(function (r) { return r.account + " " + r.windows.join("+") + " " + poolResetTime(r.resetsAt); }).join(", ") + ")";
  }
  if (pool.nextRoom) {
    var minutes = Math.max(0, Math.ceil((Date.parse(pool.nextRoom.resetsAt) - now) / 60_000));
    var wait = minutes < 60 ? minutes + "m" : minutes < 1440 ? Math.floor(minutes / 60) + "h " + minutes % 60 + "m" : Math.floor(minutes / 1440) + "d " + Math.floor(minutes / 60) % 24 + "h";
    line += " · next room: " + pool.nextRoom.account + " " + poolResetTime(pool.nextRoom.resetsAt) + " (in " + wait + ")";
  }
  if (pool.lastAccount) {
    var used = pool.lastAccount.sessionUsedPercent;
    line += " · LAST ACCOUNT WITH ROOM (" + pool.lastAccount.account + (used === null ? "" : ", " + (pool.lastAccount.sessionWindow || "5H") + " " + usedPercentText(used, "unknown") + " used") + ")";
  }
  if (typeof pool.resetsAvailable === "number") line += " · resets available: " + pool.resetsAvailable;
  else if (pool.reportedResetsAvailable) {
    var credits = pool.reportedResetsAvailable;
    line += " · resets available: " + credits.count + " reported (" + credits.accounts + "/" + credits.total + " accounts; " + (credits.total - credits.accounts) + " unknown)";
  }
  return line;
}
