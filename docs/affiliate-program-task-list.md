# Active Paw Affiliate Program — Task List (for review before build)

**Date:** 2026-06-20 · **Companions:** `affiliate-program-analysis.md` (why/economics), `affiliate-program-terms-and-ruleset.md` (gates/rules)
**Status:** DRAFT for review. No code written yet. Sequenced so the **prerequisites that gate the program (and have standalone ROI) come first**.

### How to read this
- **Type** tells you what each task *is*: `CODE` = in this worker repo · `SCRIPT` = one-off Admin-API/Python · `CONFIG` = Shopify/affiliate-app setup · `OPS` = manual program operation · `EXT` = external (solicitor/accountant) · `DECISION` = your call.
- **The only tasks you "write code" for are `CODE` / `SCRIPT`** — flagged 🟦. The affiliate program itself runs on a Shopify app, not custom code (per the research), so the code surface is deliberately small: COGS data, the SKU allowlist, retention, and the signals the app can't compute.
- Each task has an **acceptance** (done-when) and a **source** (which prereq/gate it satisfies).
- **Phase gates are hard:** don't start a phase until the prior phase's gate is met.

---

## Phase 0 — Decision & readiness gate (no build until this passes)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 0.1 | Go/no-go + success targets: confirm intent and set 3 numeric targets — affiliate new-customer CAC < paid CAC; program net-profit-after-commission > 0; cohort incrementality > 16% (I\*=C/51 at 8%) | DECISION | — | Targets written + agreed | analysis §1 |
| 0.2 | **Step-0 readiness check:** do we have a repeat-buying base / retention engine? If NO → Phase 1.3 is a *blocking* prerequisite, not optional | DECISION | — | Documented yes/no; if no, 1.3 promoted to blocker | analysis §3, ruleset Part F |

**Gate:** proceed only if 0.1 agreed AND 0.2 resolved (build retention first if absent).

---

## Phase 1 — Prerequisites / plumbing (standalone ROI; unblocks everything)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 1.1 🟦 | **COGS → Shopify Cost-per-item:** populate per-variant cost from CJ landed cost (product + freight + FX); refresh job when costs move | SCRIPT→CODE | — | Every active variant has a non-stale Cost-per-item; refresh runs on the cron | ruleset D#1 |
| 1.2 🟦 | **Eligible-SKU allowlist generator:** compute which SKUs clear `gross − commission ≥ £6` and emit the allowlist (the £6 floor is a manual list — no app reads COGS) | CODE | 1.1 | Allowlist generated + reviewable; floor-priced SKUs excluded | ruleset B (£6 floor), D#1 |
| 1.3 🟦 | **Retention engine (min viable):** post-purchase + reorder/replenish email flow so LTV isn't one-and-done (gives affiliate CAC room to pay back) | CODE | — | At least one automated reorder flow live; repeat-rate measurable | analysis §3, ruleset F |
| 1.4 | **Pick affiliate app** (UpPromote vs Refersion) — verify it supports: full-history new-vs-returning, ≥45-day hold, clawback, net-of-VAT base, per-creator links, rolling caps | CONFIG | — | App chosen + capability checklist confirmed (not assumed) | ruleset §standards, B |

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
| 2.6 🟦 | **Signals the app can't compute:** brand-term SERP monitor (paid+organic), affiliate-cohort dispute-rate monitor (protect Shopify's ~1% threshold), order-split/burst flag | CODE | 1.4 | Alerts fire on brand interception + dispute spikes | ruleset D#7, D#10, B |

**Gate:** agreement signed-off (2.1), Gate-2 rules verified (2.3–2.5), monitoring live (2.6).

---

## Phase 3 — Pilot (small, hand-picked, incrementality-gated)

| ID | Task | Type | Depends | Acceptance | Source |
|---|---|---|---|---|---|
| 3.1 | Recruit **5–10 UK pet content/creator partners**; decline coupon/cashback + cold commission pitches (incl. the inbox ones) | OPS | Phase 2 | Roster onboarded + manually vetted | ruleset Part A |
| 3.2 | **Seeding gated on verified permanent delivery** (no further gift/commission until prior post confirmed) | OPS | 3.1 | Seeding ledger live; no un-delivered gifts outstanding | ruleset D#9, E.1 |
| 3.3 | Pilot promotes **UK-warehouse fast-delivery SKUs / bundles** (the differentiation reviewers need) | OPS | 1.2, 3.1 | Pilot SKUs are allowlisted + fast-ship | analysis §3 |

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
| 1.3 | Retention/reorder email flow | Resend-based flow (worker already has the email + inbox primitives) |
| 2.6 | Brand-SERP / dispute / order-split monitors | Scheduled checks → owner alert (reuse `maybeAlertOwner`/Resend) |

Everything else is Shopify-app config, external sign-off, or program ops — **not code.**

---

### Open questions for your review
1. **Scope of "the code we write":** just the 4 `CODE`/`SCRIPT` tasks above, or do you want any gate logic built into the worker instead of the app?
2. **Sequencing:** is the retention engine (1.3) a blocker (if no repeat-buying base) or parallel?
3. **App choice (1.4):** UpPromote vs Refersion — want me to do the capability comparison as task 1.4's first step?
4. Should I mirror the approved list into tracked tasks (harness Task list + backlog memory) once you sign off?
