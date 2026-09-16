# Live matrix (dashboard) — 2026-09-16, author's laptop

Plan 4, Task 4. `ms` **0.2.1** (brew, `/opt/homebrew/bin/ms` →
`Cellar/model-switcher/0.2.1/libexec/bin/ms`), repo `main` @ 75240cc. Claude
Code 2.1.273, tmux 3.7c, Node v22.23.0, macOS 26.5.2 arm64.

Store: the real one (`~/.config/model-switcher`). Accounts as
`/api/state` reported them — **claude: tulp, gmail, kratuvak, dirk**;
**codex: aadarwal, dirk, kratuvak, qpaig, tulp**. No account,
credential, hook, `~/.claude/settings.json` or `~/.codex` file was
touched by this run; no token was read or printed.

Preconditions: anu's unattended rotation paused for the duration
(`tmux set -g @anu_autorotate 0`, was `1`, restored to `1` at the end);
every test pane on a SEPARATE tmux server (`tmux -L ms-live`), never the
human's own session; the server killed and its socket removed at the end.

| # | Step | Result |
|---|------|--------|
| 1 | `ms dashboard --no-open`: URL, page, `/api/state`, no token | PASS |
| 2 | Two `ms claude` test sessions on `ms-live`, visible in `/api/state` | PASS |
| 3 | `POST /api/stop` → `{code:0}` + pane back to a shell; 415 and 403 refusals | PASS |
| 4 | `POST /api/switch-all` moves two panes, same conversation resumed | PASS (with F1 — the fleet move ran `--to gmail`, see below) |
| 5 | Idle exit: process gone 85 s after the last request, exit code 0 | PASS |
| 6 | Sessions stopped, `ms-live` killed, arm restored | PASS |

---

## Step 1 — the server, the page, the state

```
$ ms dashboard --no-open        # backgrounded, stderr captured
ms dashboard: http://127.0.0.1:51121
```

Exactly one line, as the verb promises. The bind was checked separately,
on another server of the same build started after the run (`ms dashboard:
http://127.0.0.1:53320`): exactly one listening socket, loopback only, no
second family or interface —

```
$ lsof -nP -p 58856 -a -iTCP
node  58856  aadarwal  12u  IPv4  TCP 127.0.0.1:53320 (LISTEN)
```

```
$ curl -s http://127.0.0.1:51121/ -o page.html -w "http %{http_code} bytes %{size_download}\n"
http 200 bytes 18591
```

Both table headers are in the served HTML, each exactly once:

```
accounts: <th>NAME</th><th>LABEL</th><th>5H</th><th>WEEK</th><th>FABLE</th><th>RESETS</th><th>STATE</th>
sessions: <th>SESSION</th><th>PANE</th><th>PROVIDER</th><th>ACCOUNT</th><th>NEED</th>
          <th>STATE</th><th>GEN</th><th>PENDING</th><th>WAKEUP</th><th>WALLED?</th><th></th>
```

and the move-all control, with its provider select, account select, force
checkbox and Go button:

```
<div class="moveall">
  <span>Move every</span> <select id="moveall-provider"></select>
  <span>pane to</span>    <select id="moveall-account"></select>
  <label class="force"><input type="checkbox" id="force"> Force (governs "Move every…" only)</label>
  <button id="moveall-go">Go</button>
</div>
```

```
$ curl -s http://127.0.0.1:51121/api/state
http 200 bytes 11472
keys: accounts,sessions,takenAt          takenAt: number 1789590551222

claude tulp      | label: tulp      | state: ok
claude gmail     | label: gmail     | state: ok
claude kratuvak  | label: kratuvak  | state: ok
claude dirk      | label: dirk      | state: ok
codex  aadarwal  | label: aadarwal  | state: ok
codex  dirk      | label: dirk      | state: ok
codex  kratuvak  | label: kratuvak  | state: ok
codex  qpaig     | label: qpaig     | state: ok
codex  tulp      | label: tulp      | state: ok

per-session keys: id,provider,cliSessionId,cwd,socket,pane,serverStart,need,
account,generation,state,desired,flags,wakeupAt,createdAt,updatedAt,
transcriptPath,rolloutOffset,pending,walled
```

All four Claude accounts and all five Codex ones, each with `label` and
`state`; every session row carries `pending` and `walled`.

Token sweep — nothing token-shaped in either the page or the state:

