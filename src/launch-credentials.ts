import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { ensureStore, p } from "./paths.ts";

// A `claude setup-token` (one year, inference-scope only; spec §6). This
// module never prints or logs a token, and never puts one in an error
// message — only account names and paths.
const SETUP_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

export function looksLikeSetupToken(s: string): boolean {
  return SETUP_TOKEN_PATTERN.test(s);
}

export function saveLaunchToken(name: string, token: string): void {
  ensureStore();
  const file = p.launchToken(name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function readLaunchToken(name: string): string | null {
  const file = p.launchToken(name);
  if (!existsSync(file)) return null;
  const contents = readFileSync(file, "utf8").trim();
  return contents.length ? contents : null;
}

export function deleteLaunchToken(name: string): void {
  rmSync(p.launchToken(name), { force: true });
}
