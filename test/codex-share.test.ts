// src/codex-share.ts: a codex account home is a view of the human's own
// ~/.codex. Every test builds a base (MS_CODEX_BASE_DIR, this test's own
// `~/.codex`) and an account home (MS_HOME/codex/work) in temp directories;
// nothing here reaches the developer's real ~/.codex or real store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tempHome } from "./helpers.ts";
import {
  CODEX_HOME_OWN,
  codexSessionsShared,
  ensureCodexBase,
  isHomeOwn,
  shareCodexHome,
  shareCodexState,
} from "../src/codex-share.ts";
import { ensureCodexReady } from "../src/hooks/codex-install.ts";

const MS = "/opt/homebrew/bin/ms";

type World = { home: string; msHome: string; base: string; acct: string; store: string };

/** A base with nothing in it yet and an account home holding only what a
 *  home always holds for itself. */
function world(opts: { base?: boolean } = {}): World {
  const { home, msHome } = tempHome(); // points MS_CODEX_BASE_DIR at home/.codex
  process.env.HOME = home;
  process.env.MS_HOME = msHome;
  const base = path.join(home, ".codex");
  if (opts.base !== false) mkdirSync(path.join(base, "sessions"), { recursive: true, mode: 0o700 });
  const acct = path.join(msHome, "codex", "work");
  mkdirSync(acct, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(acct, "auth.json"), '{"account":"work"}', { mode: 0o600 });
  writeFileSync(path.join(acct, "config.toml"), "# rendered for work\n", { mode: 0o600 });
  return { home, msHome, base, acct, store: path.join(msHome, "codex", "sessions") };
}

function put(file: string, text: string | Buffer): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text);
  return file;
}

const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/**
 * Everything under `roots`, as one line per entry: a link's text, a
 * directory's mode and inode, a file's size, mode, inode, mtime and content
 * hash. Two equal listings mean nothing was created, removed, renamed,
 * rewritten or re-linked in between — the definition of "no changes".
 */
function listing(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const f = path.join(dir, name);
      const st = lstatSync(f);
      if (st.isSymbolicLink()) out.push(`${f} -> ${readlinkSync(f)}`);
      else if (st.isDirectory()) {
        out.push(`${f}/ ${(st.mode & 0o777).toString(8)} ${st.ino}`);
        walk(f);
      } else out.push(`${f} ${st.size} ${(st.mode & 0o777).toString(8)} ${st.ino} ${st.mtimeMs} ${sha(f)}`);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/** Every regular file's bytes under `roots`, keyed by content hash — the
 *  "nothing was lost" check: each original must still be somewhere. */
function contents(...roots: string[]): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const f = path.join(dir, name);
      const st = lstatSync(f);
      if (st.isDirectory()) walk(f);
      else if (st.isFile()) out.add(sha(f));
    }
  };
  for (const r of roots) walk(r);
  return out;
}

const backupsOf = (dir: string, name: string) => readdirSync(dir).filter((n) => n.startsWith(`${name}.pre-link.`));

// --- The rule ------------------------------------------------------------

test("the only per-home entries are auth.json and config.toml, and anything named after them", () => {
  assert.deepEqual([...CODEX_HOME_OWN], ["auth.json", "config.toml"]);
  for (const own of ["auth.json", "config.toml", "config.toml.bak-ms-1789584065086", ".config.toml.tmp-123-456", "auth.json.bak", ".auth.json.tmp"]) {
    assert.equal(isHomeOwn(own), true, own);
  }
  for (const shared of ["sessions", "history.jsonl", ".sandbox_migration", "installation_id", "cache", "config", "auth"]) {
    assert.equal(isHomeOwn(shared), false, shared);
  }
});

