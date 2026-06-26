#!/usr/bin/env python
"""PreToolUse hook: block the graphify skill in this repo.

graphite owns the code graph here (see GRAPHITE.md). graphify is disabled to
avoid a graph-tool collision: both can trigger on "update the graph" or a
codebase question, and graphite is the project's chosen tool.

This hook is a backstop. The primary block is the skillOverrides "off" entry
in .claude/settings.json, which removes graphify from the model's skill list
and disables the /graphify command. This hook hard-denies the Skill tool call
if graphify is ever attempted anyway, and redirects to graphite.

Fail-open on any error: never break unrelated Skill calls.
"""
import json
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if data.get("tool_name") != "Skill":
    sys.exit(0)

skill = str((data.get("tool_input") or {}).get("skill", "")).strip().lower()
if skill in ("graphify", "graphifyy"):
    reason = (
        "graphify is disabled in this repo. graphite owns the code graph here "
        "(graph-out/). Use graphite instead: run `python -m graphite build .` to "
        'rebuild the graph, or `python -m graphite query "stats"` to inspect it. '
        "See GRAPHITE.md."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))

sys.exit(0)
