// Who an account IS, and what is running on it.
//
// A registry NAME is whatever its owner typed (`claude-7`); with ten of them the name stops saying which
// login it is. The provider's own profile already reports the e-mail at sign-in -- it was printed once and
// thrown away. It is now kept in the registry and shown beside the name. And the pool now says what is
// running on each account, which until now meant reading the sessions table sideways.

import { test } from "node:test";
import assert from "node:assert/strict";

test("registry: an e-mail survives validation; a non-string or addressless one is dropped, never a problem", async () => {
  const { validateRegistry } = await import("../src/registry.ts");
  const { registry, problems } = validateRegistry({ version: 1, accounts: [
    { name: "a", provider: "claude", email: "dirk@example.edu" },
    { name: "b", provider: "claude", email: 42 },
    { name: "c", provider: "codex", email: "not-an-address" },
    { name: "d", provider: "codex" },
  ] });
  assert.deepEqual(problems, []);
  assert.deepEqual(registry.accounts.map((a) => a.email ?? null), ["dirk@example.edu", null, null, null]);
});

test("registry: an e-mail past 254 characters, or carrying a control character, is dropped, never a problem", async () => {
  const { validateRegistry } = await import("../src/registry.ts");
  const long = `${"a".repeat(250)}@x.com`; // 256 characters, well past the bound
  const { registry, problems } = validateRegistry({ version: 1, accounts: [
    { name: "a", provider: "claude", email: long },
    { name: "b", provider: "claude", email: "a@\x1b[31mRED" },
  ] });
  assert.deepEqual(problems, []);
  assert.deepEqual(registry.accounts.map((a) => a.email ?? null), [null, null]);
});

test("sessionsByAccount: live sessions only, keyed by (provider, account) because a name is reused across providers", async () => {
  const { sessionsByAccount } = await import("../src/status.ts");
  const s = (id: string, provider: string, account: string, state: string, pane: string) => ({ id, provider, account, state, pane });
  const map = sessionsByAccount([
    s("s1", "claude", "work", "running", "%1"), s("s2", "claude", "work", "walled", "%2"),
    s("s3", "claude", "work", "gone", "%3"), s("s4", "codex", "work", "running", "%4"), s("s5", "claude", "idle", "stopped", "%5"),
  ] as never);
  assert.deepEqual(map.get("claude:work"), [{ id: "s1", pane: "%1", state: "running" }, { id: "s2", pane: "%2", state: "walled" }]);
  assert.deepEqual(map.get("codex:work"), [{ id: "s4", pane: "%4", state: "running" }]);
  assert.equal(map.get("claude:idle"), undefined, "a finished session is not running on anything");
});

test("accountRowHtml: the e-mail sits under the name and the live sessions are listed by pane; both escaped, both absent when there is nothing to say", async () => {
  const { accountRowHtml } = await import("../src/dashboard/client-logic.ts");
  const base = { name: "claude-7", label: "claude-7", state: "ok", provider: "claude", usage: null };
  const full = accountRowHtml({ ...base, email: "d<x>@example.edu", sessions: [{ id: "s1", pane: "%1", state: "running" }, { id: "s2", pane: "%2", state: "walled" }] } as never, "—");
  assert.ok(full.includes('class="ms-email"') && full.includes("d&lt;x&gt;@example.edu") && !full.includes("d<x>"));
  assert.ok(full.includes('class="ms-onacct"') && full.includes("2 sessions") && full.includes("%1") && full.includes("%2 walled"), full);
  const one = accountRowHtml({ ...base, email: null, sessions: [{ id: "s1", pane: "%1", state: "running" }] } as never, "—");
  assert.ok(one.includes("1 session") && !one.includes("1 sessions") && !one.includes("ms-email"));
  const bare = accountRowHtml({ ...base } as never, "—");
  assert.ok(!bare.includes("ms-email") && !bare.includes("ms-onacct"), "an older /api/state without the fields renders exactly as before");
});
