# PawScout / Active Paw — Task Tracker

Single source of *what's left*. Detail and rationale live in `WAREHOUSE_PLAN.md`
(section refs below); this file is the prioritized checklist. Owner: **PS** = the
worker/agent can do it; **You** = needs a human action or decision.

Last updated: 2026-06-14.

---

## 0. In progress — verify now

- [ ] **Run the two Maintenance sweeps + verify** (PS verifies after you click).
      After redeploy, click *Rewrite legacy descriptions* then *Fix default
      images*. PS then reads D1 `llm_usage` + spot-checks descriptions and
      `hero_sig` metafields to confirm the catalog is clean and nothing failed.
      → WAREHOUSE_PLAN 7a-i-k / 7a-i-m.

## 1. Robustness hardening — stop known issues recurring (PS)

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
      a different mapped collection — mixed/no signal is left alone, so it never
      overrides a reasonable LLM placement. Nightly + console "Re-file
      categories" button → POST /api/categories. LLM-free.

## 2. Deferred decisions — your call (You, then PS executes)

- [ ] **Thin the near-duplicate clusters.** ~6 silicone bath brushes, ~7 grooming
      brushes, 3 towels, 2 finger toothbrushes. Pick how many of each to keep;
      PS archives the rest. Best done with the image-quality signal/sales data.
- [ ] **"Electronic dog toy"** (`…15911762`) — useless title + suspect "age 3+"
      spec. Review the images; retitle or archive (may not be a real dog product).
- [x] **Finalize pricing** — LOCKED at **2.7×** (2026-06-14): ≈20% net on
      cost-bound items, higher blended (the £6.99 min-margin floor governs the
      cheap majority). Already live in `tenant_config.pricing`; code default left
      at 2.5× (the per-tenant choice lives in D1). Re-sync to lock prices, then
      checkout can go on. → 7a-ii.
- [ ] **Add-on lane** — now overlaps the main $0.50 band; decide keep / repurpose /
      retire. → 7a-i-j (side effect note).

## 3. Pre-launch — mostly you (You)

- [x] **Pricing locked** (2.7× — see §2).
- [ ] **Re-enable checkout** — pricing is decided. Steps: (1) run *Sync now* to
      lock all live prices to 2.7×; (2) Settings → Payments → activate the
      payment provider (merchant-only, not API); (3) if the store is
      password-protected, Online Store → Preferences → remove the password.
- [ ] **Cookie-consent banner** (PECR/GDPR) — Shopify setting.
- [ ] **reCAPTCHA on the contact form** — Shopify setting.
- [ ] **Set a shop phone** — else the privacy-policy template renders a blank
      "call {{ phone }}" line. → 7a-i (policy note iv).

## 4. Unbuilt phases — when there are orders/data (PS, designed not built)

- [~] **W-FULFIL** — order → CJ fulfilment automation (auto-fulfil w/ guardrails).
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
      - [ ] **PREREQS (You — start now; one is slow):** (1) Protected customer
            data approval (app config) — without it the address is redacted and we
            can't fulfil; (2) add `read_orders` + `write_merchant_managed_fulfillment_orders`
            scopes, then clear `tenants.access_token_enc` to re-mint; (3) top up
            the CJ wallet. Deploy needs `npm run migrate:remote` (new 0007).
            **App config lives here (Dev Dashboard, real app):**
            https://dev.shopify.com/dashboard/221233114/apps/378577780737/versions
            (edit via new version → Release. NOT the empty `0416eedd` duplicate in
            org 4969856 — see WAREHOUSE_PLAN §8 Admin links.)
      - [ ] **Stage B (PS, after prereqs + CJ API verified via relay):** the queued
            cron → `createOrderV2` + `payBalance`, store `shopifyOrderId↔cjOrderId`,
            tracking poll → Shopify `fulfillmentCreate`, balance-low alert. → 7a-iv F4–F8.
- [ ] **W6** — automated CJ damage/claims pipeline (consumes W-FULFIL mapping).
      → 7a-iii / 7a (claims).
- [ ] **W5** — Resend email marketing (opt-in, GDPR/PECR). → 7b.
- [ ] **W4** — intelligence digest; needs ≥2 weeks of live data first. → §7.
- [ ] **CJ category-browse replenishment** — supply is keyword-driven only today.

## 5. Verification debt — confirm against live, not assumed (PS)

- [ ] **"dog toy" fills to 12 on the live grid** after the $0.50 floor — proven by
      supply (25 clean candidates) but not observed on the rendered grid. → 7a-i-j.
- [ ] **`freightCalculate` live response parse** — params from docs mirror, not yet
      exercised against the live API on a real replenishment. → 7a-ii.

## 5b. API-version debt (PS — do WITH the next Shopify API bump)

- [ ] **`inventorySetQuantities` → drop `ignoreCompareQuantity`** (Shopify monitoring
      flagged it 2026-06-14; removed in API 2026-04; deadline ~Jan 2027 / 2025-07
      sunset ~mid-2026). We currently call API **2025-07** (`LATEST_API_VERSION`),
      where it still works — do NOT change it standalone (the replacement field
      isn't valid on 2025-07 and would break the nightly sync). When
      `@shopify/shopify-api` is upgraded to a 2026-04+ API version, replace the
      top-level `ignoreCompareQuantity: true` with a per-quantity
      `changeFromQuantity: null` in `src/proxy/inventory.ts` (code comment marks
      the exact spot). Re-run the inventory-sync tests after.

## 6. Future / rollout (PS, recorded for later)

- [ ] **White-label decoupling** — retire the `4qkudm-ez.` shop-sniff / hardcoded
      "Active Paw"/"PawScout" strings; make brand a per-tenant setting. Keep the
      theme a reusable, Shopify-standards-compliant theme. → 7c.

---

### Recently completed (this session)
- Robustness: mechanical pet-relevance floor + dedupe-at-admission + category
  re-audit — closes the non-pet-during-LLM-outage hole, the duplicate-flooding
  gap, and category drift. (All three hardening items above are LLM-free.)
- Search relevance fix (listV2 id-field, species gate, $0.50 floor) — verified.
- `cj-cat-` → `cj-pet-` tag rename (code + live data + collections + config).
- Vision hero-image QA at import + nightly sweep + `hero_sig` cost guard.
- `reconcileDescriptions` LLM sweep (legacy raw-CJ descriptions; claim-safe).
- Archived 6 non-pet products + 1 duplicate; pipeline-cleaned so they can't revive.
- Category fixes: dental→health, tug-ball→toys, nail care + dry combs → grooming.
- Batched sweeps with progress bar; retired the superseded sanitize button.
- Confirmed all 6 shop policies live and compliant.
