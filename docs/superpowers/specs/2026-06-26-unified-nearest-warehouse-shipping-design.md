# Unified Nearest-Warehouse Shipping Design

**Date:** 2026-06-26
**Status:** Approved design, REVISED 2026-06-26 for the Managed Markets reality (see the banner below).
**Supersedes the single-origin / flat-rate assumptions in:** `2026-06-25-shipping-cost-origin-profiles-phase1-design.md` (Phase 1 "free UK on GB items" is retained as a correct special case; see below).

> ## ⚠️ REVISION BANNER (2026-06-26): Managed Markets is ON - read this first
>
> This store has **Managed Markets ON** (verified at real checkout). That **invalidates verified-fact #2 below** ("missing zone = blocked checkout"): Managed Markets backfills any destination a custom delivery profile does not cover with carrier-calculated rates, so **zone omission cannot block an unfulfillable route.** The unfulfillable-order fix therefore moves OFF delivery profiles and ONTO the **per-market product-availability (market catalogs)** layer. The UK delivery-profile / nearest-warehouse cost work below STANDS for the UK merchant-managed market (which our profiles own). See the new section **["Managed Markets reality + per-market product-availability reframe"](#managed-markets-reality--per-market-product-availability-reframe-verified-2026-06-26)** for the full reframe, the verified coverage, and the residuals. The Phase-0 "remove the GB EU/Intl zones" edit and the Phase-A agent-correctness work are unaffected and still correct.

## Governing rule

ONE unified formula governs EVERY shipping detail (delivery TIME and COST), for every inquiry AND every order, globally: **determine the item's nearest warehouse to the customer's destination, treat THAT as the origin, and calculate time + cost from there using CJ's real per-route data.** No single-origin assumptions anywhere, including GB-warehoused products. (Owner directive, 2026-06-26.)

This holds the customer-facing line: only surface what is real and defensible. An unknown route degrades to "not available to ship to <country>", never a fabricated time or cost.

## Verified facts this design rests on