```
$ grep -e 'sk-ant-' -e 'eyJ' state.json page.html
(no matches in either file)
$ grep -i -e token -e secret -e credential -e apiKey state.json
(no matches)
```

**PASS.**

## Step 2 — two live test sessions

A dedicated tmux server, two windows, cwd `~/src/aadarwal/model-switcher`:

```
$ tmux -L ms-live new-session -d -s live -x 200 -y 50 -c ~/src/aadarwal/model-switcher
$ tmux -L ms-live new-window  -t live      -c ~/src/aadarwal/model-switcher
%0 1 bash 200x50
%1 2 bash 200x50

$ tmux -L ms-live send-keys -t %0 'ms claude' Enter
```

The first launch raised Claude Code's folder-trust dialog ("Quick safety
check: Is this a project you created or one you trust?"); answered
`Down`,`Enter` = *Yes, I trust this folder*. The second launch, in the
account's now-trusted home, raised none.

One short prompt each, to give both a real transcript to resume:

```
%0: "reply with exactly: ok"            → ⏺ ok
%1: "reply with exactly: marmalade-7"   → ⏺ marmalade-7
```

`GET /api/state` then carried both, on the `ms-live` socket:

```
15654475-e0ad-4c37-bddf-6b14e05dc089 %0 claude gmail fable running gen1 pending:null walled:"" /private/tmp/tmux-501/ms-live
94182912-2d17-4488-b527-d8b06bb78939 %1 claude gmail fable running gen1 pending:null walled:"" /private/tmp/tmux-501/ms-live
```

**PASS.**

## Step 3 — `POST /api/stop`, and the two refusals

The page's exact headers (`src/dashboard/page.ts:255` posts
`content-type: application/json`; a browser adds `Origin` and
`Sec-Fetch-Site` itself):

```
$ curl -s -X POST $U/api/stop \
    -H 'Content-Type: application/json' -H "Origin: $U" -H 'Sec-Fetch-Site: same-origin' \
    -d '{"session":"94182912-2d17-4488-b527-d8b06bb78939"}'
{"code":0,"message":"ms: 94182912-2d17-4488-b527-d8b06bb78939 stopped"}
http 200
```

The pane came back to a shell, and the row to `stopped`:

```
%0 cmd=2.1.273 dead=0
%1 cmd=bash    dead=0
94182912-… %1 claude gmail fable stopped 1
```

Refusals, all against the already-stopped session so a hole would not have
cost anything:

| Request | Answer |
|---|---|
| A: no `Content-Type` at all | `415 {"error":"refused: POST requires content-type: application/json"}` |
| B: `Content-Type: text/plain` (the CORS-simple shape) | `415` same message |
| C: `Origin: http://evil.example` + correct content-type | `403 {"error":"refused: this request came from another origin"}` |
| D: `Origin: http://127.0.0.1:1` (loopback host, wrong port) | `403` same message |
| E: `Sec-Fetch-Site: cross-site` | `403 {"error":"refused: a cross-site request"}` |
| F: `Origin: http://localhost:51121` (the other loopback spelling) | `200 {"code":0,"message":"ms: … already stopped"}` — accepted, as the fix-R deviation intends |
| G: `{"nope":1}` | `400 {"error":"malformed body: expected { session: string }"}` |
| H: `GET /api/nope` | `404 {"error":"no such route: GET /api/nope"}` |

D is the one that matters most: a loopback hostname at a *different* port
is exactly the port-scan this guard exists to refuse, and it is refused.

**PASS.**

## Step 4 — the fleet move

The stopped pane was relaunched first (`ms claude` in `%1`, seeded with
`reply with exactly: marmalade-7`) so the move had two sessions to carry,
as the plan asks.

The move named in the brief was refused, and correctly (finding **F1**):

```
$ curl -s -X POST $U/api/switch-all -H 'Content-Type: application/json' -H "Origin: $U" \
    -d '{"to":"kratuvak"}'
{"code":1,
 "message":"'kratuvak' names a claude and a codex account; --all cannot tell which fleet you mean",
 "results":[]}
http 200   time 0.026s
```

Three of the four Claude account names on this machine (`kratuvak`,
`dirk`, `tulp`) are also Codex account names, so `gmail` is the only
Claude name `--all` can accept here. Both sessions were on `gmail`, so the
move was staged the other way: two per-session `/api/switch` calls to
`kratuvak`, then the fleet move back to `gmail`.

