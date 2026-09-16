# model-switcher Plan 2 — Codex rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ms` run and rotate Codex (ChatGPT) accounts the way it already runs and rotates Claude accounts: `ms codex` launches on the account with the most room, a walled Codex pane is resumed in place on the next account, and `ms accounts`/`status`/`doctor` know Codex accounts — gated by two live spikes that settle Codex's failure contract and shared-auth behaviour first.

**Architecture:** The Claude engine (merged in PR #1) already has every moving part: registry, chooser, SQLite state + locks, event log, tmux driver, snapshot, launcher, hook, recovery transaction, manual verbs, status, reconcile, doctor. Plan 2 adds a second provider behind the same seams: a Codex usage provider (a port of the dashboard's OpenAI provider), per-account `CODEX_HOME` directories owned by the tool (the analogue of the per-account `CLAUDE_CONFIG_DIR`), a Codex hook + installer, a `codex` branch in the launcher and in the recovery transaction (exit sequence, `codex resume <id> "<prompt>"`, readiness by hook), and Codex-aware status/doctor. No new architecture: hooks trigger, tmux supervises, `ms` runs on demand.

**Tech Stack:** TypeScript ESM, Node ≥22.15 (`node:sqlite`, `process.execve`, `fetch`), zero runtime deps, `tsx` for tests, esbuild bundle; Codex CLI 0.153.x; tmux ≥3.3; macOS keychain untouched (Codex keeps `auth.json` files).

**Spec:** `docs/superpowers/specs/2026-09-15-model-switcher-design.md` (§3 components, §4 CLI surface, §6 credentials, §7 launch, §8 events, §9 recovery, §12 gates G1/G2). The Claude engine plan `docs/superpowers/plans/2026-09-15-model-switcher-engine.md` and its live record `docs/superpowers/plans/2026-09-15-live-matrix-claude.md` are the reference implementation and the proof of the seams.

## Global Constraints

- macOS only; Node `>=22.15` (`package.json` engines); zero runtime dependencies; tmux ≥ 3.3; Codex CLI tested range `0.153.x` (recorded by G1); Claude Code `2.1.27x`.
- No secret ever on argv, in a tmux command, in tmux environment, in a log line, on a pane, on stdout/stderr (only `ms accounts token <name>` prints), or in an error message. Codex credentials live in `MS_HOME/codex/<name>/auth.json` (0600) and reach the CLI only through `CODEX_HOME` set by `ms _exec`.
- Store: files 0600, directories 0700 under `MS_HOME` (`~/.config/model-switcher`); every subprocess bounded (tmux 10 s, `codex`/`claude` local reads 15 s, HTTP 20 s); hooks never print and always exit 0 for a pane they do not manage.
- Identity: a Codex account is identified by its ChatGPT `account_id` (from `auth.json`, cross-checked with the `id_token` claims); duplicate accounts are refused per provider; names are unique per provider (`NAME_PATTERN` `^[a-z0-9][a-z0-9_-]{0,31}$`).
- Chooser rule unchanged (§2): a window at 100 is out, earliest weekly reset first, then more remaining, then solo before shared. Codex has two windows (5 h primary, weekly secondary) and no Fable window; `need=fable` never selects a Codex account.
- Tests are hermetic: temp `HOME`/`MS_HOME`, stub `tmux`/`codex`/`claude`/`security` on `PATH`, stubbed `fetch`; never the real `~/.codex`, `~/.claude`, `~/.config/model-switcher`, keychain, tmux servers or network. Never run `npm run build` before tests unless `MS_ENTRY=src` (the `test` script sets it).
- Commits: `git -c commit.gpgsign=false commit`, subject, blank line, then exactly the three co-author trailers (Claude, Codex, Homi). Every task ends green on `MS_ENTRY=src npm test` and `npm run typecheck`.
- The two spikes (Tasks 1–2) are executed live by the author with a full-auto agent driving; every later task consumes their recorded facts by file path, never by memory. If G1 fails, Codex auto-rotation ships disabled (Task 8 keeps the manual verbs only) and the plan says so in the record.

---

## File structure

| File | Responsibility |
|------|----------------|
| `docs/superpowers/plans/2026-09-16-codex-spike.md` | G1/G2 record: verified facts table, pass/fail, the hook file format, the wall text, the exit sequence |
| `src/providers/codex-usage.ts` | Read/refresh `auth.json`, fetch `wham/usage`, map to `Usage` (session + weekly, no fable), identity from the id token |
| `src/providers/codex-cli.ts` | Pure helpers the launcher/recovery use: `codexLaunchCommand`, `codexResumeCommand`, `codexExitSequence`, `codexHome(name)`, `codexSessionsDir` |
| `src/snapshot.ts` | Provider switch: Claude rows poll via `claude-usage`, Codex rows via `codex-usage`; `toPickInputs` unchanged |
| `src/accounts-codex.ts` | `ms accounts` Codex branch: add/login/verify/remove/ls cells; per-account `CODEX_HOME`; shared sessions link |
| `src/accounts.ts` | Dispatch on `--provider codex` / the registry row's provider to `accounts-codex.ts` |
| `src/hooks/codex-hook.ts` | `ms _hook codex`: SessionStart/UserPromptSubmit/Stop/SessionEnd → events; wall from the Stop payload → recovery + dispatch |
| `src/hooks/codex-install.ts` | Install/verify the four entries in `~/.codex/hooks.json` (format from G1), backup, trust step |
| `src/wall.ts` | Codex wall patterns (from G1) beside the Claude ones |
| `src/launch.ts`, `src/exec.ts` | `ms codex` (provider-aware pick, `need=any`), `_exec` sets `CODEX_HOME` for Codex launches |
| `src/recover.ts` | Provider branch: exit sequence, resume command, readiness, continuation |
| `src/status.ts`, `src/doctor.ts` | Codex rows (no FABLE cell), Codex hooks/credentials checks |
| `src/cli.ts` | `registerVerb("codex", launchCodex)` |
| `docs/superpowers/plans/2026-09-16-live-matrix-codex.md` | Task 10's record |

---

### Task 1: G1 spike — the Codex failure contract (live, author-assisted)

**Files:**
- Create: `docs/superpowers/plans/2026-09-16-codex-spike.md`

**Interfaces:**
- Produces: the facts every later task reads by path — `hooks.json` location and exact format; the SessionStart/Stop/UserPromptSubmit/SessionEnd payload fields; the first-turn and later-turn wall text; whether quoted wall text produces any event; a transient error's shape; the modal; `codex resume <id> "<prompt>"` semantics; how Codex chooses `CODEX_HOME` and where sessions live per home; the graceful exit sequence that ends the TUI.

Preconditions (the author): one ChatGPT account already at its 5 h or weekly limit, or one that can be driven there with a few heavy turns; `codex` 0.153.x on PATH; a scratch directory.

- [ ] **Step 1: Hooks file — location, format, trust.** In a scratch `CODEX_HOME=$(mktemp -d)`, run `codex login --device-auth` (or copy `~/.codex/auth.json` into it for the spike only — delete afterwards), then write a Claude-style hooks file and see whether Codex loads it:

```bash
export CODEX_HOME=$(mktemp -d); cp ~/.codex/auth.json "$CODEX_HOME/"; chmod 600 "$CODEX_HOME/auth.json"
LOG=$CODEX_HOME/hooklog
cat > "$CODEX_HOME/hooks.json" <<EOF
{ "hooks": {
  "SessionStart":      [{ "hooks": [{ "type": "command", "command": "cat >> $LOG; echo >> $LOG" }] }],
  "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "cat >> $LOG; echo >> $LOG" }] }],
  "Stop":              [{ "hooks": [{ "type": "command", "command": "cat >> $LOG; echo >> $LOG" }] }],
  "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "cat >> $LOG; echo >> $LOG" }] }]
} }
EOF
codex exec "Reply with the single word ok." 2>&1 | tail -3; echo "---"; cat "$LOG" | jq -c 'keys' 2>/dev/null || cat "$LOG"
```

Record: whether `hooks.json` at `$CODEX_HOME/hooks.json` was honoured, whether a trust prompt appeared (and its exact text, and the config key that records trust), the exact key set of each payload (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `last_assistant_message`, `turn_id`, …). If the Claude-style file is ignored, try the TOML form in `config.toml` (`[hooks]` — the binary's strings mention a TOML-normalised hook identity) and record which one works.

- [ ] **Step 2: Session identity and home.** With the same home: `codex exec "Say hi"`; then `ls $CODEX_HOME/sessions/*/*/*/` and `head -1 <rollout> | jq .payload.id`; confirm the hook's `session_id` equals the rollout's `payload.id`. Then create a SECOND home, symlink its `sessions` to the first home's `sessions` directory, and run `codex resume <that id> "Reply ok again"` from the second home. Record: does a resume work across homes when `sessions` is shared (this is how a rotation moves a Codex conversation to another account); does Codex write anywhere else per home that a resume needs (`.codex-global-state.json`, `.tmp`).

- [ ] **Step 3: The wall, first turn and later turn.** With the exhausted account's `auth.json` in a fresh home (hooks file installed): interactive `codex` in a tmux pane (`tmux new-window -n g1 "env CODEX_HOME=$CODEX_HOME codex"`), send one prompt with `pane send`. Record verbatim: the screen text of the wall (`tmux capture-pane -p`), whether the TUI shows a modal or a plain message, and every hook payload that arrived (`Stop` with `last_assistant_message`? an error field? nothing?). Repeat in a healthy account with two turns, then swap in the exhausted `auth.json` mid-session (the later-turn case) and send a third prompt; record the same.

- [ ] **Step 4: Quoted text and a transient error.** Healthy account: send `Please echo this back verbatim: You've hit your usage limit for this week.` and record that no wall-like hook signal is produced (or exactly which field carries it, so the hook can require quota evidence, not text). Transient: `CODEX_HOME` with an `auth.json` whose `access_token` is garbage → record the screen and the hook payloads (this is the `auth`/`transient` classification the recovery must not treat as a wall).

- [ ] **Step 5: Graceful exit and `resume` with a prompt.** In a healthy interactive pane: which of `/quit`, `/exit`, `Ctrl-C` twice, `Ctrl-D` ends the TUI cleanly (record the sequence and time); then `codex resume <id> "<continuation>"` in the same pane: does the prompt submit automatically, how long until the first token, does the transcript re-render the old wall text. Record the continuation the model received (`transcript_path` tail).

- [ ] **Step 6: Write the record and decide.** `docs/superpowers/plans/2026-09-16-codex-spike.md` with: a facts table (each fact, the command that proved it, the verbatim value), the hook file format as a fenced example, the wall regexes proposed for `src/wall.ts`, the exit sequence, and **G1 verdict: PASS** (an event identifies the failed turn with quota evidence and quoted text produces none) or **FAIL** (then Task 8 ships the Codex branch with automatic recovery disabled and `ms status` flagging `unreported` only). Commit: `git add docs/superpowers/plans/2026-09-16-codex-spike.md && git commit -m "Codex spike G1: failure contract"` (with the three trailers). Delete every scratch home (`rm -rf` the mktemp dirs) — they held real credentials.

---

### Task 2: G2 spike — shared Codex authentication (live)

**Files:**
- Modify: `docs/superpowers/plans/2026-09-16-codex-spike.md` (a G2 section)

**Interfaces:**
- Produces: the rule Task 3 and Task 5 implement — whether several Codex processes on one account can cross a refresh boundary without one losing its credential, and therefore whether `ms status` may refresh a Codex account's token while sessions run, or must never write `auth.json` while a session is alive.

- [ ] **Step 1: Observe a refresh.** In one home, note `jq .last_refresh auth.json`, run `codex exec "ok"` twice 30 min apart or force a refresh by editing `last_refresh` to a day ago; record whether Codex rewrote `auth.json` (new `access_token`, new `last_refresh`) and whether the OLD refresh token still works afterwards (call `https://auth.openai.com/oauth/token` with `grant_type=refresh_token` and the old value — record only the HTTP status, never the tokens): rotated (old one dead) or reusable.
- [ ] **Step 2: Concurrency.** Two interactive `codex` panes on the same home plus a loop running the Task 3 provider's refresh (`node --import tsx -e` calling `refreshCodexCredentials` with `last_refresh` forced stale) every 20 s for 10 minutes; send prompts to both panes throughout. Record: any `401`/re-login prompt, any pane losing auth, the final `auth.json` consistency.
- [ ] **Step 3: Verdict.** **G2 PASS** (no process lost its credential; the tool may refresh under the per-account lock and write back atomically) or **FAIL** (the tool never refreshes a Codex credential while a managed session on that account is alive — it polls with the stored access token until it expires and then shows `auth` until the sessions end; and `ms codex` enforces one managed session per account). Commit the section.

---

### Task 3: Codex usage provider

**Files:**
- Create: `src/providers/codex-usage.ts`, `test/codex-usage.test.ts`

**Interfaces:**
- Consumes: `Usage`/`Window` from `src/pick.ts` (`Window = { usedPercent: number; resetsAt: string | null }`, `Usage = { session: Window | null; weeklyAll: Window | null; weeklyFable: Window | null }`); `AuthError`/`TransientError`/`parseRetryAfter` from `src/providers/claude-usage.ts` (import them — same classification contract); `withLock` from `src/lock.ts`.
- Produces: `readCodexCredentials(dir): CodexAuth | null`, `refreshCodexCredentials(dir, auth, signal): Promise<CodexAuth>` (write-back atomic, 0600, under `withLock("account-codex-<name>")` by the caller), `fetchCodexUsage(auth, signal): Promise<Usage>`, `codexIdentity(auth): { accountId: string; email: string | null }` (from the `id_token` payload, decoded, never verified — identity only), constants `CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"`, `CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"`, `CODEX_CLIENT_ID` copied verbatim from `~/src/aadarwal/data/lib/providers/openai.ts:14` (the dashboard's proven value — copy, do not invent).

- [ ] **Step 1: Failing tests.** In `test/codex-usage.test.ts`, with a stubbed `globalThis.fetch` and a temp home:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { readCodexCredentials, refreshCodexCredentials, fetchCodexUsage, codexIdentity, CODEX_USAGE_URL, CODEX_TOKEN_URL } from "../src/providers/codex-usage.ts";
import { AuthError, TransientError } from "../src/providers/claude-usage.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
function home(auth: object): string {
  const d = mkdtempSync(path.join(tmpdir(), "ms-codex-"));
  writeFileSync(path.join(d, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return d;
}
const AUTH = { auth_mode: "chatgpt", tokens: { id_token: idToken({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }), access_token: "at-1", refresh_token: "rt-1", account_id: "acct-1" }, last_refresh: "2026-09-15T00:00:00Z" };

test("readCodexCredentials reads auth.json and null when absent or malformed", () => {
  assert.deepEqual(readCodexCredentials(home(AUTH))?.tokens.account_id, "acct-1");
  assert.equal(readCodexCredentials(mkdtempSync(path.join(tmpdir(), "ms-none-"))), null);
  const d = home(AUTH); writeFileSync(path.join(d, "auth.json"), "{ nope");
  assert.equal(readCodexCredentials(d), null);
});

test("codexIdentity comes from the id token claims", () => {
  assert.deepEqual(codexIdentity(readCodexCredentials(home(AUTH))!), { accountId: "acct-1", email: "a@b.c" });
});

test("fetchCodexUsage maps primary/secondary windows and never sends the refresh token", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 42, reset_at: 1789600000, reset_after_seconds: 3000, limit_window_seconds: 18000 }, secondary_window: { used_percent: 7, reset_at: 1790000000, reset_after_seconds: 400000, limit_window_seconds: 604800 } } }), { status: 200 });
  }) as typeof fetch;
  const u = await fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000));
  assert.equal(seen[0].url, CODEX_USAGE_URL);
  assert.equal(seen[0].headers["chatgpt-account-id"], "acct-1");
  assert.equal(seen[0].headers["authorization"], "Bearer at-1");
  assert.equal(JSON.stringify(seen).includes("rt-1"), false);
  assert.equal(u.session?.usedPercent, 42);
  assert.equal(u.weeklyAll?.usedPercent, 7);
  assert.equal(u.weeklyFable, null);
  assert.equal(u.session?.resetsAt, new Date(1789600000 * 1000).toISOString());
});

