# Profitability Engine + Import Gate + Audit Agent — DESIGN

**Status:** APPROVED (owner said "finish everything end-to-end", 2026-07-09). Architecture below incorporates the advisor's activation-safety and correctness review. Build fully, ship **dormant** (`profit.enabled = false`), hand the owner the thresholds + the flips to activate.

## Goal

When PawScout adds a product to inventory it must already be vetted to create **real net profit** — so the class of "discover an unprofitable item later" never happens. The SAME logic, run continuously over the existing catalog, is the audit agent (owner's words: an agent "auditing all possible weaknesses and strengths of a product ... making sure the product is there to create real net profit").

## Locked decisions (owner-approved)

1. **Profit criterion = a deterministic net-after-ads floor AND a competition check.** The pricing rule already guarantees a gross margin (~£6 via the affiliate floor) and the live 2.2× multiplier is sized for ads ≈ 33% of revenue (ROAS ~3), so most products net positive at rule — EXCEPT high cost+freight items where the £30 margin cap does not survive ads (the ~£112 auto-feeder class). The gate must catch those AND the "can't beat competitors so it won't sell" case.
2. **Competitor-price signal = LLM + web search** (reuses the worker's existing OpenRouter web-search grounding, exactly as `blog/research.ts proposeTopics` does — try web, fall back hermetic). No new paid API. Estimate quality varies → only ever a SOFT signal; cache per `cj_pid` in `search_cache` (`comp:<pid>`, TTL).

## Activation safety (advisor-driven — the core of this design)

A new REJECT wired into all three `confirmAndImport` lanes and a new stage in the 04:17 cron must NOT change behaviour the moment it deploys. Follow the codebase's dormant-feature pattern (`RETENTION_REORDER` dormant, `gbFreeUkLive` verify-then-flip, `autoInvoice` off) and **separate observe from enforce** with two knobs:

| `profit.enabled` | `profit.hardBlock` | Behaviour |
|---|---|---|
| `false` (DEFAULT) | — | **Fully dormant.** No LLM spend. Import gate is a complete no-op (existing import tests unaffected). Audit stage skips. |
| `true` | `false` | **Observe + review.** Audit runs OBSERVE-ONLY: populates the Profitability console view, never archives. Import gate runs REVIEW mode: a sub-floor product imports as a DRAFT (never hard-rejected) tagged for review. |
| `true` | `true` | **Enforce.** Import gate hard-REJECTs a sub-floor product (deterministic floor only). Audit may RECOMMEND archive — still owner-confirm, never automatic. |

The owner flips `enabled` first, watches real verdicts in the console, tunes thresholds, then flips `hardBlock`. This is presented at the end of the build, not asked as a blocking question.

## Architecture: one shared engine, two consumers

### Profitability engine (`src/profitability.ts`, new)

- **`netAfterAdsGbp(landedUsd, freightUsd, pricing, profit)` — DETERMINISTIC, no LLM.** At the product's rule price (`retailPriceGbp`, computed from the **live** `cfg.pricing` passed in — never `DEFAULT_PRICING`):
  - `exVatRevenue = retail / (1 + vatRate)`
  - `cogs = landedCostGbp` (honest product + freight)
  - `adCost = adShareOfRevenue × retail` (0.33 × **gross** retail = the ROAS-3 ad spend; explicit gross base per advisor)
  - `paymentsFee = paymentsFeeRate × retail`; `refundReserve = refundReserveRate × exVatRevenue`
  - `net = exVatRevenue − cogs − adCost − paymentsFee − refundReserve`; `netPct = net / exVatRevenue`
  - Returns `{ retailGbp, cogsGbp, adCostGbp, netGbp, netPct }`.
- **`productNetAfterAds(variants, pricing, freightUsd, profit)`** — mirrors `productAffiliateEligible`'s variant policy: evaluates EVERY sellable variant and the product is judged on its **worst** one ("one thin variant disqualifies the whole product"). Returns the worst variant's `netGbp`/`netPct` + a `belowFloor` boolean.
- **`competitorSignal(llm, store, cfg, { pid, title, ourRetailGbp })` → `{ estimateGbp, confidence: 'high'|'medium'|'low', sources } | null`.** LLM + web search via `jsonChain({ web })`, cached in `search_cache` (`comp:<pid>`, `profit.cacheTtlDays`). Hermetic-safe: any failure / no LLM → `null` (no signal is NOT a fail). Logs `logLlmUsage('profit-competition', …)`.
- **`profitVerdict({ net, competitor, ourRetailGbp, profit })` → `{ verdict: 'pass'|'review'|'reject', reason }`.** Combines: deterministic floor breach (`net.belowFloor`) → **reject** (the only hard signal). High-confidence competitor estimate showing our price materially above the cheapest competitor beyond `competitionTolerancePct` → **reject** (won't sell). Medium/low-confidence competition concern → **review**. Otherwise **pass**.

### Consumer A — import gate (preventive, in `confirmAndImport`)

Runs ONLY when `cfg.profit.enabled`. After the local-for-local + live-stock gates, before `importProduct`:
- Compute `productNetAfterAds` on the detail's variants using **live** `cfg.pricing` + captured `freightUsd`.
- `belowFloor && hardBlock` → REJECT: `store.putLink({ state: 'failed' })` + return (same mechanic as every other gate; verified via `graphite query "calls confirmAndImport"`).
- `belowFloor && !hardBlock` → REVIEW: force `opts.publish = false` (import as DRAFT) + add a `cj-profit-review` tag; still records the link.
- Competitor check is NOT run here by default (keeps the `seedOriginAssortment` / `refillCollections` batch lanes cheap). A `competitionCheckOnImport` flag (default `false`) can add it later; the audit always runs it.
- `!cfg.profit.enabled` → the whole block is skipped: zero behaviour change, zero spend.

### Consumer B — audit agent (continuous, observe-first)

`auditProfitability(store, cj, admin, llm, cfg, { offset, limit })` — a rolling batch walk of `listImportedLinks` (like `reconcileCategories`, checkpointing offset). For each product: load stored detail (warehouse cache), compute `productNetAfterAds`, fetch `competitorSignal` (cached), derive `profitVerdict`, `upsertProfitVerdict`. **Never archives.** Wired as:
- Nightly STAGE `{ name: 'profit-audit', run(ctx, offset, deadline) }` (only does work when `cfg.profit.enabled`; the deterministic-only pass is cheap, competitor calls are cached + amortised 60/night).
- On-demand console "Run now" action.
- A **Profitability** console view: verdict/reason/net £+%/competitor estimate per product, sorted worst-first; a per-row **Archive (owner confirms)** button reusing the existing archive/cull path. Never auto-archive (competition-aware-catalog policy: archive not delete, owner confirms).

## Data + config

- **Migration `0027_profitability.sql`:** `product_profit` table (`shop, cj_pid` PK, `verdict, net_gbp, net_pct, our_retail_gbp, competitor_gbp, competitor_confidence, competitor_sources, reason, checked_at`) + `ALTER TABLE tenant_config ADD COLUMN profit TEXT NOT NULL DEFAULT '{}'` (rides the same `'{}'`-default + `getConfig` merge as addons/fulfil/semantic).
- **`ProfitConfig`** in `types.ts` + `DEFAULT_PROFIT` (dormant). Fields: `enabled=false, hardBlock=false, competitionCheckOnImport=false, adShareOfRevenue=0.33, paymentsFeeRate=0.025, refundReserveRate=0.03, vatRate=0.20, minNetAfterAdsGbp=2, minNetMarginPct=0.05, competitionTolerancePct=0.15, cacheTtlDays=14`. All owner-tunable in `tenant_config.profit`.
- **`tenant-store.ts`:** `getConfig` merge for `profit`; `saveProfit`; `upsertProfitVerdict` / `listProfitVerdicts` (worst-first) / `getProfitVerdict`.

## Guardrails

- Hard REJECT only on the deterministic net-after-ads floor (real cost math) + a high-confidence competition loss. Everything uncertain → REVIEW (draft/flag), never a silent auto-reject/auto-archive.
- Ships dormant; `enabled=false` = zero behaviour change + zero spend.
- LLM competition calls cached (`comp:<pid>`), kept out of the synchronous batch import path.
- Live `cfg.pricing` everywhere (2.2× today), never the 2.5× default.

## Sequence context

Piece 2 (+3) of the owner's 3-piece request. Piece 1 (Graphite call-graph fix: `callers`/`calls`/`reaches`, function-level + cross-file) is DONE, verified, deployed-in-editable-install. Pieces 2+3 converged into this one engine + its two consumers.
