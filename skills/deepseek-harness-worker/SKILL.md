---
name: deepseek-harness-worker
description: "Use when delegating coding to DeepSeek Harness (dsh)."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [delegation, deepseek, dsh, acp, zed, worker]
---

# DeepSeek Harness Worker (Hermes → dsh → Zed)

## When to Use

User asks to delegate a coding task to DeepSeek Harness / dsh, run a worker brief, resume or review a delegated session in Zed, or repair the dsh/Zed worker wiring. Not for general coding Hermes does itself.

## Architecture

Hermes = manager (plans, writes briefs, verifies diffs/tests, commits). DeepSeek Harness = coding worker: `dsh-acp-server` 0.14.4 + `@deepseek-ai/dsh` 0.2.2-rc.5, installed with npm prefix `/Users/iat-mac1/.local`. Zed = interactive platform: the same wrapper is registered as `agent_servers["DeepSeek Harness"]` in `~/.config/zed/settings.json`; CLI and Zed share one session store under `~/.dsh/sessions/<cwd-encoded>/<sessionId>/`; handoff between them is sequential, not concurrent (see Session handoff).

## Delegation (one-shot)

```
/Users/iat-mac1/.local/bin/dsh-worker run "<self-contained brief>" --cwd <absolute repo path> --json --permission-policy auto --timeout 600
```

- `auto` = unattended (headless has no TTY to answer prompts). Safety = scope `--cwd` to the target repo + manager verification afterwards. `deny` = read-only turns; `ask` is unusable headless.
- JSON result: `sessionId`, `stopReason`, `text`, `toolCalls[]`, `usage`. Exit 0 means the turn completed — NOT that the work is correct.
- Continue a session: add `--session <sessionId>` (same `--cwd`). Proven: resumed session remembers prior edits.
- Brief must be self-contained: contract, exact test command, "do not modify tests", report format.

## Manager loop (TDD)

1. Baseline: if the target has no `.git`, `git init` + commit the as-is state first (diff/revert safety net). Commit a failing test or runnable oracle (red) and run it yourself to confirm red BEFORE delegating.
2. Delegate the brief. On real projects, prefer an executable oracle over prose expectations (e.g. a PHP stub harness for WordPress code — recipe in skill `wordpress-plugin-audit`); put the exact interpreter path, harness path and scenario list in the brief: "every scenario must exit 0; do not modify the harness".
3. Verify independently: `git diff --stat` + full `git diff` (scope check — only intended files), lint ALL source files (not just changed ones), run the tests/harness yourself (green).
4. Commit with the dsh session id in the message; open the repo in Zed for the user.

Never trust worker self-reports; re-run tests and read the diff.

## Session visibility & handoff (CLI ↔ Zed ↔ desktop)

- The dsh desktop app groups threads by an ownership ledger, not a store scan: `~/.dsh/storages/workspace.json` holds per-workspace `sessionIds` (an "ordered ownership account", one-owner invariant); desktop-created sessions enter via `attachSession`, ACP-created ones (`acp-*`) never do. UNOWNED ACP THREADS STILL APPEAR under an "Ungrouped" sidebar bucket — but the index is built at startup (`listStoredHeaders`), so threads created while the app runs show up only after relaunch. Verified fix to group an ACP thread under a project workspace: quit the app, back up workspace.json, add `tables.workspaces[<new uuid>] = {path: fs.realpathSync(session cwd), title, sessionIds: ["acp-…"], createdAt/updatedAt: ISO}`, prepend the uuid to `global.workspaceIds`, relaunch. The registry accepts it (candidateMatches = header cwd === workspace path) and the thread opens normally in the desktop. Unsupported internal-format edit: keep the backup, redo after app upgrades if the schema changes.
- Zed's thread history lists only threads started in Zed. CLI-created sessions do NOT appear there — the adapter advertises `sessionCapabilities {list, resume, close, delete}` but Zed 1.29 doesn't use them for its history UI. To review delegated work in Zed: open the repo, start a new DeepSeek Harness thread; the worker reconstructs context from git, so put the dsh session id + summary in commit messages (proven: a fresh Zed thread answered a full project-history question correctly from git log alone).
- Sessions are exclusively locked: the owning dsh process holds `<sessionDir>/session.lock` open for write (check: `lsof <sessionDir>/session.lock`). CLI `--session` resume of a session Zed still owns fails with `dsh-acp-server run: Internal error` and writes NOTHING (fail-closed, no corruption). Handoff requires releasing ownership first: close the thread / disconnect the agent in Zed, then resume from CLI.
- Resume of an unowned session is proven in BOTH directions: CLI→CLI (remembers prior edits) and Zed→CLI — after a Zed restart released the lock, the CLI worker quoted the user's Zed question verbatim and its 15/15 test result with tools denied (pure seeded history, zero tool calls). Restarting Zed (or closing the thread/disconnecting the agent) releases its session locks.

