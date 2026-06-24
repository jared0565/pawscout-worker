# Pawscout Worker Agent Notes

## Shared Graphite Instructions

Follow `GRAPHITE.md` before making non-trivial code changes. Use it as the shared Graphite workflow for Codex, Claude Code, Antigravity, Visual Studio, and other coding agents working in this repo.

## Graphite Codebase Map

Before multi-file refactors, dependency questions, or architecture changes, consult `graph-out/GRAPH_REPORT.md` and `graph-out/graph.json` when present.

## Automatic Graphite Consult

For any non-trivial code change, run Graphite before broad file reads or edits:

```bash
graphite check .
graphite context <likely-changed-file>
graphite impact <likely-changed-file>
graphite query "stats"
```

Use `graphite context` first when the likely target file is known. Treat its output as a dependency map, not as proof of correctness: still read the relevant source files and tests before editing. If `graphite check .` reports stale output, rebuild before relying on context or impact data.

If the graph is missing or stale, rebuild it from the repository root with:

```bash
graphite -v build .
```

During active multi-file development, keep the graph current with:

```bash
graphite watch . --impact
```

Graphite is installed centrally at `F:\Projects\_tools\graphite`, runs locally by default, and should not use LLM or network calls unless explicitly configured.

For TypeScript, Graphite uses the local TypeScript compiler resolver automatically when available. If a project has a broken TypeScript setup, fall back with `graphite --typescript-resolver disabled build .`.
