# Pawscout Worker Claude Notes

Follow `GRAPHITE.md` before making non-trivial code changes. Use the existing `graph-out/graph.json` as the shared project graph, and do not edit `graph-out/` manually.

## Knowledge graph: graphite only

graphite is the default and only code-graph tool in this repo. For any
graph or codebase-map request ("update the graph", "what calls X", "trace the
data flow"), use graphite: `python -m graphite build .` to rebuild,
`python -m graphite query "stats"` to inspect. See `GRAPHITE.md` for the full
workflow.

The graphify skill is intentionally disabled here to avoid a graph-tool
collision (both trigger on the same phrasing, and they write to different dirs:
graphite -> `graph-out/`, graphify -> `graphify-out/`). The block is enforced
by `.claude/settings.json` (`skillOverrides.graphify: "off"` removes it from the
skill list and disables `/graphify`) plus a PreToolUse backstop hook at
`.claude/hooks/block-graphify.py`. Do not re-enable graphify in this repo.

