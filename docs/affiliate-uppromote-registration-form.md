# UpPromote registration form - paste-ready field set + terms + reviewer cheat-sheet

**Purpose:** one UpPromote registration form that *screens at submission*, mirroring PawScout's qualifying-email funnel (`src/inbox/partnership.ts`) - the same signals it extracts and the same hard gates G1–G5 - plus the binding terms (ruleset Part E, incl. the new **E.11** no-UK-dispatch clause). Both lanes converge here: PawScout-screened email applicants (Lane A) and UpPromote Marketplace / self-serve applicants (Lane B). **Manual approval, always** - the form captures the signals; a human applies the gates below.

Cross-refs: `affiliate-program-terms-and-ruleset.md` (Part A admission, Part E clauses), `affiliate-program-analysis.md` §3 (differentiator = bundles + creator audience, **no** UK-dispatch claim), `src/inbox/partnership.ts` (the email-lane equivalent: ScreenFacts + scoreScreen G1–G5).

> Field *types* below use generic names - confirm the exact control types your UpPromote plan exposes (text / paragraph / dropdown / checkbox) when you build it. Custom fields are plan-gated; **(verify on your plan)**.

---

## 1. UpPromote settings (set these first)

- **Approval mode:** Manual (turn auto-approve **OFF**). This is your audit trail and the human gate.
- **Branding / sender:** all portal + affiliate email on **@activepaw.co.uk** (never myshopify / sandbox).
- **Tag on approval:** source (`pawscout` | `marketplace` | `direct`) + niche + audience-size band - for later segmentation and holdout tests.
- **Link to the full Affiliate Agreement** from the form (referenced by the final checkbox).

---

## 2. Standard fields (UpPromote built-in)

- Full name · Email · Password · **Country** · PayPal email (can be collected later, at first payout).

---

## 3. Custom fields (the screen) - label · type · required · maps to

| # | Field label (what the applicant sees) | Type | Req? | Maps to (gate / signal) |
|---|---|---|---|---|
| 1 | **Where will you promote Active Paw?** Paste the full link(s) to the channel(s), profile(s) or site where you'd feature us. | Paragraph | ✅ | **G1** (no real link → decline); `channelUrls` |
| 2 | **Main platform** | Dropdown: Instagram / TikTok / YouTube / Blog or website / Facebook / Pinterest / Other | ✅ | context |
| 3 | **Approx. audience size** | Dropdown: <1k / 1k–10k / 10k–50k / 50k–250k / 250k+ | ✅ | relevance + engagement |
| 4 | **Recent engagement** - typical likes/comments/views on a recent post (a link to one really helps). | Text | ✅ | `engagement` (plausible / unclear / implausible) |
| 5 | **Where are most of your audience based?** | Dropdown: Mostly UK / Roughly half UK / Mostly outside the UK / Not sure | ✅ | **G3** (audience fit); `specificity` |
| 6 | **Is your audience pet-focused?** | Dropdown: Yes - pet/dog/cat focused / Partly - pets among other topics / No - general audience | ✅ | **G3** (audience fit) |
| 7 | **How would you mainly promote us?** | Dropdown: Reviews / how-to / UGC content · "Best for dogs/cats" feature · Everyday content & mentions · Discount-code posts · Paid ads · **Coupon / cashback / deals site** | ✅ | `method` (content/mixed/discount); **G2** (coupon/cashback = decline flag) |
| 8 | **Have you partnered with brands before?** Share 1–2 examples or links (pet-related especially welcome) and any results you can show. | Paragraph | ➖ (optional) | `experience` + `evidence` |
| 9 | **Anything else we should know?** | Paragraph | ➖ | free signal |

---

## 4. Terms-acceptance checkboxes - **all required to submit** (this is gate G4)

Each is a separate **required** checkbox so acceptance is explicit and auditable. (Refusing any = they can't submit = self-declines, exactly as PawScout's G4 declines someone who rejects the terms.) Verbatim wording:

1. ☑ **Performance basis** - I understand commission is paid only on **verified sales from new customers**, via my own tracked link - no upfront fees and no guaranteed-volume deals.
2. ☑ **Disclosure** - I will clearly label affiliate/sponsored posts with **#ad** (and **#ad gifted** for gifted items), shown **upfront**, before any "see more".
3. ☑ **No brand bidding** - I will not bid on, or SEO-target, "Active Paw" (including misspellings, variants, or "+ review/discount/code" combinations).
4. ☑ **No coupon/cashback aggregators** - I will not post my code or links on coupon, cashback, voucher, or browser-extension sites. My code is mine alone and will not be stacked with other discounts.
5. ☑ **Honest delivery & origin** - I will not state or imply that Active Paw ships, dispatches, holds stock, or is made **in the UK**, and I won't quote UK delivery speeds. Approved phrasing is "ships internationally" / "delivered to your door". *(ruleset E.11)*
6. ☑ **Agreement** - I have read and agree to the **[Active Paw Affiliate Agreement](#)**, and I understand every application is manually reviewed.

---

## 5. Reviewer cheat-sheet (apply when approving in UpPromote = the human G1–G5 + score)

**HARD DECLINE if ANY of these (mirror of PawScout G1–G5 - respectful decline, no commission):**
- **G1** - no real channel link, or the link is a coupon/deals page, dead, or private (Field 1).
- **G2** - Field 7 = "Coupon / cashback / deals site", or any sign they'll bid on the brand name.
- **G3** - audience is **neither** pet-relevant **nor** UK-relevant (Fields 5 + 6 both off).
- **G4** - they object to any term, ask for upfront pay, or refuse #ad disclosure.
- **G5** - states prohibited tactics: fake reviews, cookie-stuffing, self-referral, code leaking.

**APPROVE (green) - roughly PawScout score ≥ 8:** a real, visible channel + pet-and-UK(-ish) audience + content/review-led promotion + plausible engagement + accepts all terms.

**ESCALATE / ask more (amber) - don't auto-decline:** borderline - partial audience fit, unclear engagement, thin proof, or a "mixed" method. Send a short follow-up or hold for review. (Matches PawScout's auto-decline-low = **OFF**: never bin a real applicant on a soft score.)

**Always:** manual approval; tag source + niche + size on the way in.

---

## 6. Lane A note (PawScout-screened email applicants)

PawScout's `FORM_INVITE_BODY` (the `passed_to_form` stage) hands a qualified email applicant the link to **this** form. They've already answered these questions by email, so the form is confirmation + the official application record. Caveat: UpPromote's hosted form likely can't be pre-filled from PawScout's extracted facts **(verify)** - so a Lane-A applicant may re-enter their answers here. Acceptable; it's the single source-of-truth application record either way.
