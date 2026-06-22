# Active Paw Affiliate Program — Task List (for review before build)

**Date:** 2026-06-20 · **Companions:** `affiliate-program-analysis.md` (why/economics), `affiliate-program-terms-and-ruleset.md` (gates/rules)
**Status:** DRAFT for review. No code written yet. Sequenced so the **prerequisites that gate the program (and have standalone ROI) come first**.

### How to read this
- **Type** tells you what each task *is*: `CODE` = in this worker repo · `SCRIPT` = one-off Admin-API/Python · `CONFIG` = Shopify/affiliate-app setup · `OPS` = manual program operation · `EXT` = external (solicitor/accountant) · `DECISION` = your call.
- **The only tasks you "write code" for are `CODE` / `SCRIPT`** — flagged 🟦. **Decision (2026-06-20): gate enforcement lives in the Shopify app, not the worker.** So the code surface is deliberately small — COGS data, the SKU allowlist, and retention. Affiliate gate logic, fraud screening, and monitoring lean on the app + external tools (BrandVerity / Shopify dispute dashboard), not custom worker code.
- Each task has an **acceptance** (done-when) and a **source** (which prereq/gate it satisfies).
- **Phase gates are hard:** don't start a phase until the prior phase's gate is met.

---

## Phase 0 — Decision & readiness gate (no build until this passes)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 0.1 | Go/no-go + success targets: confirm intent and set 3 numeric targets — affiliate new-customer CAC < paid CAC; program net-profit-after-commission > 0; cohort incrementality > 16% (I\*=C/51 at 8%) | DECISION | — | Targets written + agreed | analysis §1 |
| 0.2 | **Step-0 readiness check:** do we have a repeat-buying base / retention engine? Decision: build 1.3 **in parallel** (not a blocker) — accepting that affiliate economics are weaker until retention lands | DECISION | — | Documented; 1.3 runs in parallel | analysis §3, ruleset Part F |

**Gate:** proceed only if 0.1 agreed AND 0.2 resolved (build retention first if absent).

---

## Phase 1 — Prerequisites / plumbing (standalone ROI; unblocks everything)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 1.1 🟦 | **COGS → Shopify Cost-per-item:** populate per-variant cost from CJ landed cost (product + freight + FX); refresh job when costs move | SCRIPT→CODE | — | Every active variant has a non-stale Cost-per-item; refresh runs on the cron | ruleset D#1 |
| 1.2 🟦 | **Eligible-SKU allowlist generator:** compute which SKUs clear `gross − commission ≥ £6` and emit the allowlist (the £6 floor is a manual list — no app reads COGS) | CODE | 1.1 | Allowlist generated + reviewable; floor-priced SKUs excluded | ruleset B (£6 floor), D#1 |
| 1.3 🟦 | **Retention engine (min viable) — runs in PARALLEL, not a phase blocker:** post-purchase + reorder/replenish email flow so LTV isn't one-and-done (gives affiliate CAC room to pay back) | CODE | — (parallel) | At least one automated reorder flow live; repeat-rate measurable | analysis §3, ruleset F |
| 1.4 ✅ | **Pick affiliate app** — ✅ **LOCKED 2026-06-20: UpPromote Grow** (user decision). Capability checklist + the 3 unenforceable gaps documented below; config spec in `affiliate-uppromote-setup.md`. | CONFIG | — | DONE — UpPromote Grow chosen | ruleset §standards, B |

**Gate:** 1.1+1.2 done (floor enforceable), 1.4 chosen, 1.3 live or scheduled.

---

## Phase 2 — Program foundation (terms, legal, gates wired)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 2.1 | **Solicitor review** of the affiliate agreement (clawback/penalty + unfair-terms) | EXT | ruleset draft | Signed-off agreement | ruleset Part E note |
| 2.2 | **Accountant: VAT split** (registered self-bill / unregistered no-VAT / non-UK reverse charge) | EXT | — | VAT handling confirmed | ruleset E.7 |
| 2.3 | **Configure Gate 2** in the app: 8% net new-customer, ex-VAT base, 7–15d cookie, ≥45d hold + new-affiliate probationary reserve, clawback, no-stacking, per-order + rolling per-customer caps | CONFIG | 1.4, 2.1 | All rules set + screenshot-verified | ruleset Part B |
| 2.4 | **New-vs-returning hardening:** upload full Shopify customer CSV; **test a fresh-email guest-checkout bypass** and confirm it's caught; disable any double-credit window | CONFIG | 1.4 | Bypass test order does NOT earn new-customer rate | ruleset D#2 |
| 2.5 | **Attribution = private links primary; per-creator codes secondary, single-locked, no-stacking;** leak monitoring (code string + brand-discount SERPs) | CONFIG | 1.4 | Links issued; code-leak monitor live | ruleset D#5, E.6 |
| 2.6 | **Monitoring via app + external tools** (per your call, gate logic stays in the app — no worker code): app-native fraud screening + BrandVerity / The Search Monitor for brand-SERP (paid+organic) + Shopify dispute dashboard for the ~1% threshold; order-splitting caught by the app's rolling caps (2.3) | CONFIG/EXT | 1.4, 2.3 | Monitors configured; brand + dispute alerts verified | ruleset D#7, D#10, B |

**Gate:** agreement signed-off (2.1), Gate-2 rules verified (2.3–2.5), monitoring live (2.6).

---

