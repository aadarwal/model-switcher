/** Child 1 of lock.test.ts's release-after-reclaim reproduction: take the lock,
 * say so, sleep until told, then release believing it still holds it.
 * Exit 0 = acquired and released, 3 = never got the lock, 4 = never told to go. */
import path from "node:path";
import { acquire } from "../../src/lock.ts";
import { mark, waitForFile } from "./barrier.ts";

const [name, dir, staleRaw] = process.argv.slice(2);

const release = acquire(name, { staleAfterMs: Number(staleRaw) });
if (!release) process.exit(3);
mark(dir, "acquired", String(process.pid));

if (!(await waitForFile(path.join(dir, "go"), 15_000))) process.exit(4);
release();
mark(dir, "released", String(process.pid));
process.exit(0);
