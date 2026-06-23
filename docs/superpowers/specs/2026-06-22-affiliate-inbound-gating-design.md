# Affiliate / Partnership Inbound Gating & Onboarding - Design Spec

**Date:** 2026-06-22
**Companion to:** `docs/affiliate-program-analysis.md`, `docs/affiliate-program-terms-and-ruleset.md`, `docs/affiliate-uppromote-setup.md`
**Status:** Design - awaiting user review before implementation planning.

## 1. Problem & principle

Inbound "I can drive sales for a commission" pitches arrive in the PawScout inbox. Two failure modes:

1. **Auto-decline everything** - safe but lazy; throws away a genuinely useful creator who *can* back up a bold claim.
2. **Engage everyone** - wastes time on low-incrementality spam, and risks over-promising a program that isn't live.

**Governing principle (from `customer-facing-only-real-defensible`):** only surface what is real and defensible; never fabricate. Applied here: we do **not** pretend a self-serve affiliate program exists, and we never let a bot dismiss a possibly-real partner on a subjective judgement.

**Design idea:** a *gate*, not a verdict. A well-built funnel makes the question "is this a scam or a real performer?" answer *itself* - a scammer self-eliminates (they can't produce verifiable, incremental, new-customer results), a real performer earns. We convert "should I trust this claim?" into "prove it, on terms where we can't lose."

This spec sits **in front of** the existing three-gate ruleset (admission / commission-eligibility / retention-holdout). It is the **inbound applicant funnel** that feeds those gates.

## 2. Goals / non-goals

**Goals**
- Capture every inbound partnership inquiry, route it into a structured funnel, and never lazily dismiss a real one.
- A cheap, high-signal qualifying step that filters obvious spam and self-selectors before any human time is spent.
- Keep the owner in control of every *accept* decision while the formal program isn't live.
- Protect profit (pay only on verified incremental results - later) and credibility (vet method + disclosure before anyone represents the brand).

**Non-goals (this spec)**
- Building the at-scale, app-enforced affiliate program (that's the ruleset + UpPromote setup; gated behind Part D plumbing + Part F "Step 0" retention engine).
- Automated payouts. The funnel runs **front-only** (capture → screen → form → escalate) until the retention engine exists; the pilot stage is *designed* here but switched on later.

## 3. Scope decision (agreed)

**Hybrid (option C):** build the front of the funnel now (capture / qualify / verify / escalate), and design the paid-pilot stage so it slots in cleanly when the retention engine is ready. Captures every opportunity immediately; keeps money decisions with the owner; doesn't strand the design.

## 4. The funnel

```
Inbound partnership inquiry
  (lane fires on ANY of: arrived on sales@  |  form Reason=Partnerships  |  classified affiliate/wholesale-b2b)
   │
   ├─ [1] Qualifying email  (6 questions; sent & signed from sales@ "Active Paw Partnerships")
   │        └─ applicant replies → JUDGE (§6):
   │              • hard gate tripped   → [respectful decline]   (logged, reversible)
   │              • clear pass (≥8/12)  → [2] Application form
   │              • genuine maybe (1–7) → [4] Escalate to owner with full breakdown
   │              • no reply            → one nudge after N days, then thread goes awaiting_customer
   │
   ├─ [2] Application form  (structured fields; bakes in #ad disclosure + terms agreement)
   ├─ [3] Verify           (ruleset checklist: identity/reach, no brand-bidding, traffic plausibility)
   ├─ [4] Owner decides
   └─ [5] (LATER) bounded performance pilot - perf-only, first-order-margin economics,
          unique tracked link, 45-day hold + clawback
```

## 5. The qualifying email (gate [1])

Six questions - each one a real creator answers in 30 seconds while a scammer stalls, dodges, or self-incriminates. Grounded in industry-standard affiliate/influencer vetting (manual review default; engagement + relevance over follower count; demand a named channel + proof; screen the promotion *method* for incrementality; check disclosure/compliance).

> **Subject: A few quick questions before we explore a partnership**
>
> Hi [Name],
>
> Thanks for reaching out about working together - we'd genuinely like to learn more. We partner with a small number of creators, so we ask everyone the same few questions first. If it looks like a fit, we'll send you our partner application.
>
> 1. **Where would you promote Active Paw?** Please share the link(s) to the channel(s) or site where you'd feature us.
> 2. **Tell us about your audience** - roughly how many followers/visitors, your typical engagement (likes/comments/views on a recent post), and which country most of them are in.
> 3. **How would you plan to promote our products?** For example a review or video, a "best for dogs" feature, everyday content, a discount-code post, paid ads - whatever you actually have in mind.
> 4. **Have you partnered with brands before?** If so, a couple of examples or links we can look at (pet-related especially welcome).
> 5. **You mentioned strong results** - what's that based on? If you can point us to a past campaign with comparable numbers, that helps a lot. *(included only when they led with a volume/sales claim)*
> 6. **How we work, briefly:** partnerships are performance-based (commission on sales from new customers, tracked with your own link), we ask for a clear `#ad` label, and we don't allow bidding on our brand name or posting codes to coupon sites. Does that suit how you operate?
>
> No rush - whenever you've got a few minutes. We read every reply.
>
> Best regards,
> Active Paw Partnerships

| Q | What it surfaces |
|---|---|
| 1 | **No-URL = instant deal-breaker** - no basis to evaluate. Lets us verify it's real, pet/UK, original (not a coupon/thin site). |
| 2 | Engagement & geography over raw follower count - catches fake engagement and audience mismatch. |
| 3 | **The incrementality fork** - content/audience-led (wanted) vs. coupon/redirect/brand-bidding (auto-decline). Most discriminating. |
| 4 | Professionalism, disclosure familiarity, verifiable track record; competitor conflict. |
| 5 | **"Can they prove it?"** - a real performer shares a case study; a scammer deflects. |
| 6 | Compliance + expectations micro-test; coupon/cashback operators self-eliminate. |

## 6. Scoring - how answers are judged

### 6.1 Core principle
The bot **only auto-declines on objective disqualifiers (hard gates).** A weak-but-not-disqualified applicant is **escalated to the owner, never binned** - a bot must not dismiss a possibly-real partner on a subjective low score.

So: **hard gate → decline. No hard gate → a score sorts form-vs-escalate.** Score never causes a decline (unless the optional low-score dial is switched on later).

### 6.2 Mechanism: LLM extracts, code decides
- **LLM extracts** structured facts from the freeform reply → `{ channelUrls[], claimedAudience, geography, method, evidenceOffered, acceptsTerms, prohibitedTacticsMentioned }` (same structured-output pattern as the existing inbox classifier).
- **Deterministic code** applies the gates + score to those facts. The *decision is code* - auditable, identical every time, un-bluffable.
- **Light automated check:** fetch the claimed channel URL to confirm it resolves and is roughly the claimed type (not a coupon site). Cheap; catches a class of fakes.
- **Degrades safely:** if extraction fails (LLM unavailable), the thread **escalates to the owner** rather than guessing - consistent with PawScout never depending on the LLM to function.

**Honest limit:** this gate filters *plausibility*, not *verified truth* - a liar can claim a real-looking URL and fake numbers. That's intentional: its job is to drop obvious fails and self-selectors cheaply. Real verification is stages [3]/[4]; the ultimate backstop is the pilot ([5]) paying only on verified, post-clawback, new-customer sales - a scammer earns nothing regardless of how good their answers were.

### 6.3 Hard gates (any one → respectful decline)
| Gate | Trips when… |
|---|---|
| G1 No channel | No checkable URL/handle, or it doesn't resolve / isn't theirs |
| G2 Wrong *type* | Coupon/cashback/deal/voucher site, browser extension, or method is brand-bidding / brand-term SEO / discount-code spam |
| G3 No audience fit | Audience neither pet-relevant **nor** in a shipping market (UK-led) |
| G4 Rejects terms | Won't work performance-based, or won't do `#ad` disclosure |
| G5 Prohibited tactics | States plans for unauthorised discounts, fake reviews, cookie-stuffing, self-referral |

### 6.4 Score (only for those who clear all gates) - sorts form vs. owner
Six signals, 0–2 each (max 12):

| # | Signal | 0 / 1 / 2 |
|---|---|---|
| S1 | Audience relevance (pet + UK) | weak / partial / strong |
| S2 | Engagement plausibility (rate vs. follower count, not obviously fake) | implausible / unclear / plausible |
| S3 | Evidence of results (esp. if numbers were claimed) | none when asked / vague / concrete (links, case study) |
| S4 | Experience & professionalism (prior partnerships, disclosure savvy) | none / some / strong |
| S5 | Promotion-method incrementality | discount-led / mixed / content-&-audience-led |
| S6 | Answer specificity & effort | vague/evasive / partial / specific & verifiable |

**Bands (configurable):**
- **Score ≥ 8 → send the application form.**
- **Score 1–7 → escalate to owner** with the full breakdown + recommendation.
- **Optional dial, DEFAULT OFF:** auto-decline very low scores (≤3). Turn on later once the scoring is trusted.

### 6.5 Worked examples
- *"1,000 buyers in 48h for a cut"*, no channel named → **G1 → decline.** With a real pet IG + a past campaign showing comparable numbers → no gate, S3/S5 high → **form**.
- Real *deal-of-the-day coupon site*, big traffic → **G2 → decline** (high traffic, near-zero incrementality).
- *8k-follower UK dog TikTok, ~6% engagement, "honest review", one past collab linked, fine with #ad + performance* → no gate, ~11/12 → **form**.
- *General-lifestyle blogger, pet-adjacent, vague on numbers, no past partnerships, accepts terms* → no gate, ~5/12 → **escalate to owner** (not dismissed).

## 7. The respectful decline

> Hi [Name],
>
> Thank you for taking the time to share that with us - we really do appreciate the interest in Active Paw.
>
> At the moment we're keeping our partnerships limited to creators whose audience and approach line up closely with what we're focused on, and it isn't quite the right fit right now. That's no reflection on your work - just where we are.
>
> If things change on your side - a growing pet-focused audience, a campaign you're proud of - we'd be glad to hear from you again.
>
> Wishing you the best with it,
> Active Paw Partnerships

Warm, specific-but-kind, honest (no false "we'll keep you on file"), leaves a real door open. Sent from `sales@`. Logged and reversible (owner can override → send the form anyway).

## 8. Routing & email identity

### 8.1 Three converging on-ramps (the partnership lane)
A thread enters the partnership funnel if **any** of:
1. **Arrived on `sales@`** (direct email) - clean, high-precision signal; `to_addr` already captured at ingest (`ingest.ts`).
2. **Form Reason = "Partnerships & wholesale"** - declared intent from the contact-form dropdown (§8.3).
3. **Classified `affiliate` / `wholesale-b2b`** by the existing content classifier - the universal catch-all that works on every thread regardless of entry point.

No single mechanism is load-bearing. Content classification catches the affiliate who uses the plain form; address + declared-intent make it cleaner/faster when present.

### 8.2 Declared intent reinforces, never overrides
- The content classifier **keeps owning `primary_category`** (unchanged).
- The dropdown adds a **separate `declared_intent`** signal, stored and shown to the owner/drafter as context.
- If declared-intent and classification diverge, the thread is still classified normally; declared-intent only (a) contributes an OR-trigger to the partnership lane and (b) informs the drafter - it never silently rewrites the category.

### 8.3 Contact-form "Reason" dropdown (theme change)
- Add `<select name="contact[Reason]">` to `snippets/contact-modal.liquid` with options: **General enquiry · Order help · Partnerships & wholesale** (default: General enquiry).
- Shopify contact forms carry custom fields into the notification body; `extractContactForm` (`src/inbox/mime.ts`) gains a parse for the Reason line → stored as `declared_intent`.
- Marked **recommended-but-optional** in the build order: the funnel works on content classification + `sales@` even without it.

### 8.4 Outbound sender identity
- The hardcoded `FROM = 'Active Paw <support@activepaw.co.uk>'` (in `send.ts`, `send-invoice.ts`, `sweep.ts`) is **parameterised**.
- Rule: reply **from the address the customer wrote to** (`to_addr` of their inbound). Partnership-lane threads send from **`sales@` ("Active Paw Partnerships")** - the qualifying email, form link, decline, and pilot comms.
- No Resend change required: Resend verifies the **domain** (`activepaw.co.uk`), so all three addresses already send (SPF/DKIM/DMARC are domain-level). All three Cloudflare Email Routing rules are confirmed to deliver to the worker.

## 9. Application form (stage [2])

A structured form (worker-served page + endpoint, or a theme page posting to the worker - decide at planning). Fields:
- Channel/handle URLs (required, ≥1)
- Platform(s) + follower/subscriber counts + typical engagement
- Audience geography + niche
- Intended promotion format(s)
- Past partnerships / example links
- Agreement checkboxes: `#ad` disclosure, no brand-bidding, no coupon-aggregator posting, performance basis, no self-referral/rebating
- Optional: media kit / rate expectations

Submissions create/advance the applicant record and notify the owner. The form can stay capture-only (no payouts) until the pilot stage is enabled.

## 10. Verification (stage [3]) - from the hardened ruleset

Owner-run (PawScout assists by surfacing the data), drawn from `affiliate-program-terms-and-ruleset.md` Gate 1:
- Identity + reach verified (handle ownership, audience size, engagement screenshots) **before any gift/commission**.
- Original content (not a coupon/redirect/look-alike page).
- Audience pet- and UK-(or shipping-market-)relevant.
- No brand bidding **and** no brand-term organic interception.
- Traffic plausibility (≈100% conversion = fraud flag).

## 11. Pilot stage (stage [5]) - designed, switched on LATER

Gated behind Part F "Step 0" (retention engine) + minimal Part D plumbing. When enabled:
- **Bounded:** time-boxed, capped total payout / order count per pilot.
- **Performance-only, new-customer-only:** 8% net new-customer (per ruleset Gate 2).
- **First-order-margin economics:** do **not** credit unproven future LTV; the pilot must pay back on order one (Part F constraint while no retention base exists).
- **Unique tracked link** primary (codes secondary, single-affiliate-locked).
- **45-day hold + clawback** on refund/cancellation/chargeback.
- **Keep/cut by holdout:** scale only if measured incremental lift clears `I* = C/51` (≈16% at 8%) - ruleset Gate 3.

Until enabled, the funnel ends at [4] (owner decides; any pilot is run manually by the owner).

## 12. Data model

New table `affiliate_applicants` (keyed by shop + thread/contact):
- `shop, id, thread_id, contact_email`
- `stage` - `screen_sent | screen_answered | passed_to_form | form_submitted | verifying | accepted | declined | pilot_active | pilot_done`
- `declared_intent` - from the form dropdown (nullable)
- `screen_verdict_json` - extracted facts + per-signal scores + reasons + decision
- `score` (int, nullable)
- `channel_urls_json`
- `created_at, updated_at`

Thread-level: capture `declared_intent` at ingest (column on the inbound message or thread, decide at planning). Existing `inbox_threads.primary_category` and `inbox_thread_labels` are untouched in meaning.

## 13. Inbox integration

- **Drafter (sweep):** for a partnership-lane thread at `stage = screen_sent`-pending (i.e. needs the screen), the drafter composes the **qualifying email** instead of a generic reply. After the applicant answers (`stage = screen_answered`), the next sweep runs the **scoring** and drafts either the form-invite, the respectful decline, or flags **escalate** - reusing the existing draft → approve/regenerate HITL flow.
- **HITL preserved:** in manual mode the owner approves every send via the thread modal (the focused inbox modal: open → review → Approve & Send / Regenerate; status + label auto-update on send; processed threads drop off the Open list).
- **Escalation:** reuse the existing owner-alert path for `escalate` verdicts and strong passes.
- **Transparency/audit:** the verdict (facts + scores + reasons) is stored on the applicant record and shown in the thread modal; auto-declines are logged and reversible.

## 14. Honest constraints & dependencies

- **No payouts until** Part D plumbing + Part F retention engine exist. Front of funnel runs now; pilot later.
- **Email screen = plausibility filter**, not fraud-proof verification. Layered verification ([3]/[4]) + pay-on-verified-results ([5]) are the real safeguards.
- **Credibility:** method + disclosure vetted before anyone represents the brand; ASA `#ad` disclosure is a hard term (joint liability).
- **UK legal:** clawback/penalty clauses against individuals need solicitor review (per ruleset Part E) - applies only at the pilot/contract stage.

## 15. Phasing

1. **Phase 1 (now):** partnership-lane routing (content-classification + `sales@`), the qualifying email, the LLM-extract→code-decide scoring, the respectful decline, `FROM` parameterisation, applicant data model, inbox/drafter integration, transparency/audit. Front-only - no payouts.
2. **Phase 2:** contact-form Reason dropdown (theme) + `declared_intent` capture.
3. **Phase 3:** application form page + endpoint.
4. **Phase 4 (gated):** the bounded performance pilot, when the retention engine lands.

## 16. Testing

- Scoring is deterministic code → unit-test the gates and bands against fixture extracted-facts (incl. each worked example in §6.5).
- LLM extraction → schema-validated structured output; test the fallback-to-escalate on extraction failure.
- Routing → unit-test the three on-ramps (sales@ / declared_intent / classification) converge to the partnership lane; declared-intent never overrides `primary_category`.
- Drafter → characterization tests that a partnership-lane thread drafts the qualifying email; post-answer drafts form/decline/escalate per verdict.
- Email identity → `FROM` resolves to `sales@` for partnership threads, to `to_addr` otherwise.

## 17. Open dials (owner-tunable later)

- Pass threshold (default **≥8/12**).
- Auto-decline low scores ≤3 (default **OFF**).
- Nudge cadence for non-responders.
- Whether to add a dedicated "Partner with us" page separate from the general contact form.
