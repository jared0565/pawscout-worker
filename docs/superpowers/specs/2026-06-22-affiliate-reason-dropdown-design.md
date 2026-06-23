# Affiliate Inbound Gating - Phase 2: Contact-form "Reason" dropdown → `declared_intent`

**Date:** 2026-06-22
**Parent:** `docs/superpowers/specs/2026-06-22-affiliate-inbound-gating-design.md` (§8.2/§8.3/§12)
**Builds on:** Phase 1 (shipped + deployed, worker `d1870f90`) - `isPartnershipLane`, `maybePartnershipDraft`, `affiliate_applicants`.
**Status:** Design - awaiting user review before implementation planning.

## 1. Problem

The on-site contact form is Shopify-native (`{% form 'contact' %}`): every submission is funnelled through one notification address, so the inbound `to_addr` can't tell sales from support from general (unlike a direct email to `sales@`). Today the partnership lane only fires via content-classification (`affiliate`) or a direct `sales@` email. A form-based partner inquiry that the classifier doesn't tag as `affiliate` is missed.

Phase 2 adds a **"What's this about?" dropdown** so a form submitter self-declares intent. This is a **declared-intent signal that reinforces - never overrides - the content classifier** (per the parent spec's governing principle). It also closes a first-touch gap: `maybePartnershipDraft` currently reads `applicant?.declared_intent`, but on a thread's first touch no applicant row exists, so declared intent must live at thread level to route on first contact.

## 2. Goals / non-goals

**Goals**
- A customer-facing Reason dropdown whose selection routes a partnership inquiry into the Phase-1 funnel on first contact.
- Keep it consistent with the Phase-1 decision that the lane is **affiliate-only**: a *creator/affiliate* selection triggers the funnel; *wholesale* does not.
- Surface the declared intent to the owner.

**Non-goals**
- Any special handling for `order` / `wholesale` beyond storing + displaying them (YAGNI; they trigger no funnel in Phase 1).
- A dedicated wholesale flow, the application-form page (Phase 3), or the pilot (Phase 4).
- Changing the content classifier or `primary_category`.

## 3. Data flow

```
Customer selects "Reason" in the contact modal
  → Shopify native form POST → notification email (custom field appears as "Reason: <token>")
  → worker email handler → extractContactForm parses + validates the token
  → ingest stores it as inbox_threads.declared_intent
  → maybePartnershipDraft / isPartnershipLane read thread.declared_intent on FIRST touch
  → Reason=partnerships → partnership funnel (qualifying email); order/wholesale → generic drafter
```

## 4. Theme - the dropdown

`snippets/contact-modal.liquid`: add a `<select name="contact[Reason]">` above the Message field. Custom `contact[*]` fields are included by Shopify in the notification email body, so the worker can read it. The `value` attribute is the **internal token** (not the label) so the notification is clean to parse:

| Option label (customer sees) | `<option value>` | Resulting `declared_intent` |
|---|---|---|
| General enquiry *(default, selected)* | `` (empty) | none |
| Order help | `order` | `order` |
| Creator / affiliate partnership | `partnerships` | `partnerships` (→ funnel) |
| Wholesale / bulk order | `wholesale` | `wholesale` |

- Label it (`<label for="ContactReason">What's this about?</label>`), styled like the other `.contact-form__field`s.
- Re-render the chosen value on a validation error, like the other fields (`{% if form.reason ... %}` is not available for custom fields, so reflect via a small `{% assign %}` from `form` if Shopify exposes it; otherwise default to General on error re-render - acceptable, the customer re-picks).
- **Mandatory theme-change process:** reconcile live vs HEAD → dev-theme push → Playwright verify the dropdown renders + submits → live push → re-verify. No `--only` clobber of live-only work.

## 5. Worker - parse, validate, store

- **`extractContactForm`** (`src/inbox/mime.ts`) returns an added `reason: string | null`: parse the notification body with `/reason[:\s]*([a-z_]+)/i`, lowercase, then **validate against the known set** `{ 'order', 'partnerships', 'wholesale' }` - anything else (incl. `general`, empty, or absent) → `null`. Never trust a raw client value; only these three are accepted.
- **Migration 0016** (`migrations/0016_thread_declared_intent.sql`): `ALTER TABLE inbox_threads ADD COLUMN declared_intent TEXT;` (nullable; existing rows NULL).
- **`createThread`** gains an optional `declaredIntent` field (stored into the new column). **`ingestParsed`** passes `form?.reason ?? null`. **`ThreadRow`** (`src/inbox/types.ts`) gains `declared_intent: string | null`.
- Only set on thread creation from a form submission; a non-form email leaves it NULL.

## 6. Worker - lane reach (the first-touch fix)

- **`maybePartnershipDraft`** (`src/inbox/partnership.ts`) reads `thread.declared_intent` instead of `applicant?.declared_intent` when computing the lane, so a `Reason=partnerships` form submission enters the funnel on first contact (no applicant row needed). `isPartnershipLane` already carries the `declaredIntent === 'partnerships'` on-ramp from Phase 1 - only the source changes.
- **Reinforces, never overrides:** `primary_category` is untouched; `declared_intent` only contributes an OR-trigger to the lane. The Phase-1 `applicant.declared_intent` column becomes redundant (thread is now the source of truth) - noted as dead, not removed (no churn; Phase-2 can drop it if desired).

## 7. Console - surface the declared intent

`getInboxThread` already returns the thread (which now carries `declared_intent`). In `renderInboxThread` (`src/console/page.ts`), when `thread.declared_intent` is present, show a small line in the detail header (e.g. **"Declared: Creator / affiliate partnership"**, mapping token → friendly label). This gives the owner the customer's stated intent even on non-funnel (`order`/`wholesale`) threads, where there's no Phase-1 applicant panel. Template-literal trap applies: run `tests/console.test.ts`; double-escape any `\\n`.

## 8. Data model

`inbox_threads.declared_intent TEXT` (nullable). No new table. `affiliate_applicants.declared_intent` (Phase 1) is left in place but unused.

## 9. Testing

- `extractContactForm`: parses `partnerships`/`order`/`wholesale`; maps unknown/`general`/empty/absent → `null`.
- `createThread`/store: persists `declared_intent`; round-trips via `getThreadWithMessages`.
- **Lane on first touch:** a thread with `declared_intent='partnerships'`, classified non-affiliate, **no applicant row** → `composeDraftForThread` drafts the qualifying email (funnel fires from the declared intent alone).
- `declared_intent='wholesale'` (non-affiliate category) → does **not** enter the funnel (generic drafter path).
- Console: `renderInboxThread` shows the declared line when present; `console.test.ts` inline-script syntax guard stays green.
- Theme: dev-theme Playwright - dropdown renders, defaults to General, submits; (declared-intent end-to-end through a real Shopify notification can't be unit-tested - verify via a live form submission post-deploy).

## 10. Dependencies & phasing

- Depends on Phase 1 (deployed). Independent of Phase 3 (application form) and Phase 4 (pilot).
- **Gated deploys (owner go):** migration 0016 → remote D1; `npx wrangler deploy`; theme live push (after dev-verify). Theme + worker both change here, so both deploy.

## 11. Honest constraints

- Relies on Shopify including the `contact[Reason]` custom field in the contact notification (documented behaviour) and on `extractContactForm`'s existing Reply-To/body parsing continuing to resolve the real visitor.
- `declared_intent` is a hint: it routes and informs, but the classifier remains authoritative for `primary_category`, and the funnel's own gates/scoring still decide outcomes.
- The end-to-end path (real form → Shopify notification → parse) is only fully provable with a live submission; unit tests cover every worker/console seam up to that boundary.
