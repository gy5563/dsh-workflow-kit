#!/usr/bin/env node
// dsh-doctor — environment & compatibility health check for the Hermes -> dsh
// workflow. Artifact 2 (dsh-task package). Zero dependencies; node >= 22.
//
//   dsh-doctor [--json] [--repo <path>] [--skip-auth]
//
// Checks: node engine, dsh/acp-server/desktop version compatibility against an
// explicit supported range, authentication usability via ONE cheap headless
// call, git-directory writability, session-lock holders, and the state of every
// environment assembly step (wrapper, profile auth patches, Zed registration,
// desktop ledger format). Detection only — it never writes state. Idempotent
// assembly (--assemble) is a later gate; mismatches are first-class conditions.
//
// Exit: 0 = no failures (warnings allowed), 1 = at least one FAIL, 2 = usage error.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "..", "..");
const HOME = os.homedir();
const DSH = path.join(HOME, ".local", "bin", "dsh");
const ACP_PKG = [
  path.join(HOME, ".local", "lib", "node_modules", "dsh-acp-server", "package.json"),
  path.join(HOME, ".local", "lib", "node_modules", "@deepseek-ai", "dsh-acp-server", "package.json"),
].find((p) => fs.existsSync(p));
const DSH_PKG = path.join(HOME, ".local", "lib", "node_modules", "@deepseek-ai", "dsh", "package.json");
const SUPPORTED = JSON.parse(fs.readFileSync(path.join(KIT, "dsh-task", "supported.json"), "utf8"));

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  if (!process.argv.includes("--json")) console.log(`[${status}] ${name} — ${detail}`);
}
function env() {
  const e = { ...process.env };
  e.PATH = `${HOME}/.local/bin:/usr/local/bin:${e.PATH ?? ""}`;
  return e;
}
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { env: env(), encoding: "utf8", timeout: opts.timeout ?? 60_000, ...opts });
}
function verTuple(v) {
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?/);
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null;
}
function verCmp(a, b) {
  const ta = verTuple(a), tb = verTuple(b);
  if (!ta || !tb) return NaN;
  for (let i = 0; i < 4; i++) if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
  return 0;
}

// 1. node engine -------------------------------------------------------------
const nodeMin = SUPPORTED.node.minimum;
const nodeOk = verCmp(process.version.replace(/^v/, ""), nodeMin) >= 0;
record("node-engine", nodeOk ? "PASS" : "FAIL",
  `${process.version} (minimum ${nodeMin}; ${SUPPORTED.node.reason})`);

// 2. dsh CLI version vs supported range --------------------------------------
let dshVer = "unknown";
if (fs.existsSync(DSH)) {
  dshVer = (sh(DSH, ["--version"]).stdout ?? "").trim() || "unknown";
  const cmp = verCmp(dshVer, SUPPORTED.dsh.supported);
  if (SUPPORTED.dsh.policy === "exact-pin") {
    record("dsh-version", cmp === 0 ? "PASS" : "FAIL",
      `${dshVer} vs supported ${SUPPORTED.dsh.supported} (${SUPPORTED.dsh.policy}). ${SUPPORTED.dsh.reason}`);
  } else {
    record("dsh-version", cmp === 0 ? "PASS" : "WARN", `${dshVer} vs supported ${SUPPORTED.dsh.supported}`);
  }
} else {
  record("dsh-version", "FAIL", `launcher missing: ${DSH}`);
}

// 3. acp-server version --------------------------------------------------------
if (fs.existsSync(ACP_PKG)) {
  const v = JSON.parse(fs.readFileSync(ACP_PKG, "utf8")).version;
  const [maj, min] = SUPPORTED["dsh-acp-server"].supported.split(".");
  const ok = v.startsWith(`${maj}.${min}.`);
  record("acp-server-version", ok ? "PASS" : "WARN", `${v} vs supported ${SUPPORTED["dsh-acp-server"].supported}`);
} else {
  record("acp-server-version", "WARN", "dsh-acp-server not installed (Zed leg unavailable)");
}