Per-session (both with the page's headers):

```
{"code":0,"message":"ms: 15654475-… switched → kratuvak"}   http 200  1.91s
{"code":0,"message":"ms: d6adc0ff-… switched → kratuvak"}   http 200  1.39s
```

Then the fleet move, one request, both panes:

```
$ curl -s -X POST $U/api/switch-all -H 'Content-Type: application/json' -H "Origin: $U" \
    -H 'Sec-Fetch-Site: same-origin' -d '{"to":"gmail"}'
{"code":0,"message":null,"results":[
  {"session":"15654475-e0ad-4c37-bddf-6b14e05dc089","code":0,"message":"switched → gmail"},
  {"session":"d6adc0ff-019a-40fe-86a2-178d099e4c79","code":0,"message":"switched → gmail"}]}
http 200   time 2.45s
```

One result line per session, both zero. `/api/state` afterwards:

```
15654475-e0ad-4c37-bddf-6b14e05dc089 %0 gmail running gen3 cli:615b7ec9-eea8-4603-a994-1e4605820227
d6adc0ff-019a-40fe-86a2-178d099e4c79 %1 gmail running gen3 cli:8d6154b1-b6c0-425c-a584-c7f081b97fbb
```

Same conversation, not a new one — the panes still showed their own
transcripts after the respawn:

```
--- %0 ---                          --- %1 ---
❯ reply with exactly: ok            ❯ reply with exactly: marmalade-7
⏺ ok                                ⏺ marmalade-7
✻ Baked for 2s · done 4:30 PM       ✻ Churned for 2s · done 4:32 PM
```

and the store agrees: `cliSessionId` is unchanged across all three
generations, and the events file records a resume rather than a start:

```
~/.config/model-switcher/sessions/15654475-…/events.jsonl
started  gen1 cli 615b7ec9-…
activity gen1 cli 615b7ec9-…
ended    gen2 cli 615b7ec9-…  (prompt_input_exit)
resumed  gen3 cli 615b7ec9-…

~/.config/model-switcher/sessions/15654475-…/recover.log
20:34:36.710 [gen 2] handing kratuvak → gmail (manual, --to gmail)
20:34:37.546 [gen 3] respawned pane %0 on gmail (launch 99b15d50-…)
20:34:39.104 [gen 3] kratuvak → gmail (manual, --to gmail, generation 3)

~/.config/model-switcher/sessions/d6adc0ff-…/recover.log
20:34:36.746 [gen 2] handing kratuvak → gmail (manual, --to gmail)
20:34:37.588 [gen 3] respawned pane %1 on gmail (launch 2708480c-…)
20:34:38.609 [gen 3] kratuvak → gmail (manual, --to gmail, generation 3)
```

Both handoffs opened within 36 ms of each other — the pool really does run
them side by side, not one after the other — and the whole fleet move for
two idle Claude panes took **2.4 s**. `continueAfter: "auto"` on two idle
sessions sent no continuation prompt, so the move cost no model tokens at
all.

**PASS**, with F1 recorded.

## Step 5 — idle exit

Polling stopped at **20:35:44Z** (the last request to each of the two
dashboards this run started; nothing else was asking either of them
anything).

```
#1 (pid 21493, the server used for steps 1–4) gone after 85 s
#2 (pid 93721, same run, wrapped to capture its status) gone after 85 s
$ cat dash2.code
exit=0
```

85 s is the polling loop's own 5 s granularity under the 90 s
`DEFAULT_IDLE_MS` (`src/dashboard/server.ts`), i.e. both exited within the
~100 s the step allows, on their own, with status 0. Neither needed a
signal.

`pgrep -f "ms dashboard"` was **not** empty afterwards — see finding **F2**;
it held one process this run did not start.

**PASS.**

## Step 6 — teardown

```
$ ms stop 15654475-e0ad-4c37-bddf-6b14e05dc089   → ms: … stopped   exit 0
$ ms stop d6adc0ff-019a-40fe-86a2-178d099e4c79   → ms: … stopped   exit 0
%0 bash dead=0     %1 bash dead=0
$ ms status | grep -c ' running '   → 0
$ tmux -L ms-live kill-server       → no server running on /private/tmp/tmux-501/ms-live
  (the stale socket file it left behind was removed by hand — finding F4)
$ tmux set -g @anu_autorotate 1; tmux show -gv @anu_autorotate  → 1
```

No session this run created is running; no `ms-live` server or socket
remains; the anu arm is back at `1`. The human's own transcripts were not
touched.

**PASS.**

---

## Findings

- **F1 — `switch --all` cannot name most of the accounts on this machine, and the page's own provider select does not help.** `switchAll` refuses an account name two providers both claim (`src/manual.ts:375–385`), and on this store `kratuvak`, `dirk` and `tulp` are each both a Claude and a Codex account: `gmail`, `aadarwal` and `qpaig` are the only unambiguous names. The page makes this worse than the CLI does, because it *asks* for the provider — `moveall-provider` — and then throws that answer away: `buildSwitchAllBody(to, force)` (`src/dashboard/page.ts:322–331`) sends `{to, force}` only, and `parseSwitchAllBody` (`src/dashboard/api.ts:180`) has no field to receive it. A human who picks "claude" and "kratuvak" on the page, having said exactly which fleet they mean, gets "`--all` cannot tell which fleet you mean". The guard is right; the page should be able to satisfy it (an optional `provider` in the body, defaulted from the select).
- **F2 — the idle exit is per-server, so `pgrep -f "ms dashboard"` is not a clean pass criterion on a machine the human is also using.** A second `ms dashboard` (pid 91925, no `--no-open`) was already up when this run started, held alive by a tab in the human's browser; `lsof` showed a client connection reappearing every few seconds for its whole life. Both dashboards this run started exited on schedule; that one correctly did not. Task 4's written criterion ("`pgrep -f \"ms dashboard\"` empty") should be read as "the one you started", or the check should match the port.
- **F3 — the statusline in a moved pane does not track the move, on this machine.** `~/.claude/statusline-rate-limits.sh` renders `@$ANU_ACCOUNT` — anu's launcher account, inherited from the shell that started the tmux server — so both panes read `@gmail137` before and after every move, including while the store and the recover log said `kratuvak`. The 2026-09-15 Claude matrix used "statusline changed" as evidence of a move (case 4); that evidence is not available here, and the honest witnesses are `/api/state`'s `account`, `sessions/<id>/recover.log`, and the generation counter.
- **F4 — `tmux -L ms-live kill-server` leaves its socket file behind.** `/private/tmp/tmux-501/ms-live` survived the kill (`has-session` → "no server running"), and was removed by hand. Harmless, but a later `tmux -L ms-live` would have had to step over it.
- **F5 — a fresh account home is not pre-trusted for a new directory.** The first `ms claude` in `~/src/aadarwal/model-switcher` raised Claude Code's folder-trust dialog and sat there until it was answered; the row read `launching` meanwhile. The Codex side writes a computed trust table ahead of the launch (2026-09-16 codex matrix, case 1: "no trust modal (pre-written table)"); the Claude side does not. An unattended first launch into a directory an account has not seen before will stall the same way.
- **F6 — the `/api/state` session list is unbounded and never forgets.** Before this run started the snapshot already carried 17 session rows, **every one of them `gone`** (`{"gone":17}`) from the 09-15/09-16 live runs, and the page renders all of them; this run left 20. Nothing is wrong with the data, but a page whose sessions table is entirely dead rows until you add one is harder to read than it should be — `ms status` has the same problem. Worth a "hide gone" default before the fleet grows further.
- **F7 (in the tool's favour) — a manual move of an idle session costs nothing and takes seconds.** `continueAfter: "auto"` sent no continuation prompt to either idle pane, so the two-pane fleet move was 2.4 s of process restarts and zero model tokens; the per-session moves were 1.9 s and 1.4 s. The 15–75 s handoff the page's busy-state comment budgets for is the *walled, continuing* case, not this one.

## Verdict

Steps 1, 2, 3, 5 and 6 PASS as written. Step 4 PASS with F1: the brief's
`{"to":"kratuvak"}` is genuinely ambiguous on this store and was refused
by design, so the fleet move was run as `{"to":"gmail"}` — two sessions,
one request, both moved, both conversations resumed. Task 4's exit
criteria are met. F1 is the one finding that should become a fix before
the page is used in earnest; F2 and F4 are wording/teardown notes; F3, F5
and F6 are facts about this machine worth carrying into the anu port
(Task 5).
