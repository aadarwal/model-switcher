// `ms accounts label <name> <text>`: name a row. Run through the real `ms`
// binary against a temp MS_HOME; no credentials, keychain or network involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run, stubDir, tempHome } from "./helpers.ts";

function book(): { env: Record<string, string>; registry: string; msHome: string } {
  const { home, msHome } = tempHome();
  const registry = path.join(msHome, "accounts.json");
  writeFileSync(
    registry,
    JSON.stringify({ version: 1, accounts: [
      { name: "claude-1", provider: "claude", label: "claude-1", orgId: null, shared: false, identityVerified: false, email: "dirk@example.edu" },
      { name: "work", provider: "claude", label: "work", orgId: null, shared: false, identityVerified: false },
      { name: "work", provider: "codex", label: "work", orgId: null, shared: false, identityVerified: false },
    ] }, null, 2) + "\n",
    { mode: 0o600 },
  );
  const { dir, stub } = stubDir();
  stub("security", "exit 44"); // `ls` reads poll grants; never the real keychain
  return { env: { HOME: home, MS_HOME: msHome, PATH: `${dir}:${process.env.PATH}` }, registry, msHome };
}

const rows = (registry: string) => (JSON.parse(readFileSync(registry, "utf8")) as { accounts: { name: string; provider: string; label: string; email?: string }[] }).accounts;

test("label: sets LABEL (the words need no quoting), keeps the rest of the row, and ls shows it; the name itself restores the default", async () => {
  const { env, registry, msHome } = book();
  const r = run(["accounts", "label", "claude-1", "Dirk", "at", "MIT"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /claude-1: label "Dirk at MIT"/);
  const row = rows(registry).find((a) => a.name === "claude-1")!;
  assert.equal(row.label, "Dirk at MIT");
  assert.equal(row.email, "dirk@example.edu", "the rest of the row is untouched");
  // Atomic like every other row write: 0600, no temp file left behind.
  assert.equal(statSync(registry).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(msHome).filter((f) => f.endsWith(".tmp")), []);

  const ls = run(["accounts", "ls"], env);
  assert.equal(ls.code, 0, ls.stderr);
  assert.match(ls.stdout.split("\n").find((l) => l.startsWith("claude-1"))!, /Dirk at MIT.*dirk@example\.edu$/);

  const back = run(["accounts", "label", "claude-1", "claude-1"], env);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stdout, /label is its name again/);
  assert.equal(rows(registry).find((a) => a.name === "claude-1")!.label, "claude-1");
});

test("label: an unknown name, a name both providers hold, no text or a control character is a usage error that writes nothing", async () => {
  const { env, registry } = book();
  const before = readFileSync(registry, "utf8");
  for (const [args, re] of [
    [["nobody", "x"], /no such account: nobody/],
    [["work", "x"], /names both a claude and a codex account — say which with --provider/],
    [["claude-1"], /label needs the text/],
    [["claude-1", "a\u001b[31mred"], /control characters/],
  ] as [string[], RegExp][]) {
    const r = run(["accounts", "label", ...args], env);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, re);
  }
  assert.equal(readFileSync(registry, "utf8"), before, "a refused label must not touch the file");

  const codex = run(["accounts", "label", "work", "Team", "--provider", "codex"], env);
  assert.equal(codex.code, 0, codex.stderr);
  const work = rows(registry).filter((a) => a.name === "work");
  assert.deepEqual(work.map((a) => [a.provider, a.label]), [["claude", "work"], ["codex", "Team"]]);
});
