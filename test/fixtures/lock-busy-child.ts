/** Holds SQLite's write lock on locks.sqlite — an open `BEGIN IMMEDIATE`, with
 * no row committed and no use of the lock API at all — so the parent can prove
 * that a busy database reads as "not acquired" and never escapes as a bare
 * Error. Exit 0 = held for the asked-for time and rolled back.
 *
 * Args: <dir> <holdMs>. The database is MS_HOME/locks.sqlite. */
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { mark } from "./barrier.ts";

const [dir, holdRaw] = process.argv.slice(2);
const file = path.join(process.env.MS_HOME ?? "", "locks.sqlite");

const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout = 250");
db.exec("CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, pid INTEGER NOT NULL, since INTEGER NOT NULL)");
db.exec("BEGIN IMMEDIATE");
mark(dir, "holding", String(process.pid));

await sleep(Number(holdRaw));
db.exec("ROLLBACK");
db.close();
process.exit(0);
