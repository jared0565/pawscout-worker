#!/usr/bin/env python
"""UserPromptSubmit hook: prints a per-turn reminder to consult the Graphite code
graph BEFORE shared-logic edits. Claude Code injects this stdout into the agent's
context each turn (UserPromptSubmit is one of the events whose stdout Claude sees).

Kept to a pure stdlib print - no graphite import, no subprocess - so it is instant
and can never fail (a crashing hook must never block the turn). Freshness is handled
separately by the Stop hook, which rebuilds the graph after every response.
"""
import sys

REMINDER = (
    "[GRAPHITE] This repo's code graph auto-rebuilds every turn (Stop hook), so it is "
    "fresh. Before editing any SHARED or core source file - a function with many "
    "callers, an API, auth, persistence, or data flow - FIRST run "
    "`python -m graphite context <file>` and `python -m graphite impact <file>`, then "
    "read the call sites it names. For 'who calls X / what does X call / does A reach B', use "
    "`python -m graphite query \"callers <fn>\"`, `query \"calls <fn>\"`, `query \"reaches <a> -> <b>\"` "
    "(function-level, cross-file) - do NOT grep for callers. Grep is not a substitute (GRAPHITE.md: "
    "impact before shared-logic changes, context before editing important files). "
    "graphite = `python -m graphite` (CLI not on PATH)."
)

print(REMINDER)
sys.exit(0)
