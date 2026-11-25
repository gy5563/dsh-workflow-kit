#!/usr/bin/env node
// dsh-assemble — Gate 1 (spec 3.3): idempotent environment assembly.
// Automates only the safe, reversible steps (profile auth patches, with
// backups). Detection-only for surfaces where blind writes are unsafe:
//   - Zed settings.json is JSONC and shared with the user's editor config
//   - the desktop ownership ledger is app-internal (quit-app-first tampering)
// Running twice must change nothing (idempotence is asserted by --verify).
// Exit: 0 assembled/detected-ok · 1 a required step needs manual action · 2 usage.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HOME = os.homedir();
const DSH = path.join(HOME, ".dsh");
const args = process.argv.slice(2);
const VERIFY = args.includes("--verify");
const JSON_OUT = args.includes("--json");

const AUTH_PATCH = `- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
`;
const REQUIRED_IDS = ["credentials", "authorization", "deepseek-account", "agent-default-model"];

const results = [];
function rec(step, status, detail) { results.push({ step, status, detail }); }
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function patchProfile(name) {
  const dir = path.join(DSH, "profiles", name);
  const file = path.join(dir, "cordis.patch.yml");
  if (!fs.existsSync(dir)) {
    rec(`auth-${name}`, "MANUAL", `profile dir missing: ${dir} — create it via dsh first`);
    return;
  }
  if (fs.existsSync(file)) {
    const txt = fs.readFileSync(file, "utf8");
    const missing = REQUIRED_IDS.filter((id) => !new RegExp(`- id: ${id}\\b`).test(txt));
    const disabled = REQUIRED_IDS.filter((id) => new RegExp(`- id: ${id}[\\s\\S]*?disabled: true`).test(txt));
    if (missing.length === 0 && disabled.length === 0) {
      rec(`auth-${name}`, "OK", "already assembled (no change)");
      return;
    }
    if (VERIFY) { rec(`auth-${name}`, "DRIFT", `missing=${missing} disabled=${disabled}`); return; }
    fs.copyFileSync(file, file + `.bak-assemble-${Date.now()}`);
    // merge: keep existing entries, append missing ones (never clobber user rows)
    let merged = txt.trimEnd() + "\n";
    for (const id of missing) {
      const block = AUTH_PATCH.split(/(?=^- id: )/m).find((b) => b.startsWith(`- id: ${id}\n`));
      if (block) merged += block;
    }
    fs.writeFileSync(file, merged);
    rec(`auth-${name}`, "ASSEMBLED", `appended missing: ${missing.join(",")} (backup kept)`);
    return;
  }
  if (VERIFY) { rec(`auth-${name}`, "DRIFT", "patch file absent"); return; }
  fs.writeFileSync(file, AUTH_PATCH);
  rec(`auth-${name}`, "ASSEMBLED", `created ${file}`);
}

function detectZed() {
  const p = path.join(HOME, ".config", "zed", "settings.json");
  if (!fs.existsSync(p)) { rec("zed-registration", "MANUAL", "Zed settings.json not found"); return; }
  const txt = fs.readFileSync(p, "utf8");
  if (/"DeepSeek Harness"\s*:/.test(txt) && /dsh-(acp-server|worker)/.test(txt)) {
    rec("zed-registration", "OK", "DeepSeek Harness agent registered (detected, not modified)");
  } else {
    rec("zed-registration", "MANUAL", 'add agent_servers["DeepSeek Harness"] = {command: dsh-acp-server, args:["run"]} — JSONC-safe edit required');
  }
}

function detectLedger() {
  const p = path.join(DSH, "storages", "workspace.json");
  if (!fs.existsSync(p)) { rec("desktop-ledger", "OK", "no ledger yet (desktop not run)"); return; }
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const n = Object.keys(j?.tables?.workspaces ?? {}).length;
    rec("desktop-ledger", "OK", `format v${j?.version ?? "?"}, ${n} workspace(s) — detection only; edits require quitting the desktop app`);
  } catch (e) {
    rec("desktop-ledger", "MANUAL", `ledger unreadable: ${e.message}`);
  }
}

patchProfile("headless");
patchProfile("acp");
detectZed();
detectLedger();

const manual = results.filter((r) => r.status === "MANUAL" || r.status === "DRIFT");
if (JSON_OUT) console.log(JSON.stringify({ results, ok: manual.length === 0 }, null, 2));
else {
  for (const r of results) console.log(`[${r.status}] ${r.step} — ${r.detail}`);
  console.log(manual.length === 0 ? "assemble: environment ready (idempotent)" : `assemble: ${manual.length} step(s) need manual action`);
}
process.exit(manual.length === 0 ? 0 : 1);