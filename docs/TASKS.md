# PawScout / Active Paw - Task Tracker

Single source of *what's left*. Detail and rationale live in `WAREHOUSE_PLAN.md`
(section refs below); this file is the prioritized checklist. Owner: **PS** = the
worker/agent can do it; **You** = needs a human action or decision.

Last updated: 2026-06-17.

---

## 0. In progress - verify now

- [ ] **Run the two Maintenance sweeps + verify** (PS verifies after you click).
      After redeploy, click *Rewrite legacy descriptions* then *Fix default
      images*. PS then reads D1 `llm_usage` + spot-checks descriptions and
      `hero_sig` metafields to confirm the catalog is clean and nothing failed.
      → WAREHOUSE_PLAN 7a-i-k / 7a-i-m.

## 1. Robustness hardening - stop known issues recurring (PS)

- [x] **Pet-relevance guard in the mechanical fallback** (done 2026-06-14).
      `isLikelyPetProduct` (search.ts): an explicit pet token admits; with no pet
      signal, a clear non-pet marker (kitchen/garden/human-grooming) rejects;
      ambiguous admits. Enforced on the non-LLM path in `confirmAndImport` and
      `replenishWarehouse`. → 7a-i-m (#5 cause).
- [x] **Dedupe-at-admission** (done 2026-06-14). `titleSignature` (sorted
      significant tokens) computed at warehouse admission against the existing
      stock set; true duplicates / reorderings (incl. the twin teeth-powders) are
      skipped, distinct items survive. → 7a (dedupe backlog note).
- [x] **Category re-audit** (done 2026-06-14). `signaledCategory` (search.ts)
      maps a title to ONE collection from keyword signals; `reconcileCategories`
      (import.ts) re-files a product only when its title points unambiguously at
      a different mapped collection - mixed/no signal is left alone, so it never
      overrides a reasonable LLM placement. Nightly + console "Re-file
      categories" button → POST /api/categories. LLM-free.

## 2. Deferred decisions - your call (You, then PS executes)

- [ ] **Thin the near-duplicate clusters.** ~6 silicone bath brushes, ~7 grooming
      brushes, 3 towels, 2 finger toothbrushes. Pick how many of each to keep;
      PS archives the rest. Best done with the image-quality signal/sales data.
- [ ] **"Electronic dog toy"** (`…15911762`) - useless title + suspect "age 3+"
      spec. Review the images; retitle or archive (may not be a real dog product).
- [x] **Finalize pricing** - LOCKED at **2.7×** (2026-06-14): ≈20% net on
      cost-bound items, higher blended (the £6.99 min-margin floor governs the
      cheap majority). Already live in `tenant_config.pricing`; code default left
      at 2.5× (the per-tenant choice lives in D1). Re-sync to lock prices, then
      checkout can go on. → 7a-ii.
- [ ] **Add-on lane** - now overlaps the main $0.50 band; decide keep / repurpose /
      retire. → 7a-i-j (side effect note).

## 3. Pre-launch - mostly you (You)

- [x] **Pricing locked** (2.7× - see §2).
- [ ] **Re-enable checkout** - pricing is decided. Steps: (1) run *Sync now* to
      lock all live prices to 2.7×; (2) Settings → Payments → activate the
      payment provider (merchant-only, not API); (3) if the store is
      password-protected, Online Store → Preferences → remove the password.
- [ ] **Cookie-consent banner** (PECR/GDPR) - Shopify setting.
- [ ] **reCAPTCHA on the contact form** - Shopify setting.
- [ ] **Set a shop phone** - else the privacy-policy template renders a blank
      "call {{ phone }}" line. → 7a-i (policy note iv).

## 4. Unbuilt phases - when there are orders/data (PS, designed not built)

- [~] **W-FULFIL** - order → CJ fulfilment automation (auto-fulfil w/ guardrails).
      - [x] **Stage A (built 2026-06-14):** `orders/paid` webhook (`registerWebhooks`
            + `/webhooks/orders-paid`), `orders` table (migration 0007), order
            parse + guardrail validation (`src/fulfil.ts`: unmapped-items,
            incomplete-address, high-risk, over-£100, not-paid → hold; else queued
            w/ 60-min grace), console **Fulfilment** card + `/api/orders` /
            `/api/order-action`. Idempotent on webhook retries. No money leg yet.
            **VERIFIED LIVE 2026-06-14** via a draft-order-marked-paid (#1001):
            webhook fired → validated → **queued** with the full shipping address
            present (protected data flows; not redacted) and line item mapped to
            its cjPid. Test order then marked cancelled in D1.
      - [ ] **PREREQS (You - start now; one is slow):** (1) Protected customer
            data approval (app config) - without it the address is redacted and we
            can't fulfil; (2) add `read_orders` + `write_merchant_managed_fulfillment_orders`
            scopes, then clear `tenants.access_token_enc` to re-mint; (3) top up
            the CJ wallet. Deploy needs `npm run migrate:remote` (new 0007). (Historical: that script is now `migrate:remote:raw`, and deploys go through `docs/RUNBOOK-DEPLOY.md`.)
            **CJ wallet funding (updated 2026-06-15):** wire min **$2000** (too
            high); **Payoneer DROPPED** by owner (too cumbersome - KYC/docs not
            worth a one-off). Path forward = **PayPal top-up via CJ support**
            (see the drafted request in §4b). INTERIM until any wallet is funded:
            AP runs `pawscout` mode but with NO balance `payBalance` fails, so the
            desired interim behaviour is **PS creates the CJ order + notifies the
            owner, who pays it manually in CJ** - see the build note in §4b.
            **App config lives here (Dev Dashboard, real app):**
            https://dev.shopify.com/dashboard/221233114/apps/378577780737/versions
            (edit via new version → Release. NOT the empty `0416eedd` duplicate in
            org 4969856 - see WAREHOUSE_PLAN §8 Admin links.)
      - [x] **Stage B (built 2026-06-15):** CJ order methods (`createOrder`,
            `payBalance`, `getOrderDetail`, read-only `getOrderList`) in cj.ts;
            `processDueOrders` (resolve `vid` from sku → createOrderV2 →
            payBalance, retry-safe via `cj_order_id` guard) + `pollTracking` →
            Shopify `fulfillmentCreateV2` with tracking, in `src/fulfil-run.ts`;
            every-15-min cron (wrangler.toml). **White-label `fulfilMode` toggle**
            (migration 0008, JSON `fulfil` column; DEFAULT 'manual'):
            `manual` = queue only; `pawscout` = PS creates+pays+tracks (the money
            leg, requires CJ native order-import OFF); `cj` = CJ's own app fulfils,
            PS stays out. Console Fulfilment card = 3 mode buttons (2-click confirm
            on `pawscout`) + read-only "Verify CJ order API". Read-only verify
            CONFIRMED CJ field names + that CJ's native sync already imports orders
            correctly (order #1001: right address). 239 tests.
            GO-LIVE: deploy → "Verify CJ order API" → fund CJ wallet → set mode to
            `pawscout` (after turning OFF CJ native import) OR `cj` (use CJ's app).
- [ ] **W6** - automated CJ damage/claims pipeline (consumes W-FULFIL mapping).
      → 7a-iii / 7a (claims).
- [ ] **W5** - Resend email marketing (opt-in, GDPR/PECR). → 7b.
- [ ] **W4** - intelligence digest; needs ≥2 weeks of live data first. → §7.
- [ ] **CJ category-browse replenishment** - supply is keyword-driven only today.

## 4b. CJ payment - interim plan + PayPal request (2026-06-15)

**Decisions:** AP = `pawscout` mode (set in D1), CJ native order-sync to be
**uninstalled** (PS sole bridge). Payoneer dropped.

- [ ] **You - uninstall the CJ Shopify app** (admin → apps → CJdropshipping →
      Uninstall) to stop CJ auto-importing orders. Safe: PS uses the CJ **API
      key** (not the app), so search/import/inventory/fulfilment are unaffected.
- [ ] **You - send CJ this PayPal request** (paste; fill the bracket):
      > Subject: Enable PayPal top-up for my CJ wallet
      > Hi CJ team - I'd like to fund my CJ wallet by PayPal. The wire-transfer
      > minimum ($2000) is too high for my current volume and Payoneer isn't
      > workable for me. Please (1) enable PayPal as a top-up method on my account
      > and send the PayPal top-up details, and (2) advise any low-minimum or
      > auto-recharge PayPal option for order payment. CJ account: [your CJ email].
      > Connected store: activepaw.co.uk. Thanks!
- [x] **PS - "create + notify, manual-pay" interim (built 2026-06-15).** In
      `pawscout` mode AP can fulfil before the wallet is funded. New `createOnly`
      sub-flag on the `fulfil` config (`{mode,createOnly}`): when ON, PS **creates**
      the CJ order and stops, leaving it status **`awaiting-payment`** with its
      `cj_order_id` set. **Safety net** (even with createOnly OFF): if `payBalance`
      fails for insufficient balance, the created order is downgraded to
      `awaiting-payment` instead of `error` (a non-balance pay error still errors).
      The owner pays the order in CJ; `pollTracking` now also polls
      `awaiting-payment` orders, so tracking still writes back + marks fulfilled.
      **Notification (interim):** the console Fulfilment card shows a red banner
      "N order(s) created in CJ awaiting your payment" listing the CJ order ids,
      and each row shows its `CJ <id>`. Email is still pending W5/Resend.
      Console has a **Create-only: ON/OFF** toggle (PawScout mode only).
      **AP is live on `{"mode":"pawscout","createOnly":true}`** (set in D1
      2026-06-15). 243 tests. Takes effect on next deploy.
- [x] **PS - awaiting-payment owner email (built 2026-06-15).** When an order
      enters `awaiting-payment`, PS emails the owner once (order name, total, CJ
      order id, pay link) so they can pay in CJ ASAP. `src/email.ts` `sendEmail()`
      (Resend, `RESEND_API_KEY` secret) + a `notify` callback injected into
      `processDueOrders` (best-effort - a send failure never fails the order;
      the order is not reprocessed, so it emails exactly once). Recipient =
      `fulfil.alertEmail` (console **Save alert email** / **Send test email**
      buttons + `/api/test-email`). **AP live alertEmail = fbm2k11@gmail.com**
      (the Resend account address - required while sending from the shared
      `onboarding@resend.dev`; verify activepaw.co.uk in Resend to send from the
      domain to anyone). 250 tests. Takes effect on next deploy.

## 5. Verification debt - confirm against live, not assumed (PS)

- [ ] **"dog toy" fills to 12 on the live grid** after the $0.50 floor - proven by
      supply (25 clean candidates) but not observed on the rendered grid. → 7a-i-j.
- [ ] **`freightCalculate` live response parse** - params from docs mirror, not yet
      exercised against the live API on a real replenishment. → 7a-ii.

## 5b. API-version debt (PS - do WITH the next Shopify API bump)

- [ ] **`inventorySetQuantities` → drop `ignoreCompareQuantity`** (Shopify monitoring
      flagged it 2026-06-14; removed in API 2026-04; deadline ~Jan 2027 / 2025-07
      sunset ~mid-2026). We currently call API **2025-07** (`LATEST_API_VERSION`),
      where it still works - do NOT change it standalone (the replacement field
      isn't valid on 2025-07 and would break the nightly sync). When
      `@shopify/shopify-api` is upgraded to a 2026-04+ API version, replace the
      top-level `ignoreCompareQuantity: true` with a per-quantity
      `changeFromQuantity: null` in `src/proxy/inventory.ts` (code comment marks
      the exact spot). Re-run the inventory-sync tests after.

## 6. Future / rollout (PS, recorded for later)

- [ ] **White-label decoupling** - retire the `4qkudm-ez.` shop-sniff / hardcoded
      "Active Paw"/"PawScout" strings; make brand a per-tenant setting. Keep the
      theme a reusable, Shopify-standards-compliant theme. → 7c.
- [ ] **Mobile app (revisit AFTER launch + real traffic data).** AP is a Shopify
      store, so a mobile app is an ADDITIVE client beside the web storefront - the
      Liquid theme and the worker don't get rewritten. Sequencing (cheap→heavy,
      discussed 2026-06-16):
      1. **Shopify "Shop" app listing** - ~zero code, just enable; customers get
         an app experience with Shopify's cart/checkout.
      2. **PWA** - add manifest + service worker to the theme (NONE exists today;
         theme is responsive only). Purely additive theme files → home-screen
         install + push notifications. Near-zero risk. **Recommended first step.**
      3. **WebView wrapper** (Median/GoNative) - native shell around the responsive
         site; reuses 100% of the storefront. Watch App Store thin-wrapper rejection.
      4. **Fully native / headless** (React Native / Flutter on Shopify Storefront
         API) - months of work. **Only real codebase risk lives here:** PS `/proxy/*`
         endpoints are authed by Shopify App Proxy HMAC (signed only for Liquid
         storefront requests); a native app would need a NEW token-based auth route
         on the worker ALONGSIDE the existing proxy verification (additive - web flow
         untouched). Search backfill/ghost cards/import already exist as worker logic;
         native just needs a second front door, not a rebuild.
      DECISION: premature pre-launch. Launch web → add PWA → go native only if data
      shows app-store presence moves revenue.

---

### Recently completed (this session)
- **HANDOVER.md added (2026-06-17).** Cold-start brief: what AP/PawScout is, what's
  deployed, launch blockers, immediate PS steps, watch items, secrets. Companion to
  this tracker.
- **CJ freight-quote tool (built 2026-06-17, extended same day).** Console
  **Shipping quote (CJ)** card → `POST /api/freight-quote` {pid, country, qty}:
  resolves a representative variant + dispatch origin the way the fulfilment pipeline
  would, calls CJ `freightCalculate`, and returns every logistic line cheapest-first
  in USD + GBP (FX mirrors the pricing rule). Read-only - creates/pays nothing.
  Generalised `cj.freightEstimate` into `cj.freightQuote(vid, from, to, quantity)`
  (destination + quantity now params, both default so admission/import callers are
  unchanged); `freightEstimate` = cheapest of the quote. Country picker is a
  **searchable combobox** (type name or ISO code, grouped, keyboard nav) and a
  **Qty** field threads through to CJ so the quote reflects a real multi-unit
  consignment, not just one unit. Answers "what does CJ actually charge to ship this
  to Spain?" and is the groundwork for destination-aware pricing / live
  carrier-calculated rates (Shopify Grow + $20/mo CCS add-on - see §6). 264 tests.
- **Image vetting: drop incongruent images, not just reorder (2026-06-15).**
  Root cause of "cat thumbnail on a dog listing": CJ serves the search
  thumbnail (`productImage`) and the detail gallery (`productImageSet`) from
  different fields, populated independently - the card showed the cat, the
  detail the dog. Upgraded the vision pass (`pickHeroImage`, llm.ts) to also
  return a `drop` list of images incongruent with the title (wrong animal,
  unrelated product, duplicate) under an explicit species rule; conservative
  (keeps when unsure). `confirmAndImport` now filters dropped images out before
  upload (rejects a listing if NONE is congruent); the nightly/console image
  sweep (`reconcileHeroImages`) now DELETES incongruent media from Shopify and
  promotes the hero, guarded by the `hero_sig` signature. Signature **versioned
  (v2)** so the existing catalog is re-vetted once. Never empties a gallery;
  the hero is never dropped. **To remediate the live 69 products: deploy, then
  run the image sweep ("Fix default images").**
- **Supplier-grid preview curation - lazy + cached (2026-06-15).** Closes the
  pre-import gap: `curateDetailImages` (import.ts) runs the vision vet once per
  product (cached in `search_cache` under `hero:<pid>` by image-set signature),
  shared by `/proxy/product` (the preview modal now shows the curated, on-title
  image) and the background import (no double vision call). The search grid
  (`searchBackfill`) swaps CJ's raw thumbnail for the cached hero via a batched
  `getHeroImages`, so a "cat on a dog listing" card self-heals after the first
  preview/import. First-ever view of a never-seen product still shows CJ's raw
  thumbnail (no pre-vision of all of CJ - the chosen cost bound). 262 tests.
- **Fulfilment vid-resolution gap fixed (2026-06-15).** Surfaced while prepping
  the live fulfilment test: only 32 of 69 imported products had a
  `warehouse_products` row, and `resolveLine` read the CJ `vid` ONLY from there -
  so ~54% of live orders would have errored instead of being created in CJ.
  `resolveLine` now falls back to a live `cj.detail(pid)` lookup when the
  warehouse row is missing/mismatched. Added `runOrderPipelineForShop` +
  `POST /api/fulfil-run` + console **Run fulfilment now** button for on-demand /
  controlled fulfilment runs. 252 tests.

- Robustness: mechanical pet-relevance floor + dedupe-at-admission + category
  re-audit - closes the non-pet-during-LLM-outage hole, the duplicate-flooding
  gap, and category drift. (All three hardening items above are LLM-free.)
- Search relevance fix (listV2 id-field, species gate, $0.50 floor) - verified.
- `cj-cat-` → `cj-pet-` tag rename (code + live data + collections + config).
- Vision hero-image QA at import + nightly sweep + `hero_sig` cost guard.
- `reconcileDescriptions` LLM sweep (legacy raw-CJ descriptions; claim-safe).
- Archived 6 non-pet products + 1 duplicate; pipeline-cleaned so they can't revive.
- Category fixes: dental→health, tug-ball→toys, nail care + dry combs → grooming.
- Batched sweeps with progress bar; retired the superseded sanitize button.
- Confirmed all 6 shop policies live and compliant.
