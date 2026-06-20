# Active Paw Affiliate Program — Gates, Eligibility Ruleset & Launch Prerequisites

**Date:** 2026-06-20 · **Companion to:** `docs/affiliate-program-analysis.md`
**Principle:** the whole program is a machine for separating **incremental** sales (net-positive) from **non-incremental** ones (margin give-away). Each rule below is a *gate* that does that, at one of three stages, plus the compliance terms that cap our legal/fraud exposure. **Nothing here is enforceable until Part D (prerequisites) is done.**

---

## Part A — Gate 1: Admission (who gets in) — the biggest lever, enforced at the door

| | Partner type | Action |
|---|---|---|
| ✅ | Pet content/review creators, "best X for dogs" sites, breed/care bloggers, pet TikTok/IG/YouTube/UGC creators with a real, UK-relevant, pet audience | **Accept (manual)** — these introduce net-new audiences (substitute for paid ads) |
| ⛔ | Coupon/voucher/deal sites, cashback portals, loyalty programs, browser extensions/toolbars (Honey-type), "we'll generate sales for commission" cold pitches with no named audience | **Auto-decline** — 66–71% non-incremental; they harvest demand you already created |

**Vetting checklist (reject on any red flag), at approval AND monthly:**
- [ ] Original content that actually mentions/reviews products (not a coupon/redirect page)
- [ ] Audience is pet-relevant and UK-relevant (or your shipping markets)
- [ ] No brand/URL bidding on "Active Paw" or misspellings
- [ ] Traffic not single-source / not implausible (≈100% conversion = fraud flag)
- [ ] Named platform/handle with verifiable reach

**No auto-approval.** Every affiliate is manually accepted.

---

## Part B — Gate 2: Commission eligibility (what's actually paid)

| Rule | Setting | Enforced by | Depends on (Part D) |
|---|---|---|---|
| **Rate** | 8% of **net** product revenue | App commission rule | — |
| **Base** | **Ex-VAT (20%), ex-shipping, ex-refunds** | App base config | #4 |
| **New-customer-only** | Full rate on 1st-order customers; **0% on returning** | Shopify new-vs-returning flag → app | #2 |
| **Per-order cap** | lesser of 8% or **£3.50/order** | App cap | — |
| **£6/unit margin floor** | No commission on any line where (unit gross − commission) < £6; exclude floor-priced SKUs from eligibility | App per-SKU margin gate | **#1** (COGS) |
| **Cookie window** | **7–15 days** (short, on purpose) | App attribution setting | — |
| **Hold / validation** | **≥ 45 days** before payout | App hold period | #3 |
| **Clawback** | Auto-reverse on refund / cancellation / chargeback | App clawback toggle | #3 |
| **Coupon-on-order exclusion** | No commission on any order that used a discount code (unless it's that affiliate's own locked code) | App rule + locked codes | #5 |
| **Owned-channel de-dup** | No commission on orders also attributable to email / branded search | App de-dup / attribution | #6 |

> **Why "net new-customer ex-VAT," not "% of order total":** UK prices are VAT-inclusive, so ~1/6 of a naive base is tax we remit to HMRC; returning buyers are the least incremental cohort; and 10% of revenue ≈ 57% of our net profit. Each clause above exists to keep the paid mix incremental.

---

## Part C — Gate 3: Retention (who you keep) — the only *empirical* gate

| Rule | Trigger | Decision |
|---|---|---|
| **Pause / holdout test** | Before scaling any partner or cohort; **quarterly** on top partners by spend | Pause commissions in matched UK regions ~4–6 weeks; measure lift in **total** orders (not attributed orders) |
| **Keep/cut** | Test result | **Keep** only if measured incremental lift clears **I\* = C/51** for the tier (at 8%, ≈16%). **Cut** if total revenue doesn't drop when paused — that partner was cannibalising. |
| **Reporting** | Always | Report **net-profit-after-commission per partner *category*** (content / creator / coupon / cashback) — **never** a single blended ROAS, which hides the dilutive tail. |

---

## Part D — Launch prerequisites (MUST be true before any payout rule can run)

These are the plumbing the gates above *assume*. Until each is checked, the corresponding rule is aspirational, not enforced.

- [ ] **#1 — Per-variant COGS in Shopify.** Populate Cost-per-item from CJ landed cost (product + freight + FX); refresh when those move. *(Gates the £6 floor + margin-based commission. CJ does not fill this automatically.)*
- [ ] **#2 — New-vs-returning flag wired** into the affiliate app **and verified with a live test order** *(off by default — the highest-leverage control silently fails if unconfigured)*.
- [ ] **#3 — Hold ≥45 days + clawback-on-refund enabled and verified** *(default 30-day hold is shorter than China transit + UK 14-day cooling-off, which starts on delivery)*.
- [ ] **#4 — Commission base = net-of-VAT, ex-shipping, ex-refunds** confirmed in app settings.
- [ ] **#5 — Per-creator unique discount codes** (never generic), each locked to one affiliate *(doubles as the offer and a clean incrementality read; survives Safari/iOS attribution loss)*.
- [ ] **#6 — Fraud/IVT screening + owned-channel (email/branded-search) de-dup** active.
- [ ] **#7 — Brand-bidding / trademark monitoring** (e.g. BrandVerity / The Search Monitor) live, with clawback+removal penalty defined.
- [ ] **#8 — Affiliate tracking cookies gated behind the PECR consent banner** *(consent rejection breaks attribution — budget accordingly)*.
- [ ] **#9 — Influencer seeding ledger:** gifted units booked as CAC (full COGS), capped per creator, with a post-commitment before gifting.
- [ ] **#10 — Affiliate-cohort dispute-rate monitor** (separate from blended 3% refunds), to protect Shopify's ~1% chargeback threshold (20% reserve / 120 days).

---

## Part E — Binding compliance clauses (go verbatim into the affiliate agreement)

1. **Disclosure (ASA):** every affiliate communication must carry clear **`#ad`** (or **`#ad gifted`** for seeded product) **upfront**, before any "see more" truncation. *(We are jointly liable for an affiliate's undisclosed ad.)*
2. **No paid-search / brand bidding:** "Active Paw", its misspellings and variants must be **negative keywords**; no direct-linking on branded terms. Automated monitoring is active; breach → commission clawback + removal.
3. **No cookie-stuffing / forced clicks / auto-redirect** attribution grabs.
4. **No self-referral** (commission on your own purchases); order-pattern monitoring + clawback.
5. **No generic discount-code distribution**; only the affiliate's own locked code.
6. **No unauthorised use of the brand name, logo, or look-alike domains.**
7. **VAT:** commission is a VATable B2B service; handled via network self-billing; **reverse-charge** for non-UK affiliates (confirm with accountant).
8. **Validation period + clawback** apply to all commissions; refunded/cancelled/disputed orders earn nothing.

---

## Part F — Pre-flight (the methodology's "Step 0")

Before recruiting at all: **validate a repeat-buying base / retention engine exists.** We currently lack subscription LTV, so each affiliate sale must pay back on *order one*. Build email/reorder/bundle (or a consumables subscription) first, or keep the affiliate program **small and incrementality-gated** until it does. Affiliates *amplify* what already works — they can't create demand for an undifferentiated catalog.

---

### One-line summary
**Gate 1 picks who (decline coupon/cashback, accept creators) · Gate 2 fences what's paid (8% net, new-customer-only, £6 floor, clawback) · Gate 3 proves it (pause-test, keep only if lift > C/51) — and none of it runs until Part D plumbing exists.**
