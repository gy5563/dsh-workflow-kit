"""dsh-dispatch — THIN Hermes plugin (spec Artifact 1).

Registers only: dispatch_dsh_task tool, /dsh-review command, on_session_end
reminder hook, a bounded prompt section, and the bundled dsh-dispatch skill.
ALL task logic (assembly, risk binding, lock pre-check, normalization, gates)
lives in dsh-workflow-kit/dsh-task/bin/dsh-task.mjs — this plugin never
reimplements it (spec 2.1: the plugin must not take on orchestration,
assembly, or output normalization).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger("hermes_cli.plugins")

PLUGIN_DIR = Path(__file__).resolve().parent
KIT = Path.home() / "projects" / "dsh-workflow-kit"
WRAPPER = KIT / "dsh-task" / "bin" / "dsh-task.mjs"


def _data_dir() -> Path:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    d = home / "plugin-data" / "dsh-dispatch"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _node() -> str:
    for cand in (shutil.which("node"), str(Path.home() / ".local/bin/node"), "/usr/local/bin/node"):
        if cand and Path(cand).exists():
            return cand
    return "node"


def _index_path() -> Path:
    return _data_dir() / "dispatches.jsonl"


def _read_index() -> list[dict]:
    p = _index_path()
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _append_index(entry: dict) -> None:
    with _index_path().open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _mark_reviewed(session_id: str) -> None:
    entries = _read_index()
    for e in entries:
        if e.get("sessionId") == session_id:
            e["reviewed"] = True
    _index_path().write_text("".join(json.dumps(e) + "\n" for e in entries))


def _pending_reviews() -> list[dict]:
    return [e for e in _read_index() if e.get("status") == "PASS" and not e.get("reviewed")]


# ── tool: dispatch_dsh_task ────────────────────────────────────────────────
def _dispatch(args=None, **kwargs) -> str:
    a = dict(args or {})
    a.update({k: v for k, v in kwargs.items() if k not in a})
    contract_path = a.get("task_contract_path")
    if not contract_path:
        return json.dumps({"success": False, "error": "task_contract_path is required"})
    cp = Path(str(contract_path)).expanduser()
    if not cp.exists():
        return json.dumps({"success": False, "error": f"contract not found: {cp}"})
    if not WRAPPER.exists():
        return json.dumps({"success": False, "error": f"wrapper missing: {WRAPPER} (clone dsh-workflow-kit)"})
    try:
        contract = json.loads(cp.read_text())
    except Exception as e:
        return json.dumps({"success": False, "error": f"contract is not valid JSON: {e}"})
    timeout_s = min(1500, max(60, int(contract.get("timeoutMs", 600000)) / 1000 + 120))
    cmd = [_node(), str(WRAPPER), "--contract", str(cp)]
    if a.get("allow_high_risk"):
        cmd.append("--allow-high-risk")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return json.dumps({"success": False, "error": f"wrapper exceeded {timeout_s}s", "exitCode": None})
    verdict_path = None
    for line in (proc.stdout or "").splitlines():
        if "verdict: " in line:
            verdict_path = line.split("verdict: ", 1)[1].strip()
    verdict = {}
    if verdict_path and Path(verdict_path).exists():
        try:
            verdict = json.loads(Path(verdict_path).read_text())
        except Exception:
            pass
    if not verdict:
        return json.dumps({"success": False, "error": "no verdict produced",
                           "exitCode": proc.returncode, "stderr": (proc.stderr or "")[-800:]})
    sid = verdict.get("sessionId")
    if sid:
        _append_index({"at": verdict.get("at"), "sessionId": sid, "contractPath": str(cp),
                       "verdictPath": verdict_path, "cwd": (verdict.get("contract") or {}).get("cwd"),
                       "status": verdict.get("status"), "reviewed": False})
    answer = ""
    ap = (verdict.get("artifacts") or {}).get("answerTxt")
    if ap and Path(ap).exists():
        answer = Path(ap).read_text()[:400]
    return json.dumps({
        "success": verdict.get("status") == "PASS",
        "exitCode": verdict.get("exitCode"), "status": verdict.get("status"),
        "failure": verdict.get("failure"), "sessionId": sid,
        "artifacts": verdict.get("artifacts"), "usage": verdict.get("usage"),
        "answerPreview": answer,
        "next": f"/dsh-review {sid}" if sid and verdict.get("status") == "PASS" else None,
    })


# ── command: /dsh-review (review only — NEVER fixes) ──────────────────────
def _review(raw_args: str) -> str:
    arg = (raw_args or "").strip()
    if not arg:
        pending = _pending_reviews()
        if not pending:
            return "dsh-review: nothing pending. Usage: /dsh-review <session_id | verdict.json path>"
        lines = ["Unreviewed dsh dispatches:"]
        lines += [f"- {e['sessionId']}  ({e.get('cwd')})  verdict: {e.get('verdictPath')}" for e in pending[-10:]]
        lines.append("Run /dsh-review <session_id> to review one. Review never modifies the repo.")
        return "\n".join(lines)
    verdict_path = None
    if arg.endswith(".json") and Path(arg).expanduser().exists():
        verdict_path = str(Path(arg).expanduser())
    else:
        matches = [e for e in _read_index() if e.get("sessionId") == arg]
        if matches:
            verdict_path = matches[-1].get("verdictPath")
    if not verdict_path or not Path(verdict_path).exists():
        return f"dsh-review: no verdict found for '{arg}'. Pass a session_id from dispatch or a verdict.json path."
    try:
        v = json.loads(Path(verdict_path).read_text())
    except Exception as e:
        return f"dsh-review: verdict unreadable: {e}"
    contract = v.get("contract") or {}
    cwd = contract.get("cwd")
    rows = []
    ok = True

    def gate(name, passed, detail):
        nonlocal ok
        ok = ok and passed
        rows.append(f"| {'✅' if passed else '❌'} | {name} | {detail} |")

    gate("dispatch verdict", v.get("status") == "PASS",
         f"status={v.get('status')} exit={v.get('exitCode')}" + (f" failure={v.get('failure', {}).get('code')}" if v.get("failure") else ""))
    # diff-scope gate
    changed = []
    base = v.get("gitBaseHead")
    if cwd and base and Path(cwd, ".git").exists():
        r = subprocess.run(["git", "-C", cwd, "diff", "--name-only", f"{base}..HEAD"],
                           capture_output=True, text=True, timeout=30)
        changed = [x for x in r.stdout.splitlines() if x]
        allowed = contract.get("allowedPaths") or []
        if allowed:
            bad = [f for f in changed if not any(f == a or f.startswith(a.rstrip("/") + "/") for a in allowed)]
            gate("diff scope ⊆ allowedPaths", not bad, f"{len(changed)} changed" + (f"; OUT OF SCOPE: {bad}" if bad else ""))
        else:
            gate("diff scope", True, f"{len(changed)} changed files (no allowedPaths declared)")
        uncommitted = subprocess.run(["git", "-C", cwd, "status", "--porcelain"], capture_output=True, text=True, timeout=30).stdout.strip()
        gate("no uncommitted leftovers", not uncommitted, uncommitted[:200] or "clean")
    else:
        gate("diff scope", True, "no git baseline recorded (read-only task)")
    # acceptance re-run (read-only review of the project's own gates)
    for cmd in contract.get("acceptance") or []:
        try:
            r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=180)
            gate(f"acceptance: {cmd[:60]}", r.returncode == 0, f"exit {r.returncode}")
        except subprocess.TimeoutExpired:
            gate(f"acceptance: {cmd[:60]}", False, "timeout 180s")
    if v.get("secretScan"):
        gate("secret scan", v["secretScan"].get("clean", False), str(v["secretScan"].get("hits", []))[:200])
    if v.get("sessionId"):
        _mark_reviewed(v["sessionId"])
    head = f"## dsh-review — {v.get('sessionId')}\n\n**{'PASS' if ok else 'FAIL'}** (review only; no changes made by this command)\n"
    table = "| | gate | detail |\n|---|---|---|\n" + "\n".join(rows)
    files = ("\n\nChanged files:\n" + "\n".join(f"- {f}" for f in changed)) if changed else ""
    return head + "\n" + table + files


def _session_end(**kwargs):
    try:
        pending = _pending_reviews()
        if pending:
            note = _data_dir() / "PENDING-REVIEWS.md"
            note.write_text("# Unreviewed dsh dispatches\n\n" + "\n".join(
                f"- {e['sessionId']} ({e.get('cwd')}) — /dsh-review {e['sessionId']}" for e in pending))
            logger.warning("dsh-dispatch: %d unreviewed dispatch(es); see %s", len(pending), note)
    except Exception as e:
        logger.debug("dsh-dispatch session-end reminder failed: %s", e)
    return None


def _prompt_section(session_info) -> str:
    try:
        pending = _pending_reviews()
        if pending:
            ids = ", ".join(e["sessionId"] for e in pending[-3:])
            return (f"dsh-dispatch: {len(pending)} completed dsh dispatch(es) await independent review "
                    f"({ids}). Run /dsh-review <session_id> before trusting or committing their output.")
    except Exception:
        pass
    return ""


def register(ctx):
    ctx.register_tool(
        name="dispatch_dsh_task",
        toolset="dsh_dispatch",
        schema={
            "name": "dispatch_dsh_task",
            "description": ("Dispatch a task to the DeepSeek Harness worker via the dsh-task wrapper. "
                            "Takes a task-contract JSON file path (goal, cwd, risk, acceptance, ...). "
                            "Returns a structured verdict; never trusts the worker's self-report. "
                            "After a PASS, review with /dsh-review <session_id>."),
            "parameters": {
                "type": "object",
                "properties": {
                    "task_contract_path": {"type": "string", "description": "Absolute path to the task-contract JSON file"},
                    "allow_high_risk": {"type": "boolean", "description": "Required to permit high-risk auto-commit (default false)"},
                },
                "required": ["task_contract_path"],
            },
        },
        handler=_dispatch,
        description="Dispatch a contract-driven task to the dsh worker (thin wrapper over dsh-task.mjs).",
        emoji="🛰️",
    )
    ctx.register_command(
        "dsh-review", handler=_review,
        description="Review a dsh dispatch verdict + diff scope + acceptance gates. Never performs fixes.",
        args_hint="<session_id | verdict.json path>",
    )
    ctx.register_hook("on_session_end", _session_end)
    ctx.register_system_prompt_section("dsh-dispatch-pending", _prompt_section, max_chars=400)
    skill = PLUGIN_DIR / "skills" / "dsh-dispatch" / "SKILL.md"
    if skill.exists():
        ctx.register_skill("dsh-dispatch", skill,
                           description="Use when dispatching coding tasks to the DeepSeek Harness worker: contract schema, risk binding, review flow.")