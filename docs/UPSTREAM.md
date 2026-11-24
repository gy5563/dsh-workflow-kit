# Upstream dependency list (Gate 4)

Every workaround mapped to its upstream behavior, with a removal condition.
Upstream repo: https://github.com/deepseek-ai/deepseek-harness — issues below
are **not yet filed**; filing them is part of maturing the loop. After every
upstream update: run `dsh-doctor` + `calibrate contract`, then test whether each
workaround can be removed (remove → re-run → keep removed only if green).
Do not let patches accumulate silently.

| # | Workaround | Upstream behavior | Removal condition | Issue status |
|---|---|---|---|---|
| 1 | headless user patch re-enables `credentials`/`authorization`/`deepseek-account` + account model routing | headless bundle disables account auth in favor of launch-time API keys | headless gains a documented account-auth option, OR a valid platform API key is provisioned (then default launch-time route works) | not filed — feature request: "headless: account authentication option" |
| 2 | manual `workspace.json` workspace record to group CLI/ACP threads in desktop | `dsh-acp` writes the shared session store but never calls `attachSession()`; desktop groups by ownership ledger | ACP attaches sessions to the workspace registry, or desktop indexes unowned sessions into workspaces by cwd | not filed — bug: "ACP-created sessions absent from workspace ownership ledger" |
| 3 | relaunch desktop to see new CLI threads | sidebar index built once at startup (`listStoredHeaders`) | live index refresh / watch on the session store | not filed — can fold into #2 |
| 4 | git handoff with session ids in commit messages | Zed agent-panel history lists only Zed-started threads; `dsh/sessions/list` extension exists but Zed doesn't consume it | Zed consumes the agent's session-list extension, or dsh-acp surfaces external sessions | not filed — feature request |
| 5 | `reasoningEffort` removed from acp profile patch | effort setting conflicts with headless/ACP turns | upstream supports effort in headless turns | not filed |
| 6 | account OAuth instead of stored API key | stored key rejected 401 (account-side, not a dsh bug) | regenerate key at platform.deepseek.com; then re-test default route and drop #1 | n/a — user action |

## Upgrade checklist

1. `dsh-doctor` — version compatibility, auth, assembly state (fails explicitly on drift).
2. `calibrate contract` — NDJSON schema + exit semantics + reason enum vs baseline.
3. For each row above: attempt removal on a scratch profile/repo, re-run 1–2, keep or restore.
4. If the ledger format (`unit.version`) changed: stop, back up, re-validate option-2 recipe before any write.
