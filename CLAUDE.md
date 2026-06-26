# Pawscout Worker Claude Notes

Follow `GRAPHITE.md` before making non-trivial code changes. Use the existing `graph-out/graph.json` as the shared project graph, and do not edit `graph-out/` manually.

## Knowledge graph: graphite only

graphite is the default and only code-graph tool in this repo. For any
graph or codebase-map request ("update the graph", "what calls X", "trace the
data flow"), use graphite: `python -m graphite build .` to rebuild,
`python -m graphite query "stats"` to inspect. See `GRAPHITE.md` for the full
workflow.

The graphify skill is intentionally disabled to avoid a graph-tool collision
(both trigger on the same phrasing). It is blocked machine-wide via
`skillOverrides.graphify: "off"` in `~/.claude/settings.json`, and this repo
also carries a committed `.claude/settings.json` with the same override so the
policy travels with the repo. Do not re-enable graphify here.

