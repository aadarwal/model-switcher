export type Need = "any" | "fable";
export type Window = { usedPercent: number; resetsAt: string | null };
export type PickInput = { name: string; provider: "claude" | "codex"; shared: boolean; reservePercent: number;
  session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null; error: string | null };
export type PickResult = { picks: { name: string; resetsAt: string | null; remaining: number }[]; out: { name: string; why: string }[] };

export function parseNeed(s: string | undefined): Need | null {
  if (s === undefined || s === "" || s === "any") return "any";
  if (s === "fable") return "fable";
  return null;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);

/** Has this account's week reached its owner's reserve (`ms accounts reserve`)?
 *  Automation stops using it at 100 − reserve of the weekly window: the one
 *  rule the chooser below, `ms status` and rebalance all read. */
export function reserveReached(reservePercent: number | undefined, weeklyAll: Window | null | undefined): boolean {
  const reserve = reservePercent ?? 0;
  return reserve > 0 && !!weeklyAll && Number.isFinite(weeklyAll.usedPercent) && weeklyAll.usedPercent >= 100 - reserve;
}

/** A reset can restore room only after ALL exhausted required windows clear.
 *  The ranking's next weekly reset is a different question: an unblocked
 *  week says nothing about a full session or Fable window. Validate the
 *  projected reading with the chooser so missing/malformed windows and
 *  unreadable accounts cannot acquire a capacity promise. */
export function roomAfterReset(input: PickInput | undefined, need: Need, now: number): number | null {
  if (!input || input.error) return null;
  const blocked: ("session" | "weeklyAll" | "weeklyFable")[] = [];
  if (input.session && Number.isFinite(input.session.usedPercent) && input.session.usedPercent >= 100) blocked.push("session");
  if (input.weeklyAll && Number.isFinite(input.weeklyAll.usedPercent) && (input.weeklyAll.usedPercent >= 100 || reserveReached(input.reservePercent, input.weeklyAll))) blocked.push("weeklyAll");
  if (need === "fable" && input.weeklyFable && Number.isFinite(input.weeklyFable.usedPercent) && input.weeklyFable.usedPercent >= 100) blocked.push("weeklyFable");
  if (!blocked.length) return null;
  const projected = { ...input };
  let at = now;
  for (const key of blocked) {
    const w = input[key]!;
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
    if (!Number.isFinite(reset) || reset <= now) return null;
    at = Math.max(at, reset);
    projected[key] = { ...w, usedPercent: 0 };
  }
  return pickAccounts([projected], need).picks.length ? at : null;
}

export function pickAccounts(inputs: PickInput[], need: Need, exclude: string[] = []): PickResult {
  const out: PickResult["out"] = [];
  const eligible: { name: string; resetsAt: string | null; remaining: number; shared: boolean; resetMs: number }[] = [];
  for (const a of inputs) {
    if (exclude.includes(a.name)) { out.push({ name: a.name, why: "excluded" }); continue; }
    if (a.error) { out.push({ name: a.name, why: `error: ${a.error}` }); continue; }
    // Codex Pro plans report no 5 h window at all (verified live 2026-09-16):
    // a missing session window is not a broken reading there, only for Claude.
    if (!a.session && a.provider !== "codex") { out.push({ name: a.name, why: "no session window" }); continue; }
    if (a.session && !Number.isFinite(a.session.usedPercent)) { out.push({ name: a.name, why: "malformed session percent" }); continue; }
    if (!a.weeklyAll) { out.push({ name: a.name, why: "no weekly window" }); continue; }
    if (!Number.isFinite(a.weeklyAll.usedPercent)) { out.push({ name: a.name, why: "malformed weekly percent" }); continue; }
    if (need === "fable" && !a.weeklyFable) { out.push({ name: a.name, why: "no fable window" }); continue; }
    if (need === "fable" && !Number.isFinite(a.weeklyFable!.usedPercent)) { out.push({ name: a.name, why: "malformed fable percent" }); continue; }
    if (a.session && a.session.usedPercent >= 100) { out.push({ name: a.name, why: "session window at 100" }); continue; }
    if (a.weeklyAll.usedPercent >= 100) { out.push({ name: a.name, why: "weekly window at 100" }); continue; }
    if (need === "fable" && a.weeklyFable!.usedPercent >= 100) { out.push({ name: a.name, why: "fable window at 100" }); continue; }
    const reserve = a.reservePercent ?? 0;
    if (reserveReached(reserve, a.weeklyAll)) {
      out.push({ name: a.name, why: `reserved: owner keeps ${reserve}% (weekly ${a.weeklyAll.usedPercent}%)` });
      continue;
    }
    const windows = need === "fable" ? [a.weeklyAll, a.weeklyFable!] : [a.weeklyAll];
    const weeklyRemaining = (100 - reserve) - a.weeklyAll.usedPercent;
    const remaining = need === "fable" ? Math.min(weeklyRemaining, 100 - a.weeklyFable!.usedPercent) : weeklyRemaining;
    const resetMs = Math.min(...windows.map((x) => ms(x.resetsAt)));
    const resetsAt = windows.map((x) => x.resetsAt).filter((x): x is string => !!x).sort((x, y) => ms(x) - ms(y))[0] ?? null;
    eligible.push({ name: a.name, resetsAt, remaining, shared: a.shared, resetMs });
  }
  eligible.sort((x, y) => x.resetMs - y.resetMs || y.remaining - x.remaining || Number(x.shared) - Number(y.shared) || x.name.localeCompare(y.name));
  return { picks: eligible.map(({ name, resetsAt, remaining }) => ({ name, resetsAt, remaining })), out };
}
