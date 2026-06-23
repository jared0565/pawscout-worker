# Active Paw Affiliate Program - Gates, Eligibility Ruleset & Launch Prerequisites

**Date:** 2026-06-20 · **Companion to:** `docs/affiliate-program-analysis.md`
**Hardened** after a 3-lens adversarial review (compliance / enforceability / gaming): 6 Critical + 7 Important loopholes closed - see the change-notes inline (🛡️).
**Principle:** the whole program is a machine for separating **incremental** sales (net-positive) from **non-incremental** ones (margin give-away). Each rule is a *gate* that does that, at one of three stages, plus the terms that cap legal/fraud exposure. **Nothing here is enforceable until Part D (prerequisites) is done - and several "rules" are deliberately marked as manual/contractual because no Shopify affiliate app can enforce them automatically.**

> ⚠️ **Two honesty notes from the review:** (1) The named apps (UpPromote / Refersion) **cannot read product COGS and cannot see cross-channel attribution** - so the £6-margin gate and owned-channel de-dup are NOT automatic app rules; they are a manual SKU allowlist and the Gate-3 holdout test respectively. (2) **Get a UK solicitor to review the agreement** before use - clawback/penalty clauses against individuals engage the *Cavendish v Makdessi* penalty doctrine and Consumer Rights Act 2015 unfair-terms rules.

---

## Part A - Gate 1: Admission (who gets in) - the biggest lever, enforced at the door

| | Partner type | Action |
|---|---|---|
| ✅ | Pet content/review creators, "best X for dogs" sites, breed/care bloggers, pet TikTok/IG/YouTube/UGC creators with a real, **verified**, pet- and UK-relevant audience | **Accept (manual)** - they introduce net-new audiences (substitute for paid ads) |
| ⛔ | Coupon/voucher/deal sites, cashback portals, loyalty programs, browser extensions/toolbars (Honey-type), discount-code SEO pages, "we'll generate sales for commission" cold pitches with no named audience | **Auto-decline** - 66-71% non-incremental; they harvest demand you already created |

**Vetting checklist (reject on any red flag), at approval AND monthly:**
- [ ] **Identity + reach verified** before any commission/gift (handle ownership, audience size, engagement screenshots) - 🛡️ *closes the "fake low-reach identities under the per-creator cap" exploit*
- [ ] Original content that mentions/reviews products (not a coupon/redirect/look-alike page)
- [ ] Audience pet-relevant and UK-relevant (or your shipping markets)
- [ ] **No brand bidding AND no brand-term organic optimisation** on "Active Paw" / misspellings / "Active Paw review|discount" - 🛡️ *the review found organic brand interception is invisible to a paid-search monitor*
- [ ] Traffic not single-source / not implausible (≈100% conversion = fraud flag)

**No auto-approval.** Type-based filtering at the door is necessary but **not sufficient** - a "clean" creator can still behave like a cashback portal (see anti-rebate, E.9). Gate 3 is what proves they didn't.

---

## Part B - Gate 2: Commission eligibility (what's actually paid)

