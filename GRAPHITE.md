# Graphite Development Context

Graphite is the shared local code graph for this project. Codex, Claude Code, Antigravity, Visual Studio, and other coding agents should use the same graph instead of rebuilding separate mental maps.

## Required Workflow

Before non-trivial code changes:

1. Run `graphite check .`
2. Run `graphite context <target-file>` before editing important files.
3. Run `graphite impact <target-file>` before changing shared logic, APIs, data flow, auth, persistence, or deployment behavior.
4. Use `graphite query "stats"` when project structure is unclear.
5. To trace data flow, use the call-graph verbs instead of grepping: `graphite query "callers <fn>"` (who calls it), `graphite query "calls <fn>"` (what it calls), `graphite query "reaches <a> -> <b>"` (is there a call path). These resolve at function granularity, cross-file. Caveat: static analysis only - dynamic dispatch (e.g. calling `x.run()` on an array of objects) is not linked, so `reaches` can return a false "no path" across such hops.

After edits:

1. Run `graphite build .`
2. Run relevant tests, typechecks, or validation commands.
3. Do not edit `graph-out/` manually.

## Operating Rules

- Treat Graphite as a project map, not as proof of correctness.
- Always read the source files and tests that Graphite identifies before changing behavior.
- If `graphite check .` reports stale output, rebuild before relying on context or impact data.
- Graphite runs locally and should not use LLM or network calls unless explicitly configured.
- For TypeScript resolver issues, use `graphite --typescript-resolver disabled build .` only as a fallback.

## LLM Enrichment (moved)

Graphite here is zero-LLM. Canonical commands (`scan`, `build`, `report`, `check`, `validate`) reject all `--llm*` flags. LLM enrichment now happens only through the operator-governed `graphite overlay build`, which requires verified provider/model identity digests and is not part of routine agent workflow. Keep daemon/watch builds zero-LLM.
