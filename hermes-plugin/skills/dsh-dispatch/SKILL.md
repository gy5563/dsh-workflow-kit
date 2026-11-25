---
name: dsh-dispatch
description: "Use when dispatching coding tasks to the DeepSeek Harness worker: contract schema, risk binding, dispatch→review flow."
version: 0.1.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [dsh, deepseek, dispatch, contract, review]
    related_skills: [deepseek-harness-worker]
---

# dsh-dispatch — contract-driven worker dispatch

Hermes is the manager; the DeepSeek Harness (`dsh`) is the worker. Dispatch goes
through the **dsh-task wrapper** (`~/projects/dsh-workflow-kit/dsh-task/bin/dsh-task.mjs`),
never through ad-hoc CLI flags. The plugin tool `dispatch_dsh_task` is a thin
caller of that wrapper; `/dsh-review` reviews results and **never fixes anything**.

## Task contract (the only dispatch input)

Write a JSON file, then call `dispatch_dsh_task(task_contract_path=<abs path>)`.

```json
{
  "goal": "One precise task statement. Include failing-test output or exact repro.",
  "cwd": "/absolute/path/to/repo",
  "risk": "medium",
  "acceptance": ["node --test test/foo.test.mjs", "php -l src/foo.php"],
  "allowedPaths": ["src/", "test/"],
  "commitRequired": true,
  "commitMessage": "fix: foo (optional; default fix: dsh-task — <goal>)",
  "sessionId": "session-… (optional: resume; see lock rule)",
  "addDirs": ["/extra/root (optional, medium risk only)"],
  "timeoutMs": 600000
}
```

Required: `goal`, `cwd`, `acceptance` (array of gate commands, may be empty).
`allowedPaths` defaults to `[]`, `commitRequired` to `false`. Risk binding is
enforced by the wrapper, not by trust:

| risk | permission | approval | writes |
|---|---|---|---|
| low | read-only | never | none; `commitRequired` rejected |
| medium | workspace-write | never | cwd + `addDirs`; `.git` granted iff `commitRequired` |
| high | workspace-write | never | auto-commit refused unless `allow_high_risk=true`; secret scan runs before any commit |

**Commit gate:** `commitRequired` is enforced by the wrapper, never by the
LLM. After acceptance passes, the wrapper stages and commits itself with a
`[dsh-session: <id>]` audit trailer (`commitMessage` honored). It fails closed
(exit 8) on `commit-required-empty` (worker produced nothing), `scope-violation`
(changes outside `allowedPaths`), or `commit-failed` (git error). Do not instruct
the worker to commit — the wrapper owns it; a worker self-commit is detected
and not double-committed.

## Failure classes (distinct exit codes — never collapse to "failed")

0 PASS · 2 false-success (exit 0 but reason≠completed, incl. SIGTERM-masked) ·
3 dsh reported failure · 4 session lock held (dsh NOT invoked; remediation in
verdict) · 5 output-contract violation (no output / bad NDJSON / no final /
spawn error / timeout) · 6 empty answer · 7 contract/usage rejection ·
8 acceptance gate, commit gate (empty work / scope violation / git failure),
or secret scan failed.

Artifacts per run: `run.jsonl` (raw events), `answer.txt`, `verdict.json`.

## Flow (manager discipline)

1. **Reproduce first.** Hermes establishes the failing baseline itself (RED test
   or exact repro) before writing the contract. Never dispatch a vague goal.
2. **Dispatch** via the tool. Read the returned verdict — `success` comes from
   the wrapper's gates, not the worker's claims.
3. **Review** with `/dsh-review <session_id>`: re-checks verdict, diff scope vs
   `allowedPaths`, uncommitted leftovers, re-runs acceptance, secret scan.
   Review never modifies the repo.
4. **Verify independently.** Hermes re-runs the acceptance gates and inspects
   the diff itself before believing or committing anything. Worker self-reports
   are never sufficient evidence.
5. **Resume rule:** a session id locked by a live owner (Zed/desktop thread)
   cannot be resumed from CLI — the wrapper pre-detects this (exit 4) and names
   the holder. Close the thread in its owning app first; never force the lock.

## Environment

- Wrapper/doctor/calibration: `~/projects/dsh-workflow-kit` (symlinks
  `dsh-doctor`, `calibrate` in `~/.local/bin`).
- Preflight: `dsh-doctor` (14 checks). Contract drift: `calibrate contract`
  (replay mode needs no tokens). Wrapper semantics: `calibrate smoke` (stub
  suites, zero LLM calls).
- Headless auth lives in `~/.dsh/profiles/headless/cordis.patch.yml`
  (credentials + authorization + deepseek-account + agent-default-model).
  Never print credential refs.
- Acceptance gates: use `node --test` (discovery) or explicit file/glob args —
  `node --test <dir>` is broken on node 26.7 and fakes a failing suite.
- Full calibration: `calibrate full` (golden set + economics; dispatch with
  `calibration/bin/golden.mjs` and `golden-acp.mjs` first). Findings and
  fidelity gaps: `docs/FIDELITY.md`.