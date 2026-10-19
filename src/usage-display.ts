/** Optional display facts also work with snapshots written before providers
 * reported durations, plan names, or discretionary reset credits. */
export type DisplayWindow = { usedPercent?: number | null; resetsAt?: string | null; windowSeconds?: number; resetStarted?: boolean };
export type DisplayUsage = {
  session?: DisplayWindow | null; weeklyAll?: DisplayWindow | null; weeklyFable?: DisplayWindow | null;
  planType?: string; requestsAllowed?: boolean; limitReached?: boolean; resetsAvailable?: number;
};

/** Shared with the browser. Keep these functions closure-free and embed
 * every dependency explicitly in dashboard/page.ts. */
export function windowPeriod(w: DisplayWindow | null | undefined, fallback: string): string {
  var seconds = w && w.windowSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds % 86400 === 0) return String(seconds / 86400) + "d";
  if (seconds % 3600 === 0) return String(seconds / 3600) + "h";
  if (seconds % 60 === 0) return String(seconds / 60) + "m";
  return String(seconds) + "s";
}

export function windowLimitLabel(w: DisplayWindow | null | undefined, fallback: string): string {
  var period = windowPeriod(w, fallback);
  return (fallback === "fable" || fallback === "Fable") && period !== fallback ? period + " " + fallback : period;
}

/** Never turn nonzero usage into zero or a value below 100 into 100. */
export function usedPercentText(value: unknown, missing: string): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) + "%" : missing;
}

export function windowResetState(w: DisplayWindow | null | undefined): string {
  return w && w.resetStarted === false ? "reset not started" : "reset unknown";
}

export function reportedResetCount(usage: DisplayUsage | null | undefined): number | null {
  var n = usage && usage.resetsAvailable;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function usageRequestsBlocked(usage: DisplayUsage | null | undefined): boolean {
  return !!usage && (usage.requestsAllowed === false || usage.limitReached === true);
}