test("every top-level entry of the base is linked into the home — but never its auth.json, config.toml, or a database's companions", () => {
  const w = world();
  put(path.join(w.base, "history.jsonl"), '{"text":"hi"}\n');
  put(path.join(w.base, "AGENTS.md"), "# mine\n");
  put(path.join(w.base, "skills", "mine", "SKILL.md"), "---\n");
  put(path.join(w.base, "auth.json"), '{"account":"the human\'s own"}');
  put(path.join(w.base, "config.toml"), 'model = "x"\n');
  put(path.join(w.base, "config.toml.bak-20260904-114708"), "old\n");
  put(path.join(w.base, "state_5.sqlite"), "db");
  put(path.join(w.base, "state_5.sqlite-wal"), "wal");
  put(path.join(w.base, "state_5.sqlite-shm"), "shm");

  const r = shareCodexState(w.acct);

  assert.deepEqual(r.problems, []);
  for (const name of ["sessions", "history.jsonl", "AGENTS.md", "skills", "state_5.sqlite"]) {
    assert.equal(readlinkSync(path.join(w.acct, name)), path.join(w.base, name), name);
  }
  assert.equal(readFileSync(path.join(w.acct, "auth.json"), "utf8"), '{"account":"work"}', "the account's own credential");
  assert.equal(readFileSync(path.join(w.acct, "config.toml"), "utf8"), "# rendered for work\n");
  for (const never of ["config.toml.bak-20260904-114708", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
    assert.equal(existsSync(path.join(w.acct, never)), false, never);
  }
  assert.match(r.changes.join("\n"), /linked 5 entries of .*\.codex into .*codex\/work/);
  assert.equal(codexSessionsShared(w.acct), true);
});

test("a missing base is created 0700 with an empty sessions, and the store path becomes a link to it", () => {
  const w = world({ base: false });
  const r = shareCodexState(w.acct);
  assert.deepEqual(r.problems, []);
  assert.equal(statSync(w.base).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(path.join(w.base, "sessions")), []);
  assert.equal(readlinkSync(w.store), path.join(w.base, "sessions"));
  assert.equal(readlinkSync(path.join(w.acct, "sessions")), path.join(w.base, "sessions"));
  assert.ok(r.changes.includes(`created ${w.base}`), r.changes.join("\n"));
});

// --- Real entries where a link belongs -------------------------------------

test("a real directory is merged file by file: moved when the base lacks it, extended when the base holds a prefix, and never overwritten", () => {
  const w = world();
  const b = (rel: string) => path.join(w.base, "sessions", rel);
  const h = (rel: string) => path.join(w.acct, "sessions", rel);
  put(h("2026/09/22/only-here.jsonl"), "home only\n");
  put(h("2026/09/23/new-day.jsonl"), "a whole day the base lacks\n");
  put(b("2026/09/22/same.jsonl"), "identical\n");
  put(h("2026/09/22/same.jsonl"), "identical\n");
  put(b("2026/09/22/went-on-here.jsonl"), "line 1\n");
  put(h("2026/09/22/went-on-here.jsonl"), "line 1\nline 2 in the home\n");
  put(b("2026/09/22/went-on-there.jsonl"), "line 1\nline 2 in the base\n");
  put(h("2026/09/22/went-on-there.jsonl"), "line 1\n");
  put(b("2026/09/22/forked.jsonl"), "line 1\nthe base's line 2\n");
  put(h("2026/09/22/forked.jsonl"), "line 1\nthe home's line 2\n");
  const before = contents(w.acct, w.base);

  const r = shareCodexState(w.acct);

  assert.deepEqual(r.problems, []);
  assert.equal(readlinkSync(path.join(w.acct, "sessions")), path.join(w.base, "sessions"));
  assert.equal(readFileSync(b("2026/09/22/only-here.jsonl"), "utf8"), "home only\n");
  assert.equal(readFileSync(b("2026/09/23/new-day.jsonl"), "utf8"), "a whole day the base lacks\n");
  assert.equal(readFileSync(b("2026/09/22/went-on-here.jsonl"), "utf8"), "line 1\nline 2 in the home\n", "the base's prefix is extended");
  assert.equal(readFileSync(b("2026/09/22/went-on-there.jsonl"), "utf8"), "line 1\nline 2 in the base\n", "the longer base copy is kept");
  assert.equal(readFileSync(b("2026/09/22/forked.jsonl"), "utf8"), "line 1\nthe base's line 2\n", "a fork never overwrites the base");

  const [aside] = backupsOf(w.acct, "sessions");
  assert.ok(aside, "what the base already had stays beside the link");
  const kept = path.join(w.acct, aside!, "2026", "09", "22");
  assert.deepEqual(readdirSync(kept).sort(), ["forked.jsonl", "same.jsonl", "went-on-here.jsonl", "went-on-there.jsonl"]);
  assert.equal(readFileSync(path.join(kept, "forked.jsonl"), "utf8"), "line 1\nthe home's line 2\n");
  assert.equal(existsSync(path.join(w.acct, aside!, "2026", "09", "23")), false, "an emptied directory is removed from the copy");
  const line = r.changes.find((l) => l.startsWith(`merged ${path.join(w.acct, "sessions")}`));
  assert.ok(line, r.changes.join("\n"));
  assert.match(line!, /2 moved in, 1 extended; 4 already there, kept in .*sessions\.pre-link\.\d+; differs from the base, so both are kept: 2026\/09\/22\/forked\.jsonl/);

  // Nothing that was anywhere before is gone.
  const after = contents(w.acct, w.base);
  for (const h of before) assert.ok(after.has(h), "a file's bytes vanished");
});

test("a directory whose every file moved into the base leaves no copy behind", () => {
  const w = world();
  put(path.join(w.acct, "shell_snapshots", "a.sh"), "a\n");
  put(path.join(w.base, "shell_snapshots", "b.sh"), "b\n");
  const r = shareCodexState(w.acct);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(backupsOf(w.acct, "shell_snapshots"), []);
  assert.deepEqual(readdirSync(path.join(w.base, "shell_snapshots")).sort(), ["a.sh", "b.sh"]);
  assert.ok(r.changes.some((l) => /merged .*shell_snapshots into .*\(1 moved in\)$/.test(l)), r.changes.join("\n"));
});

test("a .jsonl file gets every line the base lacks appended, byte for byte, and the original kept", () => {
  const w = world();
  const odd = Buffer.from([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]); // {"t":"\xff\xfe"} — not UTF-8
  put(path.join(w.base, "history.jsonl"), '{"text":"one"}\n{"text":"two"}\n');
  put(path.join(w.acct, "history.jsonl"), Buffer.concat([Buffer.from('{"text":"two"}\n{"text":"three"}\n'), odd, Buffer.from("\n")]));

  const r = shareCodexState(w.acct);

  assert.deepEqual(r.problems, []);
  assert.equal(readlinkSync(path.join(w.acct, "history.jsonl")), path.join(w.base, "history.jsonl"));
  assert.deepEqual(
    readFileSync(path.join(w.base, "history.jsonl")),
    Buffer.concat([Buffer.from('{"text":"one"}\n{"text":"two"}\n{"text":"three"}\n'), odd, Buffer.from("\n")]),
  );
  const [aside] = backupsOf(w.acct, "history.jsonl");
  assert.match(aside ?? "", /^history\.jsonl\.pre-link\.\d+$/);
  assert.ok(r.changes.some((l) => l.includes("(2 lines added); the original is kept as")), r.changes.join("\n"));
});

test("a database is never merged: the home's, with its WAL, is kept beside the link and the base's is the one in use", () => {
  const w = world();
  const baseDb = new DatabaseSync(path.join(w.base, "memories_1.sqlite"));
  baseDb.exec("CREATE TABLE m(x); INSERT INTO m VALUES ('base');");
  baseDb.close();
  // The home's is left OPEN in WAL mode, so its -wal and -shm are on disk.
  const homeDb = new DatabaseSync(path.join(w.acct, "memories_1.sqlite"));
  homeDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE m(x); INSERT INTO m VALUES ('home');");
  assert.ok(existsSync(path.join(w.acct, "memories_1.sqlite-wal")), "fixture sanity: the WAL is there");

  const r = shareCodexState(w.acct);
  homeDb.close();

  assert.deepEqual(r.problems, []);
  assert.equal(readlinkSync(path.join(w.acct, "memories_1.sqlite")), path.join(w.base, "memories_1.sqlite"));
  const [stem] = backupsOf(w.acct, "memories_1.sqlite").filter((n) => !/-(wal|shm)$/.test(n));
  assert.ok(stem, r.changes.join("\n"));
  assert.ok(existsSync(path.join(w.acct, `${stem}-wal`)), "the WAL went with its database");
  assert.equal(existsSync(path.join(w.acct, "memories_1.sqlite-wal")), false);
  // The kept copy is still a database, WAL and all; the linked one is the base's.
  const kept = new DatabaseSync(path.join(w.acct, stem!), { readOnly: true });
  assert.deepEqual(kept.prepare("SELECT x FROM m").all().map((row) => row.x), ["home"]);
  kept.close();
  const viaLink = new DatabaseSync(path.join(w.acct, "memories_1.sqlite"), { readOnly: true });
  assert.deepEqual(viaLink.prepare("SELECT x FROM m").all().map((row) => row.x), ["base"]);
  viaLink.close();
  assert.ok(r.changes.some((l) => l.includes("a database is never merged")), r.changes.join("\n"));
});

test("SQLite opened through the link keeps its WAL beside the base's database — one WAL for every home, not one each", () => {
  // The empirical fact the whole design leans on (checked against Codex
  // 0.156.1 itself, too): a symlinked database resolves to the real file.
  const w = world();
  const seed = new DatabaseSync(path.join(w.base, "state_5.sqlite"));
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x);");
  seed.close();
  shareCodexState(w.acct);

  const plain = new DatabaseSync(path.join(w.base, "state_5.sqlite"));
  const viaHome = new DatabaseSync(path.join(w.acct, "state_5.sqlite"));
  viaHome.exec("INSERT INTO t VALUES ('from the home')");
  plain.exec("INSERT INTO t VALUES ('from ~/.codex')");
  assert.deepEqual(viaHome.prepare("SELECT x FROM t ORDER BY rowid").all().map((row) => row.x), ["from the home", "from ~/.codex"]);
  assert.ok(existsSync(path.join(w.base, "state_5.sqlite-wal")));
  assert.equal(existsSync(path.join(w.acct, "state_5.sqlite-wal")), false, "no second WAL beside the link");
  plain.close();
  viaHome.close();
});

