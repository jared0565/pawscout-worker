# Affiliate Program Analysis — Active Paw (UK pet dropshipping)

**Date:** 2026-06-20
**Goal:** Decide whether/how to run an affiliate program, optimised for **NET PROFIT** (not revenue).
**Method:** Web-grounded research (2024-2026 sources) across 6 lenses — standards/platforms, commission benchmarks, fraud/compliance, pet-niche fit, net-profit economics, and a completeness critique — every finding tested against Active Paw's actual cost stack.

---

## TL;DR verdict

**Conditional YES — but only as a tightly-gated paid-ads *substitute*, run in-house on a Shopify app, recruiting hand-picked pet content creators and influencers. NOT an open affiliate network, and explicitly NOT coupon / cashback / loyalty / browser-extension partners.**

The single number that governs everything: at our ~17% net margin, **the program adds profit only if incrementality > C/51** (C = commission as % of revenue). Most of what an open affiliate network sends you — coupon and cashback sites — is proven **non-incremental** (a real DTC geo-test found *zero* incremental revenue from loyalty/cashback affiliates). For us, a non-incremental commissioned sale is a pure give-away of margin we already had.

**Do NOT just say "yes" to the inbound commission pitches** (`samfeezco`, `gobocreative1` in the inbox). Cold "we'll generate sales for commission" outreach is overwhelmingly the low-incrementality, high-risk type. Recruiting is deliberate and outbound, not reactive.

---

## 1. The economics — why net profit, not revenue, is the only lens

Per £100 of revenue, our documented cost stack:

| Line | £ |
|---|---|
| Revenue | 100 |
| − COGS (landed supplier cost, 1/2.5 of retail) | 40 |
| **= Gross profit** | **60** |
| − Payment fees (~2.5%) | 2.5 |
| − FX (~1.5%) | 1.5 |
| − Refunds (~3%) | 3 |
| − Fixed (~2%) | 2 |
| **= Contribution (pre-acquisition)** | **51** |
| − Paid ads (blended ~33%, ROAS ~3) | 33 |
| **= Net profit** | **~18 (≈ the ~17% target)** |

An **affiliate order skips the ad line**, so its net = **51 − C**. That looks generous — but the catch is the counterfactual.

**The break-even is an incrementality rate, not a commission rate.** Let `I` = fraction of affiliate-attributed orders that genuinely would NOT have happened otherwise. Program value per attributed order:

```
value = I·(51 − C)  +  (1 − I)·(−C)   =   51·I − C
break-even:  I* = C / 51
```

| Commission C (% of revenue) | Break-even incrementality I* | Net on a TRULY incremental sale | Net on a NON-incremental sale |
|---|---|---|---|
| 5% | **10%** | £46 (vs £33 net-of-ad… highly accretive) | −£5 (pure give-away) |
| **8% (recommended)** | **~16%** | £43 | −£8 |
| 10% | **~20%** | £41 | −£10 |
| 15% (DTC pet norm) | **~29%** | £36 | −£15 |
| 20%+ (DTC headline) | **39%+** | loss-making territory | −£20 |

Two facts the headline rate hides:
- **10% of revenue ≈ 57% of our net profit per order.** A rate that sounds modest against revenue is enormous against a 17% net. → *Pay on gross profit (margin), not revenue, wherever the platform allows.*
- **The ad-substitution ceiling is well below 33%.** Commission only "pays for itself" by displacing a paid ad — and the canonical eBay field experiment (Blake/Nosko/Tadelis, *Econometrica* 2015) showed even **brand-keyword paid ads are largely non-incremental** (organic recaptured the clicks). So the realistic ceiling sits near what large pet *retailers* actually pay (~7-8%), not the 33% gross ad budget.

---

## 2. Suggested commission structure & calculations

**Anchor to pet *reseller* benchmarks, not DTC.** We are a 60%-gross / 17%-net reseller, structurally like Chewy/Petco/Amazon-pet — **not** a 70-80%-gross DTC brand.