1. **CarrierService is plan-blocked.** The store is on the **Basic** plan (`shop.plan.shopifyPlus = false`, `partnerDevelopment = false`). Shopify third-party carrier-calculated rates and the CarrierService API require **Advanced or Plus**; `carrierServiceCreate` fails on Basic. Source: help.shopify.com third-party carrier-calculated shipping; shopify.dev CarrierService. Therefore live per-cart dynamic quoting at checkout is NOT available without a plan upgrade. **Decision: use static delivery profiles** (plan-independent).
2. ~~**Missing zone = blocked checkout.** A product belongs to exactly ONE shipping profile (assigning it to a custom profile removes it from General; no fall-through). If no zone in that profile covers the destination, checkout is blocked for that cart ("shipping not available"). Source: help.shopify.com shipping profiles + troubleshooting. This is the native mechanism that makes unfulfillable routes genuinely unbuyable, with no plan gate and no Shopify Functions.~~ **INVALIDATED on this store (verified at real checkout 2026-06-26).** Managed Markets is ON and **backfills** any destination a custom profile does not cover with carrier-calculated rates (FedEx/DHL), so a missing zone does NOT block checkout for international destinations. The zone-omission mechanism only holds for the **UK merchant-managed market** (which our profiles own). Unfulfillable-order prevention moves to per-market product availability - see the [reframe section](#managed-markets-reality--per-market-product-availability-reframe-verified-2026-06-26).
3. **CJ warehouse model (direct API probe, 2026-06-26).** Warehouses are domestic-only EXCEPT CN. GB->GB / US->US / DE->DE work (fast, ~$0); cross-border from a local warehouse returns ZERO options. CN is the only global cross-border hub (CN->GB/US/DE/ES/IT/IE/SE/BE/CA/AU/BR ~$8-11 / 8-12 days), with gaps at FR and NL in the sample. GB-warehoused products are GB-only (16/16 sampled origins were {GB}, no CN fallback).
4. **Catalog origin-signatures (remote D1, 2026-06-26).** Over 92 imported+linked products there are exactly **4 distinct signatures**: `CN` (49), `GB` (40), `US` (2), `CN,US` (1). "Few" is confirmed; this maps to 4 delivery profiles, not dozens.

## Managed Markets reality + per-market product-availability reframe (verified 2026-06-26)

### What the live store actually does

Markets are **not** UK-only. Active markets (verified at real checkout + Admin API):
- **United Kingdom** - primary, **merchant-managed**. Our delivery profiles OWN it. Verified at checkout: CN->UK shows **GBP 3.41**, GB->UK shows **GBP 0** (exact nearest-warehouse formula match - the solid, verified win).
- **European Union** - Managed (27 regions).
- **United States and Canada** - Managed (one market spanning both countries).
- **Australia** - Managed.

**Managed Markets is ON, and it backfills.** For any destination a custom delivery profile does not carry a zone for, Managed Markets surfaces carrier-calculated rates (FedEx/DHL) so the cart still checks out. Proven by driving real checkouts: a GB-only product to a German address shows FedEx GBP 15.95 + DHL EUR 39.95 (a **sellable-but-unfulfillable** order, since CJ ships GB-warehoused products GB->GB only); a CN product to Germany shows ~EUR 5.95 (fulfillable). The legacy `/cart/shipping_rates.json` AJAX API does NOT reflect Managed Markets and returned a false "blocked" for non-UK destinations - **always verify international via a real checkout (Playwright), never the legacy API.** Owner decision: **keep Managed Markets ON.**

Consequence: the static-profile "omit zone => block" mechanism (verified-fact #2) is invalid for international destinations here. Unfulfillable-order prevention moves to the per-market **product-availability** layer.

### The reframe: exclude unfulfillable products per market (market catalogs)

Shopify's native per-market product-availability is **market catalogs**. Documented merchant flow: **Markets > Catalogs > create a catalog for a market > "By default, all products are included. To exclude a product, select its checkbox, and then click Exclude from catalog,"** or bulk via CSV (a `Published` column, `FALSE` to exclude). A product excluded from a market's catalog is **hidden from the storefront, omitted from search, blocked from add-to-cart, and removed from the cart when the buyer enters a shipping address in that market** - checkout-level enforcement that Managed Markets' shipping backfill cannot re-introduce (the product is gone from the cart, so there is no line to rate). API equivalent: `publicationUpdate(publishablesToRemove: [...])` on the **market catalog's publication**.

**Managed-Markets caveat - verification status (DO NOT over-claim).** The catalog/exclusion mechanism is documented to apply across Shopify Markets AND Managed Markets, and the only Managed-Markets-specific locks found are on **pricing/currency** (`MANAGED_MARKET` GraphQL error = "the market manager has exclusive control of pricing"); the Managed Markets *requirements-and-considerations* help doc lists many limitations (no subscriptions, no B2B, no free orders, prepaid duties, ...) but **none on product availability / catalog control.** HOWEVER this is **documented-for-standard-markets, UNVERIFIED-for-managed on this store**: there are currently **no market catalogs** here (the Admin API shows only the 3 sales-channel publications - Online Store / POS / Shop - each with `catalog: null`; product availability per market is presently inherited from the Online Store channel), and the `read_markets` scope needed to inspect/create them is denied to our tokens. The `MANAGED_MARKETS_CATALOG_NOT_ALLOWED` error ("catalogs created by Managed Markets cannot be added to a market") is a genuine risk signal, not noise. **Do not assert it works until the linchpin test passes.**

**Linchpin test (owner-gated, mirrors the old Phase 0):** owner creates a catalog for the EU managed market and excludes ONE GB-only product; then Playwright-checkout (a) that GB product to a German address - it must be blocked / removed from cart - and (b) a CN product to Germany - it must still sell. If a merchant-controlled catalog **cannot be created or attached** to a Managed market, STOP and rethink before touching the other 41 products. The same single test simultaneously confirms the caveat and begins the real fix.

### Coverage + residuals (CJ source-verified 2026-06-26)

The reframe cleanly solves the bulk, but **Managed Markets group countries coarser than CJ's per-route reality**, leaving per-country residuals inside the multi-country managed markets:

- **GB-only (40) - CLEAN, fully solved.** GB warehouse is domestic-only (GB->GB ~$0; GB->US/DE/anything returns 0 CJ options). UK is its own market. Exclude all 40 from the EU + US/CA + AU markets => sellable only to the UK, their only fulfillable destination. No residual. This is ~95% of the exposure (40 of the 42 problem products).
- **US-only (2 dog-multivitamin supplements) - residual to Canada.** Verified on both products: US->US works (Yunexpress, $0, 3-5d); **US->CA / US->GB / US->DE all return 0 CJ options.** But the managed market is **"United States and Canada"** (one market) - you cannot exclude from Canada while keeping the US. Excluding from EU + AU still leaves them sellable-but-unfulfillable to Canada. Owner decision (these are 2 niche products, one literally titled "Do Not Sell On Amazon Dog Multivitamin"): accept + monitor the small Canada exposure / delist them / split US and CA into separate markets if Managed Markets permits.
- **CN (49) + CN+US (1) - stay in all markets, small EU per-country residual.** The CN hub reaches GB/US/CA/AU/DE and most of the EU (CN+US cat-scissors verified CN->CA/DE/FR all fulfillable). Exception: a handful of CN **ingestibles/supplements** have per-country EU gaps (verified on our catalog: *Dog Itching Relief Supplement* CN->FR=0 and CN->NL=0; *Dog Vitamin Supplement* and *Dog Prebiotics Snacks* CN->NL=0; *Ear Drops* and general goods reach all EU sampled). The EU managed market is one market (27 regions) - you cannot exclude only FR/NL. Owner decision for the ~3-4 affected CN health products: accept the small FR/NL exposure / pull them from the entire EU market (loses ~25 fulfillable EU regions) / plan-upgrade to a CarrierService for per-destination blocking.

### Granularity tradeoff (the core insight)

The original static-profile design expressed fulfillability **per-country** (zone omission) but is defeated by Managed Markets backfill (cannot block). Per-market product availability genuinely **enforces** (checkout removes the excluded product) but is only **per-market** (country-group) granular. The reframe trades granularity for real enforcement: it fully fixes the 40 GB-only (UK is its own market) and most of the rest, leaving the small per-country residuals above inside the EU and US/CA managed markets that only a plan upgrade (CarrierService) or market restructuring could close.

### Execution path (owner-admin first; verification doubles as the fix)

Lead with the **owner / admin-UI path** - it needs no API scope add, no re-auth, no worker code, and the first exclusion IS the linchpin test:
1. Owner: Markets > Catalogs > create a catalog for **European Union**, **United States and Canada**, and **Australia** (the three managed markets).
2. Exclude per market (product lists exportable via `listSignatureMemberships`):
   - **European Union** catalog: exclude the **40 GB-only + 2 US-only** (the US-only supplements are unfulfillable to the EU: US->DE/anything = 0 CJ options).
   - **Australia** catalog: exclude the **40 GB-only + 2 US-only** (same reason).
   - **United States and Canada** catalog: exclude the **40 GB-only only**. KEEP the 2 US-only here (US is their only fulfillable market; US/CA is one market so they cannot be excluded from Canada alone - that is the documented Canada residual).
   - The 49 CN + 1 CN+US products stay in every market (CN hub fulfills them), except the optional EU-FR/NL residual decision for the ~3-4 CN ingestibles.
3. Use the CSV bulk path (export each catalog, set `Published=FALSE` for the excluded handles, re-import) for the 40-row edits rather than clicking 40 checkboxes.
4. Re-run the linchpin Playwright checkout proofs after the EU catalog exists.

**Worker-automation path (only after the admin path is proven):** `publicationUpdate(publishablesToRemove)` on each managed market's catalog publication, driven by `listSignatureMemberships`. It needs **`read_markets` + `write_markets` added to the app scopes** (to discover/attach the market catalog publications) on top of the `write_publications` the app already has, plus a merchant re-auth. It may also hit `MANAGED_MARKETS_CATALOG_NOT_ALLOWED`. Do not build it until the admin path confirms a merchant catalog can be attached to a Managed market.

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
   - not fulfillable -> omit the zone. **NOTE (2026-06-26): omitting the zone no longer blocks checkout** for international destinations because Managed Markets backfills it with carrier rates (see the reframe section). Zone presence/pricing still governs the **UK merchant-managed market** (which the profiles own); unfulfillable-international blocking is handled by the per-market product-availability reframe, not by zone omission.
3. Assign each product's VARIANTS to its signature's profile via `variantsToAssociate` / `variantsToDissociate`, diffing current membership.

This generalizes the existing `ensureGbLocalProfile` / `syncGbProfileMembership` (`src/shipping/delivery-profile.ts`) from one GB profile to N signature profiles. The `{GB}` profile becomes UK-only (its bad zones already removed in Phase 0). Each profile's per-zone rate encodes the nearest-warehouse cost for that destination, so the static profile is simply the cached output of the formula, refreshed nightly.

## Why this is "only real and defensible"

- The customer is charged exactly what is quoted (quote == checkout), both derived from the same resolver over the same `cj_logistics` rows.
- Delivery time is CJ-grounded (existing door-to-door band model).
- Unfulfillable routes are made unbuyable by **per-market product exclusion** (market catalogs), so the shop never sells an order it cannot fulfill. (Zone omission was the original mechanism but is defeated by Managed Markets backfill on this store - see the reframe section. Residual: per-country gaps inside a multi-country managed market, e.g. US-only -> Canada, CN ingestibles -> FR/NL, cannot be excluded at sub-market granularity; owner decisions, documented in the reframe section.)
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
