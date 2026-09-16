# The Codex wall drill — observing a real wall without spending a subscription

`ms`'s automatic recovery for Codex ships **off**, for one reason and one only:
no live Codex wall has ever been observed end to end (spike verdict G1:
PARTIAL; `src/autorotate.ts`, README "What rotation does to a pane"). The gate
is honest — the tool will not move a human's session on a signal nobody has
seen — but it can only be lifted by seeing one.

Seeing one the ordinary way costs a subscription's weekly quota. This drill
gets the same evidence in about a minute, by making exactly one thing fake: the
two HTTP endpoints that decide "you are out of quota". Everything else is real
— a real `codex` binary, a real account, a real `auth.json`, a real tmux pane,
ms's real hooks, the real rollout watcher, the real rotation.

The instrument is `scripts/codex-wall-mock.mjs` (zero dependencies, `node:http`,
127.0.0.1 only). Its contract is pinned by `test/codex-wall-mock.test.ts`, so
when the drill fails you can tell the CLI's fault from the mock's.

Every claim below cites its source in openai/codex **`rust-v0.154.0`** (commit
`6b9826e`), with paths relative to that checkout's `codex-rs/`.

---

## 0. Why this works at all

| Fact | Source |
|---|---|
| A 429 whose body is `{"error":{"type":"usage_limit_reached"}}` is the *only* thing that becomes a wall. | `codex-api/src/api_bridge.rs:132-163` |
| `plan_type` and `resets_at` live inside that `error` object; `resets_at` is **unix seconds**. Unknown fields are ignored. | `codex-api/src/api_bridge.rs:259-270` |
| Any other 429 body is `CodexErr::RetryLimit` instead — a different error, different text, not a wall. | `codex-api/src/api_bridge.rs:165` |
| There is no retry to wait out: 429 is excluded from transport retry, `UsageLimitReached` is non-retryable, and the turn loop returns before the retry machinery. One round trip. | `model-provider-info/src/lib.rs:313-319`; `protocol/src/error.rs:370-392`; `core/src/session/turn.rs:1489-1496` |
| The turn POSTs to `{base_url}/responses`, and `base_url` is whatever the config says — no scheme check, no host allowlist. | `codex-api/src/endpoint/responses.rs:42`; `codex-api/src/provider.rs:52` |
| It maps to the wire value `usage_limit_exceeded`, which is what ms tails. | `protocol/src/error.rs:436-438`; `protocol/src/protocol.rs:1848-1854` |

There is **no built-in "simulate a usage limit" switch** in Codex — no env var,
no `--config` knob, no debug subcommand. Redirecting the base URL is the
supported way in, and it is the way OpenAI's own integration tests do it
(`core/tests/common/test_codex.rs:820-827`).

---

## 1. Register a scratch account

Use a throwaway ChatGPT account. It is never actually charged — no turn of
this drill reaches OpenAI — but the drill does rotate *away* from it, so the
pool needs at least one other Codex account with room for the rotation to land
on.

```bash
ms accounts add wallscratch --provider codex --label "Wall drill"
ms accounts login wallscratch --provider codex          # --device-auth over SSH
```

`login` writes `auth.json` into that account's own `CODEX_HOME`, which is
`$MS_HOME/codex/wallscratch` (`src/paths.ts`'s `p.codexHome`; `MS_HOME`
defaults to `~/.config/model-switcher`). Note the path — the next step edits
the `config.toml` beside it.

---

## 2. Start the mock

```bash
node scripts/codex-wall-mock.mjs --port 8899
# codex-wall-mock: http://127.0.0.1:8899
```

