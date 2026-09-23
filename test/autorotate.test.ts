import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_AUTOROTATE_KEY,
  codexAutorotateEnabled,
  codexAutorotateEnv,
  codexAutorotateLine,
  syncCodexAutorotate,
  REBALANCE_KEY,
  rebalanceEnabled,
  rebalanceEnv,
  rebalanceLine,
  syncRebalance,
  type AutorotateStore,
} from "../src/autorotate.ts";

/** A store that is nothing but the two methods the gate uses, so these tests
 * say something about the RULE and not about sqlite. */
function store(initial?: Record<string, string>): AutorotateStore & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    map,
    writes: 0,
    getKv(k) { return map.get(k) ?? null; },
    setKv(k, v) { map.set(k, v); this.writes++; },
  };
}

function withEnv(v: string | undefined, fn: () => void): void {
  const saved = process.env.MS_CODEX_AUTOROTATE;
  if (v === undefined) delete process.env.MS_CODEX_AUTOROTATE;
  else process.env.MS_CODEX_AUTOROTATE = v;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.MS_CODEX_AUTOROTATE;
    else process.env.MS_CODEX_AUTOROTATE = saved;
  }
}

test("the environment is three-valued: on, off, and not set here", () => {
  withEnv(undefined, () => assert.equal(codexAutorotateEnv(), null));
  withEnv("", () => assert.equal(codexAutorotateEnv(), null, "an empty export is not an answer"));
  withEnv("1", () => assert.equal(codexAutorotateEnv(), true));
  // Exactly "1" is on. Everything else somebody wrote down is them saying no.
  for (const v of ["0", "false", "no", "true", "yes", "01", " 1"]) {
    withEnv(v, () => assert.equal(codexAutorotateEnv(), false, v));
  }
});

test("absent everywhere is ON: Codex automatic recovery is the default since 0.2.4", () => {
  // The gate shipped off while no live Codex wall had been observed. It has
  // been now — 85 real walled rollouts carry the record the tool parses, and
  // the whole chain was watched end to end — so silence means on.
  withEnv(undefined, () => assert.equal(codexAutorotateEnabled(store()), true));
  withEnv("", () => assert.equal(codexAutorotateEnabled(store()), true, "an empty export is not somebody saying no"));
});

test("the stored gate is read WITHOUT the environment — the tmux-dispatched case", () => {
  // `ms _recover` runs under `tmux run-shell`, which carries the tmux server's
  // global environment and not the shell that exported the flag. This is the
  // whole reason the gate is a stored row.
  withEnv(undefined, () => {
    assert.equal(codexAutorotateEnabled(store({ [CODEX_AUTOROTATE_KEY]: "1" })), true);
    assert.equal(codexAutorotateEnabled(store({ [CODEX_AUTOROTATE_KEY]: "0" })), false);
  });
});

test("the stored gate WINS over the environment whenever there is one", () => {
  // The hook keeps the store current from the shell that actually runs codex,
  // so a stale variable in some other environment must not overrule it.
  withEnv("1", () => assert.equal(codexAutorotateEnabled(store({ [CODEX_AUTOROTATE_KEY]: "0" })), false, "stored off beats env on"));
  withEnv("0", () => assert.equal(codexAutorotateEnabled(store({ [CODEX_AUTOROTATE_KEY]: "1" })), true, "stored on beats env off"));
});

test("the environment is the fallback only while nothing has been stored", () => {
  withEnv("1", () => assert.equal(codexAutorotateEnabled(store()), true));
  withEnv("0", () => assert.equal(codexAutorotateEnabled(store()), false));
  // Only "1" is yes, so every other exported value is off — `false` and `no`
  // as intended, but a typo too. Somebody who exports MS_CODEX_AUTOROTATE=true
  // to be explicit turns the feature OFF, and the mirror writes that down.
  // That is the rule `codexAutorotateEnv` states, and the README's env table
  // says it in those words rather than "anything else leaves it on".
  withEnv("true", () => assert.equal(codexAutorotateEnabled(store()), false, "not '1' is off, exactly as codexAutorotateEnv reads it"));
  // A value the gate does not recognise is not a gate: fall back, do not guess.
  withEnv("1", () => assert.equal(codexAutorotateEnabled(store({ [CODEX_AUTOROTATE_KEY]: "yes" })), true));
  withEnv(undefined, () => assert.equal(codexAutorotateEnabled(store({ [CODEX_AUTOROTATE_KEY]: "yes" })), true, "an unrecognised row falls back to the default, which is on"));
});

