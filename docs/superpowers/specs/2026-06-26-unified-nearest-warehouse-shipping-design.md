# Unified Nearest-Warehouse Shipping Design

**Date:** 2026-06-26
**Status:** Approved design (pending spec-review gate)
**Supersedes the single-origin / flat-rate assumptions in:** `2026-06-25-shipping-cost-origin-profiles-phase1-design.md` (Phase 1 "free UK on GB items" is retained as a correct special case; see below).

## Governing rule

ONE unified formula governs EVERY shipping detail (delivery TIME and COST), for every inquiry AND every order, globally: **determine the item's nearest warehouse to the customer's destination, treat THAT as the origin, and calculate time + cost from there using CJ's real per-route data.** No single-origin assumptions anywhere, including GB-warehoused products. (Owner directive, 2026-06-26.)

This holds the customer-facing line: only surface what is real and defensible. An unknown route degrades to "not available to ship to <country>", never a fabricated time or cost.

## Verified facts this design rests on

1. **CarrierService is plan-blocked.** The store is on the **Basic** plan (`shop.plan.shopifyPlus = false`, `partnerDevelopment = false`). Shopify third-party carrier-calculated rates and the CarrierService API require **Advanced or Plus**; `carrierServiceCreate` fails on Basic. Source: help.shopify.com third-party carrier-calculated shipping; shopify.dev CarrierService. Therefore live per-cart dynamic quoting at checkout is NOT available without a plan upgrade. **Decision: use static delivery profiles** (plan-independent).
2. **Missing zone = blocked checkout.** A product belongs to exactly ONE shipping profile (assigning it to a custom profile removes it from General; no fall-through). If no zone in that profile covers the destination, checkout is blocked for that cart ("shipping not available"). Source: help.shopify.com shipping profiles + troubleshooting. This is the native mechanism that makes unfulfillable routes genuinely unbuyable, with no plan gate and no Shopify Functions.
3. **CJ warehouse model (direct API probe, 2026-06-26).** Warehouses are domestic-only EXCEPT CN. GB->GB / US->US / DE->DE work (fast, ~$0); cross-border from a local warehouse returns ZERO options. CN is the only global cross-border hub (CN->GB/US/DE/ES/IT/IE/SE/BE/CA/AU/BR ~$8-11 / 8-12 days), with gaps at FR and NL in the sample. GB-warehoused products are GB-only (16/16 sampled origins were {GB}, no CN fallback).
4. **Catalog origin-signatures (remote D1, 2026-06-26).** Over 92 imported+linked products there are exactly **4 distinct signatures**: `CN` (49), `GB` (40), `US` (2), `CN,US` (1). "Few" is confirmed; this maps to 4 delivery profiles, not dozens.

## Charge policy (owner decision, 2026-06-26)

Charge the customer the **nearest-warehouse cost**: the actual CJ freight for the resolved nearest route, converted USD->GBP with a conservative FX buffer plus an optional handling/markup. The charge equals the calculated cost (per-route cost-recovery), the most consistent reading of the governing rule. UK on GB items is free (GB->GB freight ~= 0). Flat-rate and free-everywhere were rejected because the charge would diverge from the calculated nearest-warehouse cost.

Open knobs to confirm at spec review (defaults proposed):
- **FX:** a configured conservative USD->GBP rate (default proposal: a fixed constant with a buffer, refreshed manually/periodically; NOT a live FX call inside the sync). Stored as a Fulfil config knob.
- **Handling/markup:** default proposal 0 (pure cost-recovery) with an optional flat handling add (e.g. GBP 0). Stored as a Fulfil config knob.
- **Served countries:** default proposal = each product's own domestic country plus the CJ-verified CN-reachable set (GB, US, DE, ES, IT, IE, SE, BE, CA, AU, BR). FR and NL are EXCLUDED until a per-route CJ probe confirms a real route (their absence honestly blocks checkout there). Stored as a config list.
- **Mixed-cart behavior:** accept the honest block. A cart mixing a GB-only item and a CN item shipping to Germany cannot ship as one consignment, so checkout is blocked; the inbox agent explains it on inquiry ("these items ship from different locations; the <GB item> is available to the UK only"). No silent partial fulfilment.

## Architecture

### The formula is one shared resolver, not a new table

The raw data already lives in `cj_logistics` (per-route: from_country, to_country, transit band, `freight_cost_usd`). The unified formula is a pure function both consumers call:

```
resolveNearestRoute(origins: Set<string>, dest: string, matrix) ->
    { origin, transitBand, freightUsd } | { fulfillable: false }
```

Logic (data-driven nearest-by-real-cost):
- Among the product's stocking `origins`, keep only those that have a real `cj_logistics` route to `dest` (a row with a parsed transit band; freight may be 0 for domestic).
- If none qualify -> `{ fulfillable: false }`.
- Otherwise pick the cheapest qualifying route (tie-break: shortest transit). Domestic (~free) naturally wins over CN (~$9); CN is chosen only when no domestic warehouse serves the destination.

This is general (not hardcoded to the CN/binary special case) and yields the correct nearest warehouse purely from CJ data. Both the inbox agent and the nightly profile sync call it, which is what guarantees quote == checkout: the same origin, the same route, the same number.

### Phase 0: interim fix + linchpin proof (do first, with owner go)

