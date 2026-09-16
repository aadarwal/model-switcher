/** Shared helpers for the lock.test.ts fixture children. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

export function mark(dir: string, name: string, body = ""): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, name), body);
}

/** Announce this process in `dir` and wait until `expected` of us are there. */
export async function barrier(dir: string, expected: number, boundMs: number): Promise<boolean> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, String(process.pid)), "");
  return waitUntil(() => readdirSync(dir).length >= expected, boundMs);
}

export async function waitForFile(file: string, boundMs: number): Promise<boolean> {
  return waitUntil(() => existsSync(file), boundMs);
}

export async function waitUntil(done: () => boolean, boundMs: number): Promise<boolean> {
  const until = Date.now() + boundMs;
  while (Date.now() < until) {
    if (done()) return true;
    await sleep(5);
  }
  return done();
}