## Phase 3 — Pilot (small, hand-picked, incrementality-gated)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 3.1 | Recruit **5–10 UK pet content/creator partners**; decline coupon/cashback + cold commission pitches (incl. the inbox ones) | OPS | Phase 2 | Roster onboarded + manually vetted | ruleset Part A |
| 3.2 | **Seeding gated on verified permanent delivery** (no further gift/commission until prior post confirmed) | OPS | 3.1 | Seeding ledger live; no un-delivered gifts outstanding | ruleset D#9, E.1 |
| 3.3 | Pilot promotes **exclusive bundles / value sets** (the differentiation reviewers need — creator audience + bundle, **NOT** a delivery-speed / UK-dispatch claim) | OPS | 1.2, 3.1 | Pilot SKUs are allowlisted | analysis §3, ruleset E.11 |

**Gate:** ≥4 weeks of pilot data on net-new customers.

---

## Phase 4 — Measure & scale (Gate 3 — the only empirical gate)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 4.1 | **Holdout/pause test per cohort** — deactivate code AND commission in matched regions / whole cohort; measure lift in *total* orders | OPS | Phase 3 | Per-cohort incrementality measured | ruleset Part C |
| 4.2 | **Keep/cut + scale:** keep only partners whose lift clears I\*=C/51; report net-profit-after-commission per *category*; scale proven partners only | DECISION | 4.1 | Cut list + scale list; blended ROAS never used | ruleset C, analysis §1 |

---

## Code surface at a glance (what you'd actually build in this repo)

| # | Code task | Rough shape |
|---|---|---|
| 1.1 | COGS → Shopify Cost-per-item + refresh | Admin-API write of per-variant cost from CJ landed cost; hook into the existing cron + freight-quote logic |
| 1.2 | Eligible-SKU allowlist generator | Pure function over COGS + pricing → list of floor-clearing SKUs |
| 1.3 | Retention/reorder email flow (parallel) | Resend-based flow (worker already has the email + inbox primitives) |

**That's the entire code surface — 3 tasks.** Gate enforcement, fraud screening, and monitoring all live in the Shopify app + external tools (per your decision), not the worker. Everything else is app config, external sign-off, or program ops.

---

### Decisions (your review, 2026-06-20)
1. **Code scope:** gate logic stays **in the app** → worker code surface = **3 tasks** (1.1 COGS, 1.2 allowlist, 1.3 retention). 2.6 monitoring moved to app + external tools.
2. **Sequencing:** retention engine (1.3) runs **in parallel** — not a phase blocker.
3. **App choice (1.4):** ✅ **LOCKED — UpPromote Grow** (user, 2026-06-20). Comparison result below; configuration spec in `docs/affiliate-uppromote-setup.md`.
4. **Tracking:** ✅ mirroring this list into the harness Task list + backlog memory.

---

## Task 1.4 result — App comparison & recommendation (web-verified, 2026)

> **Headline:** **neither** UpPromote nor Refersion natively enforces the hardened ruleset's anti-abuse core. **3 gaps are shared by both** and must be handled with manual/external compensating controls at pilot scale:
> - **R6 — no commission caps** (no per-order, no rolling per-customer). Both only do *tiered/escalating* commission (the opposite of a cap) → order-splitting unmitigated in-app.
> - **R1/R7 — new-vs-returning is email-only** → a returning buyer using a fresh email at guest checkout reads as "new" in both. Not closable in-app.
> - **R8 — no real fraud/IVT/coupon-leak screening** (manual monitoring only in both).

**Where they differ (decides the pilot):**

| Factor | **UpPromote Grow** | Refersion |
|---|---|---|
| **Cost at pilot scale** | $29.99/mo **+ 2% of referral sales** | Scale **~$479/mo annual (~$5.7k/yr)** to unlock new-vs-returning |
| New-vs-returning | Matches **full Shopify list out-of-box** | Scale-gated **+ manual CSV/support workaround** |
| UK payouts | **PayPal + store-credit auto-payout (works)** | Auto-rail is **US/USD-only → UK = manual** |
| Net-of-VAT base | excludes tax/shipping (partial) | dedicated **EU VAT-subtract** option (slightly better) |
| Refund clawback | semi-auto (manual approve); chargebacks undocumented | auto only on full cancel; refunds/chargebacks manual |
| Cookie / locked codes / no-stack | ✓ / ✓ / ✓ (Shopify default) | ✓ / ✓ / ✓ (Shopify default) |
| Volume cap | Grow ~300 referral orders/mo | — |

**RECOMMENDATION: UpPromote Grow for the pilot.** At 5–10 creators / low volume, `$29.99 + 2% of a small sales base` (e.g. ~£63/mo on £2k sales) is far cheaper than Refersion's ~£380/mo fixed Scale fee; UpPromote also does new-vs-returning out-of-box and has working UK auto-payouts. Refersion's only edge — 0% txn fee under $1M GMV — only pays off at high volume, and its new-vs-returning is worse (Scale-gated + CSV) with US-only payouts. *(Caveat: UpPromote's 2%-of-**sales** fee ≈ ~12% of a 17% net margin — real, but small in absolute terms at pilot volume and avoidable later by moving to a flat tier.)*

**Implication for the "gate logic in the app" decision:** it holds **for the pilot**, because the 3 unenforceable gates are covered by **manual compensating controls** that are feasible at 5–10 vetted creators:
- **Caps (R6):** manual per-order/rolling review rule (flag same-customer/same-code order bursts).
- **Fresh-email bypass (R1/R7):** UpPromote's full-list match catches email-reuse; the residual (fresh email + guest) needs manual address/payment review.
- **Fraud (R8):** Gate-1 manual vetting + manual redemption-rate monitoring.

🚩 **Re-evaluate-at-scale gate (add to Phase 4):** these manual controls don't scale. Before growing past the pilot, decide whether to (a) add worker/Shopify-Flow logic for caps + identity, or (b) move to a network (Awin) with native fraud/voucher-attribution. The "no custom code" stance is a pilot decision, not permanent.

*(Sources: UpPromote & Refersion 2026 help-centre docs — full URLs in the task transcript.)*
