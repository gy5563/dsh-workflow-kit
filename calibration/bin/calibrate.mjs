#!/usr/bin/env node
// calibrate — assertion-based validation of the Hermes -> dsh workflow.
// Artifact 3 (calibration package). Zero dependencies; node >= 22.
//
//   calibrate contract            run contract fixtures, diff vs baseline (FAIL on drift)
//   calibrate contract --record   record a new known-good baseline (deliberate act)
//   calibrate smoke               wrapper stub tests + one minimal real task  [phase B]
//   calibrate full                golden task set vs baseline metrics         [phase C]
//
// Contract rules (spec 1.1): FAIL if any baseline field disappears, any type
// changes, or the termination-reason enum gains values. Additive fields/types
// are WARN (drift to review, not silent acceptance). Exit codes: 0 pass,
// 1 contract failure, 2 usage/environment error, 3 not-yet-implemented phase.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASELINE = path.join(ROOT, "baseline", "contract-baseline.json");
const RUNS = path.join(ROOT, "runs");
const DSH = path.join(os.homedir(), ".local", "bin", "dsh");
const HOME = os.homedir();

const FIXTURES = {
  pong: {
    dir: path.join(ROOT, "fixtures", "pong"),
    args: ["Reply with exactly the word PONG and nothing else. Do not use any tools."],
    llm: true,
    expectExit: 0,
    textEquals: "PONG",
    requiredTypes: ["session", "status", "final"],
  },
  readfile: {
    dir: path.join(ROOT, "fixtures", "readfile"),
    args: ["Read the file fixture.txt in the current directory and reply with its exact contents, nothing else."],
    llm: true,
    expectExit: 0,
    textContains: "FIXTURE-OK-7f3a",
    requiredTypes: ["session", "status", "text", "tool_call", "tool_result", "final"],
  },
  badsession: {
    dir: path.join(ROOT, "fixtures", "pong"),
    args: ["--session-id", "session-00000000-0000-0000-0000-000000000000", "continue"],
    llm: false,
    expectExit: 1,
    requiredTypes: ["error"],
  },
};

function env() {
  const e = { ...process.env };
  e.PATH = `${HOME}/.local/bin:/usr/local/bin:${e.PATH ?? ""}`;
  return e;
}

