#!/usr/bin/env node
// install.mjs — plug-and-play bootstrap for the Hermes → dsh → Zed workflow kit.
// Idempotent: running twice changes nothing. Automates only safe, reversible
// steps; every write to a pre-existing user file keeps a timestamped backup.
//
//   node install.mjs [--dry-run] [--with-zed] [--verify] [--prefix <dir>]
//
//   --dry-run   report what would happen, write nothing
//   --with-zed  register the agent in Zed settings.json (JSONC-safe: backup +
//               parse-verify + auto-restore on failure). Default: detect only.
//   --verify    after install, run full dsh-doctor + calibrate smoke (1 live
//               LLM call). Default: dsh-doctor --skip-auth (zero tokens).
//   --prefix    npm user prefix (default ~/.local — avoids sudo/EACCES)
//
// What stays manual by design (never automated):
//   - DeepSeek auth: account OAuth sign-in is interactive; credentials are
//     never written or shipped by this installer.
//   - the desktop ownership ledger (app-internal; quit-app-first tampering).
// Exit: 0 all automatable steps ok (manual next-steps listed) · 1 a step FAILED.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const WITH_ZED = argv.includes("--with-zed");
const VERIFY = argv.includes("--verify");
const PREFIX = (() => {
  const i = argv.indexOf("--prefix");
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(HOME, ".local");
})();
const supported = JSON.parse(fs.readFileSync(path.join(KIT, "dsh-task", "supported.json"), "utf8"));

const results = [];
const rec = (step, status, detail) => { results.push({ step, status, detail }); console.log(`[${status}] ${step} — ${detail}`); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 300000, ...opts });

// ---------- 1. prerequisites ----------
const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeMin = Number(supported.node.minimum.split(".")[0]);
if (nodeMajor < nodeMin) { rec("node", "FAIL", `node ${process.versions.node} < minimum ${supported.node.minimum}`); finish(); }
rec("node", "OK", `v${process.versions.node} (>= ${supported.node.minimum})`);
const npm = run("npm", ["--version"]);
if (npm.status !== 0) { rec("npm", "FAIL", "npm not found"); finish(); }
rec("npm", "OK", npm.stdout.trim());
const hermesHome = path.join(HOME, ".hermes");
const hasHermes = fs.existsSync(hermesHome);
rec("hermes", hasHermes ? "OK" : "MANUAL", hasHermes ? `${hermesHome} present` : "Hermes not found — install Hermes first, then re-run (plugin/skill steps will apply)");

// ---------- 2. pinned npm packages (user prefix, no sudo) ----------
function pkgVersion(name) {
  try { return JSON.parse(fs.readFileSync(path.join(PREFIX, "lib", "node_modules", name, "package.json"), "utf8")).version; }
  catch { return null; }
}
const pins = [
  ["@deepseek-ai/dsh", supported.dsh.supported],
  ["dsh-acp-server", "0.14.4"],
];
const toInstall = pins.filter(([name, want]) => {
  const have = pkgVersion(name);
  if (have === want) { rec(`npm:${name}`, "OK", `${have} (exact pin)`); return false; }
  if (name === "dsh-acp-server" && have?.startsWith("0.14.")) { rec(`npm:${name}`, "OK", `${have} (0.14.x range)`); return false; }
  return true;
});
if (toInstall.length) {
  if (DRY) rec("npm-install", "DRY", `would install ${toInstall.map(([n, v]) => `${n}@${v}`).join(" ")} --prefix ${PREFIX}`);
  else {
    const r = run("npm", ["install", "--prefix", PREFIX, ...toInstall.map(([n, v]) => `${n}@${v}`)]);
    if (r.status !== 0) { rec("npm-install", "FAIL", (r.stderr ?? r.stdout ?? "").slice(-400)); finish(); }
    rec("npm-install", "INSTALLED", toInstall.map(([n, v]) => `${n}@${v}`).join(" "));
  }
}

