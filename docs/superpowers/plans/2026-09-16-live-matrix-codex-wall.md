# Live matrix — a Codex usage wall, observed end to end

Date: 2026-09-16 18:50 local. `ms` 0.2.3 (brew), Codex CLI 0.153.4, macOS 26. Laptop, real store, anu's arm paused for the run.

## Why a mock

All seven ChatGPT accounts are Pro (weekly-only windows, none near 100 %), so no real wall could be reached. Two facts made a deterministic stand-in honest:

- The wall's on-disk signal is real: this machine's own `~/.codex/sessions` holds 85 rollouts with `{"type":"event_msg","payload":{"type":"task_complete","turn_id":…,"error":{"message":"You've hit your usage limit. … or try again at …","codex_error_info":"usage_limit_exceeded"}}}` — the exact shape `src/hooks/codex-hook.ts` parses.
- Codex's source (`codex-rs`, tag rust-v0.154.0) maps exactly one response to that error: HTTP 429 with `{"error":{"type":"usage_limit_reached","plan_type":"pro","resets_at":<unix>}}`, no client retries (`codex-api/src/api_bridge.rs`); the TUI prints `■ You've hit your usage limit. … or try again at <time>.` (`protocol/src/error.rs`, `tui/.../notices.rs`).

So only the tool's reaction chain was unobserved. `scripts/codex-wall-mock.mjs` (node, no dependencies) answers the inference call with that 429, refuses the WebSocket upgrade with 426 so the client falls back to HTTP, and serves a healthy Pro-shaped usage body. A scratch account `wallme` (a copy of a fresh credential, sent only to the mock, removed afterwards) carried in its `config.toml`:

```toml
chatgpt_base_url = "http://127.0.0.1:8899/backend-api"
openai_base_url  = "http://127.0.0.1:8899/backend-api/codex"
```

The first attempt used a custom `[model_providers.mock]` instead; the rollout persists `model_provider`, so the resume on the real account failed with `Model provider mock not found` and the tool parked the session — the correct reaction to a dead relaunch, and the reason the drill uses the URL override, which keeps the provider id `openai`.

## Run

`MS_CODEX_AUTOROTATE=1 ms codex --as wallme` in a pane on a separate tmux server; one prompt (`Reply with the single word ok and nothing else.`).

| t (s) | Observed |
|---|---|
| 0 | prompt submitted; mock: `POST /backend-api/codex/responses -> 429`; TUI: `■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:50 PM.` |
| +45 | watchdog pass (45 s interval — an account ≥ 80 %): `rate_limited` recorded (`kindDetail: session`, the rollout's `turn_id`) |
| +46 | recovery: `handing wallme → kratuvak (session wall)`; Ctrl-C ×2; `ended` |
| +47 | `respawned pane %0 on kratuvak`, `codex resume <id> "<continuation>"` |
| +50 | `resumed` (generation 2), `activity`; Codex printed the continuation prompt and answered `• ok`; `stop` recorded |
| +51 | `ms status`: `kratuvak … continuing 2` (reads `running` at the next prompt) |

Events (`sessions/<id>/events.jsonl`): `started`, `activity`, `rate_limited`, `ended`, `resumed`, `activity`, `stop`. Recovery log: three lines, no screen scraping needed. The real account's own warning (`less than 25 % of your weekly limit left`) appeared in the resumed pane — genuine usage, genuine account.

Verdict: **PASS**. The wall-to-answer time is ~50 s, of which ~45 s is the watchdog interval and ~4 s the handoff.

## Follow-ups landing in 0.2.4
- Automatic Codex recovery defaults ON (`MS_CODEX_AUTOROTATE=0` to disable), with the caps the consult asked for: one recovery per fresh turn, exclusive session lock, each candidate once per wall, at most three account changes per session per ten minutes, pause on exhaustion.
- `parseTaskComplete` also accepts the `turn_complete` alias.
- `wall.ts` recognises the TUI's `■` glyph (landed with the mock).
- The mock, its tests and its doc ship in the repo (`scripts/codex-wall-mock.mjs`, `docs/superpowers/plans/2026-09-16-codex-wall-mock.md`).