function runFixture(name) {
  const f = FIXTURES[name];
  fs.mkdirSync(f.dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const proc = spawnSync(
    DSH,
    ["headless", "--json", "--permission-mode", "read-only", "--approval-policy", "never", ...f.args],
    { cwd: f.dir, env: env(), encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const durationMs = Date.now() - t0;
  const runDir = path.join(RUNS, `${startedAt.replace(/[:.]/g, "-")}-${name}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.jsonl"), proc.stdout ?? "");
  fs.writeFileSync(path.join(runDir, "run.err"), proc.stderr ?? "");
  const events = [];
  const badLines = [];
  for (const line of (proc.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { badLines.push(line); }
  }
  return {
    name, fixture: f, runDir, startedAt, durationMs,
    exitCode: proc.status, signal: proc.signal, spawnError: proc.error?.message ?? null,
    events, badLines, stderr: proc.stderr ?? "",
  };
}

// ---- schema extraction / diff --------------------------------------------

function schemaOf(v) {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) {
    return { type: "array", items: v.length ? mergeSchemas(v.map(schemaOf)) : { type: "unknown" } };
  }
  if (typeof v === "object") {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = schemaOf(val);
    return { type: "object", fields };
  }
  return { type: typeof v }; // string | number | boolean
}

function mergeSchemas(list) {
  const out = {};
  for (const s of list) {
    if (s.type !== "object" || !s.fields) { Object.assign(out, s); continue; }
    out.type = "object";
    out.fields ??= {};
    for (const [k, v] of Object.entries(s.fields)) {
      out.fields[k] = out.fields[k] ? mergeSchemas([out.fields[k], v]) : v;
    }
  }
  return out;
}

function eventSchemas(events) {
  const byType = {};
  for (const ev of events) {
    if (!ev || typeof ev.type !== "string") continue;
    (byType[ev.type] ??= []).push(schemaOf(ev));
  }
  const out = {};
  for (const [t, list] of Object.entries(byType)) out[t] = mergeSchemas(list);
  return out;
}

function reasonKinds(events) {
  const kinds = new Set();
  for (const ev of events) {
    const r = ev?.reason ?? (ev?.type === "status" && ev?.phase === "turn_end" ? ev.reason : null);
    if (r && typeof r.kind === "string") kinds.add(r.kind);
  }
  return [...kinds].sort();
}

// Walk baseline schema against observed schema. Every baseline field must
// exist with the same type; extras are additive drift.
function diffSchema(base, obs, trail, fails, warns) {
  if (!obs) { fails.push(`field disappeared: ${trail}`); return; }
  if (base.type !== obs.type) {
    // merged unions may legitimately widen (e.g. array items unknown->object)
    if (base.type === "unknown") { warns.push(`type refined: ${trail} unknown -> ${obs.type}`); return; }
    fails.push(`type changed: ${trail} ${base.type} -> ${obs.type}`);
    return;
  }
  if (base.type === "object") {
    for (const [k, v] of Object.entries(base.fields ?? {})) {
      diffSchema(v, obs.fields?.[k], `${trail}.${k}`, fails, warns);
    }
    for (const k of Object.keys(obs.fields ?? {})) {
      if (!(k in (base.fields ?? {}))) warns.push(`new field: ${trail}.${k}`);
    }
  }
  if (base.type === "array" && base.items) {
    diffSchema(base.items, obs.items, `${trail}[]`, fails, warns);
  }
}

// ---- contract test ---------------------------------------------------------

function buildBaseline(runs) {
  const fixtures = {};
  const allKinds = new Set();
  for (const r of runs) {
    const schemas = eventSchemas(r.events);
    for (const k of reasonKinds(r.events)) allKinds.add(k);
    fixtures[r.name] = {
      expectExit: r.exitCode,
      requiredTypes: r.fixture.requiredTypes,
      eventTypes: Object.keys(schemas).sort(),
      schemas,
      reasonKinds: reasonKinds(r.events),
      sequence: r.events.map((e) => e.type),
    };
  }
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    dshVersion: dshVersion(),
    exitMap: { completed: 0, error: 1 },
    reasonKindEnum: [...allKinds].sort(),
    fixtures,
  };
}

function dshVersion() {
  const p = spawnSync(DSH, ["--version"], { env: env(), encoding: "utf8", timeout: 60_000 });
  return (p.stdout ?? "").trim() || "unknown";
}

function checkFixture(r, base) {
  const fails = [];
  const warns = [];
  const checks = [];
  const f = r.fixture;
  const bf = base.fixtures[r.name];

  if (r.spawnError) fails.push(`spawn error: ${r.spawnError}`);
  if (r.badLines.length) fails.push(`${r.badLines.length} unparseable NDJSON line(s)`);

  // exit-code contract
  if (r.exitCode !== bf.expectExit) {
    fails.push(`exit code ${r.exitCode} != baseline ${bf.expectExit}`);
  }
  const final = r.events.find((e) => e.type === "final");
  if (final) {
    const mapped = base.exitMap[final.reason?.kind];
    if (mapped !== undefined && mapped !== r.exitCode) {
      fails.push(`exit code ${r.exitCode} contradicts final.reason.kind=${final.reason?.kind} (map says ${mapped})`);
    }
  }

  // required event types present
  const schemas = eventSchemas(r.events);
  for (const t of bf.requiredTypes) {
    if (!schemas[t]) fails.push(`required event type missing: ${t}`);
  }

  // per-type schema diff (field disappearance / type change / additive)
  for (const [t, bs] of Object.entries(bf.schemas)) {
    if (!schemas[t]) {
      if (bf.requiredTypes.includes(t)) continue; // already failed above
      warns.push(`optional event type absent this run: ${t}`);
      continue;
    }
    diffSchema(bs, schemas[t], t, fails, warns);
  }
  for (const t of Object.keys(schemas)) {
    if (!bf.schemas[t]) warns.push(`new event type: ${t}`);
  }

  // termination-reason enum must not gain values
  for (const k of reasonKinds(r.events)) {
    if (!base.reasonKindEnum.includes(k)) fails.push(`termination-reason enum gained value: ${k}`);
  }

  // behavioral sanity of the fixed fixtures
  if (f.textEquals !== undefined && final?.text !== f.textEquals) {
    fails.push(`fixture text mismatch: expected ${JSON.stringify(f.textEquals)}, got ${JSON.stringify(final?.text ?? null)}`);
  }
  if (f.textContains !== undefined && !(final?.text ?? "").includes(f.textContains)) {
    fails.push(`fixture text missing token ${JSON.stringify(f.textContains)}`);
  }

  checks.push({ name: "ndjson-parse", status: r.badLines.length ? "FAIL" : "PASS" });
  checks.push({ name: "exit-contract", status: fails.some((x) => x.startsWith("exit code")) ? "FAIL" : "PASS" });
  checks.push({ name: "schema-drift", status: fails.some((x) => /field disappeared|type changed/.test(x)) ? "FAIL" : "PASS" });
  checks.push({ name: "reason-enum", status: fails.some((x) => x.startsWith("termination-reason")) ? "FAIL" : "PASS" });
  checks.push({ name: "fixture-behavior", status: fails.some((x) => x.startsWith("fixture text")) ? "FAIL" : "PASS" });

  return {
    fixture: r.name,
    status: fails.length ? "FAIL" : "PASS",
    fails, warns, checks,
    sessionId: r.events.find((e) => e.type === "session")?.sessionId ?? null,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    eventCount: r.events.length,
    runDir: r.runDir,
  };
}

function usageTotal(events) {
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const ev of events) {
    if (ev?.type === "status" && ev?.phase === "step_end" && ev.usage) {
      for (const k of Object.keys(t)) t[k] += ev.usage[k] ?? 0;
    }
  }
  return t;
}

function main() {
  const [cmd = "contract", ...rest] = process.argv.slice(2);
  if (cmd === "smoke" || cmd === "full") {
    console.error(`calibrate ${cmd}: not yet implemented — requires the dsh-task wrapper (phase B) / golden task set (phase C). See README roadmap.`);
    process.exit(3);
  }
  if (cmd !== "contract") {
    console.error("usage: calibrate contract [--record] | smoke | full");
    process.exit(2);
  }
  if (!fs.existsSync(DSH)) {
    console.error(`dsh launcher not found at ${DSH}`);
    process.exit(2);
  }

  // --replay <fixture> <run.jsonl> <exitCode>: diff a captured run against the
  // baseline with ZERO LLM calls (spec 1.1: no real LLM dependency where possible).
  const replayIdx = rest.indexOf("--replay");
  if (replayIdx !== -1) {
    const [name, jsonlPath, exitStr] = rest.slice(replayIdx + 1, replayIdx + 4);
    if (!FIXTURES[name] || !jsonlPath || exitStr === undefined || !fs.existsSync(jsonlPath)) {
      console.error("usage: calibrate contract --replay <fixture> <run.jsonl> <exitCode>");
      process.exit(2);
    }
    if (!fs.existsSync(BASELINE)) {
      console.error("[calibrate] no baseline; run `calibrate contract --record` first");
      process.exit(2);
    }
    const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    const events = [];
    const badLines = [];
    for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { badLines.push(line); }
    }
    const r = {
      name, fixture: FIXTURES[name], runDir: path.dirname(jsonlPath),
      exitCode: Number(exitStr), events, badLines, spawnError: null, durationMs: 0,
      startedAt: new Date().toISOString(),
    };
    const res = checkFixture(r, base);
    console.log(`[${res.status}] ${name} (replay, exit=${r.exitCode}, ${events.length} events)`);
    for (const x of res.fails) console.log(`    FAIL: ${x}`);
    for (const x of res.warns) console.log(`    warn: ${x}`);
    process.exit(res.status === "PASS" ? 0 : 1);
  }

  const record = rest.includes("--record");
  const names = Object.keys(FIXTURES);
  const runs = [];
  for (const n of names) {
    process.stderr.write(`[calibrate] fixture ${n} ... `);
    const r = runFixture(n);
    process.stderr.write(`exit=${r.exitCode} events=${r.events.length} ${r.durationMs}ms\n`);
    runs.push(r);
  }

  if (record) {
    const baseline = buildBaseline(runs);
    const anyFail = runs.some((r) => r.spawnError || r.badLines.length || (r.fixture.llm && r.exitCode !== 0));
    if (anyFail) {
      console.error("[calibrate] refusing to record baseline: a fixture did not complete cleanly");
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[calibrate] baseline recorded -> ${BASELINE} (dsh ${baseline.dshVersion}, reasonKinds=${baseline.reasonKindEnum.join(",")})`);
    process.exit(0);
  }

  if (!fs.existsSync(BASELINE)) {
    console.error("[calibrate] no baseline; run `calibrate contract --record` first (deliberate known-good capture)");
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const results = runs.map((r) => checkFixture(r, base));
  const verdict = {
    schemaVersion: 1,
    kind: "contract",
    at: new Date().toISOString(),
    dshVersion: dshVersion(),
    baselineRecordedAt: base.recordedAt,
    baselineDshVersion: base.dshVersion,
    status: results.every((r) => r.status === "PASS") ? "PASS" : "FAIL",
    fixtures: results,
    usage: Object.fromEntries(runs.map((r) => [r.name, usageTotal(r.events)])),
  };
  const vDir = path.join(RUNS, `verdict-${verdict.at.replace(/[:.]/g, "-")}`);
  fs.mkdirSync(vDir, { recursive: true });
  fs.writeFileSync(path.join(vDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
  for (const r of results) {
    console.log(`[${r.status}] ${r.fixture} (exit=${r.exitCode}, ${r.eventCount} events, ${r.durationMs}ms)`);
    for (const x of r.fails) console.log(`    FAIL: ${x}`);
    for (const x of r.warns) console.log(`    warn: ${x}`);
  }
  if (verdict.dshVersion !== verdict.baselineDshVersion) {
    console.log(`    warn: dsh version drift ${verdict.baselineDshVersion} -> ${verdict.dshVersion}`);
  }
  console.log(`[calibrate] contract ${verdict.status} — verdict: ${path.join(vDir, "verdict.json")}`);
  process.exit(verdict.status === "PASS" ? 0 : 1);
}

main();
