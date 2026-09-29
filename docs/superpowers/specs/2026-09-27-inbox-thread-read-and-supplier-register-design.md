# Inbox: thread reading, a supplier lane and a supplier register

Status: design and written spec approved by the owner on 2026-09-27; next is
the implementation plan.

## Why

An audit of the 14 newest inbox threads and every supplier thread (read-only,
production D1, 2026-09-26) found:

1. **Suppliers have no lane.** Eight suppliers in three weeks (cat litter,
   Bioline twice, felt products twice, toys, two packaging makers) were all
   classified `other` and drafted by the general agent. Replies declined the
   information they offered ("no commitment regarding catalogues"), and one
   sent a felt-products factory to the affiliate programme (the owner discarded
   it). The `supplier_ack` template exists but is reachable only by a console
   click, and it says "there is nothing you need to do from here", which
   contradicts what the owner does by hand: every edited supplier reply asked
   for "your website address or preferably alibaba store ... for our later
   reference".
2. **Service vendors get the creator template.** An EU fulfilment company
   (Mail Boxes Etc. Liberec) was offered the affiliate discount code; Raphael,
   who wrote "I'm not reaching out for affiliate", got the full creator invite.
3. **Threads are answered message by message, not read.** "Are you there?"
   openers get "Yes, please share what you noticed", which invites the pitch
   that follows; a pitcher's "Thank you for your response" got "We are glad we
   could help".
4. **Wrong greeting names.** "Hi Store", "Hi Ecormerce": `ROLE_NAMES` in
   `src/inbox/draft.ts` has no store/shop/ecommerce entries.
5. **A closed thread never reopens.** Investor Mark's "do you ship
   internationally?" (2026-06-18) was never answered, and his new message on
   2026-09-24 produced no draft (`src/inbox/ingest.ts:106`).

Autosend is off on every lane (`tenant_config.inbox.agents.*.autosend` all
false, read 2026-09-26), so every draft is reviewed by the owner before
sending. Nothing in this design changes that.

## Owner decisions (2026-09-27)

- Approach A: a new `supplier` classifier lane plus a thread-reading step
  before every draft.
