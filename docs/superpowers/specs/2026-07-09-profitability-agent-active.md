# Continuous Profitability Agent (active: adjust-or-drop) — DESIGN

**Supersedes the action model in** `2026-07-09-profitability-engine-design.md` (which was observe-first / owner-confirm). Owner redefined the requirement (2026-07-09): a **continuous** agent that acts on its own — research the market, then **adjust the price if we can still profit, else drop; a clear loss is dropped immediately, no owner decision.** Owner approved: **full auto** (log every action for review/undo); **no market data => cost-check only** (drop only if it loses money at its own price, never drop for competition without evidence).

## The owner's algorithm (verbatim intent)
inventory -> research price vs other sellers (LLM + web search) -> *can we set a competitive price and still be profitable?* -> **Yes: adjust (lower to it). No: drop.** Clear loss (loses money even at its current shelf price) -> **immediate auto-drop.**

## Data basis (traced, not assumed)
Value each product on its **ACTUAL live Shopify numbers**, not a rule price or admission-time cost:
- `productInventoryItems(admin, productId)` returns per variant `{ variantId, price, cost }` where `cost` = Shopify `unitCost.amount` (the landed GBP COGS the inventory sync writes). Both are current shelf/admin values.
- No CJ call and no rule-price recompute needed. This closes the two gaps the owner caught: stale admission cost, and rule-price-vs-frozen-shelf.
- Reprice via the existing `updateVariantPrices` (productVariantsBulkUpdate). Drop via the archive mutation (`productUpdate status:ARCHIVED` + link state 'archived'), same path as `cullStaleProducts`.
- Competitor price via the existing `competitorSignal` (LLM + web search, cached in `search_cache comp:<pid>`).

Caveat (honest): `cost` freshness is bounded by how often the inventory sync touches each product (it writes `unitCost`). Confirming/deepening that coverage is a related follow-up, tracked separately.

## Decision tree (pure function `decideProfitAction`)
Fee stack from `ProfitConfig` (adShareOfRevenue, paymentsFeeRate, refundReserveRate, vatRate, minNetAfterAdsGbp = floor, competitionTolerancePct). `liveNet(price,cost) = price/(1+vat) - cost - adShare*price - payments*price - refund*(price/(1+vat))`. A product is judged on its **worst sellable variant** (mirrors affiliate eligibility). Competitor counts only at **high/medium** confidence; low confidence is treated as no data.

1. **No live price/cost** for any variant -> `keep` (never act blind).
2. **Loses money at the current shelf price** (worst variant `liveNet < floor`): lowering can't fix it (less revenue = worse).
   - If a high/medium competitor price is **above** our from-price AND the product would clear the floor at that market price -> `flag` ("only viable at a higher price ~£X; a price increase is your call") — because the system never auto-RAISES a customer price.
   - Else -> `drop` ("loses £X/unit at its current price; cannot be fixed by lowering"). This is the **clear-loss auto-drop**.
3. **Profitable now, but priced above the market** (from-price > competitor * (1+tolerance), high/medium confidence):
   - Scale all variant prices down so the from-price meets the market. If the worst variant still clears the floor at those prices -> `reprice` (lower to compete, still profitable). New prices round DOWN to a .99 ending so we never land above market.
   - Else -> `drop` ("to compete we'd need ~£X, below our profitable floor").
4. **Profitable and at/below market (or no usable competitor)** -> `keep`.

Only ever LOWERS a price (respects the standing no-auto-raise rule). The raise-to-save case is surfaced as `flag`, not executed.

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
