# Continuous Profitability Agent (active: adjust-or-drop) — DESIGN

**Supersedes the action model in** `2026-07-09-profitability-engine-design.md` (which was observe-first / owner-confirm). Owner redefined the requirement (2026-07-09): a **continuous** agent that acts on its own — research the market, then **adjust the price if we can still profit, else drop; a clear loss is dropped immediately, no owner decision.** Owner approved: **full auto** (log every action for review/undo); **no market data => cost-check only** (drop only if it loses money at its own price, never drop for competition without evidence).

## The owner's governing rule (definitive, 2026-07-09)
> **Net profit must always be >= GBP2 per unit, no ceiling.** Price each product as HIGH as possible while staying **strictly below the competitor's DELIVERED price** (their item price + their shipping - only membership tiers like Amazon Prime get free delivery, so a normal buyer pays postage and our free UK delivery is a real edge). So the agent **auto-RAISES** as readily as it lowers. If it **cannot clear GBP2 even at the best sub-market price -> drop.** Clear loss -> drop. Act on **defensible values only** (real CJ cost, real competitor delivered price, our real price); no approval needed, just keep the owner informed. **The shop must make profit and never lose money.**

This supersedes the earlier "never auto-raise / lower-only" model.

## Data basis (traced, not assumed)
Value each product on its **ACTUAL live Shopify numbers**, not a rule price or admission-time cost:
- `productInventoryItems(admin, productId)` returns per variant `{ variantId, price, cost }` where `cost` = Shopify `unitCost.amount` (the landed GBP COGS the inventory sync writes). Both are current shelf/admin values.
- No CJ call and no rule-price recompute needed. This closes the two gaps the owner caught: stale admission cost, and rule-price-vs-frozen-shelf.
- Reprice via the existing `updateVariantPrices` (productVariantsBulkUpdate). Drop via the archive mutation (`productUpdate status:ARCHIVED` + link state 'archived'), same path as `cullStaleProducts`.
- Competitor price via the existing `competitorSignal` (LLM + web search, cached in `search_cache comp:<pid>`).

Caveat (honest): `cost` freshness is bounded by how often the inventory sync touches each product (it writes `unitCost`). Confirming/deepening that coverage is a related follow-up, tracked separately.

## The full cost stack (what "net" weighs)
`liveNet(price,cost) = price/(1+vat) - cost - adShare*price - payments*price - refund*(price/(1+vat)) - affiliate - discount`, where affiliate = `affiliateSalesShare*(commission*exVat + platformFee*price)` and discount = `expectedDiscountRate*price`. Inputs: `price` = live Shopify shelf price, `cost` = live Shopify landed cost (both real). Defaults: adShare 0.33 (worst-case, tune to real blend), payments 2.5%, refunds 3%, VAT 20%, affiliate 15% share x (8%+2%), discount 5% blended, **floor = GBP2**. Open item: a fixed-overhead term (Shopify/apps ~2%) if the owner wants it.

## Decision tree (pure function `decideProfitAction`, judged on the WORST sellable variant)
Competitor counts only at **high/medium** confidence (low = no data).
1. **No live price/cost** -> `keep` (never act blind).
2. **Defensible competitor delivered price exists:** target = `round99Down(competitorDelivered)` (a .99 strictly below it). Scale all variants so the from-price hits target (RAISES if we are below it, LOWERS if above).
   - Worst variant still `>= GBP2` at target -> `reprice` all variants to target (skip if the from-price move is under a 50p deadband -> `keep`). Direction (raise/lower) is logged.
   - Worst variant `< GBP2` at the best sub-market price -> `drop` ("cannot clear GBP2 even at the best price below the market").
3. **No defensible market price:** cannot safely reprice (never guess a price).
   - Loses money at current price -> `drop`. Positive but `< GBP2` -> `flag` (owner's call). `>= GBP2` -> `keep`.

Prices only ever land on a `.99` at or below the competitor's delivered price (never above the market). Auto-raise and auto-drop both run without approval on defensible data; every action is logged.

## Architecture
- **`decideProfitAction(...)`** — pure, deterministic, fully unit-tested (this doc's first deliverable).
- **`runProfitAgent(store, admin, llm, cfg, {offset, limit})`** — per product: `productInventoryItems` (live price+cost) -> `competitorSignal` (cached) -> `decideProfitAction` -> execute (`updateVariantPrices` to lower / archive to drop) -> write the verdict + the action taken to `product_profit` (+ an action log) -> continue. Never throws out of the loop.
- **Continuous:** runs on the **15-minute cron** in rolling batches (small, cached competitor calls) so the whole catalog is re-evaluated through the day — not a nightly pass. Also re-checks a product right after its inventory sync (fresh cost) — event-adjacent.
- **Switch model:** `profit.enabled` gates everything (dormant = nothing). When enabled, a `profit.dryRun` flag (default true on first enable) makes the agent COMPUTE and record what it *would* do without touching prices/listings — a one-look preview — then the owner clears dryRun for full-auto. This is a preview, not per-action approval (owner chose full auto).
- **Action log:** every reprice (from->to) and drop is recorded (reusing `product_profit` + a reason/action column, or a small `profit_actions` table) so the owner can review and reverse.

## Console
The Profitability view shows: current live price, competitor price, verdict, and the **action taken** (kept / repriced £X->£Y / dropped) with timestamp. Archived products drop off the list (already shipped). A dry-run banner + a single "Go live (full auto)" control replaces the manual per-row archive as the primary flow (manual archive stays as a fallback).

## Sequence / status
Observe-first engine (net-after-ads, competitorSignal, verdicts, console) is already built + deployed dormant. This doc converts it to the **active adjust-or-drop** agent the owner specified. First build step: `decideProfitAction` + tests (TDD), then the runner + execution + 15-min wiring + dry-run + console, then deploy dormant for the owner's preview-then-full-auto.