// ---------- 3. bin symlinks + portable dsh-worker ----------
const binDir = path.join(PREFIX, "bin");
const links = {
  "dsh-doctor": path.join(KIT, "dsh-task", "bin", "dsh-doctor.mjs"),
  "dsh-task": path.join(KIT, "dsh-task", "bin", "dsh-task.mjs"),
  "dsh-assemble": path.join(KIT, "dsh-task", "bin", "dsh-assemble.mjs"),
  "calibrate": path.join(KIT, "calibration", "bin", "calibrate.mjs"),
};
if (!DRY) fs.mkdirSync(binDir, { recursive: true });
for (const [name, target] of Object.entries(links)) {
  const p = path.join(binDir, name);
  let st = null; try { st = fs.lstatSync(p); } catch {}
  if (st?.isSymbolicLink() && fs.readlinkSync(p) === target) { rec(`bin:${name}`, "OK", "symlink current"); continue; }
  if (st && !st.isSymbolicLink()) { rec(`bin:${name}`, "MANUAL", `${p} exists and is not a symlink — left untouched`); continue; }
  if (DRY) { rec(`bin:${name}`, "DRY", `would symlink → ${target}`); continue; }
  if (st) fs.unlinkSync(p);
  fs.symlinkSync(target, p);
  rec(`bin:${name}`, "INSTALLED", `→ ${target}`);
}
{
  const p = path.join(binDir, "dsh-worker");
  const bundled = path.join(KIT, "dsh-task", "bin", "dsh-worker.zsh");
  let exists = fs.existsSync(p);
  if (exists && /dsh-acp-server/.test(fs.readFileSync(p, "utf8"))) rec("bin:dsh-worker", "OK", "existing worker wrapper kept (works)");
  else if (DRY) rec("bin:dsh-worker", "DRY", "would install portable zsh wrapper");
  else {
    if (exists) fs.copyFileSync(p, p + `.bak-install-${Date.now()}`);
    fs.copyFileSync(bundled, p); fs.chmodSync(p, 0o755);
    rec("bin:dsh-worker", "INSTALLED", "portable wrapper (resolves node/acp-server relative to itself)");
  }
}
if (!(process.env.PATH ?? "").split(":").includes(binDir))
  rec("PATH", "MANUAL", `add to your shell profile: export PATH="${binDir}:$PATH"`);
else rec("PATH", "OK", `${binDir} on PATH`);

// ---------- 4. Hermes plugin + worker skill ----------
if (hasHermes) {
  const pluginsDir = path.join(hermesHome, "plugins");
  const p = path.join(pluginsDir, "dsh-dispatch");
  const target = path.join(KIT, "hermes-plugin");
  let st = null; try { st = fs.lstatSync(p); } catch {}
  if (st?.isSymbolicLink() && fs.readlinkSync(p) === target) rec("hermes-plugin", "OK", "symlink current");
  else if (st && !st.isSymbolicLink()) rec("hermes-plugin", "MANUAL", `${p} exists (not a symlink) — remove it manually, then re-run`);
  else if (DRY) rec("hermes-plugin", "DRY", `would symlink → ${target}`);
  else {
    fs.mkdirSync(pluginsDir, { recursive: true });
    if (st) fs.unlinkSync(p);
    fs.symlinkSync(target, p);
    rec("hermes-plugin", "INSTALLED", "dsh-dispatch enabled (tools arrive in the next gateway session)");
  }
  const skillSrc = path.join(KIT, "skills", "deepseek-harness-worker");
  const skillDst = path.join(hermesHome, "skills", "autonomous-ai-agents", "deepseek-harness-worker");
  if (fs.existsSync(skillSrc)) {
    if (fs.existsSync(skillDst)) rec("worker-skill", "OK", "existing skill kept (kit snapshot not overwritten)");
    else if (DRY) rec("worker-skill", "DRY", "would install bundled skill snapshot");
    else { fs.mkdirSync(path.dirname(skillDst), { recursive: true }); fs.symlinkSync(skillSrc, skillDst); rec("worker-skill", "INSTALLED", "bundled snapshot symlinked"); }
  }
}

// ---------- 5. auth detection (never writes credentials) ----------
const hasCreds = fs.existsSync(path.join(HOME, ".dsh", ".credentials.yaml")) || !!process.env.DEEPSEEK_API_KEY;
rec("auth", hasCreds ? "OK" : "MANUAL", hasCreds
  ? "credentials detected (values never read or printed)"
  : "run `dsh` once and sign in (account OAuth), or set DEEPSEEK_API_KEY — then re-run");

