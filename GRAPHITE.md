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

## Optional LLM Enrichment

Graphite is zero-LLM by default. Use LLM enrichment only when a human explicitly wants AI-generated graph summaries in `graph-out/GRAPH_REPORT.md`.

Local examples:

```bash
graphite --llm local --llm-provider ollama --llm-model qwen2.5-coder report .
graphite --llm local --llm-provider lmstudio --llm-model local-model report .
```

Cloud or remote OpenAI-compatible example:

```bash
set GRAPHITE_LLM_API_KEY=<provider-key>
graphite --llm cloud --llm-provider openai-compatible --llm-base-url https://example.com/v1 --llm-model my-model report .
```

Intelligent auto mode:

```bash
graphite --llm auto --llm-provider openrouter report .
```

Auto mode keeps builds zero-LLM for small/simple graphs, skips cloud calls when credentials are missing, and uses LLM enrichment only when graph complexity/risk signals justify the extra cost. For OpenRouter, it defaults to `moonshotai/kimi-k2.7-code` when `--llm-model` is omitted.
OpenRouter examples:

```bash
set GRAPHITE_LLM_API_KEY=<openrouter-api-key>
graphite --llm cloud --llm-provider openrouter report .
graphite --llm cloud --llm-provider openrouter --llm-model "moonshotai/kimi-k2.7-code" report .
graphite --llm cloud --llm-provider openrouter --llm-model "~openai/gpt-latest" report .
```

Graphite automatically uses OpenRouter's OpenAI-compatible base URL. To use a specific OpenRouter model, replace `--llm-model` with a model slug from the OpenRouter model catalog.

Rules:

- Prefer local LLMs for sensitive or private codebases.
- Do not put API keys in committed files or shell history; prefer `GRAPHITE_LLM_API_KEY`.
- Keep daemon/watch builds zero-LLM unless explicitly requested.
- LLM enrichment sends bounded graph metadata and analysis summaries, not raw source code, but still treat external providers as third-party data processors.
