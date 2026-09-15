/** Child 2 of lock.test.ts's release-after-reclaim reproduction: take the lock
 * away from the live child 1 by age, and keep it (no release), so the test can
 * check whether child 1's release removes this row.
 * Exit 0 = reclaimed, 3 = could not, 4 = child 1 never acquired. */
import path from "node:path";
import { acquire } from "../../src/lock.ts";
import { mark, waitForFile } from "./barrier.ts";

const [name, dir, staleRaw] = process.argv.slice(2);

if (!(await waitForFile(path.join(dir, "acquired"), 15_000))) process.exit(4);

const release = acquire(name, { staleAfterMs: Number(staleRaw) });
if (!release) process.exit(3);
mark(dir, "reclaimed", String(process.pid));
process.exit(0);
