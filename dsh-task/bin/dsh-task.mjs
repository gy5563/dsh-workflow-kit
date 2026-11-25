#!/usr/bin/env node
// dsh-task — contract-driven wrapper around `dsh headless`. Artifact 2 core.
// Zero dependencies; node >= 22.
//
//   dsh-task --contract <task.json> [--out <dir>] [--dsh-bin <path>]
//            [--allow-high-risk] [--dry-run]
//
// Produces run.jsonl (raw NDJSON), answer.txt (final text), verdict.json
// (structured outcome) in --out (default: <cwd>/.dsh-task/<timestamp>).
//
// Exit codes (distinguishable failure classes — spec 1.2):
//   0 PASS
//   2 false-success: dsh exit 0 (or SIGTERM-masked) but reason != completed,
//     or exit/reason contradiction
//   3 dsh reported failure (reason != completed, honest nonzero exit)
//   4 session lock held — pre-detected, dsh NOT invoked, remediation included
//   5 output-contract violation: no output / unparseable NDJSON / no final /
//     spawn error / timeout
//   6 empty answer (completed but final.text empty)
//   7 contract rejected / usage error
//   8 acceptance gate failed OR high-risk secret scan failed
//
// Risk binding (Gate 2): low -> read-only/never; medium -> workspace-write/
// never + allowlisted add-dirs; high -> refuse auto-commit unless
// --allow-high-risk, then post-turn secret scan of new commits.
// Git authorization: commitRequired grants --add-dir <cwd>/.git; otherwise
// no .git grant is issued.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const DEFAULT_DSH = path.join(HOME, ".local", "bin", "dsh");
const EXIT = {
  PASS: 0, FALSE_SUCCESS: 2, DSH_FAILURE: 3, LOCK_HELD: 4,
  OUTPUT_CONTRACT: 5, EMPTY_ANSWER: 6, CONTRACT_REJECTED: 7, GATE_FAILED: 8,
};

function die(code, failure, extra = {}, verdictPath = null) {
  const verdict = {
    schemaVersion: 1, kind: "dsh-task", at: new Date().toISOString(),
    status: "FAIL", exitCode: code, failure, ...extra,
  };
  if (verdictPath) {
    try { fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2) + "\n"); } catch {}
  }
  process.stderr.write(JSON.stringify(verdict, null, 2) + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--contract") out.contract = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--dsh-bin") out.dshBin = argv[++i];
    else if (a === "--allow-high-risk") out.allowHighRisk = true;
    else if (a === "--dry-run") out.dryRun = true;
    else out._.push(a);
  }
  return out;
}

function validateContract(c, args) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(c && typeof c === "object", "contract must be a JSON object");
  if (problems.length) return problems;
  need(typeof c.goal === "string" && c.goal.trim().length > 0, "goal: required non-empty string");
  need(typeof c.cwd === "string" && path.isAbsolute(c.cwd), "cwd: required absolute path");
  need(typeof c.cwd === "string" && fs.existsSync(c.cwd) && fs.statSync(c.cwd).isDirectory(), "cwd: must exist and be a directory");
  need(Array.isArray(c.acceptance), "acceptance: required array of shell commands (may be empty)");
  if (c.allowedPaths === undefined) c.allowedPaths = [];
  if (!Array.isArray(c.allowedPaths)) problems.push("allowedPaths: must be an array (may be empty)");
  if (c.commitRequired === undefined) c.commitRequired = false;
  if (typeof c.commitRequired !== "boolean") problems.push("commitRequired: must be a boolean");
  need(["low", "medium", "high"].includes(c.risk), "risk: required, one of low|medium|high");
  if (c.sessionId !== undefined) {
    need(typeof c.sessionId === "string" && /^session-[0-9a-f-]{36}$/.test(c.sessionId),
      "sessionId: optional, must look like session-<uuid>");
  }
  if (c.timeoutMs !== undefined) need(Number.isInteger(c.timeoutMs) && c.timeoutMs > 0, "timeoutMs: optional positive integer");
  if (c.risk === "low" && c.commitRequired === true) problems.push("risk=low (read-only) cannot require commits");
  if (c.risk === "high" && c.commitRequired === true && !args.allowHighRisk) {
    problems.push("high-risk auto-commit refused by default; pass --allow-high-risk to accept a post-turn secret scan, or run interactively via Zed");
  }
  return problems;
}

function permissionArgs(c) {
  if (c.risk === "low") return ["--permission-mode", "read-only", "--approval-policy", "never"];
  return ["--permission-mode", "workspace-write", "--approval-policy", "never"];
}