// ---------- 6. profile assembly (Gate 1) ----------
if (DRY) rec("assemble", "DRY", "would run dsh-assemble (idempotent profile patches, backups kept)");
else {
  const r = run(process.execPath, [path.join(KIT, "dsh-task", "bin", "dsh-assemble.mjs")]);
  process.stdout.write(r.stdout ?? "");
  rec("assemble", r.status === 0 ? "OK" : "MANUAL", r.status === 0 ? "profiles ready" : "see assemble output above (fresh machine: run `dsh` once first, then re-run)");
}

// ---------- 7. Zed registration ----------
const zedSettings = (() => {
  const i = argv.indexOf("--zed-settings");
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(HOME, ".config", "zed", "settings.json");
})();
function stripJsonc(text) {
  let out = "", i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) { out += c; if (c === "\\") { out += text[i + 1] ?? ""; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,\s*([}\]])/g, "$1"); // trailing commas are legal JSONC
}
if (!fs.existsSync(zedSettings)) rec("zed", "MANUAL", "Zed settings.json not found — install Zed, open it once, then re-run with --with-zed");
else {
  const txt = fs.readFileSync(zedSettings, "utf8");
  const registered = /"DeepSeek Harness"\s*:/.test(txt) && /dsh-(acp-server|worker)/.test(txt);
  if (registered) rec("zed", "OK", "DeepSeek Harness agent already registered (not modified)");
  else if (!WITH_ZED) rec("zed", "MANUAL", 'not registered — re-run with --with-zed for a backed-up JSONC-safe edit, or add agent_servers["DeepSeek Harness"] manually');
  else if (DRY) rec("zed", "DRY", "would insert agent_servers entry (backup + verify + auto-restore)");
  else {
    const entry = `"DeepSeek Harness": {\n      "type": "custom",\n      "command": ${JSON.stringify(path.join(binDir, "dsh-worker"))},\n      "args": [],\n      "env": {}\n    }`;
    const bak = zedSettings + `.bak-install-${Date.now()}`;
    fs.copyFileSync(zedSettings, bak);
    let next;
    const m = txt.match(/"agent_servers"\s*:\s*\{/);
    if (m) next = txt.slice(0, m.index + m[0].length) + "\n    " + entry + "," + txt.slice(m.index + m[0].length);
    else {
      const root = txt.indexOf("{");
      next = txt.slice(0, root + 1) + `\n  "agent_servers": {\n    ${entry}\n  },` + txt.slice(root + 1);
    }
    let ok = false;
    try {
      const j = JSON.parse(stripJsonc(next));
      ok = j?.agent_servers?.["DeepSeek Harness"]?.command === path.join(binDir, "dsh-worker");
    } catch {}
    if (ok) { fs.writeFileSync(zedSettings, next); rec("zed", "INSTALLED", `entry added; backup ${path.basename(bak)}; restart Zed to load it`); }
    else { rec("zed", "FAIL", "post-edit parse verification failed — original restored, nothing changed"); }
  }
}

// ---------- 8. verification ----------
if (!DRY) {
  const doctorArgs = [path.join(KIT, "dsh-task", "bin", "dsh-doctor.mjs"), ...(VERIFY ? [] : ["--skip-auth"])];
  const r = run(process.execPath, doctorArgs, { timeout: 240000 });
  const tail = (r.stdout ?? "").trim().split("\n").slice(-2).join(" | ");
  rec("doctor", r.status === 0 ? "OK" : "MANUAL", `${VERIFY ? "full" : "--skip-auth"}: ${tail}`);
  if (VERIFY) {
    const s = run(process.execPath, [path.join(KIT, "calibration", "bin", "calibrate.mjs"), "smoke"], { timeout: 400000 });
    const line = (s.stdout ?? "").split("\n").find((l) => l.startsWith("smoke:")) ?? "";
    rec("smoke", s.status === 0 ? "OK" : "FAIL", line || "smoke produced no summary");
  }
}

finish();
function finish() {
  const fails = results.filter((r) => r.status === "FAIL");
  const manual = results.filter((r) => r.status === "MANUAL");
  console.log(DRY ? "\ninstall --dry-run complete (nothing written)" : "\ninstall complete (idempotent — safe to re-run)");
  if (manual.length) { console.log("Next steps (manual by design):"); for (const r of manual) console.log(`  - ${r.step}: ${r.detail}`); }
  if (fails.length) { console.log(`${fails.length} step(s) FAILED`); process.exit(1); }
  process.exit(0);
}
