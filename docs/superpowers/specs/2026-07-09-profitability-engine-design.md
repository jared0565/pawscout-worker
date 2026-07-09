# Profitability Engine + Import Gate + Audit Agent — DESIGN (DRAFT)

**Status:** DRAFT, mid-brainstorm. Architecture presented to owner 2026-07-09; owner had not yet approved when the session compacted. Resume by confirming the architecture below (and the two open decisions), then finalize this spec → `writing-plans` → build. Do NOT start implementation until the owner approves.

## Goal
When PawScout adds a product to inventory, it must already be vetted to create **real net profit** — so the class of "discover an unprofitable item later" never happens. Same logic, run continuously over the existing catalog, is the audit agent. (Owner's words: an agent "auditing all possible weaknesses and strengths of a product ... making sure the product is there to create real net profit.")

## Locked decisions (owner-approved this session)
1. **Profit criterion = net-after-ads floor AND a competition check.** The pricing rule already guarantees ~£6 gross margin/unit and the 2.2x multiplier is sized for ads ≈ 33% of revenue (ROAS ~3), so most products already net positive at rule — EXCEPT high cost+freight items where the £30 margin cap doesn't survive ads (the £112 auto-feeder class). The gate must catch those AND the "can't beat competitors so it won't sell" case.
2. **Competitor-price signal = LLM + web search** (reuses the worker's existing OpenRouter web-search grounding). No new paid API. Per-call cost + latency; estimate quality varies → only HARD-block on high-confidence signals, draft-for-review otherwise. Cache results in D1 (per cj_pid, TTL).

## Architecture: one shared engine, two consumers
### Profitability engine (new, e.g. `src/profitability.ts`)
- `netAfterAdsGbp(cost, freight, cfg)` — DETERMINISTIC. At the product's rule price (retailPriceGbp): ex-VAT revenue − landed COGS − freight − platform fee − ad cost (revenue × ad-share). Returns £/unit + %. No LLM. Reuses the pricing.ts rule + affiliate-floor-style math.
- `competitorSignal(product, llm)` — LLM + web-search → `{ estimateGbp, confidence, sources }`. Cached in D1 (per cj_pid, TTL) to avoid re-querying every run.
- `profitVerdict(...)` → `PASS | REVIEW | REJECT` + reason, combining both.

### Consumer A — import gate (preventive)
Wire `profitVerdict` into `confirmAndImport`'s gate chain (chain today = isLikelyPetProduct / curate / curateDetailImages / cj.stockByPid / importProduct — NO profit gate; confirmed via `graphite query "calls confirmAndImport"`). REJECT → don't import (link ends `rejected`, logged w/ reason). REVIEW → import as draft (as today) tagged w/ verdict+reason. PASS → normal.

### Consumer B — audit agent (continuous)
Nightly rolling stage (like `store-inventory`, which does 60/night) + on-demand console action; runs `profitVerdict` over the existing catalog, writes a verdict/reason per product, surfaces a "Profitability" console view. Clear losers FLAGGED for owner review; archive-with-reason on owner confirm (never auto-delete — competition-aware-catalog policy).

## Guardrails
- Hard-block ONLY on the deterministic net-after-ads floor + high-confidence competition loss. Everything uncertain → REVIEW (draft/flag), never silent auto-reject/auto-archive.
- Config (net-after-ads floor, ad-share/ROAS, competition margin, confidence thresholds) in `tenant_config`.
- LLM calls cached + rate-aware for cost.

## Open decisions (raise on resume, before finalizing spec)
- Fail behavior: hard-block vs always-draft-for-review (recommended: hard-block only on deterministic floor + high-confidence competition; else draft).
- Audit action on fail: flag-for-review vs auto-archive (recommended: flag, owner confirms).
- Exact config values (floor £/%, ad-share, competition margin, confidence thresholds).
- Verify confirmAndImport's exact reject mechanics + where to insert the gate (read the code during spec finalize; use `graphite context src/proxy/import.ts`).

## Sequence context
This is Piece 2 (+3) of a 3-piece request. Piece 1 (Graphite call-graph fix: callers/calls/reaches verbs, function-level + cross-file) is DONE, verified, deployed-in-editable-install. Pieces 2+3 converged into this one engine.