test("an untouched window (reset a full window away) has a null reset", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 0, reset_at: 1789600000, reset_after_seconds: 18000, limit_window_seconds: 18000 } } }), { status: 200 })) as typeof fetch;
  const u = await fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000));
  assert.equal(u.session?.resetsAt, null);
});

test("401/403 are auth, 429/5xx/network are transient with retry-after", async () => {
  for (const [status, cls] of [[401, AuthError], [403, AuthError], [429, TransientError], [503, TransientError]] as const) {
    globalThis.fetch = (async () => new Response("no", { status, headers: status === 429 ? { "retry-after": "7" } : {} })) as typeof fetch;
    await assert.rejects(fetchCodexUsage(readCodexCredentials(home(AUTH))!, AbortSignal.timeout(5000)), (e: Error) => e instanceof cls && (status !== 429 || (e as TransientError).retryAfterMs === 7000));
  }
});

test("refreshCodexCredentials posts the refresh grant, writes back atomically at 0600, keeps unrelated keys", async () => {
  const d = home({ ...AUTH, extra: "keep" });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, CODEX_TOKEN_URL);
    const body = JSON.parse(String(init.body));
    assert.equal(body.grant_type, "refresh_token"); assert.equal(body.refresh_token, "rt-1");
    return new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", id_token: AUTH.tokens.id_token }), { status: 200 });
  }) as typeof fetch;
  const next = await refreshCodexCredentials(d, readCodexCredentials(d)!, AbortSignal.timeout(5000));
  assert.equal(next.tokens.access_token, "at-2");
  const onDisk = JSON.parse(readFileSync(path.join(d, "auth.json"), "utf8"));
  assert.equal(onDisk.tokens.refresh_token, "rt-2"); assert.equal(onDisk.extra, "keep");
  assert.equal(statSync(path.join(d, "auth.json")).mode & 0o777, 0o600);
  assert.match(onDisk.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
});

