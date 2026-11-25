#!/usr/bin/env node
// golden-acp — economic comparison path (spec §1.4): same golden goals via
// ACP-direct (no wrapper, no gates), then INDEPENDENT verification of the repo
// state (acceptance commands + commit check) — the ACP path has no gates of
// its own, so firstPass is measured, never claimed.
// Usage: node golden-acp.mjs [--only <task>]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { contractFor, reset, record } from "./golden.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const G = path.join(ROOT, "golden");
const ACP = path.join(ROOT, "bin", "acp-direct.mjs");
const TASKS = ["minimal-fix", "batch-1", "batch-6"];
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

function normalizeUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? u.cachedReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? u.cachedWriteTokens ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };
}

for (const name of only ? [only] : TASKS) {
  if (!TASKS.includes(name)) { console.error(`unknown acp task: ${name}`); process.exit(2); }
  const dir = reset(name);
  const c = contractFor(name, dir);
  // ACP has no wrapper commit gate — the worker must be told to commit itself.
  // (This asymmetry is part of what the wrapper buys: deterministic commits.)
  const goal = `${c.goal} When done, commit all changes with git using the message: ${c.commitMessage}`;
  const outDir = path.join(G, "runs", `acp-${name}-${Date.now()}`);
  const r = spawnSync(process.execPath, [ACP, "--cwd", dir, "--goal", goal, "--out", outDir, "--timeout-ms", String(c.timeoutMs)],
    { encoding: "utf8", timeout: c.timeoutMs + 60000, maxBuffer: 64 * 1024 * 1024 });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(path.join(outDir, "acp-result.json"), "utf8")); } catch {}
  // independent verification — never trust the transport's stopReason alone
  const gateOk = c.acceptance.every((cmd) => spawnSync("bash", ["-lc", cmd], { cwd: dir, encoding: "utf8", timeout: 120000 }).status === 0);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const base = spawnSync("git", ["rev-parse", "golden-base"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const clean = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim() === "";
  const committed = head !== base && clean;
  const firstPass = res?.stopReason === "end_turn" && gateOk && committed;
  record({
    task: name, path: "acp-direct", firstPass, exitCode: r.status,
    status: res?.stopReason ?? "NO-RESULT", usage: normalizeUsage(res?.usage),
    wallMs: res?.wallMs ?? null, sessionId: res?.sessionId ?? null,
    gateReruns: 0, interventions: 0, gateOk, committed, outDir,
  });
}
console.log("acp comparison results appended");