## Deleting threads entirely (no delete API exists)

0.2.2-rc.5 is archive-only by design: the session context menu has no delete item, `dsh-api-workspace-controller` exposes only archive/unarchive/pin/detach, and `dsh-session-persistence-jsonl` is append-only (no removal method). Even workspace "Delete" keeps logs (threads move to Ungrouped). Archive = id added to `global.archivedSessionIds` + ArchivedSessionGate rejects new steps; the log file stays. Hard delete = manual file surgery, proven safe:

1. Quit the desktop app first (it holds `session.lock` on retained sessions and rewrites workspace.json from its in-memory ledger). Graceful quit without TCC prompt: Swift `NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh").forEach { $0.terminate() }`, poll until exited. Check holders with `lsof +D ~/.dsh/sessions`.
2. Back up: tar the session dirs + `storages/workspace.json` + their `storages/session_projcache/sessions/<id>.json` entries (backup under `~/.dsh/backups/`, NOT scratch — scratch is pruned after 24h).
3. Delete `~/.dsh/sessions/<cwd-encoded>/<sessionId>/` dirs, their projcache `<id>.json` files, and prune empty cwd-encoded parents.
4. Clean `workspace.json`: remove ids from `tables.workspaces[*].sessionIds`, `global.archivedSessionIds`, `global.pinnedSessionIds`; atomic write (tempfile + os.replace).
5. The search index self-heals: `dsh-session-query-sqlite._reconcile` drops sessions absent from the persistence store — no index surgery needed. Forks are safe to orphan: a fork copies its inherited prefix into its own log (`inheritedEventCount` is just a count; `parentSession` is a plain string reference).
6. Relaunch (`open -a "DeepSeek Harness"`); the sidebar index is built at startup. The app creates a fresh blank draft session on launch and attaches it to a workspace — a new id appearing afterwards is normal, not resurrection. Verify: remaining dirs == keepers, no deleted id anywhere in the ledger JSON.

Thread inventory recipe: decode each `session.v4.jsonl.zstd` (concatenated zstd frames), take the first `session` event header (cwd/createdAt) and the LAST `session/title` event's `data.title` (ignore `session/title-llm-request` events — they carry no final title).

## Auth — account OAuth, no API key needed

- The acp profile routes through the DeepSeek account login (shared with the desktop app): `~/.dsh/profiles/acp/cordis.patch.yml` sets `provider: deepseek-account`, `model: deepseek-flash` on ids `agent-default-model` and `acp`.
- Do NOT set `reasoningEffort` in that patch — headless turns fail with "proposed reasoning effort ... after step preparation fixed adapter default".
- `DEEPSEEK_API_KEY` in `~/.hermes/.env` and the key in dsh's credentials store are expired (HTTP 401). LLM turns don't need them; the `web-search-deepseek` tool does — ask the user for a fresh key only if web search is needed.
- Startup noise `[llm-deepseek-api-key] ... 401; using the bundled catalog` is benign; `[llm-deepseek-account] ... loaded 2 model(s)` confirms OAuth works.

