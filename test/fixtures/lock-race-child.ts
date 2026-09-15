/** One racer for lock.test.ts's real-process race.
 *
 * Node/tsx startup varies by hundreds of milliseconds, so racing on wall-clock
 * time alone would be a coin toss rather than a race. Each child announces
 * itself in a barrier directory and waits until every sibling has, so all N
 * attempt the same lock within a couple of milliseconds of each other.
 *
 * Exit 0 = took the lock (and released it), 3 = lost it, 4 = the barrier never
 * filled, which makes the run inconclusive rather than a pass.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { acquire } from "../../src/lock.ts";

const [name, readyDir, expectedRaw] = process.argv.slice(2);
const expected = Number(expectedRaw);

mkdirSync(readyDir, { recursive: true, mode: 0o700 });
writeFileSync(path.join(readyDir, String(process.pid)), "");

const deadline = Date.now() + 15_000;
while (readdirSync(readyDir).length < expected) {
  if (Date.now() > deadline) process.exit(4);
  await sleep(2);
}

const release = acquire(name);
if (!release) process.exit(3);
// Hold long enough that every loser's attempt lands inside the window.
await sleep(500);
release();
process.exit(0);
