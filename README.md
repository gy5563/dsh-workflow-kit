# dsh-workflow-kit

Validation and maturation kit for the **Hermes (manager) → DeepSeek Harness
(worker) → Zed (interactive platform)** workflow. Built to the executable spec
pasted 2026-11-24: assert, don't observe; three artifacts, not one plugin;
four gates; doctor + contract calibration before any pluginization.

## Artifacts

| Dir | Artifact | Status |
|---|---|---|
| `dsh-task/` | **2 — DSH task package**: `dsh-doctor` (14 checks), `dsh-task.mjs` contract wrapper (8 exit classes, risk binding, lock pre-check), `dsh-assemble.mjs` (Gate 1, idempotent), `supported.json` | ✅ |
| `calibration/` | **3 — calibration package**: contract baseline + NDJSON drift checker, `wrapper-stubs.mjs` (24 assertions, zero LLM), `calibrate contract\|smoke\|full` | contract ✅ smoke ✅, full = phase C |
| `hermes-plugin/` | **1 — thin Hermes plugin** (`dsh-dispatch`): `dispatch_dsh_task(contract_path)`, `/dsh-review <session_id>`, bundled skill, session-end reminder + prompt section. Symlinked from `~/.hermes/plugins/dsh-dispatch` | ✅ enabled |
| `docs/` | `FIDELITY.md` (guaranteed vs undocumented vs unsupported), `UPSTREAM.md` (workaround → upstream map, Gate 4) | ✅ |

## Commands

```sh
node dsh-task/bin/dsh-doctor.mjs [--json] [--repo <path>] [--skip-auth]
node dsh-task/bin/dsh-task.mjs --contract <task.json> [--out <dir>] [--dsh-bin <stub>] [--allow-high-risk] [--dry-run]
node dsh-task/bin/dsh-assemble.mjs [--verify] [--json]   # Gate 1, idempotent
node calibration/tests/wrapper-stubs.mjs                 # 24 assertions, zero LLM
node calibration/bin/calibrate.mjs contract              # live fixtures vs baseline
node calibration/bin/calibrate.mjs contract --record     # deliberate new baseline
node calibration/bin/calibrate.mjs contract --replay <fixture> <run.jsonl> <exit>  # zero-LLM
node calibration/bin/calibrate.mjs smoke                 # stubs + one minimal live task
```

Symlinks in `~/.local/bin`: `dsh-doctor`, `calibrate`, `dsh-assemble`.

Contract fixtures: `pong` (no tools), `readfile` (one tool call), `badsession`
(no LLM — error envelope + exit 1). Fail rules: field disappearance, type
change, termination-reason enum gain, exit/reason contradiction, fixture text
mismatch. Additive drift = WARN. Every run writes `run.jsonl` + `verdict.json`
under `calibration/runs/`.

## Wrapper exit classes (spec §1.2 path-fallback requirement)

0 PASS · 2 false-success (exit 0 but reason≠completed, incl. SIGTERM-masked) ·
3 dsh reported failure · 4 session lock held (dsh NOT invoked; remediation
names the holder) · 5 output-contract violation (no output / bad NDJSON / no
final / spawn error / timeout) · 6 empty answer · 7 contract/usage rejection ·
8 acceptance gate or high-risk secret scan failed.

Risk binding (Gate 2): low→read-only/never (no commits) · medium→
workspace-write/never + allowlisted add-dirs (`.git` granted iff
commitRequired) · high→auto-commit refused without `--allow-high-risk`,
secret scan before commit. Contract required fields: `goal`, `cwd`,
`acceptance`; `allowedPaths`/`commitRequired` default to `[]`/`false`.

## Verified results

**Phase A (2026-11-24, dsh 0.2.2-rc.5)**
- doctor: 14 pass / 0 fail / 0 warn (incl. live account-auth PONG, git-write
  probe on laaffiliate, lock scan, assembly state, ledger format v2).
- calibrate contract: PASS (3 fixtures). Drift injection: type change + enum
  gain → FAIL exit 1; stripped `final.text` replay → FAIL "field disappeared";
  wrong exit code → FAIL exit/reason contradiction. Baseline restored
  byte-identical afterwards.

**Phase B (2026-11-25)**
- wrapper-stubs: **24/24 PASS** (T0 contract/risk, T1 SIGTERM false-success,
  T2 git authorization, T3 lock protocol, T4 failure-class distinction).
- calibrate smoke: exit 0 (stubs + live readfile task through the wrapper).
- Plugin live e2e: `dispatch_dsh_task` → wrapper → real dsh → PASS
  (FIXTURE-OK-7f3a); `/dsh-review` → all gates green, review-only.
- dsh-assemble: exit 0, idempotent (patch files byte-identical across runs);
  ACP handshake still OK after assembly (dsh 0.14.4).

## Roadmap (spec §4 order)

- **Phase A (done)**: doctor + calibrate contract. Headless profile bootstrapped
  with account OAuth (`~/.dsh/profiles/headless/cordis.patch.yml`).
- **Phase B (done)**: contract wrapper + 24 stub assertions + `calibrate smoke`
  + thin plugin (dispatch/review only) + Gate 1 idempotent assembly + Gate 2
  risk binding + Gate 3 lock pre-detection.
- **Phase C (next)**: golden task set (minimal fix / standard feature / batch /
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
- The plugin is version-controlled here; `~/.hermes/plugins/dsh-dispatch` is a
  symlink to `hermes-plugin/`. Edit here, never in the symlink target path.
- `dsh-assemble` automates only safe reversible steps (profile auth patches
  with backups). Zed JSONC registration and the desktop ownership ledger are
  detection-only: blind writes there are unsafe (shared editor config;
  app-internal state requiring quit-first).