test("syncCodexAutorotate mirrors an export, and an unset variable changes nothing", () => {
  const s1 = store();
  withEnv("1", () => syncCodexAutorotate(s1));
  assert.equal(s1.map.get(CODEX_AUTOROTATE_KEY), "1");

  const s2 = store({ [CODEX_AUTOROTATE_KEY]: "1" });
  withEnv("0", () => syncCodexAutorotate(s2));
  assert.equal(s2.map.get(CODEX_AUTOROTATE_KEY), "0", "turning it off travels too");

  // "I was not told" is never "turn it off": a shell with no export must not
  // undo the gate a flagged shell set.
  const s3 = store({ [CODEX_AUTOROTATE_KEY]: "1" });
  withEnv(undefined, () => syncCodexAutorotate(s3));
  assert.equal(s3.map.get(CODEX_AUTOROTATE_KEY), "1");
  assert.equal(s3.writes, 0, "and nothing was written");

  // An unchanged gate is not rewritten on every hook event.
  const s4 = store({ [CODEX_AUTOROTATE_KEY]: "1" });
  withEnv("1", () => syncCodexAutorotate(s4));
  assert.equal(s4.writes, 0);
});

test("the doctor line names the export that would flip it, both ways round", () => {
  assert.equal(codexAutorotateLine(true), "codex auto-recovery: on (export MS_CODEX_AUTOROTATE=0 to disable)");
  assert.equal(codexAutorotateLine(false), "codex auto-recovery: off (export MS_CODEX_AUTOROTATE=1 to enable)");
});

// --- The rebalance gate --------------------------------------------------

function withRebalanceEnv(v: string | undefined, fn: () => void): void {
  const saved = process.env.MS_REBALANCE;
  if (v === undefined) delete process.env.MS_REBALANCE;
  else process.env.MS_REBALANCE = v;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.MS_REBALANCE;
    else process.env.MS_REBALANCE = saved;
  }
}

test("absent everywhere is ON: rebalance joins Codex auto-recovery in defaulting on", () => {
  // It shipped off in 0.3.1 while nobody had watched it move work; that
  // observation is done, so — like the Codex gate above — silence means on.
  withRebalanceEnv(undefined, () => {
    assert.equal(rebalanceEnabled(store()), true);
    assert.equal(rebalanceEnabled(store({ nothing: "1" })), true);
  });
  withRebalanceEnv("", () => assert.equal(rebalanceEnabled(store()), true, "an empty export is not somebody saying no"));
});

test("only an exact '0' turns rebalance off, from either the store or the shell", () => {
  withRebalanceEnv(undefined, () => {
    assert.equal(rebalanceEnabled(store({ [REBALANCE_KEY]: "1" })), true);
    assert.equal(rebalanceEnabled(store({ [REBALANCE_KEY]: "0" })), false);
    assert.equal(rebalanceEnabled(store({ [REBALANCE_KEY]: "yes" })), true, "an unrecognised row falls back to the default, which is on");
  });
  withRebalanceEnv("0", () => assert.equal(rebalanceEnabled(store()), false));
  // Only "1" is yes, so every other exported value — including an explicit
  // "true" — is read as off, the same rule rebalanceEnv states.
  for (const v of ["true", "no", "01", " 1"]) {
    withRebalanceEnv(v, () => assert.equal(rebalanceEnabled(store()), false, v));
  }
  withRebalanceEnv("1", () => assert.equal(rebalanceEnabled(store()), true));
});

test("the stored rebalance gate WINS over the environment — the tmux-dispatched case", () => {
  withRebalanceEnv("1", () => assert.equal(rebalanceEnabled(store({ [REBALANCE_KEY]: "0" })), false, "stored off beats env on"));
  withRebalanceEnv("0", () => assert.equal(rebalanceEnabled(store({ [REBALANCE_KEY]: "1" })), true, "stored on beats env off"));
});

test("the rebalance environment is three-valued, exactly as the Codex one is", () => {
  withRebalanceEnv(undefined, () => assert.equal(rebalanceEnv(), null));
  withRebalanceEnv("", () => assert.equal(rebalanceEnv(), null));
  withRebalanceEnv("1", () => assert.equal(rebalanceEnv(), true));
  withRebalanceEnv("0", () => assert.equal(rebalanceEnv(), false));
});

test("syncRebalance mirrors an export, and an unset variable changes nothing", () => {
  const s1 = store();
  withRebalanceEnv("1", () => syncRebalance(s1));
  assert.equal(s1.map.get(REBALANCE_KEY), "1");

  const s2 = store({ [REBALANCE_KEY]: "1" });
  withRebalanceEnv("0", () => syncRebalance(s2));
  assert.equal(s2.map.get(REBALANCE_KEY), "0", "turning it off travels too");

  const s3 = store({ [REBALANCE_KEY]: "1" });
  withRebalanceEnv(undefined, () => syncRebalance(s3));
  assert.equal(s3.map.get(REBALANCE_KEY), "1");
  assert.equal(s3.writes, 0, "and nothing was written");

  const s4 = store({ [REBALANCE_KEY]: "1" });
  withRebalanceEnv("1", () => syncRebalance(s4));
  assert.equal(s4.writes, 0, "an unchanged gate is not rewritten on every turn");
});

test("the rebalance doctor line names the export that would flip it, both ways round", () => {
  assert.equal(rebalanceLine(true), "rebalance: on (export MS_REBALANCE=0 to disable)");
  assert.equal(rebalanceLine(false), "rebalance: off (export MS_REBALANCE=1 to enable)");
});