| Program type | Typical commission | Cookie | Why it's the wrong/right anchor |
|---|---|---|---|
| Pet **resellers** (Chewy, Petco, Amazon-pet, Pets Warehouse, Zooplus UK) | **2–8%** | 7–15 days | ✅ **Our anchor** — same thin margins |
| Pet **DTC/subscription** (BarkBox, Innovet, HolistaPet, Paw.com) | 15–25% (some 40%) | 7 days | ❌ Affordable only on 70-80% gross margins we don't have |

### Recommended terms

| Lever | Recommendation | Rationale |
|---|---|---|
| **Headline rate** | **8% of *net* new-customer product revenue** (≈ 13% of gross profit), with a **per-order cap** (lesser of 8% or ~£3.50) | Inside the reseller band; break-even incrementality only ~16%, clearable by content/creators |
| **Base** | **Net of VAT (20%), shipping, and refunds** — never gross order total | We are VAT **seller-of-record** on sub-£135 China consignments; UK prices are VAT-inclusive, so ~1/6 of a naive base is tax we remit to HMRC |
| **Pay on margin, not revenue** | Prefer a % of gross profit; if the app only does %-of-revenue, enforce the cap + a per-SKU margin gate | A flat %-of-revenue silently breaches the **£6/unit floor** on cheap SKUs (a £10 toy at gross £6 minus £1 commission = £5, under floor) |
| **New-customer-only** | **Full rate on first-order customers; 0% (or token 2%) on returning** | Returning buyers are the least incremental cohort — they'd re-order via email/organic. This is the single biggest margin protector. |
| **Cookie window** | **7–15 days** (match Petco/Chewy), not the 30-day default | Short window mechanically filters slow conversions that were really the customer's own return intent |
| **Coupon/cashback/loyalty/toolbar** | **Exclude, or hard-cap at 1–2%** | 66–71% non-incremental; a real geo-test found *zero* incremental revenue (Haus.io) |
| **Validation/hold** | **≥ 45 days**, with **auto-clawback on refunds/cancellations** | Must exceed China transit (8-15d) + UK 14-day cooling-off (starts on *delivery*). A refunded dropship order is a **total loss** (no restock), so commission on it is a double loss. |

**Worked example (one incremental new-customer sale, £40 order, ex-VAT base ≈ £33.33):** commission = 8% × £33.33 ≈ **£2.67**. Net on that order ≈ £51%·£40 − £2.67 ≈ **£17.7** — vs the ~£7.2 net it would have made carrying blended ad cost. Strongly accretive **because it's incremental and ad-free.** The same £2.67 paid on a sale that would have closed organically is **−£2.67 of pure profit** gone.

---

## 3. Is it beneficial for *our* model? (pet dropshipping specifics)

**Pet is a strong gross-margin niche** (40-65% typical) and owners spend even under financial pressure. But three structural facts make a *broad* program dangerous for us:

1. **No subscription/LTV flywheel.** The pet numbers that make affiliate CAC affordable (75-85% food-subscription retention, Chewy Autoship = 78% of sales, 4-5× LTV:CAC) come from **consumables subscriptions**. We sell cleaning/accessories/health/toys via dropship with **no autoship engine** — so each affiliate sale must **pay back on order one**, which a 15-20% commission can't.
2. **Product parity kills editorial incrementality.** A CJ-sourced product is identical to dozens of rival listings, so "best dog X" reviewers have little reason to feature *us* — yet content/review is the *only* provably-incremental channel. We must manufacture a reason we can stand behind: **exclusive bundles / value sets**, and the **creator's own curated audience + endorsement** (the relationship is the differentiator, not the product). **NOT a UK-warehouse / fast-delivery claim** — Active Paw is CJ-dropshipped from China (≈8–15-day transit) and must never state or imply UK dispatch/origin (governing rule; see ruleset Part E.11). ⚠️ With the delivery-speed angle removed, **bundles + creator audience are now the *entire* editorial-incrementality case** — if the bundles aren't genuinely compelling, this thesis weakens. Treat that as the load-bearing assumption to validate in the pilot.
3. **Thin margin = no buffer for the non-incremental tail.** A 40-60%-net DTC brand can absorb a non-incremental sale and still profit; at 17% net we cannot.

