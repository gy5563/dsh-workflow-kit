#!/usr/bin/env node
// Spec 1.2 — four stub-based behavior tests for the dsh-task wrapper.
// The wrapper logic is the subject under test; dsh is replaced by a stub
// (via --dsh-bin) so there is ZERO LLM nondeterminism. Every suite includes
// a deliberately failing stub/control. Runs in seconds.
//
//   node calibration/tests/wrapper-stubs.mjs
//
// Suites:
//   T1 SIGTERM false-success  (stub exits 0 on SIGTERM, reason=aborted → 2)
//   T2 git authorization      (grant iff commitRequired; failing-commit stub)
//   T3 session-resume lock    (held lock → 4 before dsh; released → proceeds)
//   T4 path fallback          (no-output / bad-ndjson / no-final / empty → 5/6)
//   T0 contract rejection     (invalid contracts → 7; high-risk refusal)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "../..");
const WRAPPER = path.join(KIT, "dsh-task/bin/dsh-task.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stubs-"));

const STUB = path.join(TMP, "stub-dsh.mjs");
fs.writeFileSync(STUB, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const mode = process.env.STUB_MODE ?? "ok";
const argv = process.argv.slice(2);
if (process.env.STUB_ARGV_FILE) fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(argv));
const ev = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const session = { type: "session", sessionId: "session-11111111-2222-3333-4444-555555555555", cwd: process.cwd() };
const done = (text, kind = "completed") => { ev(session); ev({ type: "final", sessionId: session.sessionId, reason: { kind }, text }); process.exit(kind === "completed" ? 0 : 1); };
if (mode === "ok") done("DONE-" + mode);
else if (mode === "sigterm") {
  process.on("SIGTERM", () => { ev(session); ev({ type: "final", sessionId: session.sessionId, reason: { kind: "aborted" }, text: "partial" }); process.exit(0); });
  setTimeout(() => process.exit(1), 15000);
} else if (mode === "git-grant") {
  const grants = argv.filter((a, i) => argv[i - 1] === "--add-dir");
  if (grants.includes(path.join(process.cwd(), ".git"))) done("COMMITTED");
  else { ev(session); ev({ type: "final", sessionId: session.sessionId, reason: { kind: "error", message: "cannot write .git without grant" }, text: "" }); process.exit(1); }
} else if (mode === "commit-fails") { ev(session); ev({ type: "final", sessionId: session.sessionId, reason: { kind: "error", message: "commit rejected by stub" }, text: "" }); process.exit(1); }
else if (mode === "no-output") process.exit(0);
else if (mode === "garbage") { process.stdout.write("this is not json\\n"); process.exit(0); }
else if (mode === "no-final") { ev(session); ev({ type: "status", phase: "turn_start", turn: 1 }); process.exit(0); }
else if (mode === "empty-text") done("");
else { console.error("unknown stub mode " + mode); process.exit(99); }
`);
fs.chmodSync(STUB, 0o755);

let passCount = 0, failCount = 0;
function check(name, cond, detail = "") {
  if (cond) { passCount++; console.log(`  PASS ${name}`); }
  else { failCount++; console.log(`  FAIL ${name} ${detail}`); }
}

function makeRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.email", "stub@test"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.name", "stub"], { encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "README.md"), "stub repo\n");
  spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "-qm", "init"], { encoding: "utf8" });
  return dir;
}

function contractFor(dir, over = {}) {
  return {
    schemaVersion: 1, goal: "stub task", cwd: dir, acceptance: [],
    allowedPaths: [], commitRequired: false, risk: "medium", ...over,
  };
}

function runWrapper(contract, { mode = "ok", home = null, signalAfterMs = null, extraArgs = [] } = {}) {
  const cfile = path.join(TMP, `contract-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfile, JSON.stringify(contract));
  const outDir = path.join(TMP, `out-${Math.random().toString(36).slice(2)}`);
  const argvFile = path.join(TMP, `argv-${Math.random().toString(36).slice(2)}.json`);
  const env = { ...process.env, STUB_MODE: mode, STUB_ARGV_FILE: argvFile };
  if (home) env.HOME = home;
  const child = spawn(process.execPath, [WRAPPER, "--contract", cfile, "--out", outDir, "--dsh-bin", STUB, ...extraArgs], { env, cwd: TMP });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  let killTimer = null;
  if (signalAfterMs) killTimer = setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      let verdict = null;
      try { verdict = JSON.parse(fs.readFileSync(path.join(outDir, "verdict.json"), "utf8")); } catch {}
      let argvRecorded = null;
      try { argvRecorded = JSON.parse(fs.readFileSync(argvFile, "utf8")); } catch {}
      resolve({ code, verdict, argvRecorded, stdout, stderr, outDir });
    });
  });
}

// ---------------------------------------------------------------- T1
console.log("T1 — SIGTERM false-success");
{
  const repo = makeRepo("t1");
  const r = await runWrapper(contractFor(repo), { mode: "sigterm", signalAfterMs: 500 });
  check("wrapper exits 2 when dsh exits 0 on SIGTERM with reason=aborted", r.code === 2, `got ${r.code}`);
  check("verdict marks false-success", r.verdict?.failure?.code === "false-success", JSON.stringify(r.verdict?.failure));
  const ok = await runWrapper(contractFor(repo), { mode: "ok" });
  check("control: healthy stub passes (exit 0)", ok.code === 0, `got ${ok.code}`);
}