test("any other file: an identical copy becomes the link with nothing kept, a different one is kept beside it", () => {
  const w = world();
  put(path.join(w.base, ".sandbox_migration"), "v1\n");
  put(path.join(w.acct, ".sandbox_migration"), "v1\n");
  put(path.join(w.base, "installation_id"), "base-id\n");
  put(path.join(w.acct, "installation_id"), "home-id\n");

  const r = shareCodexState(w.acct);

  assert.deepEqual(r.problems, []);
  assert.equal(readlinkSync(path.join(w.acct, ".sandbox_migration")), path.join(w.base, ".sandbox_migration"));
  assert.deepEqual(backupsOf(w.acct, ".sandbox_migration"), [], "an identical copy holds nothing to keep");
  assert.equal(readlinkSync(path.join(w.acct, "installation_id")), path.join(w.base, "installation_id"));
  const [aside] = backupsOf(w.acct, "installation_id");
  assert.equal(readFileSync(path.join(w.acct, aside!), "utf8"), "home-id\n");
  assert.equal(readFileSync(path.join(w.base, "installation_id"), "utf8"), "base-id\n", "the base's wins, untouched");
});

test("what the home made that the base lacks is MOVED into the base and linked — the same inode, so an open file follows", () => {
  const w = world();
  const models = put(path.join(w.acct, "models_cache.json"), "{}\n");
  const ino = statSync(models).ino;
  put(path.join(w.acct, "plugins", "cache", "x.json"), "{}\n");
  const db = new DatabaseSync(path.join(w.acct, "goals_1.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE g(x); INSERT INTO g VALUES (1);");

  const r = shareCodexState(w.acct);
  db.close();

  assert.deepEqual(r.problems, []);
  assert.equal(readlinkSync(path.join(w.acct, "models_cache.json")), path.join(w.base, "models_cache.json"));
  assert.equal(statSync(path.join(w.base, "models_cache.json")).ino, ino, "moved, not copied");
  assert.ok(existsSync(path.join(w.base, "plugins", "cache", "x.json")));
  assert.equal(readlinkSync(path.join(w.acct, "goals_1.sqlite")), path.join(w.base, "goals_1.sqlite"));
  const moved = new DatabaseSync(path.join(w.base, "goals_1.sqlite"), { readOnly: true });
  assert.deepEqual(moved.prepare("SELECT x FROM g").all().map((row) => row.x), [1]);
  moved.close();
  assert.equal(backupsOf(w.acct, "goals_1.sqlite").length, 0, "nothing displaced, nothing kept");
  assert.ok(r.changes.some((l) => /moved .*models_cache\.json into .*\.codex \(it had none\)/.test(l)), r.changes.join("\n"));
});

// --- The retired store, and links ------------------------------------------

test("the retired store is merged into ~/.codex/sessions once, then becomes a link — and a home's link at it is re-pointed", () => {
  const w = world();
  // The layout every machine had before 0.3.6.
  put(path.join(w.store, "2026", "09", "16", "rollout-2026-09-16T10-00-00-ms-1.jsonl"), "ms only\n");
  put(path.join(w.base, "sessions", "2026", "09", "19", "rollout-2026-09-19T16-17-21-both.jsonl"), "turn 1\n");
  put(path.join(w.store, "2026", "09", "19", "rollout-2026-09-19T16-17-21-both.jsonl"), "turn 1\nturn 2, in an ms pane\n");
  symlinkSync(w.store, path.join(w.acct, "sessions"));

  const r = shareCodexState(w.acct);

  assert.deepEqual(r.problems, []);
  assert.equal(readlinkSync(w.store), path.join(w.base, "sessions"));
  assert.equal(readlinkSync(path.join(w.acct, "sessions")), path.join(w.base, "sessions"), "re-pointed, not left two hops away");
  assert.equal(readFileSync(path.join(w.base, "sessions", "2026", "09", "16", "rollout-2026-09-16T10-00-00-ms-1.jsonl"), "utf8"), "ms only\n");
  assert.equal(
    readFileSync(path.join(w.base, "sessions", "2026", "09", "19", "rollout-2026-09-19T16-17-21-both.jsonl"), "utf8"),
    "turn 1\nturn 2, in an ms pane\n",
    "the conversation an ms pane took further is the one ~/.codex now holds",
  );
  const [aside] = backupsOf(path.dirname(w.store), "sessions");
  assert.ok(aside, "the old store's copy of what the base already had is kept");
  assert.ok(r.changes.some((l) => l.startsWith(`merged ${w.store} into ${path.join(w.base, "sessions")}`)), r.changes.join("\n"));
  assert.ok(r.changes.some((l) => l.startsWith(`re-pointed ${path.join(w.acct, "sessions")}`)), r.changes.join("\n"));
});

test("a symlink the human pointed somewhere else is reported and never touched", () => {
  const w = world();
  put(path.join(w.base, "AGENTS.md"), "# base\n");
  const mine = put(path.join(w.home, "elsewhere", "AGENTS.md"), "# deliberately different\n");
  symlinkSync(mine, path.join(w.acct, "AGENTS.md"));

  const r = shareCodexState(w.acct);

  assert.equal(readlinkSync(path.join(w.acct, "AGENTS.md")), mine);
  assert.ok(r.problems.some((l) => l.includes("AGENTS.md is a symlink to") && l.includes("never touched automatically")), r.problems.join("\n"));
});

test("a link at an entry the base no longer has is removed; nothing else about the home changes", () => {
  const w = world();
  put(path.join(w.base, "version.json"), "{}\n");
  shareCodexState(w.acct);
  rmSync(path.join(w.base, "version.json"));

  const r = shareCodexState(w.acct);

  assert.equal(existsSync(path.join(w.acct, "version.json")), false);
  assert.equal(lstatSync(path.join(w.acct, "sessions")).isSymbolicLink(), true);
  assert.ok(r.changes.some((l) => l.includes("version.json") && l.includes("no longer exists")), r.changes.join("\n"));
});

test("a file where the base has a directory is never merged automatically, and says so", () => {
  const w = world();
  put(path.join(w.base, "skills", "x", "SKILL.md"), "---\n");
  put(path.join(w.acct, "skills"), "not a directory\n");
  const r = shareCodexState(w.acct);
  assert.equal(readFileSync(path.join(w.acct, "skills"), "utf8"), "not a directory\n");
  assert.ok(r.problems.some((l) => l.includes("never merged automatically")), r.problems.join("\n"));
});

test("a home that IS the base is refused, and a base entry that contains the home is never linked into it", () => {
  const w = world();
  assert.ok(shareCodexHome(w.base).problems.some((l) => l.includes("a home cannot be linked to itself")));

  // An MS_HOME kept inside ~/.codex: linking `ms` into the home would be a
  // link from the home to its own ancestor.
  const inside = path.join(w.base, "ms", "codex", "work");
  mkdirSync(inside, { recursive: true, mode: 0o700 });
  const r = shareCodexHome(inside);
  assert.deepEqual(r.problems, []);
  assert.equal(existsSync(path.join(inside, "ms")), false);
  assert.equal(readlinkSync(path.join(inside, "sessions")), path.join(w.base, "sessions"));
});

// --- Idempotence, dry runs, and the one caller that refuses ------------------

test("a second run changes nothing and says nothing — the whole tree lists the same, inode for inode", () => {
  const w = world();
  // Every kind of entry, and the retired store, all at once.
  put(path.join(w.base, "history.jsonl"), '{"text":"one"}\n');
  put(path.join(w.acct, "history.jsonl"), '{"text":"two"}\n');
  put(path.join(w.acct, "sessions", "2026", "09", "23", "r.jsonl"), "home\n");
  put(path.join(w.base, "installation_id"), "base\n");
  put(path.join(w.acct, "installation_id"), "home\n");
  put(path.join(w.acct, "models_cache.json"), "{}\n");
  put(path.join(w.base, "skills", "s", "SKILL.md"), "---\n");
  put(path.join(w.store, "2026", "09", "16", "old.jsonl"), "old store\n");
  const baseDb = new DatabaseSync(path.join(w.base, "queue_1.sqlite"));
  baseDb.exec("CREATE TABLE q(x)");
  baseDb.close();
  const homeDb = new DatabaseSync(path.join(w.acct, "queue_1.sqlite"));
  homeDb.exec("CREATE TABLE q(x)");
  homeDb.close();

  // MS_HOME/locks.sqlite is the lock the pass takes: every run writes its own
  // row and deletes it again, so it is the one file that is SUPPOSED to move.
  const state = () => listing(w.base, w.msHome).filter((l) => !l.startsWith(path.join(w.msHome, "locks.sqlite")));

  const first = shareCodexState(w.acct);
  assert.deepEqual(first.problems, []);
  assert.ok(first.changes.length > 0);
  const snapshot = state();

  const second = shareCodexState(w.acct);
  assert.deepEqual(second, { changes: [], pending: [], problems: [] });
  assert.deepEqual(state(), snapshot);

  const dry = shareCodexState(w.acct, { dryRun: true });
  assert.deepEqual(dry, { changes: [], pending: [], problems: [] }, "and a dry run finds nothing to do");
});

test("a dry run reports what a real run would do, and changes nothing", () => {
  const w = world();
  put(path.join(w.base, "history.jsonl"), "{}\n");
  put(path.join(w.acct, "notes.md"), "made in the home\n");
  put(path.join(w.store, "2026", "09", "16", "old.jsonl"), "old store\n");
  const snapshot = listing(w.home);

  const dry = shareCodexState(w.acct, { dryRun: true });

  assert.deepEqual(listing(w.home), snapshot);
  assert.deepEqual(dry.changes, []);
  const said = dry.pending.join("\n");
  assert.match(said, /codex\/sessions is still a store of its own/);
  assert.match(said, /2 of .*'s entries not linked \(history\.jsonl, sessions\)/);
  assert.match(said, /notes\.md is not in .*\.codex yet/);
});

test("ensureCodexReady links the home on every launch, and refuses one whose sessions cannot be the base's", () => {
  const w = world();
  const cwd = path.join(w.home, "project");
  mkdirSync(cwd);
  put(path.join(w.acct, "history.jsonl"), '{"text":"typed before the links existed"}\n');
  const notes: string[] = [];

  assert.equal(ensureCodexReady(w.acct, cwd, MS, (l) => notes.push(l)), null);
  assert.equal(readlinkSync(path.join(w.acct, "history.jsonl")), path.join(w.base, "history.jsonl"));
  assert.ok(notes.some((l) => l.includes("history.jsonl")), notes.join("\n"));

  // A launch after that says nothing at all.
  const again: string[] = [];
  assert.equal(ensureCodexReady(w.acct, cwd, MS, (l) => again.push(l)), null);
  assert.deepEqual(again, []);

  // `sessions` pointed somewhere else is the one thing a launch refuses on:
  // a rotation into this home would resume nothing.
  rmSync(path.join(w.acct, "sessions"));
  const stray = path.join(w.home, "stray-sessions");
  mkdirSync(stray);
  symlinkSync(stray, path.join(w.acct, "sessions"));
  const refused = ensureCodexReady(w.acct, cwd, MS, () => {});
  assert.ok(refused, "refused");
  assert.match(refused!.problem, /sessions is not .*\.codex\/sessions.*ms doctor --fix/);
  assert.equal(realpathSync(path.join(w.acct, "sessions")), realpathSync(stray), "and the human's link is left alone");
});

test("ensureCodexBase refuses a base that is a file, and reports a store link that points somewhere else", () => {
  const w = world({ base: false });
  put(w.base, "not a directory\n");
  const r = ensureCodexBase();
  assert.equal(r.usable, false);
  assert.ok(r.problems.some((l) => l.includes("is not a directory")));

  const w2 = world();
  mkdirSync(path.dirname(w2.store), { recursive: true });
  symlinkSync(path.join(w2.home, "somewhere"), w2.store);
  const r2 = ensureCodexBase();
  assert.equal(r2.usable, true);
  assert.ok(r2.problems.some((l) => l.includes("never touched automatically")), r2.problems.join("\n"));
});