// 4. desktop app pairing -------------------------------------------------------
const plist = "/Applications/DeepSeek Harness.app/Contents/Info.plist";
if (fs.existsSync(plist)) {
  const r = sh("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist]);
  const v = (r.stdout ?? "").trim();
  record("desktop-pairing", v === SUPPORTED.desktopApp.pairedWith ? "PASS" : "WARN",
    `app ${v || "unknown"} vs CLI paired-with ${SUPPORTED.desktopApp.pairedWith} (shared session store)`);
} else {
  record("desktop-pairing", "INFO", "desktop app not installed (CLI-only workflow)");
}

// 5. authentication usability — one cheap headless call ------------------------
if (process.argv.includes("--skip-auth")) {
  record("auth-headless", "SKIP", "--skip-auth requested");
} else if (fs.existsSync(DSH)) {
  const t0 = Date.now();
  const p = sh(DSH, ["headless", "--json", "--permission-mode", "read-only", "--approval-policy", "never",
    "Reply with exactly the word PONG and nothing else. Do not use any tools."],
    { cwd: os.tmpdir(), timeout: 240_000 });
  let final = null;
  for (const line of (p.stdout ?? "").split("\n")) {
    try { const e = JSON.parse(line); if (e.type === "final") final = e; } catch {}
  }
  const ok = p.status === 0 && final?.reason?.kind === "completed" && final?.text === "PONG";
  record("auth-headless", ok ? "PASS" : "FAIL",
    ok ? `account route usable (PONG in ${Date.now() - t0}ms, exit 0)`
       : `exit=${p.status} reason=${JSON.stringify(final?.reason ?? null)} stderr=${(p.stderr ?? "").split("\n")[0] ?? ""}`);
} else {
  record("auth-headless", "FAIL", "dsh launcher missing");
}

// 6. git-directory writability --------------------------------------------------
function gitProbe(dir, label) {
  const probe = path.join(dir, ".git", "dsh-doctor-probe");
  try {
    fs.writeFileSync(probe, "probe");
    fs.unlinkSync(probe);
    record(label, "PASS", `.git writable at ${dir}`);
  } catch (e) {
    record(label, "FAIL", `.git NOT writable at ${dir}: ${e.code ?? e.message}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-doctor-"));
const init = sh("git", ["init", "-q", tmp]);
if (init.status === 0) {
  gitProbe(tmp, "git-write-temp");
  fs.rmSync(tmp, { recursive: true, force: true });
} else {
  record("git-write-temp", "FAIL", `git init failed: ${(init.stderr ?? "").trim()}`);
}
const repoIdx = process.argv.indexOf("--repo");
if (repoIdx !== -1) {
  const repo = process.argv[repoIdx + 1];
  if (!repo || !fs.existsSync(path.join(repo, ".git"))) {
    record("git-write-repo", "FAIL", `not a git repository: ${repo}`);
  } else gitProbe(repo, "git-write-repo");
}

// 7. session locks (exclusive-lock handoff hazard) -------------------------------
const sessRoot = path.join(HOME, ".dsh", "sessions");
const holders = [];
let lockCount = 0;
if (fs.existsSync(sessRoot)) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "session.lock") {
        lockCount++;
        const lsof = sh("lsof", ["-t", p], { timeout: 15_000 });
        for (const pid of (lsof.stdout ?? "").trim().split("\n").filter(Boolean)) {
          const ps = sh("ps", ["-o", "comm=", "-p", pid]);
          holders.push({ pid: +pid, cmd: (ps.stdout ?? "").trim(), lock: p });
        }
      }
    }
  };
  walk(sessRoot);
}
record("session-locks", holders.length ? "WARN" : "PASS",
  holders.length
    ? `${holders.length} live lock(s): ${holders.map((h) => `pid ${h.pid} (${path.basename(h.cmd)})`).join(", ")} — close those threads before CLI resume`
    : `${lockCount} lock file(s), none held`);

// 8. environment assembly state (Gate 1 detection) --------------------------------
const wrapper = path.join(HOME, ".local", "bin", "dsh-worker");
let wrapperOk = false;
try { fs.accessSync(wrapper, fs.constants.X_OK); wrapperOk = true; } catch {}
record("assembly-wrapper", wrapperOk ? "PASS" : "FAIL", `${wrapper} ${wrapperOk ? "present+executable" : "missing/not executable"}`);

function patchState(profile, required) {
  const p = path.join(HOME, ".dsh", "profiles", profile, "cordis.patch.yml");
  if (!fs.existsSync(p)) return { ok: false, detail: `profile ${profile} missing` };
  const text = fs.readFileSync(p, "utf8");
  const missing = required.filter((r) => !text.includes(r));
  return missing.length
    ? { ok: false, detail: `profile ${profile} patch missing: ${missing.join(", ")}` }
    : { ok: true, detail: `profile ${profile} auth patch intact` };
}
const hl = patchState("headless", ["id: credentials", "id: authorization", "id: deepseek-account", "provider: deepseek-account"]);
record("assembly-headless-auth", hl.ok ? "PASS" : "FAIL", hl.detail);
const acp = patchState("acp", ["provider: deepseek-account"]);
record("assembly-acp-auth", acp.ok ? "PASS" : "WARN", acp.detail);

const zedSettings = path.join(HOME, ".config", "zed", "settings.json");
if (fs.existsSync(zedSettings)) {
  const ok = fs.readFileSync(zedSettings, "utf8").includes('"DeepSeek Harness"');
  record("assembly-zed-registration", ok ? "PASS" : "WARN",
    ok ? "agent_servers entry present (JSONC preserved)" : "entry missing — Zed leg unregistered");
} else {
  record("assembly-zed-registration", "INFO", "Zed settings not found");
}

const ledger = path.join(HOME, ".dsh", "storages", "workspace.json");
if (fs.existsSync(ledger)) {
  try {
    const j = JSON.parse(fs.readFileSync(ledger, "utf8"));
    const v = j?.unit?.version;
    record("assembly-ledger-format", v === SUPPORTED.workspaceLedger.unitVersion ? "PASS" : "WARN",
      `workspace.json unit.version=${v} (supported ${SUPPORTED.workspaceLedger.unitVersion}; ${SUPPORTED.workspaceLedger.status})`);
  } catch (e) {
    record("assembly-ledger-format", "WARN", `workspace.json unparsable: ${e.message}`);
  }
} else {
  record("assembly-ledger-format", "INFO", "no desktop ledger (desktop app never run)");
}

// 9. calibration baseline freshness ----------------------------------------------
const baseline = path.join(KIT, "calibration", "baseline", "contract-baseline.json");
if (fs.existsSync(baseline)) {
  const b = JSON.parse(fs.readFileSync(baseline, "utf8"));
  record("calibration-baseline", b.dshVersion === dshVer ? "PASS" : "WARN",
    `recorded ${b.recordedAt} against dsh ${b.dshVersion} (current ${dshVer})`);
} else {
  record("calibration-baseline", "WARN", "no contract baseline — run `calibrate contract --record`");
}

// verdict ---------------------------------------------------------------------
const fails = results.filter((r) => r.status === "FAIL");
const warns = results.filter((r) => r.status === "WARN");
const verdict = {
  schemaVersion: 1, kind: "doctor", at: new Date().toISOString(),
  status: fails.length ? "FAIL" : "PASS",
  counts: { pass: results.filter((r) => r.status === "PASS").length, fail: fails.length, warn: warns.length },
  checks: results,
};
if (process.argv.includes("--json")) console.log(JSON.stringify(verdict, null, 2));
else console.log(`\n[doctor] ${verdict.status} — ${verdict.counts.pass} pass, ${fails.length} fail, ${warns.length} warn`);
process.exit(fails.length ? 1 : 0);
