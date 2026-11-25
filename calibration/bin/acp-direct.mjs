#!/usr/bin/env node
// acp-direct — minimal ACP client for the economic comparison (spec §1.4).
// Drives dsh-acp-server (via dsh-worker) directly: initialize → session/new →
// session/prompt, auto-answering permission requests. No wrapper, no gates.
// Usage: node acp-direct.mjs --cwd <repo> --goal <text> [--out <dir>] [--timeout-ms N]
// Writes acp-events.jsonl + acp-result.json under --out.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cwd = get("--cwd"); const goal = get("--goal");
const outDir = get("--out", fs.mkdtempSync(path.join(os.tmpdir(), "acp-")));
const timeoutMs = Number(get("--timeout-ms", "300000"));
if (!cwd || !goal) { console.error("usage: acp-direct --cwd <repo> --goal <text>"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const BIN = process.env.DSH_ACP_BIN || path.join(os.homedir(), ".local/bin/dsh-worker");
const child = spawn(BIN, [], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: `${os.homedir()}/.local/bin:/usr/local/bin:${process.env.PATH}` } });
const events = [];
const pending = new Map();
let nextId = 1, sessionId = null, promptDone = false, usage = null, stopReason = null;
const t0 = Date.now();

function send(method, params, isNotification = false) {
  const msg = { jsonrpc: "2.0", method, params };
  if (!isNotification) { msg.id = nextId++; }
  child.stdin.write(JSON.stringify(msg) + "\n");
  return msg.id;
}
function respond(id, result) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function findUsage(o) {
  if (!o || typeof o !== "object") return null;
  if (typeof o.inputTokens === "number" || typeof o.outputTokens === "number") return o;
  for (const v of Object.values(o)) { const r = findUsage(v); if (r) return r; }
  return null;
}

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    events.push(m);
    if (m.id !== undefined && m.method) {
      // server → client request
      if (m.method === "session/request_permission") {
        const opts = m.params?.options ?? [];
        const pick = opts.find((o) => o.kind === "allow_always") ?? opts.find((o) => String(o.kind).startsWith("allow")) ?? opts[0];
        respond(m.id, { outcome: { outcome: "selected", optionId: pick?.optionId } });
      } else {
        respond(m.id, {}); // fs/terminal capabilities were declared false
      }
    } else if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m); pending.delete(m.id);
    } else if (m.method === "session/update") {
      const u = findUsage(m.params);
      if (u) usage = { ...(usage ?? {}), ...u };
    }
  }
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = send(method, params);
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, timeoutMs);
  });
}

const timer = setTimeout(() => { console.error("acp-direct: global timeout"); finish("timeout"); }, timeoutMs + 30000);
function finish(reason) {
  clearTimeout(timer);
  const wallMs = Date.now() - t0;
  const result = { path: "acp-direct", wallMs, stopReason: stopReason ?? reason, sessionId, usage, eventCount: events.length, at: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir, "acp-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "acp-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "acp-stderr.txt"), stderr.slice(-4000));
  console.log(JSON.stringify(result));
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(reason === "end_turn" || reason === "completed" ? 0 : 1), 300);
}

(async () => {
  try {
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (init.error) throw new Error("initialize: " + JSON.stringify(init.error));
    const sess = await rpc("session/new", { cwd, mcpServers: [] });
    if (sess.error) throw new Error("session/new: " + JSON.stringify(sess.error));
    sessionId = sess.result?.sessionId;
    const pr = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: goal }] });
    if (pr.error) throw new Error("session/prompt: " + JSON.stringify(pr.error));
    stopReason = pr.result?.stopReason;
    const u = findUsage(pr.result); if (u) usage = { ...(usage ?? {}), ...u };
    promptDone = true;
    finish(stopReason ?? "no-stop-reason");
  } catch (e) {
    console.error("acp-direct error:", e.message);
    finish("error");
  }
})();