The GB Local profile (`gid://shopify/DeliveryProfile/147216892242`, 40 GB-only members) still carries the wrong mirrored EU and International zones, so GB-only items are currently buyable to the EU at a flat rate they cannot be fulfilled at. Remove those zones (UK-only). Then prove the linchpin empirically on THIS store with Playwright:
- A GB item checked out to a FRENCH address shows "shipping not available" / is blocked.
- A GB item to a UK address still offers free UK shipping.

If the EU checkout is NOT blocked (i.e. it falls through to another profile), STOP and redesign before building Phase B. This is the one assumption that can invalidate the whole static approach.

(The 2 US-only and 1 CN+US products are a smaller live exposure of the same class; they are corrected by Phase B rather than a separate Phase 0 edit.)

### Phase A: agent correctness (ships independently, no plan dependency)

Today `resolveItemShipping` (`src/inbox/agents/shipping.ts`) falls back to the best-STOCKED origin when the destination country is not stocked. For a GB-only product to France this borrows another product's CN->FR matrix row and fabricates a delivery time for a shipment that cannot physically happen (the line-125 CN default route). Fix:
- Replace best-stocked selection with `resolveNearestRoute`.
- When the resolver returns `fulfillable: false`, the agent states honestly that the item cannot ship to that country. No CN fabrication, no borrowed matrix row.
- Fulfillability means CJ returned a real route, not merely that a warehouse stocks the item (CN->FR / CN->NL came back empty).
- TIME only in Phase A; no new cost claim yet (preserves quote == checkout until Phase B lands). Cost-quoting turns on with Phase B, using the same resolver so the quote equals the charge.

### Phase B: origin-signature static profiles (the checkout half, on Basic)

A nightly job (extends `runDailyMaintenance`) materializes the formula into Shopify delivery profiles, one per signature:
1. Compute the catalog's distinct origin-signatures (the D1 query in this design).
2. For each signature, ensure a delivery profile whose zones are built per served destination via `resolveNearestRoute(signature, dest)`:
   - fulfillable -> add a country zone with rate = `freightUsd` converted to GBP (FX + handling), or free when the nearest route is domestic GB->GB.
   - not fulfillable -> omit the zone (so checkout is blocked there, honestly).
3. Assign each product's VARIANTS to its signature's profile via `variantsToAssociate` / `variantsToDissociate`, diffing current membership.

This generalizes the existing `ensureGbLocalProfile` / `syncGbProfileMembership` (`src/shipping/delivery-profile.ts`) from one GB profile to N signature profiles. The `{GB}` profile becomes UK-only (its bad zones already removed in Phase 0). Each profile's per-zone rate encodes the nearest-warehouse cost for that destination, so the static profile is simply the cached output of the formula, refreshed nightly.

## Why this is "only real and defensible"

- The customer is charged exactly what is quoted (quote == checkout), both derived from the same resolver over the same `cj_logistics` rows.
- Delivery time is CJ-grounded (existing door-to-door band model).
- Unfulfillable routes are genuinely unbuyable (zone omission), so the shop never sells an order it cannot fulfill.
- The only approximation is margin precision: static per-zone freight cannot vary by parcel weight, since Shopify static rates are not per-product. That is the existing Phase-2 margin-engine concern, not a customer-facing inaccuracy. Once Phase B is live the agent must quote the static bucketed rate, never a live per-product CJ freight call, so the quote cannot diverge from the charge.

## The exact alternative (recorded, not chosen)

Upgrading to the Advanced plan unlocks the CarrierService API and exact per-item, per-weight dynamic rates quoted live at checkout (a freight cache plus a callback within Shopify's ~10s timeout). It is the most precise option but carries a recurring plan cost and a larger build. Chosen path is the Basic-plan static approximation; revisit if the store upgrades.

## Components / files

- `src/logistics.ts` (or a new `src/shipping/nearest-route.ts`): the pure `resolveNearestRoute` resolver + types. Unit-tested in isolation.
- `src/inbox/agents/shipping.ts`: Phase A rewire of `resolveItemShipping` to the resolver; honest unfulfillable path; remove the CN-default borrowed-row fallback.
- `src/shipping/delivery-profile.ts`: Phase 0 zone removal helper; Phase B generalization to N signature profiles + per-zone nearest-warehouse pricing.
- `src/tenant-store.ts`: a `listSignatureMemberships()` accessor (signature -> shopify product/variant ids) for the sync; reuse the json_each origins pattern.
- `src/jobs.ts`: wire the signature sync into `runDailyMaintenance` (best-effort, after the existing GB sync which it replaces).
- `src/types.ts`: Fulfil knobs for FX rate, handling/markup, served-country list.
- Config + console: surface FX/handling/served-countries (read-only status is enough for MVP; editing can be a follow-up).
- Tests: resolver unit tests (domestic-wins, CN-fallback, unfulfillable, tie-break); agent honest-unfulfillable test; profile-sync zone-presence + pricing tests; Phase 0 Playwright checkout-block proof.

## Out of scope (follow-ups)

- Per-weight exact freight (margin engine, Phase 2).
- CarrierService / plan upgrade.
- Editing FX/served-countries from the console (status display is enough for MVP).
- Auto-resolving FR/NL and other CN gaps (needs per-category CJ probing).