## Wrapper: ~/.local/bin/dsh-worker (zsh)

Restores PATH (`~/.local/bin:/usr/local/bin`) because GUI/Dock-launched Zed inherits launchd's minimal PATH with no node; injects `DEEPSEEK_API_KEY` from `~/.hermes/.env` when unset; `exec`s `dsh-acp-server "$@"`. One entry point serves both Zed (ACP stdio) and Hermes (`run` CLI).

## Pitfalls

- macOS `/bin/bash` is 3.2: avoid backslash-escaped quotes inside `$()` and `${var%\'}` patterns; the wrapper uses `#!/bin/zsh`.
- After writing shell files with tools, verify bytes on disk (`od -c`) and `zsh -n` before long test runs: one dropped closing quote in a grep pattern produced four successive phantom "parser bug" failures in BOTH bash and zsh.
- Secret masking mangles inline `sed s/KEY=.../` expressions — extract env values with `grep '^NAME' file | cut -d= -f2- | tr -d` instead.
- npm global prefix `/usr/local` is root-owned (EACCES): install with `--prefix /Users/iat-mac1/.local`; native postinstalls need `--allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs`.
- Zed `settings.json` is JSONC (trailing commas): edit via Python string-replace, validate by stripping trailing commas + `json.loads` round-trip, back up first, keep absolute command paths. See skill `zed-acp-external-agents`.
- Keep the dsh CLI version paired with the desktop app (both 0.2.2-rc.5); RC mismatch risks protocol drift.
- The terminal guard blocks deeply nested inline one-liners — split into small commands or script files.
- UI automation of the dsh Electron app: `computer_use` capture→click fails with `screenshot_context_missing` (0 AX elements; capture never registers for the click path, even with pid/window_id or foreground). Working fallback: a Swift CGEvent script (`swift file.swift`, CLT installed) — map window-relative screenshot coords via `CGWindowListCopyWindowInfo` bounds for the app PID, convert top-left→CG bottom-left with `NSScreen.screens[0].frame.height`, post leftMouseDown/Up. `osascript … to activate/quit` can trigger a macOS TCC automation prompt that blocks the screen; NSRunningApplication.activate in Swift does not.

## Contract dispatch (preferred manager surface, Phase B)

Use the `dispatch_dsh_task` tool (plugin `dsh-dispatch`, symlinked from
`~/projects/dsh-workflow-kit/hermes-plugin`) with a task-contract JSON path:
required `goal`, `cwd`, `acceptance`; optional `risk` (low/medium/high binding
enforced by wrapper), `allowedPaths`, `commitRequired`, `sessionId`, `addDirs`,
`timeoutMs`. Then `/dsh-review <session_id>` (review-only, never fixes) and
independent re-verification before committing. Wrapper exit classes 0/2/3/4/5/6/7/8
are distinct failure kinds — read `verdict.json`, never collapse to "failed".
Preflight: `dsh-doctor`; `dsh-assemble` (idempotent Gate 1); `calibrate smoke`
(29 stub assertions + one live task); `calibrate contract --replay` (zero-LLM
drift check); `calibrate full` (Phase C golden set + wrapper-vs-ACP economics).
Kit repo `~/projects/dsh-workflow-kit` is the source of truth.
`commitRequired` is a wrapper gate: the wrapper itself stages+commits after
acceptance (audit trailer `[dsh-session: <id>]`), exit 8 on no work /
scope-violation / git failure — never instruct the worker to commit.
Acceptance commands: `node --test` discovery or file/glob args only;
`node --test <dir>` is broken on node 26.7 (false RED).

## Headless dispatch surface (preferred for asserted workflows)

