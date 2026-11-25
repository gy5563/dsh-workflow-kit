#!/usr/bin/env node
// golden — Phase C golden task set runner (spec §1.3), wrapper path.
// Goals live in golden/tasks.json (shared with the ACP-direct comparator so
// both paths dispatch identical tasks). Resets each synthetic fixture to its
// baseline tag, dispatches via the dsh-task wrapper (real dsh), records
// metrics to golden/results.jsonl.
// Usage: node golden.mjs [--only <task>] [--list]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.resolve(ROOT, "..");
const G = path.join(ROOT, "golden");
const WRAPPER = path.join(KIT, "dsh-task", "bin", "dsh-task.mjs");
const RESULTS = path.join(G, "results.jsonl");
const T = JSON.parse(fs.readFileSync(path.join(G, "tasks.json"), "utf8"));
const NAMES = ["minimal-fix", "feature", "batch-1", "batch-3", "batch-6"];

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

export function contractFor(name, dir) {
  const isBatch = name.startsWith("batch-");
  const t = structuredClone(isBatch ? T["batch-template"] : T[name]);
  if (!t) throw new Error(`unknown task: ${name}`);
  if (isBatch) {
    const n = name.slice(6);
    t.goal = t.goal.replaceAll("{n}", n);
    t.commitMessage = t.commitMessage.replaceAll("{n}", n);
  }
  t.cwd = dir;
  return t;
}
function git(cwd, ...a) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
}
export function reset(name) {
  const dir = path.join(G, name);
  git(dir, "reset", "--hard", "-q", "golden-base");
  git(dir, "clean", "-fdxq");
  return dir;
}
function dispatch(contract, outDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golden-"));
  const cp = path.join(tmp, "contract.json");
  fs.writeFileSync(cp, JSON.stringify(contract, null, 2));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [WRAPPER, "--contract", cp, "--out", outDir],
    { encoding: "utf8", timeout: (contract.timeoutMs ?? 600000) + 60000, maxBuffer: 64 * 1024 * 1024 });
  const wallMs = Date.now() - t0;
  let verdict = null;
  for (const line of (r.stdout ?? "").split("\n")) {
    if (line.includes("verdict: ")) {
      try { verdict = JSON.parse(fs.readFileSync(line.split("verdict: ")[1].trim(), "utf8")); } catch {}
    }
  }
  return { verdict, wallMs, spawnStatus: r.status };
}
export function record(entry) {
  entry.at = new Date().toISOString();
  fs.appendFileSync(RESULTS, JSON.stringify(entry) + "\n");
  const u = entry.usage ?? {};
  console.log(`${entry.task.padEnd(14)} ${entry.path.padEnd(11)} ${entry.firstPass ? "PASS" : "FAIL"} exit=${entry.exitCode} wall=${(entry.wallMs / 1000).toFixed(1)}s tokens=${(u.inputTokens ?? 0) + (u.outputTokens ?? 0)} (cacheRead=${u.cacheReadTokens ?? 0})`);
}

function runSimple(name) {
  const dir = reset(name);
  const outDir = path.join(G, "runs", `${name}-${Date.now()}`);
  const { verdict, wallMs, spawnStatus } = dispatch(contractFor(name, dir), outDir);
  record({
    task: name, path: "wrapper", firstPass: verdict?.status === "PASS",
    exitCode: verdict?.exitCode ?? spawnStatus, status: verdict?.status ?? "NO-VERDICT",
    usage: verdict?.usage ?? null, wallMs, sessionId: verdict?.sessionId ?? null,
    gateReruns: 0, interventions: 0, outDir,
  });
}

function runResume() {
  const dir = reset("resume");
  const out1 = path.join(G, "runs", `resume-r1-${Date.now()}`);
  const r1 = dispatch(contractFor("resume-r1", dir), out1);
  const sid = r1.verdict?.sessionId;
  record({ task: "resume-r1", path: "wrapper", firstPass: r1.verdict?.status === "PASS", exitCode: r1.verdict?.exitCode, status: r1.verdict?.status, usage: r1.verdict?.usage ?? null, wallMs: r1.wallMs, sessionId: sid, gateReruns: 0, interventions: 0, outDir: out1 });
  if (!sid) { console.error("resume: round 1 gave no sessionId — aborting round 2"); return; }
  const out2 = path.join(G, "runs", `resume-r2-${Date.now()}`);
  const c2 = contractFor("resume-r2", dir); c2.sessionId = sid;
  const r2 = dispatch(c2, out2);
  const sameSession = r2.verdict?.sessionId === sid;
  record({ task: "resume-r2", path: "wrapper", firstPass: r2.verdict?.status === "PASS" && sameSession, exitCode: r2.verdict?.exitCode, status: r2.verdict?.status, usage: r2.verdict?.usage ?? null, wallMs: r2.wallMs, sessionId: r2.verdict?.sessionId ?? null, sessionContinuity: sameSession, gateReruns: 0, interventions: 0, outDir: out2 });
  if (!sameSession) console.error(`resume: SESSION MISMATCH r1=${sid} r2=${r2.verdict?.sessionId}`);
}

// CLI entry (skip when imported by the comparator)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (args.includes("--list")) { console.log(NAMES.join("\n") + "\nresume (two rounds)"); process.exit(0); }
  fs.mkdirSync(path.join(G, "runs"), { recursive: true });
  const names = only ? [only] : NAMES;
  for (const name of names) {
    if (name === "resume") continue;
    if (!NAMES.includes(name)) { console.error(`unknown task: ${name}`); process.exit(2); }
    runSimple(name);
  }
  if (!only || only === "resume") runResume();
  console.log(`results appended to ${RESULTS}`);
}