// scripts/canary-issues.mjs turns the canary's JSON report into the issues a
// scheduled run files. The filing itself is `gh`; what is tested here is
// which issues a report calls for, and that nothing a CLI printed can steer
// the exact-title dedupe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { issuesFor } from "../scripts/canary-issues.mjs";

const pass = { name: "--version parses", ok: true, detail: "0.161.0" };
const fail = { name: "daemon start in an ms account home", ok: false, detail: "exit 1: failed to create daemon state directory" };

test("one issue per CLI with a failing check, none for a clean one", () => {
  const issues = issuesFor(
    [
      { tool: "codex", version: "0.161.0", results: [pass, fail], notes: ["home links 11 base entries"] },
      { tool: "claude", version: "2.1.290", results: [pass], notes: [] },
    ],
    "https://example.test/run/1",
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.title, "Canary: Codex 0.161.0 breaks ms");
  assert.match(issues[0]!.body, /Run: https:\/\/example\.test\/run\/1/);
  assert.match(issues[0]!.body, /- ✗ daemon start in an ms account home — exit 1/);
  assert.doesNotMatch(issues[0]!.body.split("<details>")[0]!, /--version parses/, "only failures above the fold");
});

test("a title carries only a known tool and a plain version", () => {
  const issues = issuesFor(
    [
      { tool: "codex", version: "0.161.0\" in:body", results: [fail] },
      { tool: "claude", version: null, results: [fail] },
      { tool: "something-else", version: "1.0.0", results: [fail] },
      null,
    ],
    "(local run)",
  );
  assert.deepEqual(issues.map((i) => i.title), ["Canary: Codex (version unknown) breaks ms", "Canary: Claude Code (version unknown) breaks ms"]);
});

test("a report that is not a list calls for nothing", () => {
  assert.deepEqual(issuesFor({ tool: "codex" }, "x"), []);
  assert.deepEqual(issuesFor(null, "x"), []);
});
