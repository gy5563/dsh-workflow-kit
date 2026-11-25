#!/usr/bin/env node
// golden-setup — build the Phase C golden task fixtures (spec §1.3).
// Synthetic repos only; never touches real projects. Idempotent: recreates
// each fixture and re-tags the baseline. PTC note: dsh 0.2.2-rc.5 exposes no
// "PTC mode" in the CLI — the batch-migration task uses plain headless dispatch
// (recorded in docs/FIDELITY.md).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const G = path.join(ROOT, "golden");
fs.mkdirSync(G, { recursive: true });

function git(cwd, ...a) {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout;
}
function repo(name, files) {
  const dir = path.join(G, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=golden", "-c", "user.email=golden@local", "commit", "-q", "-m", "golden baseline");
  git(dir, "tag", "-f", "golden-base");
  return dir;
}

// 1. minimal fix — one-line bug, one test file
repo("minimal-fix", {
  "calc.js": `export function add(a, b) {\n  return a - b; // BUG: should be a + b\n}\n`,
  "test/calc.test.mjs": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../calc.js";\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-1, 1), 0);\n});\n`,
  "package.json": `{"name":"minimal-fix","type":"module","private":true}\n`,
});

// 2. standard feature — implement slugify against 3 tests
repo("feature", {
  "src/stringutil.js": `export function slugify(s) {\n  throw new Error("not implemented");\n}\n`,
  "test/stringutil.test.mjs": `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { slugify } from "../src/stringutil.js";\ntest("lowercases and dashes spaces", () => assert.equal(slugify("Hello World"), "hello-world"));\ntest("strips punctuation", () => assert.equal(slugify("What's up?!"), "whats-up"));\ntest("trims and collapses dashes", () => assert.equal(slugify("  a -- b  "), "a-b"));\n`,
  "package.json": `{"name":"feature","type":"module","private":true}\n`,
});

// 3. batch migration — N files, same mechanical rename; sizes 1/3/6
for (const n of [1, 3, 6]) {
  const files = { "package.json": `{"name":"batch-${n}","type":"module","private":true}\n` };
  for (let i = 0; i < n; i++) {
    files[`src/mod${i}.js`] = `export function legacyName() {\n  return "old";\n}\n`;
    files[`test/mod${i}.test.mjs`] = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { modernName } from "../src/mod${i}.js";\ntest("mod${i} migrated", () => assert.equal(modernName(), "new"));\n`;
  }
  repo(`batch-${n}`, files);
}

// 4. two-round resume — round 1 creates partial work (no commit), round 2 finishes
repo("resume", {
  "package.json": `{"name":"resume","type":"module","private":true}\n`,
  "README.md": `# Store\n\nTwo-round task: round 1 creates src/store.js with set(); round 2 adds get() + tests.\n`,
});

console.log("golden fixtures ready:", fs.readdirSync(G).join(", "));