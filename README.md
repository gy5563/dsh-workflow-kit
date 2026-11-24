# dsh-workflow-kit

Validation and maturation kit for the **Hermes (manager) → DeepSeek Harness
(worker) → Zed (interactive platform)** workflow. Built to the executable spec
pasted 2026-11-24: assert, don't observe; three artifacts, not one plugin;
four gates; doctor + contract calibration before any pluginization.

## Artifacts

| Dir | Artifact | Status |
|---|---|---|
| `dsh-task/` | **2 — DSH task package**: `dsh-doctor` health/compat check, `supported.json` version range, (phase B: task wrapper + permission presets + one-command install) | doctor ✅ |
| `calibration/` | **3 — calibration package**: contract baseline + NDJSON schema diff checker, fixtures, `calibrate contract\|smoke\|full` | contract ✅, smoke/full pending |
| `hermes-plugin/` | **1 — thin Hermes plugin**: `dispatch_dsh_task(contract_path)`, `/dsh-review <session_id>`, `dsh-dispatch` skill, session-end reminder hook | phase B |
| `docs/` | `FIDELITY.md` (guaranteed vs undocumented vs unsupported), `UPSTREAM.md` (workaround → upstream map, Gate 4) | ✅ |

## Commands

```sh
node dsh-task/bin/dsh-doctor.mjs [--json] [--repo <path>] [--skip-auth]
node calibration/bin/calibrate.mjs contract            # live fixtures vs baseline
node calibration/bin/calibrate.mjs contract --record   # deliberate new baseline
node calibration/bin/calibrate.mjs contract --replay <fixture> <run.jsonl> <exit>  # zero-LLM
```

Contract fixtures: `pong` (no tools), `readfile` (one tool call), `badsession`
(no LLM — error envelope + exit 1). Fail rules: field disappearance, type
change, termination-reason enum gain, exit/reason contradiction, fixture text
mismatch. Additive drift = WARN. Every run writes `run.jsonl` + `verdict.json`
under `calibration/runs/`.

## Verified results (2026-11-24, dsh 0.2.2-rc.5)

- doctor: 14 pass / 0 fail / 0 warn (incl. live account-auth PONG, git-write
  probe on laaffiliate, lock scan, assembly state, ledger format v2).
- calibrate contract: PASS (3 fixtures).
- Drift injection: type change + enum gain → FAIL exit 1; replay with stripped
  `final.text` → FAIL "field disappeared"; wrong exit code → FAIL exit/reason
  contradiction. Baseline restored byte-identical afterwards.

## Roadmap (spec §4 order)

- **Phase A (done)**: doctor + calibrate contract. Headless profile bootstrapped
  with account OAuth (`~/.dsh/profiles/headless/cordis.patch.yml`).
- **Phase B**: `dsh-task` wrapper producing `run.jsonl`/`verdict.json`/`answer.txt`
  per task; the four stub tests (SIGTERM false-success → exit 2, git-dir
  authorization via `--add-dir`, session-lock pre-detection, path-fallback
  error codes); `calibrate smoke`; thin Hermes plugin (dispatch + review only,
  no env assembly); Gate 1 idempotent assembly (`--assemble` with backups),
  Gate 2 risk-bound permission modes, Gate 3 lock protocol + commit-message
  session-id audit.
- **Phase C**: golden task set (minimal fix / standard feature / batch /
  two-round resume) with metrics baselines; `calibrate full`; economic
  comparison Hermes-dispatched vs ACP-direct (slopes, not absolutes).

## Environment notes

- Dispatch surface is `dsh headless` (shipped bundle), NOT the acp `run`
  subcommand used by the earlier scratch tests. Headless gives the NDJSON
  projection, `--permission-mode`/`--approval-policy`/`--add-dir`, and strict
  exit semantics the spec asserts against.
- `run.jsonl`/`verdict.json`/`answer.txt` are **kit-produced normalization
  artifacts**, not native dsh outputs (no dsh package writes them).
- Auth: account OAuth only (stored API key is 401). See `docs/FIDELITY.md` B1.
