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
Competitor counts only at **high/medium** confidence (low = no data). The competitor
price is the SOFTEST input (an LLM web lookup), so the most destructive action -
archiving a product - is gated to the HARDEST evidence.
1. **No live price/cost** -> `keep` (never act blind).
2. **Defensible competitor delivered price exists (high/medium):** target =
   `undercutTarget(competitorDelivered, undercutPct)` - a .99 an undercut-% below the
   market. Scale all variants so the from-price hits target (RAISES if we are below it,
   LOWERS if above).
   - Worst variant still `>= GBP2` at target -> `reprice` all variants to target (skip
     if the from-price move is under a 50p deadband -> `keep`). Direction (raise/lower)
     is logged. Reprice runs on high OR medium confidence (it is recoverable).
   - Worst variant `< GBP2` at the best sub-market price -> can't win here:
     - competitor confidence **high** -> `drop` ("cannot clear GBP2 even at the best
       price below the market"). Auto-archive only on hard, agreed market evidence.
     - competitor confidence **medium** -> `flag` (owner's call). A soft low estimate
       must never silently archive a possibly-profitable product.
3. **No defensible market price:** price on our OWN defensible rule (the "market of
   one"), never guess against a phantom competitor. In priority order:
   - Sells **below landed cost** (revenue ex-VAT `< cost`) -> `drop`. A DEFENSIBLE
     loss - the shop loses money on the item itself, independent of the tunable
     ad-share assumption.
   - Net **`>= GBP2`** at its current price -> `keep`. We do NOT lower a working price
     with no evidence it is above market ("no competitor found" is ambiguous - it can
     mean we are the only seller as easily as an unmatched search), and never
     speculate a raise above a price already clearing the floor.
   - **Thin** (net `< GBP2`, above cost): reprice to our **cost-plus rule price**
     (`costPlusPriceGbp` on the LIVE cost = our standard markup, capped) when that
     price clears the floor - a `reprice` that keeps the product live. The raise is
     CAPPED at the rule (never a premium above our own markup without a competitor
     signal the market bears more); since net rises monotonically with price, this
     only ever RAISES a thin item. If even the rule price can't clear the floor (or no
     cost-plus price is available) -> `flag` (owner's call).
   - Rationale (asymmetry + owner's rule): the ad share defaults to the worst case
     (0.33), so judging a no-market-data drop on FULL-STACK net would auto-archive
     genuinely profitable stock the moment a lookup comes back empty (cold cache / LLM
     off). The drop gate is assumption-free (below cost); a thin item is PRICED to our
     defensible margin and kept selling rather than flagged-and-frozen; only a genuine
     human call flags. No/soft data never unlocks a more destructive action than hard
     market data does. The cost-plus price uses the live Shopify cost, so it also
     corrects a no-competitor product whose cost rose after the agent took price
     authority (the nightly sync no longer reprices it).

Prices only ever land on a `.99` at or below the competitor's delivered price (never
above the market). Auto-raise runs freely on defensible data; auto-drop runs only on
hard evidence (a clear loss at our own price, or a high-confidence market it can't beat);
every action is logged. **Asymmetry rule:** more/softer competitor data must never unlock
a MORE destructive action than less data would.

## Coherence with the existing crons (two collisions, resolved)
The active agent shares the catalog with `syncStoreInventory` (nightly price/cost/stock
sync) and `auditProfitability` (observe verdicts). Both collide and are resolved here:

1. **Price authority.** `syncStoreInventory` reprices variants toward the pricing-rule
   price and is LOWER-ONLY (jobs.ts: `if (Number(expected) > Number(v.price)) return []`).
   The agent RAISES above the rule price (to just under a higher competitor), so the
   sync would drag every raised product back down and the agent would re-raise it - a
   price sawtooth on exactly the products the agent lifts. Resolution: when
   `profit.enabled && !dryRun` the **profit agent is the price authority** and the sync
   SKIPS its price-lowering block (cost-per-item and stock still sync every night). In
   dry-run or when disabled, the sync keeps full control (nothing changes today).
2. **Single writer of `product_profit`.** `auditProfitability` (nightly stage + "Run
   Audit Now") and `runProfitAgent` both upsert the same `(shop,cj_pid)` row with
   DIFFERENT models. The active agent supersedes observe: the nightly `profit-audit`
   stage is retired and "Run Audit Now" re-points at the runner in dry-run, so the
   runner is the sole writer. Dry-run reproduces the observe output the console renders.

## Architecture
- **`decideProfitAction(...)`** — pure, deterministic, fully unit-tested (this doc's first deliverable).
- **`runProfitAgent(store, admin, llm, cfg, {offset, limit})`** — per product: `productInventoryItems` (live price+cost) -> `competitorSignal` (cached) -> `decideProfitAction` -> execute (`updateVariantPrices` to lower / archive to drop) -> write the verdict + the action taken to `product_profit` (+ an action log) -> continue. Never throws out of the loop.
- **Continuous:** runs on the **15-minute cron** in rolling batches (small, cached competitor calls) so the whole catalog is re-evaluated through the day — not a nightly pass. Also re-checks a product right after its inventory sync (fresh cost) — event-adjacent.
- **Switch model:** `profit.enabled` gates everything (dormant = nothing). When enabled, a `profit.dryRun` flag makes the agent COMPUTE and record what it *would* do without touching prices/listings — a one-look preview — then the owner clears dryRun for full-auto. This is a preview, not per-action approval (owner chose full auto). **First-enable must WRITE `dryRun:true` explicitly:** `getConfig` merges saved JSON *over* `DEFAULT_PROFIT`, so a saved profit object's `dryRun` wins over the default — the enable action sets it, never relying on the default surviving the merge.
- **Action log (`profit_actions`, append-only):** every reprice (from->to) and drop is recorded so the owner can review and reverse. This ledger is **load-bearing, not optional:** a dropped product is archived and archived rows are excluded from `listProfitVerdicts`, so the ledger is the ONLY surviving record of a drop. `product_profit` also carries the latest action inline (action / from / to / acted_at / dry_run) as a console convenience — those two are the whole persistence surface, nothing more.

## Console
The Profitability view shows: current live price, competitor price, verdict, and the **action taken** (kept / repriced £X->£Y / dropped) with timestamp. Archived products drop off the list (already shipped). A dry-run banner + a single "Go live (full auto)" control replaces the manual per-row archive as the primary flow (manual archive stays as a fallback).

## Sequence / status
Observe-first engine (net-after-ads, competitorSignal, verdicts, console) is already built + deployed dormant. This doc converts it to the **active adjust-or-drop** agent the owner specified. First build step: `decideProfitAction` + tests (TDD), then the runner + execution + 15-min wiring + dry-run + console, then deploy dormant for the owner's preview-then-full-auto.