function grantArgs(c) {
  const grants = [];
  if (c.commitRequired) grants.push(path.join(c.cwd, ".git"));
  if (c.risk !== "low") {
    for (const p of c.allowedPaths ?? []) {
      const abs = path.isAbsolute(p) ? p : path.join(c.cwd, p);
      if (!abs.startsWith(c.cwd + path.sep) && abs !== c.cwd) grants.push(abs);
    }
  }
  const args = [];
  for (const g of grants) args.push("--add-dir", g);
  return args;
}

// Gate 3: detect the exclusive session lock BEFORE invoking dsh.
function lockCheck(sessionId) {
  const root = path.join(HOME, ".dsh", "sessions");
  if (!fs.existsSync(root)) return null;
  for (const enc of fs.readdirSync(root)) {
    const lock = path.join(root, enc, sessionId, "session.lock");
    if (!fs.existsSync(lock)) continue;
    const lsof = spawnSync("lsof", ["-t", lock], { encoding: "utf8", timeout: 15_000 });
    const pids = (lsof.stdout ?? "").trim().split("\n").filter(Boolean);
    if (!pids.length) return null; // lock file exists but unheld — resumable
    const holders = pids.map((pid) => {
      const ps = spawnSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8", timeout: 10_000 });
      return { pid: +pid, cmd: (ps.stdout ?? "").trim() };
    });
    return { lock, holders };
  }
  return null;
}