test("a refresh rejection is auth for invalid_grant/400/401 and transient for 5xx", async () => {
  const d = home(AUTH);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  await assert.rejects(refreshCodexCredentials(d, readCodexCredentials(d)!, AbortSignal.timeout(5000)), AuthError);
  globalThis.fetch = (async () => new Response("down", { status: 502 })) as typeof fetch;
  await assert.rejects(refreshCodexCredentials(d, readCodexCredentials(d)!, AbortSignal.timeout(5000)), TransientError);
});
```

- [ ] **Step 2: Run, expect "module not found".** `MS_ENTRY=src node --disable-warning=ExperimentalWarning --import tsx --test test/codex-usage.test.ts`.

- [ ] **Step 3: Implement `src/providers/codex-usage.ts`.** Port `~/src/aadarwal/data/lib/providers/openai.ts` (read it in full first) with these exact differences: the credential file is `path.join(dir, "auth.json")` (the dir is the account's `CODEX_HOME`); `CodexAuth = { auth_mode?: string; tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string }; last_refresh?: string }`; `fetchCodexUsage` sends `Authorization: Bearer <access_token>` and `ChatGPT-Account-Id: <account_id>` and maps `rate_limit.primary_window` → `session`, `secondary_window` → `weeklyAll`, `weeklyFable: null`, with the dashboard's "untouched window" rule (`reset_after_seconds >= limit_window_seconds` and `used_percent === 0` → `resetsAt: null`); errors classify exactly like `claude-usage.ts` (401/403 → `AuthError`, 429/5xx/non-JSON/network → `TransientError` with `parseRetryAfter`); `refreshCodexCredentials` posts JSON `{ grant_type: "refresh_token", refresh_token, client_id: CODEX_CLIENT_ID }`, merges the response over the existing file (unrelated keys kept), sets `last_refresh` to now ISO, writes to `auth.json.tmp-<pid>` then `renameSync` (0600), and returns the new object; `codexIdentity` decodes the id token's middle segment (base64url JSON) and reads `["https://api.openai.com/auth"].chatgpt_account_id` (fall back to `tokens.account_id`) and `email`. Every fetch takes the caller's `signal`. No console output.

- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `Codex usage provider: auth.json, wham/usage, refresh with write-back`.

---

### Task 4: Snapshot provider switch

**Files:**
- Modify: `src/snapshot.ts` (the per-account poll function — search for the call to `readPollCredentials`/`fetchUsage`), `test/snapshot.test.ts`

**Interfaces:**
- Consumes: Task 3's four functions; `p.codexHome(name)` (added here to `src/paths.ts`: `codexHome: (name: string) => sub("codex", name)`).
- Produces: a Codex registry row polls through `codex-usage`; its `AccountUsage` has `usage.weeklyFable === null`; errors classify the same; the per-account lock name is `account-codex-<name>`.

- [ ] **Step 1: Failing test.** In `test/snapshot.test.ts` add, using the file's existing world/fixture helpers, a registry with `{ name: "work", provider: "codex", … }` whose `MS_HOME/codex/work/auth.json` is the Task 3 fixture, a stubbed fetch answering `wham/usage`, and assert `getSnapshot({ maxAgeMs: 0 })` yields `accounts[i].usage.session.usedPercent === 42` for the Codex row, `weeklyFable === null`, and that `toPickInputs` for `need: "fable"` never returns the Codex row as a candidate (its `weeklyFable` is null → excluded by `pickAccounts`; add the assertion at the `pick.test.ts` level too: a `PickInput` with `weeklyFable: null` is out for `need=fable`, in for `need=any`).

- [ ] **Step 2: Run, expect the Codex row to read "no poller yet".**
- [ ] **Step 3: Implement.** In the poll function, branch on `a.provider`: `"claude"` → existing path; `"codex"` → `readCodexCredentials(p.codexHome(a.name))` (null → `AuthError("no credentials (ms accounts login <name>)")`), refresh when `last_refresh` is older than 55 minutes OR on a 401 once (G2 PASS) — if G2 FAILED, refresh only when no managed session for that account is alive (`listSessions().some(s => s.account === name && s.state !== "stopped")` → skip refresh, report `auth` when the token no longer works), then `fetchCodexUsage`. Reuse `withLock(\`account-codex-${name}\`)` around the refresh.
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `Snapshot: Codex rows poll through the Codex provider`.

---

### Task 5: `ms accounts` for Codex

**Files:**
- Create: `src/accounts-codex.ts`, `test/accounts-codex.test.ts`; Modify: `src/accounts.ts` (dispatch), `src/paths.ts` (`codexHome`, `codexSessionsLink`)

**Interfaces:**
- Consumes: `loadRegistry`/`saveRegistry`/`findAccount`/`NAME_PATTERN` (`src/registry.ts`), `Account` (`provider: "codex"`), Task 3's `readCodexCredentials`/`codexIdentity`/`fetchCodexUsage`, `ensureStore`.
- Produces: `ms accounts add <name> --provider codex [--label L] [--shared]` (registry row, `MS_HOME/codex/<name>` 0700 created, `sessions` inside it is a symlink to `MS_HOME/codex/sessions` — the shared rollout store every Codex home of this tool uses, per G1 Step 2 — or, if G1 found a resume cannot cross homes even with a shared `sessions` dir, a per-home copy at rotate time, recorded in the spike file); `ms accounts login <name>` runs `codex login` (with `--device-auth` when `!process.stdin.isTTY` or `--device-auth` given) with `CODEX_HOME=<dir>`, bounded 10 min, streaming its output line by line (the device code and URL must reach the human; nothing token-shaped can appear — Codex prints none), then reads `auth.json`, refuses a duplicate `accountId` already registered under another Codex name, records `orgId = accountId`, `identityVerified = true`, `identityMethod = "codex-login"`, and proves the credential with one bounded `fetchCodexUsage`; `verify` re-runs the read + fetch; `remove` deletes the registry row and the home directory (never the shared `sessions` store); `ls` cells for Codex rows: POLL = usage fetch ok, TOKEN = `n/a`, VERIFIED = identityVerified.

- [ ] **Step 1: Failing tests** (stub `codex` on PATH that writes a fixture `auth.json` into `$CODEX_HOME` when called with `login`, logs its argv and env to a file, and exits 0; a stubbed fetch for `wham/usage`):

```ts
test("add --provider codex creates the home with a shared sessions link", () => {
  const s = scene();
  assert.equal(s.ms(["accounts", "add", "work", "--provider", "codex"]).code, 0);
  const home = path.join(s.msHome, "codex", "work");
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(readlinkSync(path.join(home, "sessions")), path.join(s.msHome, "codex", "sessions"));
  assert.equal(s.row("work").provider, "codex");
});
test("login runs codex login under the account's CODEX_HOME, records identity, refuses a duplicate account id", () => {
  const s = scene();
  s.ms(["accounts", "add", "work", "--provider", "codex"]);
  const r = s.ms(["accounts", "login", "work"]);
  assert.equal(r.code, 0, r.stderr);
  const call = s.codexCalls()[0];
  assert.deepEqual(call.argv.slice(0, 2), ["login", "--device-auth"]);   // stdin is not a TTY in tests
  assert.equal(call.env.CODEX_HOME, path.join(s.msHome, "codex", "work"));
  assert.equal(s.row("work").orgId, "acct-1"); assert.equal(s.row("work").identityVerified, true);
  s.ms(["accounts", "add", "work2", "--provider", "codex"]);
  const dup = s.ms(["accounts", "login", "work2"]);
  assert.equal(dup.code, 1); assert.match(dup.stderr, /already registered as work/);
});
test("ls shows POLL yes / TOKEN n-a for a Codex row and the usage fetch never carries the refresh token", () => { /* stubbed fetch records headers; assert */ });
test("remove deletes the home but not the shared sessions store", () => { /* seed a rollout file in the shared store; assert it survives */ });
test("a Codex name may equal a Claude name (per-provider uniqueness)", () => { /* add gmail claude + gmail codex → both rows */ });
```

- [ ] **Step 2: Run, expect failures on the missing `--provider` handling.**
- [ ] **Step 3: Implement `src/accounts-codex.ts`** with `addCodex`, `loginCodex`, `verifyCodex`, `removeCodex`, `codexCells` and wire `src/accounts.ts`: `add` parses `--provider claude|codex` (default claude); `login`/`verify`/`remove`/`ls` dispatch on the row's provider. `codex login` is spawned with `stdio: ["inherit", "pipe", "pipe"]`, both streams forwarded line by line to stderr (there is no token to redact — assert none appears anyway), timeout 600 s, `env: { ...process.env, CODEX_HOME: dir }` with `CODEX_HOME`'s parent 0700. The shared store `MS_HOME/codex/sessions` is created by `ensureStore()` (0700).
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `ms accounts: Codex accounts (per-account CODEX_HOME, device login, identity by account id)`.

---

### Task 6: Codex hook and installer

**Files:**
- Create: `src/hooks/codex-hook.ts`, `src/hooks/codex-install.ts`, `test/codex-hook.test.ts`, `test/codex-install.test.ts`; Modify: `src/cli.ts` (`_hook codex`), `src/wall.ts` (Codex patterns)

**Interfaces:**
- Consumes: `src/hooks/claude-hook.ts` (read it in full — the Codex hook mirrors its structure: the `MS_*` gate, `onRow`, `appendEvent`, `addRecovery` + `run-shell -b`, the state transitions C1/I5/R1 semantics); the G1 record's payload fields and wall evidence; `wallKindFromText`.
- Produces: `codexHook(): Promise<number>` registered as `_hook codex`; events: SessionStart → `started` (or `resumed` when the payload says the session was resumed — G1 records the field; if none exists, `resumed` when the row already has a `cliSessionId` equal to the payload's and its generation is `resuming`), UserPromptSubmit → `activity`, Stop → `rate_limited` ONLY with the quota evidence G1 recorded (a field in the payload, or the transcript's last assistant message matching the Codex wall pattern AND the turn ending in error — never plain text on its own), SessionEnd → `ended`; `installCodexHooks(hooksPath, msBin) → { changed, backup }` and `codexHooksInstalled(hooksPath, msBin)` writing the four entries in the format G1 recorded into `~/.codex/hooks.json` (merge, backup, refuse an unparseable file — same contract as `installClaudeHooks`); `src/wall.ts` gains `["codex-session", /you'?ve hit your usage limit/i-style patterns from G1]` mapped onto the existing kinds (`session`/`weekly`).

- [ ] **Step 1: Failing tests.** Mirror `test/claude-hook.test.ts`'s harness (temp `MS_HOME`, seeded session row with `provider: "codex"`, `MS_SESSION`/`MS_PANE`/`MS_LAUNCH` in env, stub `tmux` logging `run-shell`): SessionStart/UserPromptSubmit/SessionEnd append the right kinds; a Stop payload carrying the G1 quota evidence for the CURRENT generation opens a recovery and issues `run-shell -b … _recover <id>`; the same text quoted in a healthy turn (no evidence) appends nothing walled; an unmanaged pane (no `MS_SESSION`) exits 0 with no store write; the installer tests copy `test/hooks-install.test.ts` for the Codex file (merge, no-op second run, backup, unparseable refused).
- [ ] **Step 2: Run, expect module-not-found.**
- [ ] **Step 3: Implement** the two modules and register `_hook codex` in `src/cli.ts` (`registerVerb("_hook", async ([which]) => which === "claude" ? claudeHook() : which === "codex" ? codexHook() : 2)`).
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `Codex hook and installer: events, quota-evidenced walls, hooks.json merge`.

---

### Task 7: `ms codex` launch

**Files:**
- Create: `src/providers/codex-cli.ts`, `test/codex-cli.test.ts`; Modify: `src/launch.ts`, `src/exec.ts`, `src/cli.ts`, `test/launch.test.ts`, `test/exec.test.ts`

**Interfaces:**
- Consumes: `launchClaude`'s structure (`parseLaunchArgs`, the inside/outside-tmux paths, `writeLastPick`, the exit codes 1/2/3/4) — read `src/launch.ts` in full and factor the provider-independent spine into `launchWith(provider, argv)`; `execLaunch` (`src/exec.ts`) which today sets `CLAUDE_CODE_OAUTH_TOKEN` from the 0600 token file.
- Produces: `codexLaunchCommand(flags: string[]): string[]` = `["codex", ...flags]`; `codexHome(name)`; `launchCodex(argv)` registered as `codex`: pick among Codex rows only (`need` is always `any`; `--need fable` → exit 2 "codex has no fable window"), `--as <name>` honoured, session row `provider: "codex"`, `cliSessionId: null` until the first hook event (Codex has no `--session-id`; the hook's SessionStart fills it — Task 6 handles a null row id by adopting the payload's), launch row `command: ["codex", ...flags]`, `env: {}`; `_exec` for a Codex launch sets `CODEX_HOME = p.codexHome(account)` (never a token variable) and strips `OPENAI_API_KEY` from the child env; the status line `ms: <account> (codex) → pane %N`.

- [ ] **Step 1: Failing tests** in `test/launch.test.ts` (reuse its world; add Codex rows with `auth.json` fixtures and a `wham/usage` stub): `ms codex` picks the Codex account with the most room and respawns into `_exec`; `ms codex --need fable` exits 2; `ms codex --as work` on a tokenless… (no tokens for Codex — instead: an account whose `auth.json` is missing exits 1 naming `ms accounts login work`); in `test/exec.test.ts`: a Codex launch row makes `_exec` set `CODEX_HOME` and NOT `CLAUDE_CODE_OAUTH_TOKEN`, and `OPENAI_API_KEY` is absent from the child env.
- [ ] **Step 2: Run, expect unknown verb / missing branch.**
- [ ] **Step 3: Implement** `launchWith` + `launchCodex`, the `_exec` branch (`launch.provider` or the session's provider decides), register `codex`.
- [ ] **Step 4: Run to green; typecheck.**
- [ ] **Step 5: Commit** — `ms codex: launch a Codex account with the most room`.

---

### Task 8: Recovery — the Codex branch

**Files:**
- Modify: `src/recover.ts`, `src/providers/codex-cli.ts`, `test/recover.test.ts`, `test/codex-cli.test.ts`

**Interfaces:**
- Consumes: the G1 record (exit sequence, `codex resume <id> "<prompt>"` behaviour, whether the old wall re-renders); `stopPane` (Claude's exit sequence — read it: Escape, `/exit`, bounded wait, SIGTERM, SIGKILL, modal → signal), `startsFresh`, `CONTINUATION`, readiness (`resumed`/`started` for the new generation), `park`, `FAILURE_OUTCOMES`.
- Produces: `codexExitSequence(): { keys: string[][]; waitMs: number }` from G1 (e.g. `[["C-c"], ["C-c"]]` or `["/quit", "Enter"]` — the record decides; the plan carries both as the two candidates and the implementer picks the recorded one); `codexResumeCommand(cliSessionId, continuation, flags): string[]` = `["codex", "resume", cliSessionId, ...(continuation ? [continuation] : []), ...flags]`; in `recover.ts` the transaction branches on `session.provider` for (a) the exit sequence, (b) the relaunch command (Codex never uses `--session-id`: a never-used Codex session is relaunched as a plain `codex` with the same `MS_SESSION`, and the hook's SessionStart adopts the new id), (c) readiness (hook `started`/`resumed` for the new generation, same rule), (d) the continuation text (shared `CONTINUATION`), (e) the candidate pool (Codex rows only, `need: "any"`). If G1 FAILED, `claimAutomatic` refuses Codex sessions with `"codex automatic recovery is disabled (G1 failed); use ms rotate"` and only the manual verbs move them.

- [ ] **Step 1: Failing tests** (reuse `test/recover.test.ts`'s stub tmux/state world with a Codex session and Codex accounts): happy path — a `rate_limited` on a Codex session hands off `work → home`, the tmux log shows the exit sequence keys then `respawn-pane -k … _exec <launch>` and the launch row's command is `["codex", "resume", "<id>", CONTINUATION, ...flags]`; readiness by a `resumed` event for gen 2 → `continuing`; a never-used Codex session (no `activity`) relaunches as `["codex", ...flags]` with no continuation; `need=fable` sessions never see Codex candidates; secrets scan: no `auth.json` content on any argv line.
- [ ] **Step 2: Run, expect the Claude branch to be used (wrong command).**
- [ ] **Step 3: Implement** the provider switch in `recover.ts` via small pure helpers in `codex-cli.ts`; keep the Claude path byte-identical (the existing recover tests must not change).
- [ ] **Step 4: Run to green; typecheck; run the whole suite twice.**
- [ ] **Step 5: Commit** — `Recovery: the Codex branch (exit sequence, codex resume, readiness)`.

---

### Task 9: Status and doctor for Codex

**Files:**
- Modify: `src/status.ts`, `src/doctor.ts`, `test/status.test.ts`, `test/doctor.test.ts`

**Interfaces:**
- Consumes: `accountState` (`src/status.ts`), `checkClaudeAccount`/`checkHooks` (`src/doctor.ts`), Task 6's `codexHooksInstalled`/`installCodexHooks`, Task 3's reads.
- Produces: `ms status` accounts table shows Codex rows with `FABLE` as `—` and `STATE` from the same enum (`no-grant` when `auth.json` is missing, `no-token` never for Codex); the sessions table is provider-agnostic already (the `WALLED?` screen scrape uses the Codex patterns from Task 6 for Codex sessions); `ms doctor` adds `✓/✗ Codex hooks installed` (with `--fix` installing into `~/.codex/hooks.json`, backup kept), `✓/✗ codex --version` (bounded 10 s, tested range from G1), per Codex account `credentials readable` + `usage fetch ok` (refresh only under `--fix`, per the Claude rule and G2's verdict), and the store walk covers `codex/<name>/auth.json` (0600) and the shared `codex/sessions` dir (0700, never chmod'ed recursively — Codex owns its contents).
- [ ] **Step 1: Failing tests** (extend both files' fixtures with a Codex row + a Codex session): the row renders with `—` in FABLE; a `rate_limited`-less Codex session whose screen shows the Codex wall text reads `unreported`; doctor lines exist and `--fix` installs the Codex hooks into a temp `~/.codex/hooks.json` while leaving other keys intact.
- [ ] **Step 2–4:** run red → implement → green; typecheck.
- [ ] **Step 5: Commit** — `Status and doctor know Codex accounts and hooks`.

---

### Task 10: Live matrix (Codex) — the gate for Plan 3

**Files:**
- Create: `docs/superpowers/plans/2026-09-16-live-matrix-codex.md`

Executed by the author with a full-auto agent driving, like the Claude matrix (`docs/superpowers/plans/2026-09-15-live-matrix-claude.md` is the template: preconditions, a case table with pane/evidence, a bugs section, a verdict). Preconditions: two ChatGPT accounts logged in via `ms accounts login`, one of them at a limit (or driven there), Codex hooks installed by `ms doctor --fix` (backup kept), anu's arm paused for the run.

- [ ] **Cases:** (1) `ms codex` in a fresh pane → picked account, `started`, `running`; (2) a real wall → `rate_limited` with quota evidence → worker → `A → B` → `codex resume` → continuation answered; time it; (3) two `ms rotate` at once; (4) `ms switch --to <other>` idle → no continuation; (5) `ms stop`; (6) quoted wall text → nothing walled, `unreported` at most; (7) never-used session rotate → plain relaunch, no continuation; (8) killed worker → adopted on the next status; (9) outside tmux; (10) mixed pool: one Claude and one Codex session in the same tmux server, each rotating within its own provider; (11) `ms doctor` clean on the final state.
- [ ] **Exit criteria:** 1–7, 10, 11 PASS; 8 and 9 PASS or documented. Failures become bug tasks appended to this plan before Plan 3. Commit the record: `Live matrix (Codex): results`.

---

## Plan 3 (next, after Task 10): wizard and packaging

Gets its own plan document. Outline so the shape is agreed now:
- `ms setup` (spec §10): resumable state in `MS_HOME/setup.json`; prerequisites (`claude`, `codex`, `tmux` versions, hook paths); "How many Claude accounts? How many ChatGPT accounts?" → per account name → `ms accounts add/login` driven by the wizard (the human clicks through the browser tabs; the wizard never types for them); hooks via `ms doctor --fix`; opt-ins off by default: statusline badge (merge into the existing statusline command with a backup) and shell alias (`alias claude='ms claude'`, `alias codex='ms codex'` appended to the rc file with a marker line); finish with `ms doctor` + `ms status`.
- Homebrew tap `aadarwal/homebrew-tap`, formula `model-switcher` (`depends_on "node"`, `depends_on "tmux"`; installs `dist/ms.js` + `bin/ms` + `bin/resolve-entry.mjs`; `bin/ms` on PATH so `msBinary()` equals the PATH entry and `ms doctor`'s last check passes); `make release` builds, tags `vX.Y.Z`, uploads the tarball the formula points at; S6 gate (hook trust, custom homes, CLI upgrades, repair paths).

## Plan 4 (after Plan 3): `ms dashboard`, bounded `ms switch --all`, anu port

Deferred per spec §13; `ms dashboard` is a localhost page + JSON API alive only while open, over the same store and verbs; `switch --all --to X` walks sessions with bounded concurrency (the handoff slots) and per-session refusals; the Codex mechanics port into anu as a separate anu task.

---

## Self-review

- **Spec coverage.** §3/§4 Codex verbs → T5, T7, T9; §6 Codex identity (account id) → T5; §7 launch → T7; §8 Codex hooks → T6; §9 Codex recovery branch → T8; §12 G1 → T1, G2 → T2; §10 → Plan 3; §13 → Plan 4. S3–S5 remain covered by the Claude matrix + suites; S6 → Plan 3.
- **Placeholders.** Every code task has test code and an implementation description naming the exact file to port and the exact differences. The two facts only a live spike can settle (the hooks file format, the exit sequence/wall text) are produced by T1 as a committed document that T6/T8 read by path; T8 carries both candidate exit sequences and T6 the Claude-style file as the expected shape, so an implementer is never left to invent a value.
- **Type consistency.** `Usage`/`Window` (`src/pick.ts`) used by T3/T4; `Account.provider: "codex"` (`src/registry.ts`) by T5/T7/T9; `AuthError`/`TransientError`/`parseRetryAfter` (`src/providers/claude-usage.ts`) by T3/T4; `codexHome(name)` (`src/paths.ts`, added in T4) by T5/T7/T9; `codexResumeCommand`/`codexExitSequence`/`codexLaunchCommand` (`src/providers/codex-cli.ts`, T7/T8); `codexHook`/`installCodexHooks`/`codexHooksInstalled` (T6) by T9; `launchWith` (T7) is internal to `launch.ts`.