- Supplier replies are signed **Active Paw Sourcing Team**.
- A lasting supplier register in the worker, a console view, and a one-off
  written report now of the suppliers already in the inbox (delivered as a
  private page, not committed, because it carries other companies' contacts).
- Vague openers ("Is this Activepaw?", "Are you there?") are answered and
  steered to products or orders, not to "share your ideas".
- A bare "thank you" after our answer gets **no draft**; the console shows
  "no reply needed" with a button to draft anyway.
- A new message on a closed thread **reopens it only when a customer asks a
  real question**; pitches and spam stay closed.
- Every goods or packaging supplier is asked whether they offer dropshipping,
  and the register records the answer (`dropship`).
- The saved `inbox.replyGuidance` is left as it is (owner-editable in the
  console).

Assumptions the owner did not correct:
- "Information" a supplier offers means a catalogue, price list, specs,
  product listing, or a website or store link. Samples, calls, meetings and
  WhatsApp are not accepted: they need an address or read as engagement.
- Logistics and fulfilment companies get their own polite reply (neither the
  supplier wording about products nor the affiliate code).
- Off-niche suppliers get the same reply; the register marks them off-niche.
- No template repeats the owner's ad-hoc claims about how we source ("our
  system connects via API", "mostly Alibaba"): they are not grounded facts.

## Non-goals

- No change to autosend, the money hold, the partnership funnel's stages for
  real creators, or any store fact in `STORE_FACTS`.
- No reply to suppliers beyond the acknowledgement: no ordering, sampling or
  supplier onboarding flow.
- No change to `inbox.replyGuidance` content.

## Design

### 1. Thread reader (`src/inbox/thread-read.ts`, new)

One LLM call (the `text` chain; the central reasoning floor in `src/llm.ts`
already applies) that reads the whole two-sided transcript from
`buildDraftTranscript` (quote-stripped, role markers neutralised, inbound
treated as untrusted) plus the subject and the sender's email domain, and
returns a validated `ThreadReading`:

| Field | Meaning |
|---|---|
| `senderRole` | `customer`, `creator`, `marketer` (sells us a service, including performance or commission based growth), `goods-supplier`, `logistics`, `unknown` |
| `openAsks` | questions from the sender that no reply of ours has answered yet |
| `offered` | one line: what they offer us, or empty |
| `alreadyAnswered` | short list of what we have already told them |
| `replyNeeded` | false only when the open messages carry no question or request and are an acknowledgement (thanks, ok) after our answer |
| `supplier` | present only for `goods-supplier` and `logistics`: `company`, `contactName`, `website`, `storeLinks[]`, `kind` (`goods`, `packaging`, `logistics`), `productLines[]`, `shipsFrom`, `nicheFit` (`on-niche` dog and cat products, `adjacent`, `off-niche`), `dropship` (`yes`, `no`, `unknown`: `yes` or `no` only when the sender's own words say so) |

Validation caps every string, keeps a link only when it parses as an http or
https URL, and drops unknown enum values. The reading is stored on the thread
(`inbox_threads.reading_json`, `read_at`) so the console can show it.

**Failure is never blocking**: no model, a bad reply or a validation miss
returns `null`, and drafting proceeds exactly as today.

Where it runs, in `composeDraftForThread` (`src/inbox/sweep.ts`), first,
before the partnership intercept:

- `replyNeeded === false` → no draft is written; the thread goes to
  `awaiting_customer` and the stored reading carries the reason.
- `senderRole` is `goods-supplier` or `logistics` and the thread is not in
  the `supplier` lane → the thread is moved to it (classification set, pending
  drafts superseded), as `reclassifyOne` does on a lane change.
  **Owner ruling 2026-09-28:** only from `other`, `wholesale-b2b` or
  `affiliate`. A `lead`, `product-question`, `order-status`,
  `shipping-returns` or `complaint` thread keeps its lane and its agent; the
  supplier register is still written.
- The partnership intercept (`maybePartnershipDraft`) stands down for the
  supplier lane unless an applicant row already exists. For a `marketer`, its
  first touch is `service_prove_first`, never the creator `signup_invite`;
  a `creator` keeps today's funnel.
- The reading is passed to `draftReply` and rendered into the system prompt as
  grounded context ("what they still need answered", "what we already said"),
  replacing the generic "answer the latest message" paragraph.

Closed threads: the sweep also picks up `closed` threads (never `automated`,
never `spam`) whose newest inbound is newer than their classification, runs the
reader, and reopens the thread to `needs_reply` only when `senderRole` is
`customer` and `openAsks` is non-empty; otherwise it stamps the thread so it
does not re-qualify. Ingest itself is unchanged (it has no LLM).

### 2. Supplier lane

- `INBOX_LABELS` gains `supplier`. The classifier guide defines it: an offer
  to supply us goods, packaging or materials, or supply-chain services
  (warehousing, fulfilment, logistics). Marketing, SEO and growth pitches stay
  `other` under the prove-first rule. `decideDisposition` gives `supplier`
  `needs_reply` with no owner alert.
- New agent `src/inbox/agents/supplier.ts`, department `sourcing`
  (`DEPARTMENT_SIGNATURES.sourcing = 'Active Paw Sourcing Team'`), not
  commercial, autosend default false. Its prompt, fed by the reading:
  1. thank them for the specific range or service named in `offered`;
  2. accept what they offer to send (catalogue, price list, specs, listing):
     they are welcome to email it;
  3. ask for their website or Alibaba (or other online) store link for our
     reference, unless the thread already has it;
  3a. ask whether they offer dropshipping, that is sending single orders
     directly to our customers, unless the thread already answers it (goods
     and packaging suppliers only, not logistics). Asking commits us to
     nothing; the answer is recorded in the register (section 3);
  4. say their details are kept on file for reference, and nothing more;
  5. a request for a call, meeting, WhatsApp or samples: we keep supplier
     contact on email and are not arranging samples or calls (no "at this
     stage");
  6. logistics: we keep their service details and website on file; never
     share our products, volumes or order data for a quote;
  7. a follow-up is shorter and acknowledges only what is new (existing
     never-repeat rule and `repeatsPriorOutbound`).
- **No-promises check** (`draft-quality.ts`, deterministic): on supplier-lane
  drafts, `promisesSupplier(text)` flags commitment wording (we will order,
  place an order, stock, list, review, contact you, be in touch, get back to
  you; look forward to working together; partnership; accepting a call,
  meeting, WhatsApp or samples; the affiliate URL or a discount code). A hit is
  a revision issue in `refineUntilClean`; if it survives the revisions the
  draft is held with reason `supplier_commitment`.
- **One rule everywhere**: the goods-supplier sentence in `SHARED_SCAFFOLDING`,
  the GOODS SUPPLIERS line in `otherAgent`, the supplier line in
  `PARTNERSHIP_STANCE` (`partnership.ts`), and `SUPPLIER_ACK_BODY` with its
  `SECOND_TOUCH` and `POINTER_BACK` entries all say the same thing (accept the
  information, ask for the website or store link, no commitment), and
  `supplier_ack` signs as the Sourcing Team.

### 3. Supplier register

Migration `0044_supplier_register.sql` (new; no applied migration is edited):

- `supplier_register`: `shop`, `email` (unique per shop), `company`,
  `contact_name`, `website`, `store_links` (JSON), `kind`, `product_lines`
  (JSON), `ships_from`, `niche_fit`, `dropship` (`yes`, `no`, `unknown`,
  default `unknown`; owner decision 2026-09-27), `first_thread_id`, `first_seen_at`,
  `last_seen_at`, `message_count`, and owner fields `status` (`new`,
  `reviewed`, `dismissed`, default `new`) and `notes`. Index on
  `(shop, last_seen_at)`.
- `inbox_threads` gains `reading_json TEXT` and `read_at TEXT`.

Filling: whenever a reading has `supplier`, the row is upserted by email. An
update only fills or extends fields; it never blanks one that has a value, and
never touches `status` or `notes`. `dropship` moves from `unknown` to `yes` or
`no` when a reading reports the sender's answer, and a later `unknown` never
overwrites a known answer. The console view shows and filters by it. Tenant-scoped through `TenantStore` like
every other table.

Console: a **Suppliers** view in the Inbox tab (newest first, filters by kind
and niche fit, a link to each thread, status and notes editable; everything
escaped). Routes are session-authed like the rest of `/api/inbox/*`.

Back-fill: a console button "Scan past inbox for suppliers" sets a cursor
(`search_cache` key `job:supplier-backfill`); each 15-minute sweep then reads
up to 20 `other`/`supplier` threads from the last 90 days (cap 200 in total),
writes register rows and thread readings only, drafts nothing and changes no
thread status, until the cursor is done.

### 4. General drafter clean-up

- The sender-related patches in `SHARED_SCAFFOLDING` (WhatsApp, pitch,
  supplier, partnership exception) become one ordered block keyed by
  `senderRole`. Fact rules are kept word for word.
- Vague openers with no concrete question (`unknown` sender, no `openAsks`
  beyond "is this Active Paw / are you there"): "Yes, this is Active Paw" plus
  an invitation to ask about our products or an order. The existing worked
  example ("Is your store ready for order?" answered "we are open and taking
  orders") still holds.
- The "reply with a short warm acknowledgement" instruction applies only when
  the reader failed; otherwise `replyNeeded` decides.
- `ROLE_NAMES` gains `store`, `shop`, `ecommerce`, `ecormerce`, `ecom`,
  `marketing`, `business` and `export`, so they greet "Hi there". (The
  local-part fallback that produced "Ecormerce" is covered by the same list.)
- Console: a thread with `replyNeeded === false` shows "no reply needed" and a
  "Draft anyway" action (the existing Regenerate route, forced).

## Error handling

- Reader failure: `null`, today's behaviour, logged with `logLlmUsage` on
  success only (as the other inbox calls do).
- Register write failure: logged and skipped; never blocks the draft.
- Back-fill: a failed thread is skipped and counted; the cursor still moves.

## Testing (tests first)

- `promisesSupplier`: each commitment phrase flagged; a clean acknowledgement
  passes; the affiliate URL flagged.
- `salutationName`: the new role words return null.
- Reader validation: caps, URL filter, enum filter, `null` on garbage.
- Supplier prompt: the dropshipping question is asked once, not when the thread
  already answers it, and never to a logistics sender; the no-promises check
  does not flag the question itself.
- Register upsert: fill, extend, never blank, `dropship` unknown never
  overwrites yes or no, status and notes untouched,
  tenant isolation (a second shop never sees the row).
- Sweep routing with a mocked LLM: each `senderRole`; `replyNeeded` false
  writes no draft; supplier re-route supersedes drafts; the funnel stands down
  for suppliers; `marketer` gets `service_prove_first`; closed thread reopens
  only for a customer with an open ask; reader failure equals today.
- Every existing dated regression (Rose, Sofia, azanwatch3 and the rest) stays
  green unchanged.
- `tests/console.test.ts` and `npm run lint` after the console change
  (template-literal page).
- Migration applied to a local D1; full suite and `tsc --noEmit` green; CI
  green on the branch.

## Rollout

1. Written report of the existing suppliers (read-only, private page), first.
2. Branch `feat/inbox-thread-read-suppliers`, commits pushed as they land,
   `aramid check --staged`, never `--no-verify`.
3. `npm run deploy -- --env staging`; then production only on the owner's go,
   off the cron marks.
4. After production: regenerate drafts on the audited threads (the eight
   suppliers, Mail Boxes Liberec, Raphael, the "are you there" openers) and
   compare with the old drafts; start the back-fill; read the register.
