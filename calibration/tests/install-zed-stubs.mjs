// Fixture test for install.mjs Zed JSONC insertion (fresh-machine path).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const KIT = path.join(os.homedir(), "projects", "dsh-workflow-kit");
const tmp = fs.mkdtempSync(path.join(os.homedir(), ".hermes", "cache", "scratch", "zed-install-test-"));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

const f1 = path.join(tmp, "with-agent-servers.json");
fs.writeFileSync(f1, `// Zed settings (JSONC)
{
  "theme": "One Dark", // inline comment
  "agent_servers": {
    "Hermes Agent": {
      "type": "custom",
      "command": "/x/hermes",
      "args": ["acp"],
    },
  },
  /* block
     comment */
  "autosave": "on_focus_change",
}
`);
const f2 = path.join(tmp, "no-agent-servers.json");
fs.writeFileSync(f2, `{\n  "theme": "One Dark"\n}\n`);

for (const [name, f] of [["existing agent_servers", f1], ["no agent_servers", f2]]) {
  const before = fs.readFileSync(f, "utf8");
  const r = spawnSync(process.execPath, [path.join(KIT, "install.mjs"), "--with-zed", "--zed-settings", f], { encoding: "utf8", timeout: 240000 });
  const zedLine = (r.stdout ?? "").split("\n").find((l) => l.includes("] zed —")) ?? "";
  check(`${name}: installer exit 0`, r.status === 0, zedLine);
  const after = fs.readFileSync(f, "utf8");
  check(`${name}: entry inserted`, /"DeepSeek Harness"\s*:/.test(after) && after.includes("dsh-worker"));
  check(`${name}: Hermes Agent preserved`, !before.includes("Hermes Agent") || after.includes("Hermes Agent"));
  check(`${name}: comments preserved`, !before.includes("//") || after.includes("// Zed settings"));
  const baks = fs.readdirSync(tmp).filter((x) => x.startsWith(path.basename(f) + ".bak-install-"));
  check(`${name}: backup kept`, baks.length === 1);
  // idempotence: second run must not change the file
  const r2 = spawnSync(process.execPath, [path.join(KIT, "install.mjs"), "--with-zed", "--zed-settings", f], { encoding: "utf8", timeout: 240000 });
  check(`${name}: re-run no-op`, r2.status === 0 && fs.readFileSync(f, "utf8") === after);
}
console.log(`${pass} passed, ${fail} failed; fixtures: ${tmp}`);
process.exit(fail ? 1 : 0);