`dsh headless [task|-] --json --permission-mode read-only|workspace-write|danger-full-access --approval-policy ask|never [--add-dir <root>]... [--session-id <id>]` — shipped bundle, better than acp `run` for validation: NDJSON projection on stdout (`session/status/thinking/text/tool_call/tool_result/final/error`), exit 0 **iff** `final.reason.kind === "completed"`. `--add-dir /repo/.git` is the documented git-write authorization. Adoption rules: header cwd must equal launch cwd exactly; sessions with an agentPreset (desktop) are refused; unknown `--session-id` → structured error exit 1; live agent under same id refused. Turn-end reason kinds (source, merge-extensible): completed/blocked/aborted/interrupted/error/max-tokens/forked.

Auth gotcha: the headless bundle disables `credentials`, `authorization` AND `deepseek-account` (launch-time API keys by design). With only an account OAuth grant, the user patch must re-enable **all three** (`disabled: false`) and route `agent-default-model` to `deepseek-account/deepseek-flash` — re-enabling just the account plugin leaves it `pending (waiting for service: authorization)` → ACCOUNT_SIGN_IN_REQUIRED.

Validation kit: `~/projects/dsh-workflow-kit` (commit 6b206cd): `dsh-doctor` (14 checks: versions/auth/git-write/locks/assembly/ledger format) and `calibrate contract` (3 fixtures incl. a zero-LLM error fixture; FAIL on field disappearance/type change/reason-enum gain/exit contradiction; `--replay` diffs captured runs with no LLM). `run.jsonl`/`verdict.json`/`answer.txt` are kit-produced normalization artifacts — no native dsh package writes them. Docs: FIDELITY.md + UPSTREAM.md in the kit.

## Inspecting dsh internals

Answer behavior questions from source, not guesswork: the full plugin source tree ships in the local npm install — grep `~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<package>/lib/*.js` (e.g. `dsh-workspace` = thread ownership ledger, `dsh-api-session-controller` = session APIs). Desktop-only code lives in the Electron asar: `npx -y @electron/asar list "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"`, then `extract-file <path>` (desktop-host's lib/index.js is only a loader). To compare sessions across surfaces, decode each recording's first `session` event (id prefix, cwd, agentPreset) with `scripts/read_session_frames.js`.

## Verification commands

- Handshake under launchd-like env: `python3 ~/.hermes/cache/scratch/acp_probe.py` → `HANDSHAKE OK` (recreate probe from skill `zed-acp-external-agents` if pruned).
- Smoke: `dsh-worker run "Reply with exactly the word PONG and nothing else. Do not use any tools." --cwd <scratch dir> --json --permission-policy deny --timeout 180` → `text: "PONG"`, exit 0.
- In Zed: Agent Panel → new thread → pick "DeepSeek Harness"; wire logs via command palette `dev: open acp logs`.
- Verify a Zed-side turn without the UI: find the newest dir under `~/.dsh/sessions/<cwd-encoded>/`, confirm the live process tree (`ps -o ppid= -p <dsh-acp-server pid>` → Zed), then read `session.v4.jsonl.zstd` with this skill's `scripts/read_session_frames.js` (node ≥22 has zstd in node:zlib). Look for `user/message`, `request/context` (provider should be `deepseek-account`), `assistant/message`, `turn/end`. Session logs are concatenated zstd frames — plain zstdDecompressSync reads only the header frame.
- Benign Zed log noise at thread start: WARN "Received session notification for unknown session" (startup race) and the api-key 401 catalog line. Zed threads run with approval prompts + workspace-write sandbox scoped to the open project.

## Reinstall / repair

```
npm install -g --prefix /Users/iat-mac1/.local @deepseek-ai/dsh@0.2.2-rc.5 dsh-acp-server@0.14.4 --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
```

The `acp` profile auto-bootstraps on first `dsh-acp-server` run; if recreated, re-apply the account-routing `cordis.patch.yml` (see Auth). Wrapper and Zed entry survive reinstalls.
