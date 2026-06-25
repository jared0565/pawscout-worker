# Inbox item-aware, nearest-warehouse shipping-time answers — design

- **Date:** 2026-06-25
- **Status:** Approved (brainstorming) — pending implementation plan
- **Owner area:** PawScout worker — inbox drafter (shipping-time grounding)
- **Related:** `docs/superpowers/specs/2026-06-21-cj-logistics-store-design.md` (the D1 logistics matrix this builds on); the 2026-06-25 inbox grounding audit (motivation).

## Problem

When a customer asks "how long does shipping take?", the drafter today answers **generically**: `deriveDestinationCountry` resolves the inquirer's destination, then a single `cj_logistics` matrix row (which **assumes CN origin**) yields a door-to-door band (e.g. UK 6-21 days). It is destination-aware but **not item-aware**, so it cannot reflect that a specific product may be stocked in a **nearer warehouse** (e.g. GB) and therefore arrive much faster.

The 2026-06-25 audit confirmed the grounding *system* is correct (live drafts quoting "7-23 days" to the US match the matrix exactly) but surfaced the gap: the honest answer to "how long is shipping?" is **per item**, because delivery time depends on which warehouse holds that product and how near it is to the customer. We now also have 39 **verified GB-warehoused** products live, making nearest-warehouse answers materially better for UK customers.

## Goals

- Answer shipping-time inquiries **per specific item**, using the **nearest in-stock warehouse** for the inquirer's destination.
- Keep the fast common case (UK inquirer + catalog item) **call-free** (served from D1); only hit CJ live when D1 cannot answer.
- Stay strictly grounded and honest: conservative door-to-door bands, never fabricate, never name a non-GB origin.
- Allow a per-SKU **verified** "UK fulfilment location" wording for GB-warehoused items (owner decision, matches affiliate ruleset E.11).

## Non-goals

- No precomputed per-(product × every destination) matrix (rejected: heavy sync, still misses non-catalog items).
- No always-live-CJ drafting (rejected: latency/rate-limit exposure the architecture deliberately moved off).
- No change to non-shipping category agents, classification, or the sweep/HITL flow.

## Decisions (from brainstorming)

1. **Flow: infer first, then ask.** If the inquiry identifies a product (URL/handle, an order line item, or a confident match), answer with that item's nearest-warehouse estimate. If no item can be identified, ask which item.
2. **Data source: D1 first, live CJ fallback.** Use the per-product band already in D1 for the common case; one live CJ freight quote when D1 cannot answer (non-UK destination, or item not covered).
3. **Item match: high-confidence signals only.** A wrong match = a wrong delivery promise, so only quote per-item when the product is unambiguous; otherwise confirm the item with the customer.
4. **Origin wording: per-SKU verified UK-location allowed.** For items **verified GB-warehoused at source**, the draft may mention a UK fulfilment location + the faster time. All other items: **delivery time only, origin never named**. Never a blanket "Active Paw ships from the UK."

## Architecture (Approach 1)

Two new focused modules plus wiring into the existing shipping category agent. Nothing else in the inbox pipeline changes.

### 1. `src/inbox/item-resolver.ts` — identify the product (high-confidence only)

`resolveInquiryItem(thread, latestMessage, store, orders?) → ResolvedItem | null`

`ResolvedItem = { cjPid: string; repVid: string; handle: string; title: string }`

Signals, tried in order, stop at first confident hit:

1. **Product URL / handle** in the latest message or subject (`/products/<handle>`, or a bare handle that matches) → look up the `product_links` row (state `imported`/`draft`) → catalog item. Strongest signal.
2. **Order line item** — if the contact email maps to a recent order (`read_orders`) and the inquiry references "my order", use the order's line item(s). (Best-effort; only when the order lookup is unambiguous.)
3. **Confident LLM title match** — match the free-text description against catalog titles; require **exactly one** hit above a confidence threshold. Ambiguous / multi-hit / low-confidence → `null`.
4. No signal → `null` (the agent asks).

Pure except for the D1 read (catalog lookup) and optional order lookup; the LLM match is injected (testable with a fake).

### 2. `src/inbox/delivery-resolver.ts` — nearest-warehouse delivery band

`resolveItemDelivery(item, destISO, store, cj) → ItemDelivery | null`

`ItemDelivery = { band: DayRange; verifiedGbWarehouse: boolean; source: 'd1' | 'cj' | 'matrix' }`

Logic:

1. Read the item's warehouses from D1 (`warehouse_products.detail.origins`, e.g. `{ "GB": 40, "CN": 1000 }`). Set `verifiedGbWarehouse = (origins.GB ?? 0) > 0` — **real stock only**, never assumed.
2. **Pick the nearest in-stock warehouse** for `destISO`: prefer a warehouse whose country **equals the destination** (domestic = fastest); else fall back to `CN` (the global hub the matrix already covers). ("Nearest" is our deterministic choice of `fromCountry`, because `cj.freightQuoteAging` takes the origin as an input — CJ does not auto-select it.)
3. **Compute the band:**
   - **Destination = GB + catalog item:** use the per-product actual GB band already produced by `syncStoreInventory` (`supplier.delivery_days_actual`); for a GB-stocked item this already reflects the fast domestic time. `source: 'd1'`. No CJ call.
   - **Otherwise (non-GB destination, or no per-product band):** one live `cj.freightQuoteAging(repVid, fromCountry=nearestWarehouse, toCountry=destISO)` → cheapest option's aging → `bandFromQuote()` → conservative `doorToDoorBand` (domestic route ⇒ customs=0). `source: 'cj'`.