| Rule | Setting | How it's actually enforced | Prereq |
|---|---|---|---|
| **Rate** | 8% of **net** product revenue | App commission rule | - |
| **Base** | **Ex-VAT (20%), ex-shipping, ex-refunds** | App base config | #4 |
| **Attribution method** | **Private referral LINK is primary** (requires a click → respects the cookie window). Per-creator codes are **secondary and controlled** | App link + locked code | #5 |
| **New-customer-only** | Full rate on 1st-order customers; **0% on returning** | Shopify full-history customer match (NOT affiliate-only DB) + fingerprint | **#2** |
| **Per-order cap** | lesser of 8% or **£3.50/order** | App cap | - |
| **Per-customer / rolling cap** | aggregate cap per customer & per rolling 7 days | 🛡️ App rolling cap / fraud flag - *closes order-splitting (split a £200 basket into 5 orders to beat the per-order cap)* | #6 |
| **£6/unit margin floor** | **Manually-maintained eligible-SKU allowlist** - only enroll SKUs whose gross − commission ≥ £6; exclude floor-priced SKUs | 🛡️ **Manual list, NOT an app gate** - no affiliate app reads COGS | **#1** |
| **Cookie window** | **7-15 days** | App attribution setting | - |
| **Hold / validation** | **≥ 45 days**; **new affiliates: probationary rolling reserve spanning the ~120-day chargeback window** | 🛡️ App hold + manual reserve - *churn-and-burn affiliates get paid at day 45 then vanish before chargebacks land* | #3, #10 |
| **Clawback** | Auto-reverse on refund / cancellation / chargeback - **against held/unvested commission only** | App clawback toggle | #3 |
| **Coupon stacking** | An affiliate's locked code **must not stack** with any other discount; orders using a **non-affiliate** code earn **0%** | 🛡️ App rule - *reconciles the earlier contradiction (you can't exclude all coupon orders when the code IS the attribution)* | #5 |
| **Owned-channel de-dup** | Branded-search / email-attributable orders → not commissionable | 🛡️ **Largely NOT app-enforceable** (apps can't see cross-channel) → the **Gate-3 holdout** is the real control | #6 |

> **Why net new-customer ex-VAT:** UK prices are VAT-inclusive (~1/6 is tax we remit); returning buyers are least incremental; 10% of revenue ≈ 57% of our net. Every clause pushes the paid mix toward incremental.

---

## Part C - Gate 3: Retention (who you keep) - the only *empirical* gate

| Rule | Trigger | Decision |
|---|---|---|
| **Pause / holdout test** | Before scaling any partner/cohort; **quarterly** on top partners | 🛡️ **Deactivate the CODE *and* commission** in matched UK regions ~4-6 weeks (a live code keeps discounting → confounds the read), confirm the creator can geo-gate, and prefer **whole-cohort** holdouts (national creator content can't be geo-split). Measure lift in **total** orders. |
| **Keep/cut** | Test result | **Keep** only if measured incremental lift clears **I\* = C/51** (at 8%, ≈16%). **Cut** if total revenue doesn't drop when paused. 🛡️ **A confounded/leaky result = do-NOT-scale, not keep.** |
| **Reporting** | Always | **Net-profit-after-commission per partner *category*** - never a blended ROAS, which hides the dilutive tail. |

---

## Part D - Launch prerequisites (MUST be true before any payout rule can run)

- [ ] **#1 - Per-variant COGS maintained offline** (CJ landed cost + freight + FX) → used to build the **manual eligible-SKU allowlist** for the £6 floor. *(No app reads COGS; this gate is a list you maintain, refreshed when costs move.)*
- [ ] **#2 - Full-history new-vs-returning matching, verified to fail the bypass.** On Refersion, upload the **full Shopify customer CSV** (its returning-DB is built only from prior *affiliate* sales, so a 10-time organic buyer counts as "new"); UpPromote checks the full list but is still email-keyed. Add **device/shipping-address/payment fingerprinting**, **disable the 1-hour double-credit window**, and make the test order **attempt a fresh-email guest-checkout bypass**. 🛡️ *the #1 gaming exploit*
- [ ] **#3 - Hold ≥45 days + clawback-on-refund enabled and verified;** new-affiliate probationary reserve configured (Part B).
- [ ] **#4 - Commission base = net-of-VAT, ex-shipping, ex-refunds.**
- [ ] **#5 - Per-creator PRIVATE referral links primary; codes secondary, single-affiliate-locked, NOT listed on aggregators** (see E.5/E.6). Rate-limit/rotate codes; monitor leakage (code string + "Active Paw discount" SERPs). 🛡️ *a public code can be posted to RetailMeNot/Honey and recreates the banned coupon dynamic*
- [ ] **#6 - Fraud/IVT screening; rolling per-customer caps; order-split + same-code burst flags.**
- [ ] **#7 - Brand monitoring covers PAID *and* ORGANIC** SERPs (brand-term ranking, look-alike "Active Paw review/code" pages), not just ad auctions. 🛡️
- [ ] **#8 - Affiliate tracking cookies gated behind the PECR consent banner** (rejection breaks attribution - budget for it).
- [ ] **#9 - Seeding gated on VERIFIED, PERMANENT delivery:** require a non-expiring, linkable post with upfront `#ad gifted` disclosure by a deadline; **identity/reach verified before the first gift**; further seeding/commission **blocked until prior delivery confirmed**; offset future commission for non-delivery. 🛡️ *gifted COGS is irreversible - "never post / 24h story / post-then-delete" must be designed out*
- [ ] **#10 - Affiliate-cohort dispute-rate monitor** (separate from blended 3% refunds) to protect Shopify's ~1% chargeback threshold (20% reserve / 120 days).

---

## Part E - Binding compliance clauses (into the agreement - **subject to UK solicitor review**)

1. **Disclosure (ASA):** clear **`#ad`** / **`#ad gifted`** **upfront**, before any "see more". *(We are jointly liable for an affiliate's undisclosed ad.)*
2. **No brand bidding *or* brand-term organic interception:** "Active Paw", misspellings, variants and "review/discount/code" combinations as negative keywords **and** no SEO optimisation or look-alike pages targeting them. Paid + organic SERP monitoring active; breach → clawback of **held** commission + removal. 🛡️
3. **No cookie-stuffing / forced clicks / auto-redirect.**
4. **No self-referral** (incl. fresh-email/guest-checkout variants); fingerprint + pattern monitoring + clawback.
5. **No generic code distribution; codes are single-affiliate-locked and must not stack** with other discounts.
6. **No listing of codes/links on coupon/cashback aggregators or browser extensions;** breach → clawback + removal. 🛡️
7. **VAT (split by status):** VAT-**registered** affiliates → network self-billing (20%); **unregistered** (most micro-influencers under the £90k threshold) → **plain commission statement, no VAT**; **non-UK** B2B → reverse charge. Confirm with accountant. 🛡️
8. **Validation period + clawback** apply to all commissions; refunded/cancelled/disputed orders earn nothing. Clawback reaches **held/unvested commission only** (not already-paid sums) to stay within UK penalty/unfair-terms law. 🛡️
9. **No customer rebating/kickback:** the affiliate must not pass back any commission, cash, or incentive to purchasers (a private rebate recreates a cashback portal inside the program). Breach → clawback + termination. 🛡️ *closes the "use my code, I'll PayPal you £5 back" loophole*
10. **No unauthorised use of brand name, logo, or look-alike domains.**
11. **No false UK-dispatch / origin claims:** affiliates must not state or imply that Active Paw ships, dispatches, holds stock, or manufactures **in the UK**, nor quote UK-style delivery speeds (e.g. "next-day", "2-4 day UK"). Products are fulfilled by our supplier from outside the UK (China; ≈8-15-day transit). Approved framing: "ships internationally" / "delivered to your door"; **prohibited:** "UK dispatch", "sent from our UK warehouse", "UK stock", "UK fast delivery". Breach → commission void + removal. 🛡️ *(Governing rule - customer-facing claims must be real & defensible. Only a specific SKU **verified CJ-UK-warehoused at source** may carry a narrow per-SKU fast-UK claim - never a blanket program framing.)*

---

## Part F - Pre-flight (the methodology's "Step 0")

Before recruiting: **validate a repeat-buying base / retention engine exists.** We lack subscription LTV, so each affiliate sale must pay back on *order one* - build email/reorder/bundle (or a consumables subscription) first, or keep the program **small and incrementality-gated** until it does.

---

### One-line summary
**Gate 1 picks who (decline coupon/cashback, verify creators) · Gate 2 fences what's paid (8% net, new-customer-only, manual £6-floor allowlist, rolling caps, probationary reserve, clawback) · Gate 3 proves it (deactivate-code holdout, keep only if lift > C/51) - codes are controlled not public, rebating/organic-interception are banned, and none of it runs until Part D plumbing exists or beyond what the apps can actually enforce.**
