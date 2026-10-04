/** Holds SQLite's write lock on locks.sqlite — an open `BEGIN IMMEDIATE`, with
 * no row committed and no use of the lock API at all — so the parent can prove
 * that a busy database reads as "not acquired" and never escapes as a bare
 * Error. Exit 0 = held, then rolled back.
 *
 * It holds until the parent writes `<dir>/release`, or for `holdMs` at most.
 * A fixed hold alone made the parent race this child's clock: on a hosted
 * macOS runner a lock attempt's own file I/O is slow enough that a retry
 * started inside the parent's wait could outlast a 600 ms hold and take the
 * lock, so the test saw an acquire that it exists to prove cannot happen.
 *
 * Args: <dir> <holdMs>. The database is MS_HOME/locks.sqlite. */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mark, waitForFile } from "./barrier.ts";

const [dir, holdRaw] = process.argv.slice(2);
const file = path.join(process.env.MS_HOME ?? "", "locks.sqlite");

const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout = 250");
db.exec("CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, since INTEGER NOT NULL)");
db.exec("BEGIN IMMEDIATE");
mark(dir, "holding", String(process.pid));

await waitForFile(path.join(dir, "release"), Number(holdRaw));
db.exec("ROLLBACK");
db.close();
process.exit(0);
