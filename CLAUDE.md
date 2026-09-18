# Claude Code Project Instructions

<!-- graphite:managed version=14 -->
## Shared Graphite Instructions

Graphite-first is required in this repo. Follow `GRAPHITE.md` before making non-trivial code changes: for cross-file questions (who-calls, where-defined, impact, data flow, structure) run the Graphite commands first; grep/glob are for literal text and filename lookups only. Fall back to manual search only after a Graphite answer proved insufficient, and say so. Use the existing `graph-out/graph.json` as the shared project graph, and do not edit `graph-out/` manually.

**Stay inside this repository.** Do not read, write, or run commands in any other repo, including its graph. Findings about another repo go to its agent as a recommendation through the shared `.agent-channel/` (see its `PROTOCOL.md`); that agent decides and acts. A tool doing its designed job is a separate question from an agent's boundary. See `GRAPHITE.md` section "Repository Isolation".
<!-- graphite:managed-end -->

## The worker is the system (do NOT use the Python scripts app for operations)

**This worker is the ONLY thing that performs operational Shopify Admin API work** for Active Paw (reading/writing products, articles, inventory, discounts, orders, and every feature). It holds the proper scopes, the in-system gating, and the vault-sealed token, and it is the production Shopify integration.

The `demo-store2` Python scripts app (`shopify_admin.py`, the client-credentials app with client id `f00b61bc465d4be0f48e67a594d784fb`) is a dev-era one-off tool and is **NOT to be used for operational or feature work**. Specifically, never:

- propose adding scopes to the scripts app,
- call the Admin API via `shopify_admin.py` to read or write store data for a feature,
- reach for the scripts app as a shortcut because a worker route is session-authed and "can't be called from the shell."

If a task needs Shopify Admin API access, **build or extend a capability in the worker** (a route, a console action, or a job stage) using the worker's own scoped token. The shell constraint (session-authed routes) is a design problem to solve inside the system (owner-triggered console action, or verify via the worker's own D1 with `wrangler d1 execute`), never a reason to fall back to the scripts app. Direct D1 reads via `wrangler` (inspecting the worker's own database) and storefront `curl` checks are fine; the scripts app's Admin API is not.

The owner has stated this repeatedly. Treat it as a firm, general rule.

## Knowledge graph: graphite only

graphite is the default and only code-graph tool in this repo. For any
graph or codebase-map request ("update the graph", "what calls X", "trace the
data flow"), use graphite: `python -P -m graphite build .` to rebuild,
`python -P -m graphite query "stats"` to inspect. See `GRAPHITE.md` for the
full workflow.

No other code-graph tool is used here. Do not install, enable or invoke one:
graphite is the sole owner of `graph-out/`, and its hooks in the committed
`.claude/settings.json` rebuild the graph on every turn. graphite itself is an
installed package, not part of this repository; `GRAPHITE.md` is the
reference.

<!-- aramid:begin -- managed by `aramid init`; hand-edits inside the fence are overwritten -->
## Aramid (security & quality gate)

This repo is gated by aramid. Read `ARAMID.md` before your first commit.

- Before committing: run `aramid check --staged`. Read findings with
  `aramid ledger filter --status open`.
- NEVER pass `--no-verify` (or `-n`) to `git commit`, or `--no-verify` to
  `git push` -- it disables secret scanning along with everything else.
  Armed repos reject the call outright.
- To suppress a WARN finding, use `aramid override <id> --reason "..."`
  (ledger-logged); never edit findings away by hand.
<!-- aramid:end -->