**Where it IS beneficial:** a hand-picked roster of UK pet content creators / "best X for dogs" review sites / pet TikTok-Instagram-YouTube influencers who **introduce net-new audiences** — these substitute for paid ads rather than taxing organic. That, gated by the terms in §2, is net-accretive.

---

## 4. Industry standards & methodology (2024–2026)

**The canonical launch sequence** (Rakuten/Tapfiliate/Tolt): **(0) validate you already have repeat-buying customers** *(we largely don't yet — a flag, see §6)* → (1) goals/KPIs (new-customer count, EPC, new-to-file rate, net-profit-after-commission per partner *category*) → (2) commission model → (3) terms (cookie, PPC/brand-bidding, disclosure clauses) → (4) tracking platform → (5) creative assets + a private creator community → (6) deliberate outbound recruiting. Recurring warning: *"affiliates amplify what already works; they can't fix unclear value or high churn."*

**Platform — Shopify-native, not a network, at our scale:**
- **UpPromote Grow** ($29.99/mo + 1.5% of referral sales) or **Refersion** (annual Scale plan = **0% transaction fee under £1M GMV**) — both support new-vs-returning gating and clawback.
- **Avoid networks (Awin ~£75/mo + 3.5% override) until 50+ active affiliates** — the override alone can equal a third of a thin per-order net.

**Tracking:** Server-to-server (S2S) postback = source of truth + **one memorable per-creator coupon code** (doubles as the offer *and* a clean incrementality read, and survives Safari/iOS attribution loss) + first-party cookie; pixels as diagnostics only. (Note: third-party cookies were **not** killed — Google reversed in 2024; the real constraint is Safari ITP / iOS ATT.)

**Attribution:** 30-day last-click is the default but is the program's core defect (it over-credits demand-*harvesters*). Report internally on **first-click / multi-touch**, measure coupon/cashback partners **separately**, never as one blended ROAS.

---

## 5. Risk register + mitigations

| Risk | Magnitude (sourced) | Mitigation |
|---|---|---|
| **Non-incrementality / cannibalisation** | Coupon/cashback 66-71% non-incremental; geo-test found *zero* lift | New-customer-only; exclude/de-rate coupon-cashback; **pause/holdout-test** top partners |
| **Cookie stuffing** | 5-10% of affiliate transactions | Validation/hold period; reject implausibly short click-to-sale; fraud tooling |
| **Brand bidding** on "Active Paw" | Pays commission to intercept your own branded search | Explicit PPC ban (brand + misspellings as negative keywords) + automated monitoring (BrandVerity) → clawback + removal |
| **Coupon/voucher leakage** | 3rd-party extensions cost merchants ~$3B/yr; 73% of retailers hit by code misuse | Never issue generic codes; lock each code to one partner; separate lower tier |
| **Bot / AI / fake traffic** | ~17-40% of affiliate traffic fake; 22% of digital ad spend lost to fraud | Pay only on validated CPA (never clicks/leads); bot screening; IP/velocity checks |
| **Self-referral** | Affiliate earns on own purchase | Anti-self-referral clause + order-pattern matching + clawback |
| **Refund = total loss + chargebacks** | Dropship chargebacks 2-5% vs 0.5-0.95%; 30%+ of disputes = "not received"; **Shopify ~1% dispute → 20% reserve/120 days** | Set honest delivery expectations in listings/creative (CN transit ≈8–15d — **no UK-dispatch claim**); ≥45-day hold + clawback; monitor affiliate-cohort dispute rate separately |
| **ASA joint liability** (UK) | Brand is **jointly responsible** for an affiliate's undisclosed ad; ASA pursued 150+ repeat offenders in 2024 | Mandatory upfront `#ad` / `#ad gifted` clause; onboarding checklist; spot-audits; suspend non-compliers |
| **PECR cookie consent** (UK) | Our affiliate cookie is non-essential → needs consent; cashback "reward" cookies are consent-*exempt* (ICO Oct-2024) — structurally advantaging them | Gate tracking behind consent banner; treat rejection as broken attribution; another reason to de-rate cashback |
| **VAT** | Commission = B2B service (20%); we're seller-of-record on sub-£135 China goods | Net-of-VAT commission base; network self-billing; reverse-charge for non-UK affiliates (confirm with accountant) |

---

## 6. Other implementation factors (decision-critical prerequisites)

These are **gating prerequisites** the standard guides assume but we don't yet have:

1. **Per-variant COGS in Shopify is not populated by CJ.** The £6 margin floor and any margin-gate are *un-enforceable* until Shopify's Cost-per-item is filled from CJ landed cost (which moves with FX/freight — we literally just added a CJ freight-quote tool, evidence cost is non-static). **Build this first.**
2. **New-vs-returning flag is OFF by default** in the affiliate apps — confirm with a test order, or the highest-leverage control silently doesn't run.
3. **Influencer seeding/gifting is real CAC, absent from every commission model.** Each gifted unit is full COGS (~40%) with zero revenue — book it as acquisition cost, cap units per creator, require a post commitment, and add the `#ad gifted` disclosure.
4. **Commission hold (45+ days) must exceed the refund-risk window** (China transit + UK cooling-off from delivery) — the default 30-day hold leaks commission on orders that later refund into total COGS loss.
5. **Retention engine should precede affiliate.** Because we lack subscription LTV, build email flows / reorder / bundle (or a consumables subscription) **first** to raise LTV — that's what makes affiliate CAC affordable later. Until then, keep affiliate small and incrementality-gated.

---

## 7. Recommended roadmap (net-profit-first)

1. **Prerequisites:** populate per-variant COGS; build a basic retention/email engine; pick UpPromote/Refersion.
2. **Terms first:** write the agreement (8% net new-customer, £6 floor gate, no coupon/cashback/toolbar, PPC/brand-bidding ban, `#ad` disclosure, anti-self-referral, ≥45-day hold + clawback).
3. **Recruit deliberately, small:** 5-10 hand-picked UK pet content/creator partners promoting **exclusive bundles / value sets** (differentiator = the creator's audience + the bundle, never a delivery-speed / UK-dispatch claim). Decline the cold commission cold-pitches.
4. **Measure on net profit per partner category, and run a pause/holdout test** on each cohort before scaling. Cut anything that doesn't clear `I* = C/51`.
5. **Scale only the proven-incremental partners;** revisit a network only past ~50 active affiliates.

**Ultimate-goal restatement:** every structural choice above exists to push the affiliate mix toward **incremental, ad-substituting** sales and starve the **non-incremental, margin-taxing** ones. At 17% net, that distinction *is* the difference between the program adding or destroying profit.

---

## Sources (selected)

Blake, Nosko & Tadelis, *Econometrica* 2015 (eBay paid-search incrementality) · Haus.io affiliate on/off geo-test 2024 · PartnerCentric FUSE & Junction-by-CJ incrementality 2024 · ReferralCandy 2026 commission benchmarks · getlasso.co / Dogster / Catster pet program rates 2025-26 · Tapfiliate 2026 tracking guide · Post Affiliate Pro cookie/fraud guides 2024-25 · Awin compliance & VAT docs · ASA/CAP affiliate guidance · ICO PECR 2024-26 · TrafficGuard / Lunio / 24metrics fraud stats · Chargebacks911 / Chargeblast dropship chargeback data 2026 · Consumer Contracts Regs 2013 · Sufio/Taxually UK dropship VAT 2026. (Full URL list in the research transcript.)
