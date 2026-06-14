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
- [ ] **Category re-audit (optional).** Nothing re-checks the LLM's initial
      collection assignment; mis-files (e.g. dental → grooming) can recur. Cheap
      periodic re-audit or a confidence check at import.

## 2. Deferred decisions — your call (You, then PS executes)

- [ ] **Thin the near-duplicate clusters.** ~6 silicone bath brushes, ~7 grooming
      brushes, 3 towels, 2 finger toothbrushes. Pick how many of each to keep;
      PS archives the rest. Best done with the image-quality signal/sales data.
- [ ] **"Electronic dog toy"** (`…15911762`) — useless title + suspect "age 3+"
      spec. Review the images; retitle or archive (may not be a real dog product).
- [ ] **Finalize pricing** (2.5× vs 2.6× / 20% net target). Gates checkout. → 7a-ii.
- [ ] **Add-on lane** — now overlaps the main $0.50 band; decide keep / repurpose /
      retire. → 7a-i-j (side effect note).

## 3. Pre-launch — mostly you (You)

- [ ] **Finalize pricing → re-enable checkout** (currently disabled by design).
- [ ] **Cookie-consent banner** (PECR/GDPR) — Shopify setting.
- [ ] **reCAPTCHA on the contact form** — Shopify setting.
- [ ] **Set a shop phone** — else the privacy-policy template renders a blank
      "call {{ phone }}" line. → 7a-i (policy note iv).

## 4. Unbuilt phases — when there are orders/data (PS, designed not built)

- [ ] **W-FULFIL** — order → CJ fulfilment automation. Needed BEFORE the first
      order ships. → 7a-iv.
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

## 6. Future / rollout (PS, recorded for later)

- [ ] **White-label decoupling** — retire the `4qkudm-ez.` shop-sniff / hardcoded
      "Active Paw"/"PawScout" strings; make brand a per-tenant setting. Keep the
      theme a reusable, Shopify-standards-compliant theme. → 7c.

---

### Recently completed (this session)
- Robustness: mechanical pet-relevance floor + dedupe-at-admission (the two
  hardening items above) — closes the non-pet-during-LLM-outage hole and the
  duplicate-flooding gap.
- Search relevance fix (listV2 id-field, species gate, $0.50 floor) — verified.
- `cj-cat-` → `cj-pet-` tag rename (code + live data + collections + config).
- Vision hero-image QA at import + nightly sweep + `hero_sig` cost guard.
- `reconcileDescriptions` LLM sweep (legacy raw-CJ descriptions; claim-safe).
- Archived 6 non-pet products + 1 duplicate; pipeline-cleaned so they can't revive.
- Category fixes: dental→health, tug-ball→toys, nail care + dry combs → grooming.
- Batched sweeps with progress bar; retired the superseded sanitize button.
- Confirmed all 6 shop policies live and compliant.
