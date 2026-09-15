import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";

export type Provider = "claude" | "codex";
export type Account = { name: string; provider: Provider; label: string; orgId: string | null; shared: boolean; identityVerified: boolean };
export type Registry = { version: 1; accounts: Account[] };
export class RegistryUnreadable extends Error {}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateRegistry(raw: unknown): { registry: Registry; problems: string[] } {
  const problems: string[] = [];
  const out: Account[] = [];
  const rows = raw && typeof raw === "object" && Array.isArray((raw as { accounts?: unknown }).accounts)
    ? ((raw as { accounts: unknown[] }).accounts) : [];
  if (!rows.length && raw && typeof raw === "object" && !("accounts" in raw)) problems.push("accounts: missing array");
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const at = `accounts[${i}]`;
    if (!row || typeof row !== "object") { problems.push(`${at}: not an object`); return; }
    const a = row as Record<string, unknown>;
    // Provider is checked before name so a row with both problems reports
    // the provider problem (registry.test.ts's "bad provider" row deliberately
    // has an invalid name string too, to prove which check wins).
    if (a.provider !== "claude" && a.provider !== "codex") { problems.push(`${at}: unknown provider ${JSON.stringify(a.provider)}`); return; }
    if (typeof a.name !== "string" || !NAME_PATTERN.test(a.name)) { problems.push(`${at}: bad name`); return; }
    const key = `${a.provider}:${a.name}`;
    if (seen.has(key)) { problems.push(`${at}: duplicate name ${a.name} for ${a.provider}`); return; }
    seen.add(key);
    out.push({
      name: a.name, provider: a.provider, label: typeof a.label === "string" ? a.label : a.name,
      orgId: typeof a.orgId === "string" ? a.orgId : null,
      shared: a.shared === true, identityVerified: a.identityVerified === true,
    });
  });
  return { registry: { version: 1, accounts: out }, problems };
}

export function loadRegistry(): { registry: Registry; parseError: string | null; problems: string[] } {
  ensureStore();
  if (!existsSync(p.registry)) return { registry: { version: 1, accounts: [] }, parseError: null, problems: [] };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(p.registry, "utf8")); }
  catch (e) { return { registry: { version: 1, accounts: [] }, parseError: `accounts.json: ${(e as Error).message} (JSON)`, problems: [] }; }
  const v = validateRegistry(raw);
  return { registry: v.registry, parseError: null, problems: v.problems };
}

export function saveRegistry(r: Registry, prev: { parseError: string | null }): void {
  if (prev.parseError) throw new RegistryUnreadable(`refusing to write over an unreadable registry: ${prev.parseError}`);
  ensureStore();
  const tmp = `${p.registry}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, p.registry);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

export function findAccount(r: Registry, name: string, provider?: Provider): Account | undefined {
  return r.accounts.find((a) => a.name === name && (!provider || a.provider === provider));
}
