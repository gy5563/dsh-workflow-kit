# Fidelity contract — Hermes → dsh workflow kit

Explicit inventory of which surfaces are contract-guaranteed, which depend on
undocumented upstream behavior, and which are unsupported. Per spec §2.2: do
not hide gaps. Re-verify after every DSH upgrade with `dsh-doctor` +
`calibrate contract`.

Verified against: `@deepseek-ai/dsh@0.2.2-rc.5`, `dsh-acp-server@0.14.4`,
desktop app `0.2.2-rc.5`, node `v26.10.0`, macOS arm64. Date: 2026-11-24.

## A. Contract-guaranteed (documented CLI surface, verified live)

| Surface | Guarantee | Evidence |
|---|---|---|
| `dsh headless [task\|-]` | one-shot runner: streams reasoning to stderr, flushes session, prints final text to stdout | `dsh headless --help`; live PONG runs |
| `--json` | NDJSON run projection on stdout | live captures in `calibration/runs/` |
| NDJSON event types | `session{sessionId,cwd}`, `status{phase,turn,step,usage?,reason?}`, `thinking{text}`, `text{text}`, `tool_call`, `tool_result`, `final{sessionId,reason,text}`, `error{message}` | `dsh-headless/lib/json-stream-*.js`; baseline schemas |
| `status.phase` enum | `turn_start`, `step_start`, `step_end`, `turn_end` | live runs |
| Exit semantics | exit 0 **iff** `final.reason.kind === "completed"`, else 1 | `dsh-headless/lib/index.js:383`; replay tests |
| Turn-end reason kinds | `completed`, `blocked`, `aborted`, `interrupted`, `error`, `max-tokens`, `forked` — **merge-extensible upstream** (`TurnEndReasonMap`); a new kind is a drift alarm, not silent acceptance | `dsh-agent/lib/index.js` `accountsForClaim` switch + v8-ignore comment |
| `--permission-mode` | presets `read-only`, `workspace-write`, `danger-full-access` | `dsh-permission-presets`; help text |
| `--approval-policy` | enum `ask`, `never` | `dsh-headless/lib/index.js:177` |
| `--add-dir <path>` | additional writable root, repeatable; help example is literally `--add-dir /repo/.git "commit the fix"` (git-dir authorization) | help text |
| `--session-id <id>` | adopts a persisted session; unknown id → structured error, exit 1 | live `badsession` fixture |
| Session adoption rules | header `cwd` must equal launch cwd **exactly**; sessions carrying an `agentPreset` (desktop/`standard`) are **refused**; a live agent under the same id is refused | `dsh-headless/lib/index.js` `assertAdoptable` |
| Profile layering | base → bundle patches → user `cordis.patch.yml` → `--patch` overlays | profile `cordis.yml` header comment |
| `dsh plugin --profile <name> <pnpm-args>` | forwards to profile-dir pnpm (add/remove) | `dsh --help` |

## B. Depends on undocumented upstream behavior (workarounds — may break)

1. **Headless account OAuth.** The headless bundle deliberately disables
   `credentials`, `authorization`, `deepseek-account` ("one-shot jobs use
   launch-time credentials"). This machine's API key is invalid (401), so the
   user patch re-enables all three and routes `agent-default-model` to
   `deepseek-account/deepseek-flash`. Works because the account plugin then
   finds the desktop OAuth grant. Not a documented headless configuration.
2. **Desktop thread grouping (option 2).** `~/.dsh/storages/workspace.json`
   (`unit.version: 2`) is an internal ownership ledger; ACP/CLI sessions are
   never attached to it. Hand-adding a workspace record with the session id
   groups the thread. Internal format — no migration guarantee.
3. **Session store layout.** `~/.dsh/sessions/<cwd-encoded>/<session-id>/`
   with `session.v4.jsonl.zstd` (concatenated zstd frames, magic `28 B5 2F FD`),
   `session.lock` (exclusive, held by live owners). Used by doctor's lock scan
   and the frame reader; naming/encoding is undocumented.
4. **`dsh-acp-server run` subcommand.** Works but is absent from `--help`
   (registered by a profile plugin). The Zed leg uses the documented stdio ACP
   mode; the CLI `run` surface is semi-documented.

## C. Unsupported / known gaps (do not build on these)

- **Zed thread history does not list CLI-started sessions.** Handoff medium is
  git (session ids in commit messages), not the Zed UI.
- **Headless cannot adopt desktop (`agentPreset`) sessions** — by design
  (`assertAdoptable`). Cross-surface resume is CLI↔CLI and Zed↔CLI(acp) only.
- **Desktop sidebar index is built at startup only** — new CLI threads appear
  after relaunch (unowned ones under "Ungrouped").
- **API-key route is dead on this machine** (stored key rejected 401). Account
  OAuth is the only working auth. Regenerating a platform key would remove
  workaround B1.
- **Ledger edits may need redoing after app upgrades**; always quit the app
  first (single-writer store) and keep a backup.
