// test/attention.test.ts
//
// src/attention.ts: which accounts need a human, why, since when, and the one
// command that fixes it. Pure — every case passes its own `now`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { accountAttention, attentionAge, attentionFix, DEFAULT_STALE_AFTER_MS, staleAfterMs } from "../src/attention.ts";

const NOW = Date.parse("2026-11-23T20:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const usage = (resetsAt: string | null = iso(NOW + 48 * HOUR)) => ({ session: null, weeklyAll: { usedPercent: 100, resetsAt }, weeklyFable: null });
type Input = Parameters<typeof accountAttention>[0];
const row = (over: Partial<Input> = {}): Input => ({
  name: "claude-4", provider: "claude", state: "ok", usage: usage(), observedAt: NOW - 60_000,
  error: null, errorKind: null, identityVerified: true, ...over,
});

test("a fresh, verified, signed-in account needs nothing", () => {
  assert.equal(accountAttention(row(), NOW), null);
  // A reading this round merely didn't refresh (a backoff) is ordinary.
  assert.equal(accountAttention(row({ state: "stale", observedAt: NOW - 20 * 60_000 }), NOW), null);
  assert.equal(accountAttention(row({ state: "transient", errorKind: "transient", error: "502" }), NOW), null);
});

test("an expired sign-in is logged out and stale, with the relogin command and the age of its last reading", () => {
  const at = accountAttention(row({ state: "auth", errorKind: "auth", error: "refresh rejected: invalid_grant", observedAt: NOW - 37 * 24 * HOUR, usage: usage(iso(NOW - 30 * 24 * HOUR)) }), NOW)!;
  assert.deepEqual(at.reasons, ["auth", "stale", "reset-passed"]);
  assert.equal(at.loggedOut, true);
  assert.equal(at.stale, true);
  assert.equal(at.lastGoodAt, NOW - 37 * 24 * HOUR);
  assert.equal(at.fix, "ms accounts login claude-4 --provider claude --relogin");
  assert.match(at.detail, /^logged out: sign-in expired or revoked; usage not refreshed; reading is from before its window reset; last good reading 37d ago$/);
});

test("no poll grant, no launch token, and a Codex sign-in each name their own fix", () => {
  const noGrant = accountAttention(row({ state: "no-grant", errorKind: "auth", error: "no poll grant (run: ms accounts login claude-4)", observedAt: null, usage: null }), NOW)!;
  assert.deepEqual(noGrant.reasons, ["no-grant", "never-read"]);
  assert.equal(noGrant.lastGoodAt, null);
  assert.equal(noGrant.fix, "ms accounts login claude-4 --provider claude --relogin");

  const noToken = accountAttention(row({ state: "no-token", errorKind: "auth", error: "no poll grant" }), NOW)!;
  assert.deepEqual(noToken.reasons, ["no-token", "no-grant"]);
  assert.equal(noToken.loggedOut, true);

  const codex = accountAttention(row({ name: "work", provider: "codex", state: "no-grant", errorKind: "auth", error: "no credentials", observedAt: null }), NOW)!;
  assert.equal(codex.fix, "ms accounts login work --provider codex");
});

test("an unverified identity over a fresh reading is flagged, but its numbers are still current", () => {
  const at = accountAttention(row({ identityVerified: false }), NOW)!;
  assert.deepEqual(at.reasons, ["unverified"]);
  assert.equal(at.stale, false);
  assert.equal(at.loggedOut, false);
  assert.equal(at.fix, "ms accounts verify claude-4 --provider claude");
  // No registry row says nothing about identity either way.
  assert.equal(accountAttention(row({ identityVerified: undefined }), NOW), null);
});

test("a reading older than the threshold is stale even with a working credential; the threshold is configurable", () => {
  const old = row({ state: "stale", observedAt: NOW - 7 * HOUR, error: "429", errorKind: null });
  const at = accountAttention(old, NOW)!;
  assert.deepEqual(at.reasons, ["stale"]);
  assert.equal(at.loggedOut, false);
  assert.equal(at.fix, "ms accounts verify claude-4 --provider claude");
  assert.match(at.detail, /last good reading 7h ago; last poll: 429$/);
  assert.equal(accountAttention(old, NOW, 8 * HOUR), null);
  assert.equal(DEFAULT_STALE_AFTER_MS, 6 * HOUR);
  assert.equal(staleAfterMs({ MS_STALE_AFTER_HOURS: "24" }), 24 * HOUR);
  assert.equal(staleAfterMs({ MS_STALE_AFTER_HOURS: "0.5" }), HOUR / 2);
  for (const bad of ["", "0", "-3", "soon"]) assert.equal(staleAfterMs({ MS_STALE_AFTER_HOURS: bad }), DEFAULT_STALE_AFTER_MS, bad);
});

test("a reset that passed after the reading was taken makes the reading stale; one the reading already saw does not", () => {
  const passed = accountAttention(row({ observedAt: NOW - HOUR, usage: usage(iso(NOW - 30 * 60_000)) }), NOW)!;
  assert.deepEqual(passed.reasons, ["reset-passed"]);
  assert.equal(passed.stale, true);
  assert.equal(accountAttention(row({ observedAt: NOW - 60_000, usage: usage(iso(NOW - HOUR)) }), NOW), null);
});

test("attentionAge / attentionFix: whole units, largest first; the fix follows the worst reason", () => {
  assert.equal(attentionAge(NOW - 45_000, NOW), "45s");
  assert.equal(attentionAge(NOW - 12 * 60_000, NOW), "12m");
  assert.equal(attentionAge(NOW - 3 * HOUR, NOW), "3h");
  assert.equal(attentionAge(NOW - 37 * 24 * HOUR, NOW), "37d");
  assert.equal(attentionAge(NOW + 5_000, NOW), "0s");
  assert.equal(attentionFix("a", "claude", ["unverified", "auth"]), "ms accounts login a --provider claude --relogin");
  assert.equal(attentionFix("a", "codex", ["stale"]), "ms accounts verify a --provider codex");
});