4. **Degrade safely:** CJ failure → `cj_logistics` matrix row (CN→dest, conservative), `source: 'matrix'` → then `null` (caller hedges). Reuses the existing null-guards in `logistics.ts` (never NaN, never throws).

Implementation choice for the plan: read `delivery_days_actual` back from the Shopify metafield, **or** persist that band into `warehouse_products` during the existing `syncStoreInventory` so the drafter stays pure-D1. **Lean: persist into D1** (keeps the drafter free of admin reads). Decide in the plan.

### 3. Wiring — shipping category agent

The shipping agent orchestrates: `resolveInquiryItem` → (if `null`, ask) → `deriveDestinationCountry` → `resolveItemDelivery` → compose. The existing sweep re-drafts `needs_reply` threads, so when the customer replies naming the item, the next sweep re-resolves and drafts the per-item answer — **no new follow-up infrastructure**.

### 4. `deriveDestinationCountry` fix (freight.ts)

Recognise `"u.s."`, `"u.s.a."`, and the phrase `"the us"` as `US`, **without** matching the bare pronoun "us" (the existing collision the audit found). Add to `COUNTRY_NAMES`/the matcher with a guarded pattern. This is required for the feature to serve US inquirers and fixes audit finding [16].

## Customer-facing wording rules (guardrails)

- **Default, every item: delivery time only, no origin named** — e.g. "your estimated delivery is 6-21 days." The warehouse is used only to compute the number.
- **Verified-GB item + UK inquirer → MAY add UK-location wording**, e.g. "this item is held in a UK fulfilment location, so it typically arrives in 2-6 days." Gated on `verifiedGbWarehouse === true` from real stock. Attributes to "a UK fulfilment location" (the supplier network) — **never** "Active Paw's own UK warehouse", **never** a blanket "we ship from the UK".
- **CN / EU / US items → time-only; the real origin is never named** (no "ships from China").
- The band is always the **conservative door-to-door** range (never under-promise), even when the nearer warehouse is fast.

This is a deliberate, scoped refinement of the standing no-UK-fulfilment rule: a per-SKU, source-verified UK-location claim is allowed; everything else is unchanged.

## Edge-case behaviour

- **Unknown item →** ask the customer to name or link the specific item, and include the **general UK band as a soft, non-committal anchor** ("in general most UK orders arrive in about 6-21 days; tell me the exact item and I'll confirm a precise estimate"). (Owner-approved default; can be switched to "no number until specified".)
- **Unknown destination →** default to the **UK** home market, phrase for UK, and invite correction ("if you're ordering from outside the UK, let me know your country"). The `deriveDestinationCountry` fix means this only triggers when location is genuinely absent.

## Error handling / degradation

Every failure falls back along a safe chain and never fabricates: per-item CJ quote → `cj_logistics` matrix (conservative) → hedge/ask. `verifiedGbWarehouse` defaults to `false` on any doubt → time-only wording. No path names a non-GB origin. Reuses the existing claim-safe null-guards in `logistics.ts`/`freight.ts`.

## Testing

- **item-resolver:** URL/handle hit; order-line hit; confident single LLM match; ambiguous → null; no-signal → null.
- **delivery-resolver:** GB catalog item → D1 band, no CJ call; non-UK → exactly one CJ call (mocked); CJ failure → matrix fallback; `verifiedGbWarehouse` true/false from `origins`.
- **nearest-warehouse pick:** destination-domestic warehouse chosen when in stock; CN fallback otherwise.
- **wording:** verified-GB + UK → UK-location phrasing; CN item → time-only, no origin; non-GB destination → time-only; assert **no** blanket "ships from the UK" string ever.
- **deriveDestinationCountry:** "the US"/"U.S."/"U.S.A." → US; bare pronoun "us" → still not matched (regression guard); existing GB/country/state cases unchanged.
- **integration:** resolved item → item-specific band in the draft; unknown item → draft asks.

## Open implementation choices (resolve in the plan)

1. `delivery_days_actual` source: read metafield vs persist into `warehouse_products` (lean: persist into D1).
2. Exact LLM-match confidence threshold + prompt for the item-resolver.
3. Whether order-line resolution (signal 2) ships in v1 or is deferred (it depends on `read_orders` plumbing in the inbox context).

## Standing-rule note

This design **refines** the `no-uk-fulfilment-claim` memory: a per-SKU, source-verified "UK fulfilment location" + faster-time claim is now permitted for GB-warehoused items; blanket UK-dispatch claims and naming any non-GB origin remain forbidden. Update that memory when the feature ships.
