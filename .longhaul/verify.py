#!/usr/bin/env python3
"""
verify.py - the executing verifier for a longhaul run.

Runs the commands in .longhaul/checks.json, writes evidence the goal evaluator can read,
and (in --stop-hook mode) refuses to let a turn end while a required check is failing.

This exists because goal evaluators judge the transcript, not the repo. An agent can say
the tests passed. It cannot write this file without the tests having actually run.

Usage:
    python verify.py                          # run checks, print report, write evidence
    python verify.py --stop-hook              # Stop hook mode, reads hook JSON on stdin
    python verify.py --only unit,types        # run a subset by id
    python verify.py --manifest path.json     # alternate manifest (e.g. checkpoint-only)

Stop hook exit codes:
    0  turn may end (all required checks pass, or escalation threshold reached)
    2  turn blocked, stderr is handed to the agent as the reason

Register in settings.json:
    {"hooks": {"Stop": [{"hooks": [
        {"type": "command", "command": "python .longhaul/verify.py --stop-hook"}
    ]}]}}
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

DEFAULT_DIR = ".longhaul"
DEFAULT_MANIFEST = os.path.join(DEFAULT_DIR, "checks.json")
EVIDENCE_JSON = os.path.join(DEFAULT_DIR, "evidence.json")
EVIDENCE_MD = os.path.join(DEFAULT_DIR, "EVIDENCE.md")
STREAK_FILE = os.path.join(DEFAULT_DIR, ".streak.json")

# Consecutive identical failures before the hook stops blocking and escalates instead.
# Kept below Claude Code's cap on consecutive Stop-hook blocks so escalation is ours,
# not the harness cutting us off mid-thought.
ESCALATE_AFTER = 5

TAIL_CHARS = 2500


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_manifest(path):
    if not os.path.isfile(path):
        return None, f"no manifest at {path}"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except ValueError as e:
        return None, f"manifest is not valid JSON: {e}"
    if not isinstance(data.get("checks"), list) or not data["checks"]:
        return None, "manifest has no checks"
    return data, None


def tail(text, limit=TAIL_CHARS):
    text = text.strip()
    if len(text) <= limit:
        return text
    return "...(truncated)...\n" + text[-limit:]


def run_check(check):
    cid = check.get("id", "unnamed")
    cmd = check.get("cmd")
    if not cmd:
        return {
            "id": cid, "status": "error", "exit_code": None,
            "criteria": check.get("criteria", []),
            "required": bool(check.get("required", True)),
            "output": "check has no cmd", "duration_s": 0.0,
        }

    cwd = check.get("cwd") or "."
    timeout = int(check.get("timeout", 600))
    start = time.time()
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
        )
        out = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        status = "pass" if proc.returncode == 0 else "fail"
        code = proc.returncode
    except subprocess.TimeoutExpired:
        out = f"timed out after {timeout}s"
        status = "fail"
        code = None
    except OSError as e:
        out = f"could not run: {e}"
        status = "error"
        code = None

    return {
        "id": cid,
        "status": status,
        "exit_code": code,
        "criteria": check.get("criteria", []),
        "required": bool(check.get("required", True)),
        "cmd": cmd,
        "output": tail(out),
        "duration_s": round(time.time() - start, 1),
    }


def criteria_rollup(results):
    """Per acceptance criterion: met only if every required check claiming it passed."""
    rollup = {}
    for r in results:
        for c in r["criteria"]:
            entry = rollup.setdefault(c, {"checks": [], "met": True})
            entry["checks"].append(r["id"])
            if r["required"] and r["status"] != "pass":
                entry["met"] = False
    return rollup


def write_evidence(manifest_path, results, rollup):
    os.makedirs(DEFAULT_DIR, exist_ok=True)
    required = [r for r in results if r["required"]]
    failing = [r for r in required if r["status"] != "pass"]

    payload = {
        "generated_at": now(),
        "manifest": manifest_path,
        "all_required_passing": not failing,
        "summary": {
            "total": len(results),
            "passed": sum(1 for r in results if r["status"] == "pass"),
            "failed": sum(1 for r in results if r["status"] == "fail"),
            "errored": sum(1 for r in results if r["status"] == "error"),
            "required_failing": [r["id"] for r in failing],
        },
        "criteria": rollup,
        "checks": results,
    }
    with open(EVIDENCE_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    lines = [
        "# Verification evidence",
        "",
        f"Generated: {payload['generated_at']}",
        f"All required checks passing: **{payload['all_required_passing']}**",
        "",
        "| check | required | status | exit | seconds | criteria |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        lines.append(
            f"| {r['id']} | {'yes' if r['required'] else 'no'} | {r['status']} | "
            f"{r['exit_code']} | {r['duration_s']} | {', '.join(r['criteria']) or '-'} |"
        )
    if rollup:
        lines += ["", "## Criteria", ""]
        for c in sorted(rollup):
            state = "met" if rollup[c]["met"] else "NOT MET"
            lines.append(f"- **{c}**: {state} (checks: {', '.join(rollup[c]['checks'])})")
    if failing:
        lines += ["", "## Failing required checks", ""]
        for r in failing:
            lines += [f"### {r['id']}", "", "```", r["output"] or "(no output)", "```", ""]
    with open(EVIDENCE_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    return payload


def read_streak():
    try:
        with open(STREAK_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"signature": None, "count": 0}


def write_streak(sig, count):
    os.makedirs(DEFAULT_DIR, exist_ok=True)
    try:
        with open(STREAK_FILE, "w", encoding="utf-8") as f:
            json.dump({"signature": sig, "count": count}, f)
    except OSError:
        pass


def print_report(payload):
    s = payload["summary"]
    print(f"\nVERIFY  {payload['generated_at']}")
    print("=" * 60)
    for r in payload["checks"]:
        mark = {"pass": "ok  ", "fail": "FAIL", "error": "ERR "}[r["status"]]
        req = "req" if r["required"] else "   "
        print(f"  {mark} {req}  {r['id']:<20} {r['duration_s']:>6}s")
    print(f"\n  {s['passed']} passed, {s['failed']} failed, {s['errored']} errored")
    if payload["criteria"]:
        unmet = [c for c, v in payload["criteria"].items() if not v["met"]]
        print(f"  criteria met: {len(payload['criteria']) - len(unmet)}"
              f"/{len(payload['criteria'])}")
        if unmet:
            print(f"  unmet: {', '.join(sorted(unmet))}")
    print(f"\n  evidence: {EVIDENCE_JSON} and {EVIDENCE_MD}\n")


def stop_hook(payload, hook_input):
    """Block the turn while required checks fail, until the failure stops changing."""
    # Honor the harness's own re-entry flag or the hook jams shut forever.
    if str(hook_input.get("stop_hook_active", "")).lower() == "true":
        return 0

    failing = payload["summary"]["required_failing"]
    if not failing:
        write_streak(None, 0)
        return 0

    signature = "|".join(sorted(failing))
    prev = read_streak()
    count = prev["count"] + 1 if prev.get("signature") == signature else 1
    write_streak(signature, count)

    if count >= ESCALATE_AFTER:
        sys.stderr.write(
            f"Verification has failed identically {count} turns in a row: {signature}. "
            "This is spinning, not iterating. Stop and write the finding to "
            f"{DEFAULT_DIR}/AMENDMENTS.md as a proposed amendment, then wait for a human. "
            "Do not retry the same approach again.\n"
        )
        # Exit 0 so the turn can end and a human sees it. Blocking further would
        # burn through the harness's consecutive-block cap and lose the message.
        return 0

    details = []
    for r in payload["checks"]:
        if r["id"] in failing:
            details.append(f"[{r['id']}] exit={r['exit_code']}\n{r['output']}")
    sys.stderr.write(
        "Required verification checks are failing, so the work is not done. "
        f"Attempt {count} of {ESCALATE_AFTER} on this failure.\n\n"
        + "\n\n".join(details)
        + f"\n\nFull evidence: {EVIDENCE_MD}. Fix the cause rather than the check. "
        "Editing tests, assertions, fixtures, or checks.json to make this pass is "
        "reported as a shortcut by the spec critic.\n"
    )
    return 2


def main():
    ap = argparse.ArgumentParser(description="Executing verifier for longhaul runs.")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--stop-hook", action="store_true", help="Stop hook mode")
    ap.add_argument("--only", help="comma-separated check ids to run")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    hook_input = {}
    if args.stop_hook and not sys.stdin.isatty():
        raw = sys.stdin.read()
        if raw.strip():
            try:
                hook_input = json.loads(raw)
            except ValueError:
                hook_input = {}

    manifest, err = load_manifest(args.manifest)
    if err:
        # A missing or broken manifest must never silently allow a turn to end,
        # but it also must not block forever on a config error.
        sys.stderr.write(f"verify: {err}\n")
        return 0 if args.stop_hook else 1

    checks = manifest["checks"]
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        checks = [c for c in checks if c.get("id") in wanted]
        if not checks:
            sys.stderr.write(f"verify: no checks matched {sorted(wanted)}\n")
            return 1

    results = [run_check(c) for c in checks]
    payload = write_evidence(args.manifest, results, criteria_rollup(results))

    if args.stop_hook:
        return stop_hook(payload, hook_input)

    if not args.quiet:
        print_report(payload)
    return 0 if payload["all_required_passing"] else 1


if __name__ == "__main__":
    sys.exit(main())