function secretScan(cwd, baseHead) {
  const findings = [];
  const log = spawnSync("git", ["-C", cwd, "log", "--format=%H", `${baseHead}..HEAD`], { encoding: "utf8", timeout: 30_000 });
  const commits = (log.stdout ?? "").trim().split("\n").filter(Boolean);
  const patterns = [
    /sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /(?:password|passwd|secret|token)\s*[:=]\s*["'][^"']{8,}["']/i,
  ];
  for (const sha of commits) {
    const diff = spawnSync("git", ["-C", cwd, "show", "--format=", sha], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    for (const line of (diff.stdout ?? "").split("\n")) {
      if (!line.startsWith("+")) continue;
      for (const re of patterns) {
        if (re.test(line)) findings.push({ commit: sha, pattern: re.source, line: line.slice(0, 120) });
      }
    }
  }
  return { commits, findings };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.contract) die(EXIT.CONTRACT_REJECTED, { code: "usage", message: "usage: dsh-task --contract <task.json> [--out dir] [--dsh-bin path] [--allow-high-risk] [--dry-run]" });
  let contract;
  try { contract = JSON.parse(fs.readFileSync(args.contract, "utf8")); }
  catch (e) { die(EXIT.CONTRACT_REJECTED, { code: "contract-unparsable", message: e.message }); }
  const problems = validateContract(contract, args);
  if (problems.length) die(EXIT.CONTRACT_REJECTED, { code: "contract-invalid", problems });

  const c = contract;
  // Normalize symlinks (macOS /var -> /private/var) so grants match the real cwd.
  c.cwd = fs.realpathSync(c.cwd);
  const dshBin = args.dshBin ?? process.env.DSH_TASK_DSH_BIN ?? DEFAULT_DSH;
  if (!fs.existsSync(dshBin)) die(EXIT.CONTRACT_REJECTED, { code: "dsh-missing", message: `dsh binary not found: ${dshBin}` });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.out ?? path.join(c.cwd, ".dsh-task", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const runJsonl = path.join(outDir, "run.jsonl");
  const runErr = path.join(outDir, "run.err");
  const answerTxt = path.join(outDir, "answer.txt");
  const verdictPath = path.join(outDir, "verdict.json");

  // Gate 3 pre-check: exclusive lock before resume.
  if (c.sessionId) {
    const held = lockCheck(c.sessionId);
    if (held) {
      die(EXIT.LOCK_HELD, {
        code: "session-lock-held",
        message: `session ${c.sessionId} is exclusively locked by a live owner; dsh was NOT invoked`,
        lock: held.lock, holders: held.holders,
        remediation: `close the thread in its owning app (pid ${held.holders.map((h) => h.pid).join(", ")}) — e.g. close the Zed/desktop thread — then retry the resume`,
      }, { contract: { goal: c.goal, cwd: c.cwd, sessionId: c.sessionId } }, verdictPath);
    }
  }

  const argv = ["headless", "--json", ...permissionArgs(c), ...grantArgs(c)];
  if (c.sessionId) argv.push("--session-id", c.sessionId);
  argv.push(c.goal);

  const baseHead = c.commitRequired
    ? (spawnSync("git", ["-C", c.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout ?? "").trim()
    : null;

  if (args.dryRun) {
    const plan = { dshBin, argv, cwd: c.cwd, outDir, risk: c.risk, commitRequired: c.commitRequired };
    fs.writeFileSync(verdictPath, JSON.stringify({ schemaVersion: 1, kind: "dsh-task-dry-run", at: new Date().toISOString(), plan }, null, 2) + "\n");
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const child = spawn(dshBin, argv, { cwd: c.cwd, env: { ...process.env, PATH: `${HOME}/.local/bin:/usr/local/bin:${process.env.PATH ?? ""}` } });
  let stdout = "";
  let stderr = "";
  let signaled = null;
  let timedOut = false;
  let spawnError = null;
  child.on("error", (e) => { spawnError = e; });
  const timeoutMs = c.timeoutMs ?? 600_000;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
  const forward = (sig) => { signaled = sig; child.kill(sig); };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const rawExit = await new Promise((resolve) => {
    child.on("close", (code, sig) => resolve({ code, sig }));
    child.on("error", () => resolve({ code: null, sig: null }));
  });
  clearTimeout(timer);
  const durationMs = Date.now() - t0;

  fs.writeFileSync(runJsonl, stdout);
  fs.writeFileSync(runErr, stderr);

  const events = [];
  const badLines = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { badLines.push(line.slice(0, 200)); }
  }
  const final = events.find((e) => e?.type === "final") ?? null;
  const sessionId = events.find((e) => e?.type === "session")?.sessionId ?? c.sessionId ?? null;
  const answer = final?.text ?? "";
  fs.writeFileSync(answerTxt, answer);

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const ev of events) {
    if (ev?.type === "status" && ev?.phase === "step_end" && ev.usage) {
      for (const k of Object.keys(usage)) usage[k] += ev.usage[k] ?? 0;
    }
  }

  const base = {
    schemaVersion: 1, kind: "dsh-task", at: startedAt, durationMs,
    contract: { cwd: c.cwd, risk: c.risk, commitRequired: !!c.commitRequired, sessionId: c.sessionId ?? null, goal: c.goal.slice(0, 200), allowedPaths: c.allowedPaths ?? [], acceptance: c.acceptance ?? [] },
    sessionId, dshExitCode: rawExit.code, dshSignal: rawExit.sig ?? signaled, timedOut,
    gitBaseHead: baseHead,
    eventCount: events.length, badLineCount: badLines.length, usage,
    artifacts: { runJsonl, runErr, answerTxt, verdict: verdictPath },
  };
  const finish = (status, exitCode, failure, extra = {}) => {
    const verdict = { ...base, status, exitCode, failure: failure ?? null, ...extra };
    fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2) + "\n");
    console.log(`[dsh-task] ${status} exit=${exitCode}${failure ? ` (${failure.code}${failure.subclass ? ":" + failure.subclass : ""})` : ""} — verdict: ${verdictPath}`);
    process.exit(exitCode);
  };

  // --- failure semantics (spec 1.2) -----------------------------------------
  if (spawnError) finish("FAIL", EXIT.OUTPUT_CONTRACT, { code: "output-contract", subclass: "spawn-error", message: `cannot spawn dsh: ${spawnError.message}` });
  if (timedOut) finish("FAIL", EXIT.OUTPUT_CONTRACT, { code: "output-contract", subclass: "timeout", message: `dsh exceeded ${timeoutMs}ms and was terminated` });
  if (rawExit.code === null && !timedOut) finish("FAIL", EXIT.OUTPUT_CONTRACT, { code: "output-contract", subclass: "spawn-signal", message: `dsh died by signal ${rawExit.sig}` });
  if (!stdout.trim()) finish("FAIL", EXIT.OUTPUT_CONTRACT, { code: "output-contract", subclass: "no-output", message: "run.jsonl empty — dsh produced no NDJSON" });
  if (badLines.length) finish("FAIL", EXIT.OUTPUT_CONTRACT, { code: "output-contract", subclass: "bad-ndjson", message: `${badLines.length} unparseable NDJSON line(s)`, samples: badLines.slice(0, 3) });
  if (!final) finish("FAIL", EXIT.OUTPUT_CONTRACT, { code: "output-contract", subclass: "no-final", message: "NDJSON stream has no final event" });

  const kind = final.reason?.kind;
  if (kind !== "completed") {
    // SIGTERM false-success: exit 0 (or signal-masked) while reason != completed.
    const masked = rawExit.code === 0 || rawExit.code === null;
    finish("FAIL", masked ? EXIT.FALSE_SUCCESS : EXIT.DSH_FAILURE, {
      code: masked ? "false-success" : "dsh-failure",
      subclass: kind ?? "unknown",
      message: `final.reason.kind=${JSON.stringify(kind)} with dsh exit ${rawExit.code}`,
      reason: final.reason ?? null,
    });
  }
  if (rawExit.code !== 0) finish("FAIL", EXIT.FALSE_SUCCESS, { code: "false-success", subclass: "exit-contradiction", message: `reason=completed but dsh exit ${rawExit.code}` });
  if (!answer.trim()) finish("FAIL", EXIT.EMPTY_ANSWER, { code: "empty-answer", subclass: "empty-answer", message: "completed but final.text is empty; answer.txt written empty" });

  // --- acceptance gate --------------------------------------------------------
  const acceptance = [];
  for (const cmd of c.acceptance ?? []) {
    const r = spawnSync(cmd, { cwd: c.cwd, shell: true, encoding: "utf8", timeout: 120_000 });
    acceptance.push({ cmd, exitCode: r.status, ok: r.status === 0, stdout: (r.stdout ?? "").slice(0, 500), stderr: (r.stderr ?? "").slice(0, 500) });
  }
  if (acceptance.some((a) => !a.ok)) {
    finish("FAIL", EXIT.GATE_FAILED, { code: "acceptance-failed", message: "one or more acceptance commands failed", failed: acceptance.filter((a) => !a.ok).map((a) => a.cmd) }, { acceptance });
  }

  // --- commit gate (Gate 3): deterministic commit + session-id audit ---------
  // commitRequired is a GATE, not a hope: the wrapper commits the worker's
  // changes itself (the LLM is never trusted to run git commit). Scope is
  // checked against allowedPaths before staging.
  let commitInfo = null;
  if (c.commitRequired) {
    const git = (...a) => spawnSync("git", ["-C", c.cwd, ...a], { encoding: "utf8", timeout: 30_000 });
    // NB: never .trim() the whole porcelain output — it eats the leading
    // status space of the first line and shifts every slice(3) path by one.
    const statusLines = (git("status", "--porcelain").stdout ?? "").split("\n").filter((l) => l.trim());
    const headNow = (git("rev-parse", "HEAD").stdout ?? "").trim();
    if (statusLines.length) {
      const files = statusLines.map((l) => l.slice(3).split(" -> ").pop().replace(/^"|"$/g, ""));
      if ((c.allowedPaths ?? []).length) {
        const outOfScope = files.filter((f) => !c.allowedPaths.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : p + "/")));
        if (outOfScope.length) finish("FAIL", EXIT.GATE_FAILED, { code: "scope-violation", message: "changed files outside allowedPaths", files: outOfScope }, { acceptance });
      }
      const msg = `${c.commitMessage ?? `fix: dsh-task — ${c.goal.slice(0, 60)}`}\n\n[dsh-session: ${sessionId ?? "unknown"}]`;
      git("add", "-A");
      const cr = git("-c", "user.name=dsh-task", "-c", "user.email=dsh-task@local", "commit", "-qm", msg);
      if (cr.status !== 0) finish("FAIL", EXIT.GATE_FAILED, { code: "commit-failed", message: (cr.stderr ?? "").slice(0, 300) }, { acceptance });
    } else if (headNow === baseHead) {
      finish("FAIL", EXIT.GATE_FAILED, { code: "commit-required-empty", message: "commitRequired but the worker left no changes and made no commit" }, { acceptance });
    }
    commitInfo = { sha: (git("rev-parse", "HEAD").stdout ?? "").trim(), auditedSession: sessionId ?? null };
  }

  // --- high-risk secret scan (Gate 2) ------------------------------------------
  let scan = null;
  if (c.risk === "high" && c.commitRequired && baseHead) {
    scan = secretScan(c.cwd, baseHead);
    if (scan.findings.length) {
      finish("FAIL", EXIT.GATE_FAILED, { code: "secret-scan-failed", message: `${scan.findings.length} potential secret(s) in new commits — review before pushing`, findings: scan.findings }, { acceptance, secretScan: scan });
    }
  }

  finish("PASS", EXIT.PASS, null, { acceptance, secretScan: scan, answerChars: answer.length, commit: commitInfo });
}

main().catch((e) => die(EXIT.OUTPUT_CONTRACT, { code: "wrapper-error", message: e?.stack ?? String(e) }));