It prints its URL once on stdout and one `METHOD PATH -> STATUS` line per
request on stderr. It logs **no bodies and no headers**: this thing sits
between a real credential and a real CLI, and must never become the one place a
token or a prompt is written down (`test/codex-wall-mock.test.ts`, "the log
carries method, path and status").

Flags:

| Flag | Default | What it does |
|---|---|---|
| `--port N` | `0` (OS picks) | Bind port. Pin it so the config below can name it. |
| `--resets-in SECONDS` | `3600` | The wall's `resets_at` is `now + this`, in unix seconds. |
| `--allow-turns N` | `0` | Serve `N` normal turns before walling. `0` walls the first. |
| `--usage-json FILE` | — | Serve this JSON from `/wham/usage` instead of the built-in healthy body. |
| `--generic-429` | off | Serve the **non-wall** 429 instead — see §7. |

What it answers:

| Request | Answer |
|---|---|
| `POST …/responses` (any base) | the quota 429, or an SSE turn while `--allow-turns` lasts |
| `GET …/wham/usage`, `GET …/api/codex/usage` | 200, a healthy Pro-shaped body (§4) |
| any WebSocket handshake | **426 Upgrade Required** (§3) |
| anything else | 404 |

---

## 3. The scratch account's `config.toml`

Both routes below work. Use the first.

`$MS_HOME/codex/wallscratch/config.toml` — the **user-level** config for that
account. This matters: `openai_base_url`, `chatgpt_base_url`, `model_provider`
and `model_providers` are all on Codex's project-local denylist, so a repo's
`.codex/config.toml` can never set them (`config/src/loader/mod.rs:72-89`;
test at `core/src/config/config_loader_tests.rs:3721-3812`). Put them here or
nowhere.

### Preferred — a custom provider (no WebSocket in the way)

```toml
model_provider = "mock"
chatgpt_base_url = "http://127.0.0.1:8899/backend-api"

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:8899/v1"
wire_api = "responses"
```

Three keys, three reasons:

- `base_url` ⇒ the turn POSTs `http://127.0.0.1:8899/v1/responses`
  (`codex-api/src/provider.rs:52`).
- A custom provider's `supports_websockets` defaults to **false**
  (`model-provider-info/src/lib.rs:147-149`), so the client never tries the
  WebSocket transport at all — which is the whole reason to prefer this route.
  `requires_openai_auth` defaults false too (`:143-145`), so the provider needs
  no credential of its own.
- `chatgpt_base_url` ⇒ the CLI's own usage poll goes to
  `http://127.0.0.1:8899/backend-api/wham/usage`
  (`backend-client/src/client.rs:117-133` picks the `wham/…` family because the
  base URL contains `/backend-api`;
  `backend-client/src/client/rate_limit_resets.rs:124-129` builds the path).

Equivalently, without editing the file at all:

```bash
ms codex --as wallscratch -- \
  -c 'model_provider="mock"' \
  -c 'model_providers.mock.name="mock"' \
  -c 'model_providers.mock.base_url="http://127.0.0.1:8899/v1"' \
  -c 'model_providers.mock.wire_api="responses"' \
  -c 'chatgpt_base_url="http://127.0.0.1:8899/backend-api"'
```

(`ms codex` passes everything after `--` to the CLI unchanged; `-c` is the
highest-precedence config layer, `config/src/loader/mod.rs:277-290`.) The `-c`
form leaves no file to clean up, which is the safer default if you only want
one run.

### Alternative — the built-in provider

```toml
openai_base_url = "http://127.0.0.1:8899/backend-api/codex"
chatgpt_base_url = "http://127.0.0.1:8899/backend-api"
```

This keeps `model_provider = "openai"`, whose `supports_websockets` is **true**
(`model-provider-info/src/lib.rs:419`), so the client tries a WebSocket
handshake first (`core/src/client.rs:1013-1017`). It falls back to plain HTTP
for exactly one answer — HTTP **426 Upgrade Required**
(`core/src/client.rs:1808-1812`); any other outcome is a hard error and the
POST that carries the wall never happens. The mock answers every handshake 426,
so this route works; it is listed second only because it has one more moving
part. It is the more faithful reproduction of the real ChatGPT path, so reach
for it if you are specifically testing transport behaviour.

### ms writes this file too — and does not disturb those keys

`ms` writes directory trust (`[projects."<cwd>"]`) and its hook block
(between `# ms-hooks-begin` / `# ms-hooks-end`) into this same `config.toml` on
every launch and every rotation. Neither writer parses TOML: `ensureCodexTrust`
(`src/providers/codex-cli.ts`) edits by line scan and appends, and the hook
installer (`src/hooks/codex-install.ts`) rebuilds only the marked block and
copies the prefix and suffix through byte for byte. Pinned by
`test/codex-install.test.ts`, "a human's base-URL overrides survive trust, a
hook install, and a repair" — which asserts the keys survive **and** that they
are still *root* keys afterwards, since a line that slid under a table header
would no longer be the override you meant.

One thing to get right yourself: **put these keys at the top of the file**,
above any `[table]` header. TOML scopes a bare key to the table above it, and
ms appends its tables at the end.

---

## 4. The usage poll stays healthy — on purpose

The mock's `/wham/usage` body says the account has **room**: `plan_type: "pro"`,
one 168 h window at 40 %, no secondary.

That is not laziness, it is the scenario. A real wall arrives mid-turn while
the usage snapshot still says there is headroom, and `ms` has to rank and
rotate through exactly that. An account that polled as 100 % would be gated by
the chooser before it was ever picked, and the drill would prove nothing.

One body satisfies both readers, which is why it is shaped the way it is:

- The **CLI** deserialises `RateLimitStatusWithResetCredits`
  (`backend-client/src/types.rs:55-67`), which flattens `RateLimitStatusPayload`
  (`codex-backend-openapi-models/…/rate_limit_status_payload.rs:15-52`) — so
  `plan_type` and `rate_limit` sit at the **top** level. `allowed` and
  `limit_reached` are required (`…/rate_limit_status_details.rs:18-20`), and a
  window carries all four of `used_percent`, `limit_window_seconds`,
  `reset_after_seconds`, `reset_at` (`…/rate_limit_window_snapshot.rs:14-22` —
  none optional).
- **ms** reads the same top-level `rate_limit.primary_window`
  (`src/providers/codex-usage.ts`). 604 800 s is ≥ a day, so it classifies as
  the weekly window and the session window is null — which is the real shape of
  a Codex Pro account, and a case `pick.ts` already tolerates.

**A gotcha worth knowing:** `chatgpt_base_url` redirects *the CLI's* poll only.
`ms`'s own poller uses a hard-coded `CODEX_USAGE_URL`
(`src/providers/codex-usage.ts`), so `ms status` keeps reading the real
`chatgpt.com/backend-api/wham/usage` with the real token throughout this drill.
That is fine — it is a read-only call that consumes no model quota — but it
means `ms status`'s numbers during the drill are the scratch account's *real*
ones, not the mock's. The mock's body still has to be right, because the CLI
reads it and because `test/codex-wall-mock.test.ts` runs ms's real parser over
it.

---

## 5. Run it

```bash
ms codex --as wallscratch
```

Type anything. Within one round trip:

**In the mock's log** (stderr):

```
codex-wall-mock: POST /v1/responses -> 429
```

**On screen**, one red line — the Codex TUI renders every error as
`format!("■ {message}")` (`tui/src/history_cell/notices.rs:244-250`, reached
from `tui/src/chatwidget/turn_runtime.rs:372-385`):

```
■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:29 PM.
```

The sentence is built client-side from `plan_type` and `resets_at`
(`protocol/src/error.rs:710-751`), so `--resets-in` changes the tail: within the
same local day it renders a bare clock time (`10:29 PM`), otherwise a full date
(`Sep 11th, 2026 9:23 PM`) — `format_retry_timestamp`, `protocol/src/error.rs:772-784`.
`plan_type: "pro"` selects the "purchase more credits" wording; the mock's
`--usage-json` does not change this, the 429's own `plan_type` does.

**In the rollout** — `$MS_HOME/codex/sessions/**/rollout-*.jsonl`, last line.
This is the only durable record: `EventMsg::Error` is explicitly *not*
persisted (`rollout/src/policy.rs:141`), while `TurnComplete` is (`:113-118`).

```json
{"timestamp":"…","type":"event_msg","payload":{
  "type":"task_complete",
  "turn_id":"…",
  "last_agent_message":null,
  "error":{
    "message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 11th, 2026 9:23 PM.",
    "codex_error_info":"usage_limit_exceeded"
  },
  "started_at":…,"completed_at":…,"duration_ms":…}}
```

There is **no `turn_aborted`** — that variant is for interrupts and budget
stops (`core/src/tasks/mod.rs:592-595`). The `task_complete` line is usually
preceded by `token_count` lines carrying rate-limit snapshots, but only if the
429 carried the `x-codex-*` headers; the mock sends none, so expect none.

---

## 6. What `ms` should show

**`ms status`.** The session's row should read walled, from the rollout record
and not from the screen. `ms _codex_watch` tails the rollout for a
`task_complete` whose `error.codex_error_info` is `usage_limit_exceeded`
(`src/hooks/codex-hook.ts`'s `parseTaskComplete`) and appends a `rate_limited`
event. A session whose pane *looks* walled with no such event reads
**`unreported`** — so `unreported` here is the failure mode to watch for: it
means the pane rendered the wall but the watcher did not see the record.

Two timing notes. The watchdog is **one timer for the whole tmux server**, armed
45 s out by `UserPromptSubmit` and re-armed while any Codex turn is in flight
(`src/hooks/codex-hook.ts`), so give it up to a minute before calling it a miss.
And `parseTaskComplete` matches the literal `task_complete` only — the v2 alias
`turn_complete` is accepted on the wire (`protocol/src/protocol.rs:1413-1415`)
but is not matched here. If a future Codex writes the v2 spelling, this drill is
how you will find out: the wall renders, and `ms status` says `unreported`.

**The screen classifier.** `src/wall.ts` labels a wall's *kind* for `ms status`
only; it never triggers a rotation. `wallKindFromText` now accepts the Codex
`■` glyph at the line start (it did not before this drill — the real TUI line
never matched, which is the first thing the drill found). Pinned by
`test/wall.test.ts`, "the Codex wall is named through the TUI's own ■ error
glyph". Known remaining gap: a wall that arrives during an auto-compaction is
prefixed `Error running remote compact task: `
(`protocol/src/error.rs:468-480`, call site `core/src/compact_remote_v2.rs:213`)
and will not match — deliberately, because allowing an arbitrary `…: ` prefix
would re-open the quoted-prose false positive the file exists to prevent.

**Rotation.** Automatic recovery is gated off (`src/autorotate.ts`). With the
gate closed, the expected outcome is: the wall recorded, `ms status` showing it,
and **nothing moved**. Then:

```bash
ms rotate                      # the manual move, always available
```

To exercise the automatic path, open the gate in the shell that runs `codex`:

```bash
MS_CODEX_AUTOROTATE=1 ms codex --as wallscratch
```

The variable is mirrored into the store on the way past, so the
tmux-dispatched `_codex_watch` and `_recover` see it too — they are run with
the tmux *server's* environment, not your shell's, which is the whole reason
the gate is a stored row (`src/autorotate.ts`).

**The recovery log.** `$MS_HOME/sessions/<session-id>/recover.log`
(`src/paths.ts`'s `p.recoverLog`). Expect the worker to take the session lock,
recheck that the wall is still true and the generation has not moved, pick the
next account with room, send Ctrl-C twice, and respawn the *same* pane on the
new account running `codex resume <id>`.

⚠️ **The rotation target is a real account.** Once the pane respawns on it, that
pane is talking to the real OpenAI backend — the mock config lives in the
*scratch* account's `CODEX_HOME`, not the new one. That is the point (it proves
the resumed session works), but it is also the moment the drill starts costing
real quota, so keep the follow-up turn short.

---

## 7. Prove the negative too

A 429 is not a wall by virtue of being a 429. Re-run with:

```bash
node scripts/codex-wall-mock.mjs --port 8899 --generic-429
```

The body's `error.type` is no longer `usage_limit_reached`, so `api_bridge.rs`
falls past `:135` and `:160` to `CodexErr::RetryLimit` at `:165`. Expect:

- on screen: `■ exceeded retry limit, last status: 429 Too Many Requests`
  (`protocol/src/error.rs:628-640`) — completely different text;
- in the rollout: `codex_error_info: "response_too_many_failed_attempts"`, not
  `usage_limit_exceeded`;
- in `ms`: **no** `rate_limited` event, **no** rotation, at any gate setting.

If `ms` moves the session here, that is a bug, and it is the most valuable
thing this drill can find. Both bodies are pinned side by side in
`test/codex-wall-mock.test.ts` ("the 429 body is the ONE shape api_bridge.rs
turns into a wall") and both texts in `test/wall.test.ts`.

### A turn before the wall

`--allow-turns 2` serves two complete SSE turns and walls the third, which is
how you check that a session with real history rotates and resumes correctly
rather than an empty one. The success stream is the minimum three events
`codex-api/src/sse/responses.rs` accepts — `response.created` (`:408`), a
`response.output_item.done` message (`:357`), `response.completed` (`:483`) —
and the last is not optional: a stream that ends without it is reported as
"stream closed before response.completed" (`:598`).

---

## 8. Clean up

```bash
# 1. Stop the mock (Ctrl-C).

# 2. Remove the overrides. If you used the `-c` form there is nothing to do.
$EDITOR "$MS_HOME/codex/wallscratch/config.toml"
#    Delete: model_provider, [model_providers.mock], chatgpt_base_url,
#            openai_base_url. LEAVE the [projects."…"] table and everything
#            between # ms-hooks-begin / # ms-hooks-end — those are ms's.

# 3. Close the gate again, if you opened it.
unset MS_CODEX_AUTOROTATE      # and clear the mirrored row:
ms doctor                      # prints its state

# 4. Remove the scratch account: the registry row and every credential it names.
ms accounts remove wallscratch --provider codex
```

Leaving a stale `base_url` behind is the one mistake with teeth: the account
would then point at a dead port and every turn would fail with a connection
error rather than a wall. `ms accounts remove` deletes the whole home, so step 4
subsumes step 2 if you are not keeping the account.

---

## 9. What the drill is evidence for

If all of §5, §6 and §7 hold, the record shows: a real `codex` binary produced a
real `usage_limit_exceeded` rollout record; ms's watcher saw it; `ms status`
reported it; `ms rotate` carried the conversation to another account; and a
merely-transient 429 did none of those things. That is the observation the
`MS_CODEX_AUTOROTATE` gate has been waiting for, and the case for changing its
default belongs in the same commit as the record of this run.
