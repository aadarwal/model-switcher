export type Need = "any" | "fable";
export type Window = { usedPercent: number; resetsAt: string | null };
export type PickInput = { name: string; provider: "claude" | "codex"; shared: boolean;
  session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null; error: string | null };
export type PickResult = { picks: { name: string; resetsAt: string | null; remaining: number }[]; out: { name: string; why: string }[] };

export function parseNeed(s: string | undefined): Need | null {
  if (s === undefined || s === "" || s === "any") return "any";
  if (s === "fable") return "fable";
  return null;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);

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
    const windows = need === "fable" ? [a.weeklyAll, a.weeklyFable!] : [a.weeklyAll];
    const remaining = Math.min(...windows.map((x) => 100 - x.usedPercent));
    const resetMs = Math.min(...windows.map((x) => ms(x.resetsAt)));
    const resetsAt = windows.map((x) => x.resetsAt).filter((x): x is string => !!x).sort((x, y) => ms(x) - ms(y))[0] ?? null;
    eligible.push({ name: a.name, resetsAt, remaining, shared: a.shared, resetMs });
  }
  eligible.sort((x, y) => x.resetMs - y.resetMs || y.remaining - x.remaining || Number(x.shared) - Number(y.shared) || x.name.localeCompare(y.name));
  return { picks: eligible.map(({ name, resetsAt, remaining }) => ({ name, resetsAt, remaining })), out };
}
