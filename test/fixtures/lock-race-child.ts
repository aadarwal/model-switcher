/** One racer for lock.test.ts's eight-process race.
 *
 * Two barriers make the result deterministic rather than timing-dependent:
 * every child waits until all N are up before attempting, and the winner then
 * HOLDS until all N have recorded an attempt. So no racer can attempt after the
 * winner released, and "exactly one exit 0" cannot be an artifact of a slow
 * start. Both barriers are bounded: exit 4 means the run was inconclusive,
 * which the parent treats as a failure rather than a pass.
 *
 * Exit 0 = took the lock and released it, 3 = lost it, 4 = a barrier never filled.
 */
import path from "node:path";
import { acquire } from "../../src/lock.ts";
import { barrier, mark, waitUntil } from "./barrier.ts";
import { readdirSync } from "node:fs";

const [name, dir, expectedRaw] = process.argv.slice(2);
const expected = Number(expectedRaw);
const attempted = path.join(dir, "attempted");

if (!(await barrier(path.join(dir, "ready"), expected, 10_000))) process.exit(4);

const release = acquire(name);
mark(attempted, String(process.pid));
if (!release) process.exit(3);

// The winner holds until every racer has already had its turn.
if (!(await waitUntil(() => readdirSync(attempted).length >= expected, 10_000))) {
  release();
  process.exit(4);
}
release();
process.exit(0);
