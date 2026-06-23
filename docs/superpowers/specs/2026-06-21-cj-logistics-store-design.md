# CJ logistics store (synced delivery-time matrix) - design

**Status:** approved 2026-06-21 (owner decisions below). Source: design workflow `wf_ed198e61-34e` (12 agents, 6-lens adversarial review).

## Goal
Store CJ logistics (delivery **time**) in D1, synced nightly from CJ, so delivery-time queries (drafter, storefront PDP) read from the DB instead of hitting CJ live each time. Governing rule [[customer-facing-only-real-defensible]]: every surfaced figure must be real/defensible, with a safe hedge when unknown - never fabricated.

## Verified facts that shape the design
- CJ `logisticAging` = **transit only** (dispatch→door), CALENDAR-day range, **weight-independent** (route/channel-driven). No processing field exists in any CJ API. CJ processing is policy (~1–3d stocked / 2–5d sourced).
- This catalog is **CN-only** (36/36 pet products probed; 0 GB warehouse). So origin ≈ always CN.
- Customer shipping PRICE is **flat & decoupled** (£4.99 UK / £14.99 EU / £23.99 intl, in Liquid, not tenant config) → the matrix stores **time only, no price**.
- Theme can only read **metafields**, never D1.

## Owner decisions (2026-06-21)
1. **Scope:** Drafter (reads D1, kills the live CJ call) + **PDP** per-product `supplier.delivery_days` metafield + **static units-corrected FAQ** (conservative superset).
2. **Destinations:** **Full ~38 markets** (every unique ISO-2 in `freight.ts COUNTRY_NAMES` + GB).
3. **Cadence:** Full nightly refresh, **fetch-once-fan-out**.
4. **Window width:** **Conservative envelope** (transit + processing + customs + slack) - never under-promise vs today's copy.

## Schema (migration 0014)
`cj_logistics` - one row per `(shop, from_country, to_country)`: `channel`, `transit_min`/`transit_max` (INT calendar days, parsed at write time; NULL ⇒ no-data ⇒ hedge), `aging_raw`, `rep_vid`, `synced_at` (freshness anchor), `consecutive_failures`, `last_error`, `created_at`. Index `(shop, synced_at)`. Added to `redactShop()`. NO price column (keep per-variant `detail.freightUsd` for the pricing floor; **retire** the dead `detail.freightDays`).

## Config (per-field defaults at use site - dodge the shallow-merge NaN)
`Fulfil.logistics?: LogisticsConfig` = `{ processingDaysMin:2, processingDaysMax:5, customsDaysMax:5, transitSlackDays:2, stalenessHours:72 }`. Read via a central `resolveLogistics(cfg)` that coerces each field with a finite-number-or-default guard (NOT relying on `DEFAULT_FULFIL` merge, which is one-level and would drop siblings).

## Core helpers (`src/logistics.ts`, pure)
- `parseDaysRange(raw)` → `{min,max}|null` (handles "4-9", "8~12 days", "N", junk→null).
- `doorToDoorBand(route, logisticsCfg)` → `{min,max}|null`: `min = procMin + transit_min`; `max = procMax + transit_max + (from≠to ? customsMax : 0) + slack`. Null-guards input, `Number.isFinite`-guards output (→ null, never NaN/throw). All CALENDAR days.

**CRITICAL units rule (adversarial catch):** relabelling "N working days" → "N calendar days" at the same integer *tightens* the promise (working days span more wall-clock; "8–12 working days" ≈ 16–17 calendar). So calendar bands must be **widened**. GUARD TEST: assert `doorToDoorBand` CN→GB calendar `max ≥` legacy "8–12 working days" wall-clock (~17 cal), for GB and every in-scope market.

## Sync (`jobs.ts syncCjLogistics`, fetch-once-fan-out)
At the **top** of `runDailyMaintenance`, before the per-shop loop (idle relay window): pick one reference shop's in-stock CN rep vid (reuse warehouse detail; `env.INBOX_FREIGHT_REP_VID` optional override). For each in-scope destination, `cj.freightQuote(repVid,'CN',dest,1)[0]` through the relay, paced; parse aging; **fan out** the same row to every active shop's partition. Per-route failure → keep prior row + `consecutive_failures++` + `last_error`, never null a good row, never throw. Bounded (`maxCjCalls`) + abort-on-3-consecutive-429. Prune removed-market rows. ~38 routes ≈ ~50s once/night.

## Consumption (one source, freshness-gated)
- `store.getLogisticsRoute(from,to,stalenessHours)` → row or **null** when stale (`synced_at` older than `stalenessHours`) OR `transit_min` NULL. Freshness lives in the accessor (`stale == missing == null`).
- **Drafter** (`sweep.ts`/`freight.ts`): read D1 + `doorToDoorBand` → **time-only** line ("Delivery to France: estimated 11–19 days."). Remove the CjClient construction, the live `freightEstimate`, and the misleading £ FX figure. Null → existing safe hedge. Keep forced HITL on a present figure.
- **PDP**: in `syncStoreInventory`, AFTER stock/price writes, compute band for `(chooseOrigin, 'GB')`; write `supplier.delivery_days` as a bare range ("6-21"); **clear** ('') when band null (→ theme static fallback). Theme renders `{{ delivery_days | default: delivery_window }} days`.
- **FAQ**: static, units-corrected **superset** bracketing every PDP band.

## Degradation (code-enforced)
Accessor null-on-stale → drafter hedges / PDP clears → static fallback; sync keeps last-good; cold start = everything null = storefront never blank, never worse than today.

## Build phases (TDD)
0. Validate processing/customs constants vs real order→door - **N/A: orders table has no delivery timestamp** (only created→fulfilled=dispatch). Use conservative documented defaults; revisit if door timestamps ever captured.
1. Pure helpers + parser (TDD; the guard test). 
2. Migration + freshness-gated accessors + redactShop.
3. `syncCjLogistics` fetch-once-fan-out, wired at cron top.
4. Drafter reads D1 (kills live CJ call); delete £ figure; time-only line.
5. PDP metafield in `syncStoreInventory`; retire `detail.freightDays`.
6. Theme: `delivery-info.liquid` + `faq-accordion.liquid` (calendar superset) - mandatory theme-change-process.

## Residual risks
Relay has no cross-invocation serialization (pre-existing; separate hardening). Processing/customs constants are policy guesses (conservative + guard test mitigate). Rep-vid representativeness (true for transit). No resumable cursor (fine at ~38 routes). FAQ static drift (kept a superset). GB-origin future (falls back to static; single origin authority).