// ---------------------------------------------------------------- T2
console.log("T2 — git authorization");
{
  const repo = makeRepo("t2");
  const withCommit = await runWrapper(contractFor(repo, { commitRequired: true }), { mode: "git-grant" });
  const realRepo = fs.realpathSync(repo);
  check("commitRequired grants --add-dir <cwd>/.git and task passes", withCommit.code === 0 && (withCommit.argvRecorded ?? []).includes(path.join(realRepo, ".git")), `code=${withCommit.code} argv=${JSON.stringify(withCommit.argvRecorded)}`);
  const noCommit = await runWrapper(contractFor(repo, { commitRequired: false }), { mode: "ok" });
  check("no-commit task gets NO .git grant", noCommit.code === 0 && !(noCommit.argvRecorded ?? []).includes(path.join(realRepo, ".git")), JSON.stringify(noCommit.argvRecorded));
  const failing = await runWrapper(contractFor(repo, { commitRequired: true }), { mode: "commit-fails" });
  check("deliberately failing commit stub is NOT swallowed (exit 3)", failing.code === 3 && failing.verdict?.failure?.code === "dsh-failure", `got ${failing.code}`);
  const noGrantStub = await runWrapper(contractFor(repo, { commitRequired: false }), { mode: "git-grant" });
  check("stub that needs .git fails without the grant (exit 3)", noGrantStub.code === 3, `got ${noGrantStub.code}`);
}

// ---------------------------------------------------------------- T3
console.log("T3 — session-resume lock");
{
  const repo = makeRepo("t3");
  const home = path.join(TMP, "t3-home");
  const sid = "session-11111111-2222-3333-4444-555555555555";
  const lockDir = path.join(home, ".dsh", "sessions", "--stub--", sid);
  fs.mkdirSync(lockDir, { recursive: true });
  const lock = path.join(lockDir, "session.lock");
  fs.writeFileSync(lock, "");
  const holder = spawn(process.execPath, ["-e", `const fs=require("fs");const fd=fs.openSync(${JSON.stringify(lock)},"w");setTimeout(()=>{fs.closeSync(fd);process.exit(0)},30000);`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const held = await runWrapper(contractFor(repo, { sessionId: sid }), { mode: "ok", home });
  check("held lock → exit 4 before dsh", held.code === 4, `got ${held.code}`);
  check("dsh stub was NOT invoked", held.argvRecorded === null);
  check("structured error + remediation names the holder", held.verdict?.failure?.code === "session-lock-held" && String(held.verdict?.failure?.remediation ?? "").includes(String(holder.pid)), JSON.stringify(held.verdict?.failure));
  holder.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  const free = await runWrapper(contractFor(repo, { sessionId: sid }), { mode: "ok", home });
  check("released lock → resume proceeds (stub invoked, exit 0)", free.code === 0 && free.argvRecorded !== null, `got ${free.code}`);
}

// ---------------------------------------------------------------- T4
console.log("T4 — path fallback (distinguishable failures)");
{
  const repo = makeRepo("t4");
  const cases = [
    ["no-output", 5, "no-output"],
    ["garbage", 5, "bad-ndjson"],
    ["no-final", 5, "no-final"],
    ["empty-text", 6, "empty-answer"],
  ];
  const seen = new Set();
  for (const [mode, wantCode, wantSub] of cases) {
    const r = await runWrapper(contractFor(repo), { mode });
    check(`${mode} → exit ${wantCode} (${wantSub})`, r.code === wantCode && r.verdict?.failure?.subclass === wantSub, `got ${r.code}/${r.verdict?.failure?.subclass}`);
    check(`${mode} → verdict.json still well-formed`, r.verdict !== null && r.verdict.schemaVersion === 1);
    seen.add(`${r.code}:${r.verdict?.failure?.subclass}`);
  }
  check("failure classes are distinguishable", seen.size === cases.length, JSON.stringify([...seen]));
}

// ---------------------------------------------------------------- T0
console.log("T0 — contract rejection & risk binding");
{
  const repo = makeRepo("t0");
  const bad = await runWrapper({ goal: "", cwd: repo, acceptance: [], allowedPaths: [], commitRequired: false, risk: "medium" }, {});
  check("empty goal rejected (7)", bad.code === 7, `got ${bad.code}`);
  const high = await runWrapper(contractFor(repo, { risk: "high", commitRequired: true }), { mode: "ok" });
  let highVerdict = null; try { highVerdict = JSON.parse(high.stderr); } catch {}
  check("high-risk auto-commit refused without flag (7)", high.code === 7 && JSON.stringify(highVerdict?.failure?.problems ?? []).includes("allow-high-risk"), `got ${high.code}`);
  const lowCommit = await runWrapper(contractFor(repo, { risk: "low", commitRequired: true }), { mode: "ok" });
  check("read-only risk cannot require commits (7)", lowCommit.code === 7, `got ${lowCommit.code}`);
  const dry = await runWrapper(contractFor(repo, { risk: "low" }), { mode: "ok", extraArgs: ["--dry-run"] });
  const plan = dry.verdict?.plan ?? {};
  check("low risk binds read-only/never", dry.code === 0 && JSON.stringify(plan.argv ?? []).includes("read-only"), JSON.stringify(plan.argv));
}

console.log(`\n${passCount} passed, ${failCount} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failCount ? 1 : 0);
