# model-switcher

A single command, `ms`, that runs `claude` and `codex` on whichever of the user's subscription accounts has room, and, when a running session hits a usage wall, restarts the same session in the same tmux pane on the next account with room and tells it to continue. It is the standalone, installable version of the account rotation the author runs inside anu, rebuilt around what the live rollout of that system taught (see §14).

## Install

```
brew install aadarwal/tap/model-switcher
ms setup
```

Status: engine under construction; see docs/superpowers/specs

Codex automatic recovery ships off: export `MS_CODEX_AUTOROTATE=1` in the shell you run `codex` from — `ms` stores the gate from there, so the tmux-dispatched watchdog and recovery worker read it too — and `ms doctor` prints its state.
