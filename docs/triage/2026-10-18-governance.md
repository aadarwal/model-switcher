# Issue #40: governance delivery and decisions

Status: design triage, 2026-10-18. Code baseline: `63fa35c` (0.3.15).
Sources: [proposal](https://github.com/aadarwal/model-switcher/issues/40),
[corrective comment](https://github.com/aadarwal/model-switcher/issues/40#issuecomment-6068532826),
and [current model/effort preservation](https://github.com/aadarwal/model-switcher/issues/38).
The private report linked from the proposal was not reviewed. The published correction
is a requirement for further investigation; its claims about managed settings, hooks,
mods, and fallback need verification against the exact supported Claude Code release.

## Delivery split

| Slice | Concrete work | Acceptance gate |
|---|---|---|
| Preserve model and effort (#38) | Carry the last recorded transcript/rollout values through an account handoff, replace stale flags, and report fallback. Use the effective scoped need when selecting capacity. | Parent-conversation metadata wins once; unavailable metadata retains launch behavior; stop intent still wins during probes. Picker changes before another recorded turn remain a documented limitation. |
| Preserve import configuration | Review `--effort`, `--disallowedTools`, and `--settings` individually in the import planner. Show configuration that cannot be carried before stopping the original CLI. | Import and subsequent rotations retain the approved settings with the same cwd semantics; sensitive inline settings never enter a public plan, pane command, or log. |
| Carry policy identity | Define a versioned manifest, explicit launch reference, immutable settings artifact, digest, and verification result. Bind these to session, conversation, and generation. | Missing, changed, malformed, or unverifiable governed artifacts refuse before the original pane is stopped, and again at execution. Ordinary launches keep their existing behavior. |
| Enforce a declared model | Define exact allowed model IDs and eligible accounts. Governed launch/handoff planning rejects explicit fallback configuration and has a terminal halt path. | No eligible account produces a visible halt with no automatic wakeup or weaker-model relaunch; unknown entitlement/capability cannot count as eligible. |
| Enforce runtime authority | Establish who installs and owns managed settings; verify the corrective comment's requested-switch, automatic-switch, fallback-chain, and mod behavior on supported versions. | A real-session matrix demonstrates the intended gate, including timeout and unsupported-version cases. Per-launch `--settings` alone cannot be advertised as authoritative governance. |
| Formalize with Lean | Specify the policy schema, refinement relation, trusted compiler, proof checker, and generated settings mapping. Lean consumes/produces the agreed manifest contract. | A conforming example and rejected counterexample cover both refinement and the actual deployed artifact. Implement after the preceding contracts are agreed. |

Keep #38 separate: preserving observed runtime settings is useful independently of
formal governance and does not establish a model floor.

## What current code requires

- [`execLaunch`](../../src/exec.ts) is the final execution gate, but preparation
  already changes configuration before reaching it. Fresh launches and recovery's
  `prepareCandidate` call `ensureCodexReady`, which can write project trust. Policy
  preflight must therefore precede preparation and destructive pane operations;
  verification at `_exec` is a second check of the same bound artifact.
- [`LaunchRow`](../../src/state.ts) stores argv and environment, with no governance
  reference or digest. Additive launch/session migrations need explicit ownership,
  generation, and verification fields. The local writable database is an operational
  record; its existence alone does not establish tamper-resistant audit provenance.
- [`KEPT_FLAGS`](../../src/import/plan.ts) intentionally keeps only values presumed
  non-secret. `--settings` accepts richer input than a model name or tool filter.
  Decide file versus inline JSON support, relative paths, mutable files, private
  snapshots, and redaction before adding it to the allowlist. `--mcp-config` needs
  its own handling for paths, credentials, and content identity.
- [`pickAccounts`](../../src/pick.ts) knows `any`/`fable` quota windows. It has no
  general model entitlement inventory or ordered model-quality relation. Define
  eligibility and canonical IDs explicitly; available quota is insufficient evidence
  that an account can run a declared model.
- Recovery currently waits and schedules a retry when capacity is exhausted.
  [`park`](../../src/recover.ts) updates bookkeeping and closes recovery; it does
  not itself stop the CLI. A governed halt must stop the verified current process,
  clear timers, close the recovery, record the violation, and reject automatic
  relaunch until an explicit permitted restart. Generation and pane ownership checks
  must make a delayed model-change event harmless to a replacement process.
- The Claude hook currently handles session lifecycle, activity, and rate limits.
  It has no model-switch policy events. Add typed violation/source/reason records
  before exposing them in `ms status --json`, the dashboard, and the session log.
  These existing local surfaces are the initial notification destination.

## Decisions required before enforcement

1. Supply the intended `WC.lean` examples and the versioned machine-readable contract,
   including which principal can change policy and which settings constitute authority.
   Prefer an explicit launch reference over discovering an executable policy in the cwd.
2. Choose whether a model declaration is an exact pin or an explicit allowlist. Define
   alias resolution, unavailable models, effort compatibility, and the required account
   entitlement source. No ordering between model names should be inferred.
3. Specify managed-settings provisioning, required CLI versions, handling of unknown
   capabilities, and how the corrective comment's mod and fallback restrictions are
   verified. Requested-switch blocking, automatic-switch detection, per-turn fallback,
   and trace auditing are separate acceptance cases.
4. Define halt/restart behavior and the maximum interval before consequential actions
   stop after a violation. A post-switch notification alone cannot prove that no action
   already ran under the changed model.
5. Decide how governed Codex trust is granted before either launch or handoff writes
   `trust_level`. Preserve explicit distrust and refuse unknown policy decisions.
6. Inventory other session-only state with measured evidence. Approvals, permission
   modes, monitors, and jobs cannot be reconstructed by inferring permission from a
   transcript or by copying the known model/effort fields.

This triage introduces no permission, trust, fallback, hook, or Lean execution changes.
