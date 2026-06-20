# Active Paw Affiliate Program — UpPromote Setup & Configuration Checklist

**Date:** 2026-06-20 · **App LOCKED:** UpPromote Grow (task 1.4) · **Companions:** `affiliate-program-terms-and-ruleset.md` (the rules this implements), `affiliate-program-analysis.md` (economics), `affiliate-program-task-list.md` (sequence)

This is the **configuration spec**: it translates the hardened ruleset into the exact UpPromote settings (and the manual controls UpPromote can't enforce). It is NOT a "do it today" list — apply it only once the prerequisites in §4 are met. UI labels in UpPromote drift; where a label is named below, **verify it against the current UpPromote UI** rather than trusting the string.

> **Honesty note carried from the app comparison:** UpPromote natively enforces *most* of Gate 2, but **three anti-abuse rules have no native setting** (caps, fresh-email new-customer, fraud/leak screening). §2 is how we cover them manually at pilot scale. §5 is the trigger to stop relying on manual controls.

---

## 0. Account & install — [USER, needs Shopify admin on 4qkudm-ez]

- [ ] Install **UpPromote: Affiliate Marketing** from the Shopify App Store onto the Active Paw store; choose the **Grow** plan (≈ **$29.99/mo + ~2% of referral sales** — confirm the current Grow-tier transaction fee at signup; ~2% is the figure the comparison used).
- [ ] Connect payouts: **PayPal Payouts** primary + **store-credit / gift-card** fallback (both are working UK rails on UpPromote; this was a deciding factor over Refersion's US-only auto-rail).
- [ ] Brand the affiliate portal + all affiliate email to **@activepaw.co.uk** (never the myshopify domain or a sandbox sender).

## 1. Native UpPromote settings → map each ruleset rule to a setting

| Ruleset (Part B) | UpPromote setting | Value |
|---|---|---|
| **Rate** 8% of net product revenue | Commission rule = Percentage | **8%** |
| **Base** ex-VAT, ex-shipping, ex-refunds | Commission base config → exclude tax + shipping | tax + shipping **excluded** |
| **New-customer-only** (0% on returning) | "Only pay commission for **new** customers" toggle + **upload the full Shopify customer list** so matching is against all history, not affiliate-only | ON + full-list match |
| **Attribution** link primary, code secondary | Per-affiliate **private referral link** primary; per-affiliate **locked coupon** secondary | link + locked code |
| **Cookie window** 7–15 days | Referral/cookie window | **14 days** |
| **Coupon no-stacking** | Coupon set to **not combine** with other discounts; non-affiliate-code orders earn 0% | no-combine |
| **Hold / validation ≥45 days** | Auto-approve commission after N days | **45**; **new affiliates → manual approve only** |
| **Clawback** on refund/cancel | "Deduct commission on refunded/cancelled orders" | ON (held/unvested only) |

## 2. The 3 gaps UpPromote can't enforce → manual compensating controls (pilot-scale only)

- [ ] **R6 — caps (no native per-order / rolling cap).** UpPromote only does *tiered/escalating* commission (the opposite of a cap). Control manually: a weekly ledger check flagging same-customer / same-code **order bursts** (the order-splitting tell). The ruleset's £3.50/order + rolling-per-customer caps are a **review rule, not an app setting**.
- [ ] **R1/R7 — fresh-email new-customer bypass.** Full-list matching catches email *reuse*; the residual (a returning buyer using a **fresh email at guest checkout**) is invisible to UpPromote. Control manually: **address/payment review** on flagged new-customer commissions **before** they approve at day 45.
- [ ] **R8 — fraud / IVT / coupon-leak.** No native screening. Control with: Gate-1 manual creator vetting (identity + reach), **monthly redemption-rate** review, **brand-SERP monitoring** (paid + organic — BrandVerity / The Search Monitor, or manual SERP checks for "Active Paw discount/review/code"), and the **Shopify dispute dashboard** to protect the ~1% chargeback threshold.

## 3. Pilot operating cadence (Gate 1 + Gate 3 live around the app)

- [ ] **Gate 1 at the door:** accept only verified UK pet content/creators; auto-decline coupon/cashback/loyalty/extension pitches (incl. inbound commission spam like the samfeezco / gobocreative1 enquiries the inbox surfaces).
- [ ] **Seeding gated on verified permanent delivery** — no further gift/commission until the prior post is confirmed live (#ad gifted, upfront).
- [ ] **Gate 3 holdout:** before scaling any creator, **deactivate the code AND commission** in a matched region / whole cohort ~4–6 weeks; keep only if incremental lift clears **I\* = C/51** (≈16% at 8%, ~20% counting the 2% UpPromote fee). Report net-profit-after-commission **per category**, never blended ROAS.

## 4. Prerequisites that still gate "go configure" — do NOT enter §1 settings before these

- [ ] **Phase 0:** program go/no-go confirmed + 3 numeric targets set (CAC vs paid, net-profit-after-commission > 0, cohort incrementality > ~16–20%).
- [ ] **1.1 + 1.2 [CODE, gated on your go]:** per-variant COGS in Shopify → the **£6-floor eligible-SKU allowlist** that decides *which SKUs to enroll* (floor-priced SKUs excluded — UpPromote can't read COGS, so enrollment is the enforcement point).
- [ ] **1.3 [CODE, parallel, gated]:** retention/reorder flow live or scheduled, so affiliate CAC has LTV to pay back against.
- [ ] **2.1 / 2.2 [EXT]:** solicitor sign-off of the agreement (clawback/penalty + unfair-terms) and accountant VAT split (registered self-bill / unregistered no-VAT / non-UK reverse charge).

## 5. Re-evaluate-at-scale trigger (add to Phase 4)

The §2 manual controls **do not scale**. Before growing past the 5–10-creator pilot, decide between (a) adding worker / Shopify-Flow logic for caps + identity, or (b) moving to a network (Awin) with native fraud + voucher-attribution. Also revisit the fee: **2% of referral sales ≈ ~12% of a 17% net margin** — at volume, a flat UpPromote tier or a network may beat it. The "no custom code / manual controls" stance is a **pilot decision, not permanent**.

---

### One-line summary
UpPromote Grow enforces 8% / new-customer-only / 14-day cookie / locked-no-stack codes / 45-day hold / clawback natively (§1); we cover its three blind spots — caps, fresh-email identity, fraud/leak — with manual review at pilot scale (§2); none of it goes live until COGS/allowlist (1.1/1.2), retention (1.3), and legal sign-off (2.1/2.2) are done (§4); and we re-decide build-vs-network before scaling (§5).
