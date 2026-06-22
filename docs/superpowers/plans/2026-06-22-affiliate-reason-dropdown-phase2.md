# Affiliate Reason Dropdown (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a customer-facing "Reason" dropdown to the contact form whose selection routes a partnership inquiry into the Phase-1 affiliate funnel on first contact, stored as `inbox_threads.declared_intent`.

**Architecture:** A self-declared intent flows: theme `<select name="contact[Reason]">` → Shopify contact notification → `extractContactForm` parses + validates the token → `ingestParsed` persists it on the new thread (`declared_intent`) → `maybePartnershipDraft` reads `got.thread.declared_intent` so the funnel fires on first touch. The console surfaces the declared intent. Declared intent **reinforces, never overrides** the content classifier — `primary_category` is untouched.

**Tech Stack:** Cloudflare Worker (TypeScript) + D1 (SQLite); Vitest with `@cloudflare/vitest-pool-workers` (`cloudflare:test`); Shopify theme (Liquid, no build step).

**Spec:** `docs/superpowers/specs/2026-06-22-affiliate-reason-dropdown-design.md`
**Parent (shipped):** Phase 1 — `isPartnershipLane`, `maybePartnershipDraft`, `affiliate_applicants` (worker `d1870f90`).

## Global Constraints

- **Reinforces, never overrides:** `declared_intent` only adds an OR-trigger to the partnership lane. `primary_category` and the content classifier are untouched.
- **Lane is affiliate-only:** declared `partnerships` → funnel (qualifying email); declared `order`/`wholesale` → generic drafter (no funnel). `isPartnershipLane` already carries the `declaredIntent === 'partnerships'` on-ramp.
- **Accepted tokens are exactly `{ order, partnerships, wholesale }`.** Anything else (incl. `general`, empty, absent, or an unknown string) → `null`. A parse miss degrades to **exactly today's behavior** (no auto-routing) — never a regression. This is the safety backstop; never trust a raw client value.
- **Worker tests run in 1–4 file batches.** A full `vitest run` of the whole suite hits a miniflare runtime ceiling (a 529-like infra failure, NOT a real test failure). Always run the named test files for the task, never the whole suite.
- **`src/console/page.ts` is one big template literal** (HTML + CSS + browser JS). `tsc` cannot see JS syntax errors inside it, so ALWAYS run `tests/console.test.ts` after editing it, and double-escape any `\\n` inside browser-JS strings.
- **Theme changes are MANDATORY-process** (memory `theme-change-process`): reconcile live vs HEAD → dev-theme push → Playwright verify → live push → re-verify. Never `--only` clobber live-only work. The theme repo (`F:\Projects\Shopify\demo-store2`) is a SEPARATE git repo from the worker.
- **Auto-push to GitHub** after each commit (both repos). Production deploys — `npx wrangler deploy`, the D1 migration on `--remote`, and the theme **live** push — require explicit owner go (gated, performed after the plan).

---

### Task 1: Parse the `Reason` token in `extractContactForm`

**Files:**
- Modify: `src/inbox/mime.ts:57-78` (`extractContactForm`)
- Test: `tests/inbox-mime.test.ts`

**Interfaces:**
- Consumes: `ParsedEmail` (unchanged).
- Produces: `extractContactForm(p)` now returns `{ email: string; name: string | null; phone: string | null; body: string; reason: string | null }` (or `null` for non-form mail, as before). `reason ∈ { 'order', 'partnerships', 'wholesale' } | null`.

- [ ] **Step 1: Write the failing tests**

Add these to `tests/inbox-mime.test.ts` inside the existing `describe('extractContactForm', ...)` block:

```ts
  it('parses a recognised Reason token from the notification body', async () => {
    const p: Awaited<ReturnType<typeof parseInbound>> = {
      messageId: '<n@shopify>', inReplyTo: null, references: [],
      from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      to: ['contact@activepaw.co.uk'], subject: 'New customer message', date: '2026-06-22T10:00:00Z',
      text: 'Name: Mia Creator\nEmail: mia@creator.com\nReason: partnerships\n\nMessage:\nI run a dog TikTok and want to collaborate.',
      html: null, headers: { 'reply-to': 'Mia Creator <mia@creator.com>' }
    };
    const c = extractContactForm(p);
    expect(c).not.toBeNull();
    expect(c!.reason).toBe('partnerships');
    expect(c!.email).toBe('mia@creator.com');
  });

  it('maps an unknown / general / empty / absent Reason to null (safe degradation)', async () => {
    const base = {
      messageId: '<n@shopify>', inReplyTo: null, references: [],
      from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      to: ['contact@activepaw.co.uk'], subject: 'New customer message', date: '2026-06-22T10:00:00Z',
      html: null as string | null, headers: { 'reply-to': 'Sam <sam@x.com>' }
    };
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\nReason: bananas\n\nMessage:\nhi' } as any)!.reason).toBeNull();
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\nReason: general\n\nMessage:\nhi' } as any)!.reason).toBeNull();
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\nReason: \n\nMessage:\nhi' } as any)!.reason).toBeNull();
    expect(extractContactForm({ ...base, text: 'Email: sam@x.com\n\nMessage:\nhi' } as any)!.reason).toBeNull();
  });

  it('does not treat the word "reason" inside the message body as a declared intent', async () => {
    const p = {
      messageId: '<n@shopify>', inReplyTo: null, references: [],
      from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      to: ['support@activepaw.co.uk'], subject: 'New customer message', date: '2026-06-22T10:00:00Z',
      text: 'Email: bob@x.com\n\nMessage:\nThe reason I am writing is to ask about an order.',
      html: null, headers: { 'reply-to': 'Bob <bob@x.com>' }
    };
    expect(extractContactForm(p as any)!.reason).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-mime.test.ts`
Expected: the three new tests FAIL (`c!.reason` is `undefined`, not `'partnerships'`/`null`). The existing two tests still pass.

- [ ] **Step 3: Add the `reason` parse + validation**

In `src/inbox/mime.ts`, widen the return type and add the parse. Change the signature (line 57-59):

```ts
export function extractContactForm(
  p: ParsedEmail
): { email: string; name: string | null; phone: string | null; body: string; reason: string | null } | null {
```

Then, just before the final `return` (currently line 77), insert the reason parse and add `reason` to the returned object:

```ts
  // Phase 2: a self-declared intent from the contact-form "Reason" dropdown
  // (contact[Reason]). Shopify lists custom fields in the notification body as
  // "Reason: <token>". Anchor to a line start (deviates from spec §5's un-anchored
  // /reason[:\s]*([a-z_]+)/i) so the word "reason" inside the message body cannot be
  // mistaken for the field. Validate against the known token set; anything else
  // (incl. "general", empty, absent, or any unknown string) → null, which degrades to
  // exactly today's behaviour (no auto-routing) — never a regression.
  const DECLARED_INTENTS = new Set(['order', 'partnerships', 'wholesale']);
  const rawReason = (p.text.match(/^\s*reason\b[:\s]*([a-z_]+)/im)?.[1] ?? '').toLowerCase();
  const reason = DECLARED_INTENTS.has(rawReason) ? rawReason : null;

  return { email: replyEmail.toLowerCase(), name, phone, body, reason };
```

(Delete the old `return { email: replyEmail.toLowerCase(), name, phone, body };` line — it is replaced by the block above.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-mime.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/inbox/mime.ts tests/inbox-mime.test.ts
git commit -m "feat(inbox): parse contact-form Reason token into declared intent"
```

---

### Task 2: Persist `declared_intent` (migration + ThreadRow + createThread + ingest)

**Files:**
- Create: `migrations/0016_thread_declared_intent.sql`
- Modify: `src/inbox/types.ts:88-93` (`ThreadRow`)
- Modify: `src/tenant-store.ts:796-807` (`createThread`)
- Modify: `src/inbox/ingest.ts:36-39` (the `createThread` call in `ingestParsed`)
- Test: `tests/inbox-ingest.test.ts`

**Interfaces:**
- Consumes: `extractContactForm().reason` (Task 1).
- Produces: `ThreadRow.declared_intent: string | null`; `createThread` accepts an optional `declaredIntent?: string | null` field. Later tasks read `ThreadRow.declared_intent`.

- [ ] **Step 1: Create the migration**

Create `migrations/0016_thread_declared_intent.sql`:

```sql
-- Phase 2: self-declared intent from the contact-form "Reason" dropdown.
-- Reinforces (never overrides) the content classifier's primary_category.
-- Nullable; existing rows and all non-form emails stay NULL.
ALTER TABLE inbox_threads ADD COLUMN declared_intent TEXT;
```

- [ ] **Step 2: Add the field to `ThreadRow`**

In `src/inbox/types.ts`, add `declared_intent` to `ThreadRow` (currently lines 88-93):

```ts
export interface ThreadRow {
  shop: string; id: string; contact_email: string; subject: string | null;
  subject_norm: string | null; status: ThreadStatus; primary_category: string | null;
  intent_score: number | null; summary: string | null; classified_at: string | null;
  last_message_at: string; created_at: string; updated_at: string;
  declared_intent: string | null;  // Phase 2: contact-form Reason dropdown (reinforces classifier)
}
```

- [ ] **Step 3: Write the failing tests**

Add these to `tests/inbox-ingest.test.ts` inside the existing `describe('ingestParsed', ...)` block:

```ts
  it('stores the contact-form declared intent on a new thread (Reason dropdown → declared_intent)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({
      messageId: '<form-partner@shopify>', from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      subject: 'New customer message',
      headers: { 'reply-to': 'Mia Creator <mia@creator.com>' },
      text: 'Name: Mia Creator\nEmail: mia@creator.com\nReason: partnerships\n\nMessage:\nI run a dog TikTok and want to collaborate.'
    }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.contact_email).toBe('mia@creator.com');
    expect(got?.thread.declared_intent).toBe('partnerships');
  });

  it('leaves declared_intent NULL for a normal direct email (no form, no Reason)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({}));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.declared_intent).toBeNull();
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-ingest.test.ts`
Expected: the new "stores the contact-form declared intent" test FAILS (`declared_intent` is `null`, not `'partnerships'` — `createThread` doesn't persist it yet). The "leaves NULL" test will already pass (column defaults NULL). The migration must be picked up automatically by `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` — if you instead see "no such column: declared_intent", the test runner did not load migration 0016; confirm the file is named `migrations/0016_thread_declared_intent.sql` and re-run.

- [ ] **Step 5: Persist `declaredIntent` in `createThread`**

In `src/tenant-store.ts`, update `createThread` (lines 796-807) to accept and store the optional field:

```ts
  async createThread(t: { contactEmail: string; subject: string; subjectNorm: string; receivedAt: string; initialStatus: ThreadStatus; declaredIntent?: string | null }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO inbox_threads (shop, id, contact_email, subject, subject_norm, status, last_message_at, created_at, updated_at, declared_intent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`
      )
      .bind(this.shop, id, t.contactEmail, t.subject, t.subjectNorm, t.initialStatus, t.receivedAt, now, t.declaredIntent ?? null)
      .run();
    return id;
  }
```

- [ ] **Step 6: Pass `reason` from `ingestParsed`**

In `src/inbox/ingest.ts`, update the `createThread` call (lines 37-39) to pass the parsed reason:

```ts
    threadId = await store.createThread({
      contactEmail: email, subject: p.subject, subjectNorm, receivedAt: p.date, initialStatus,
      declaredIntent: form?.reason ?? null
    });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-ingest.test.ts tests/inbox-store.test.ts`
Expected: PASS (both files — `inbox-store.test.ts` is a regression check that the additive `createThread` change broke no existing store test).

- [ ] **Step 8: Commit**

```bash
git add migrations/0016_thread_declared_intent.sql src/inbox/types.ts src/tenant-store.ts src/inbox/ingest.ts tests/inbox-ingest.test.ts
git commit -m "feat(inbox): persist contact-form declared_intent on the thread (migration 0016)"
```

---

### Task 3: Fire the partnership lane on `thread.declared_intent` at first touch

**Files:**
- Modify: `src/inbox/partnership.ts:198-220` (`maybePartnershipDraft` — the lane computation only)
- Test: `tests/partnership-draft-screen.test.ts`

**Interfaces:**
- Consumes: `ThreadRow.declared_intent` (Task 2); `isPartnershipLane({ inboundToAddrs, declaredIntent, primaryCategory })` (existing — already returns `true` when `declaredIntent === 'partnerships'`).
- Produces: no signature change. Behaviour change: the funnel now fires on first touch from a declared-`partnerships` thread (no applicant row required).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `tests/partnership-draft-screen.test.ts` (after the existing `describe`):

```ts
describe('partnership lane via declared intent (Phase 2 first-touch)', () => {
  it('a declared partnerships form (non-affiliate category, no applicant) drafts the qualifying email on first touch', async () => {
    const s = new TenantStore(env.DB, 'c.myshopify.com');
    await s.upsertContact({ email: 'mia@creator.com', name: 'Mia', phone: null });
    // Classified as something OTHER than affiliate, arrived on support@ (not sales@):
    // the ONLY on-ramp is the declared intent.
    const tid = await s.createThread({ contactEmail: 'mia@creator.com', subject: 'Hello', subjectNorm: 'hello', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply', declaredIntent: 'partnerships' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 30, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<c1@x>', inReplyTo: null, references: [], from: 'mia@creator.com', to: 'support@activepaw.co.uk', subject: 'Hello', bodyText: 'I run a dog TikTok and want to collaborate.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    expect(await s.getApplicantByThread(tid)).toBeNull(); // no applicant row yet — genuinely first touch
    const r = await composeDraftForThread({ ...env } as any, s, CFG, thread, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent');
  });

  it('a declared wholesale form does NOT enter the funnel (generic drafter path)', async () => {
    const s = new TenantStore(env.DB, 'd.myshopify.com');
    await s.upsertContact({ email: 'buyer@trade.com', name: 'Buyer', phone: null });
    const tid = await s.createThread({ contactEmail: 'buyer@trade.com', subject: 'Bulk order', subjectNorm: 'bulk order', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply', declaredIntent: 'wholesale' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 30, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<d1@x>', inReplyTo: null, references: [], from: 'buyer@trade.com', to: 'support@activepaw.co.uk', subject: 'Bulk order', bodyText: 'Can I buy 500 units wholesale?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, CFG, thread, noFetch);
    // No LLM keys → generic drafter returns null; the partnership intercept must NOT fire.
    expect(r).toBeNull();
    expect(await s.getApplicantByThread(tid)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/partnership-draft-screen.test.ts`
Expected: the "declared partnerships first-touch" test FAILS (`r` is `null` — the lane currently reads `applicant?.declared_intent`, which is `null` when there is no applicant row, so the intercept does not fire). The "declared wholesale" test passes (it asserts the funnel does NOT fire, which is the current behaviour too).

- [ ] **Step 3: Read declared intent from the thread, not the applicant**

In `src/inbox/partnership.ts`, in `maybePartnershipDraft`, replace the current lane computation (lines 203-206):

```ts
  const inboundToAddrs = got.messages.filter((m) => m.direction === 'inbound').map((m) => m.to_addr ?? '');
  const applicant = await store.getApplicantByThread(thread.id);
  const declaredIntent = applicant?.declared_intent ?? null;
  if (!isPartnershipLane({ inboundToAddrs, declaredIntent, primaryCategory: thread.primary_category })) return null;
```

with:

```ts
  const inboundToAddrs = got.messages.filter((m) => m.direction === 'inbound').map((m) => m.to_addr ?? '');
  // Phase 2: declared intent lives at THREAD level (set from the contact-form Reason
  // dropdown at ingest), so the funnel fires on FIRST touch — before any applicant row
  // exists. Read got.thread (the fresh SELECT * row from getThreadWithMessages) rather
  // than the param thread, so the column is always present even if a future caller passes
  // a projected thread. Reinforces, never overrides, the classifier: primary_category is
  // untouched, and isPartnershipLane only ORs the partnerships on-ramp in.
  const declaredIntent = got.thread.declared_intent;
  const applicant = await store.getApplicantByThread(thread.id);
  if (!isPartnershipLane({ inboundToAddrs, declaredIntent, primaryCategory: thread.primary_category })) return null;
```

(The `applicant` lookup is still needed by the stage logic below — only its role in computing `declaredIntent` is removed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/partnership-draft-screen.test.ts tests/partnership-draft-score.test.ts`
Expected: PASS (both files — `partnership-draft-score.test.ts` is a regression check that the screen-answered scoring path still behaves, since both exercise `maybePartnershipDraft`).

- [ ] **Step 5: Commit**

```bash
git add src/inbox/partnership.ts tests/partnership-draft-screen.test.ts
git commit -m "feat(inbox): partnership funnel fires from thread.declared_intent on first touch"
```

---

### Task 4: Surface the declared intent in the console

**Files:**
- Modify: `src/console/page.ts:1076-1090` and `1175-1179` (`renderInboxThread`)
- Test: `tests/console.test.ts`

**Interfaces:**
- Consumes: `ThreadRow.declared_intent` (Task 2), already delivered through `getInboxThread`'s `thread` payload — **no `routes.ts` change is needed** (it returns `got.thread` directly).
- Produces: a "Declared: &lt;friendly label&gt;" line in the thread-detail header when `thread.declared_intent` is set.

- [ ] **Step 1: Write the failing test**

Add this to `tests/console.test.ts` inside `describe('consolePage', ...)`:

```ts
  it('surfaces the contact-form declared intent in the thread detail', async () => {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    // renderInboxThread maps the declared_intent token to a friendly label and shows a
    // "Declared:" line when present — visible even on non-funnel order/wholesale threads
    // where there is no Partnership screening panel. Reinforces the classifier.
    expect(scripts).toContain('thread.declared_intent');
    expect(scripts).toContain('Declared:');
    expect(scripts).toContain('Creator / affiliate partnership');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/console.test.ts`
Expected: the new test FAILS (`scripts` does not contain `thread.declared_intent`). The existing "emits inline `<script>` that is syntactically valid JS" test still passes.

- [ ] **Step 3: Build the declared-intent line**

In `src/console/page.ts`, inside `renderInboxThread`, just after the `partnerHtml` block closes (after the current line 1090, `'</div>';`), add:

```ts
  var declaredHtml='';
  if(thread.declared_intent){
    var DMAP={order:'Order help',partnerships:'Creator / affiliate partnership',wholesale:'Wholesale / bulk order'};
    var dlabel=DMAP[thread.declared_intent]||thread.declared_intent;
    declaredHtml='<p class="muted" style="margin:6px 0 0;font-size:12px">Declared: <strong>'+esc(dlabel)+'</strong></p>';
  }
```

- [ ] **Step 4: Insert the line into the detail header**

In the `detail.innerHTML='...'` assignment (around line 1175-1179), insert `+declaredHtml` immediately after the summary line and before `+msgHtml`:

```ts
    +(thread.summary?'<p class="muted" style="margin:6px 0 0;font-size:12px">'+esc(thread.summary)+'</p>':'')
    +declaredHtml
    +msgHtml
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/console.test.ts`
Expected: PASS (all tests, including the inline-script syntax guard — confirms the template literal is still valid).

- [ ] **Step 6: Commit**

```bash
git add src/console/page.ts tests/console.test.ts
git commit -m "feat(console): show contact-form declared intent in thread detail"
```

---

### Task 5: Add the "Reason" dropdown to the contact form (theme)

> **Repo note:** this task edits the THEME repo at `F:\Projects\Shopify\demo-store2`, NOT the worker. Commit there. The theme has no automated test harness, so the in-loop verification is a **static content check** (below). The full dev-theme Playwright verification and the **live** push are a gated post-implementation step the controller performs per the `theme-change-process` memory — do NOT push to the live theme from this task.

**Files:**
- Modify: `F:\Projects\Shopify\demo-store2\snippets\contact-modal.liquid:49-52` (insert the select after the Phone field, before the Message field)
- Modify: `F:\Projects\Shopify\demo-store2\assets\theme.css:2749-2763` (extend the field selectors to cover `select`)

**Interfaces:**
- Produces: a `<select name="contact[Reason]">` whose option `value`s are the tokens `''` / `order` / `partnerships` / `wholesale` (matching `extractContactForm`'s accepted set from Task 1). The empty default → `null` declared intent.

- [ ] **Step 1: Add the select to the contact modal**

In `snippets/contact-modal.liquid`, insert this block **between** the Phone field (ends line 52) and the Message field (starts line 53):

```liquid
        <div class="contact-form__field">
          <label for="ContactReason">What's this about?</label>
          <select id="ContactReason" name="contact[Reason]">
            <option value="" selected>General enquiry</option>
            <option value="order">Order help</option>
            <option value="partnerships">Creator / affiliate partnership</option>
            <option value="wholesale">Wholesale / bulk order</option>
          </select>
        </div>
```

(Per spec §4, custom `contact[*]` fields are not re-exposed by Liquid `form.*` on a validation error, so the select simply defaults back to "General enquiry" on error re-render — the customer re-picks. Acceptable.)

- [ ] **Step 2: Style the select like the other fields (DRY — extend, don't duplicate)**

In `assets/theme.css`, add `select` to the two existing field rule selectors so it inherits the input styling. Change (line 2749-2750):

```css
.contact-form input,
.contact-form textarea {
```

to:

```css
.contact-form input,
.contact-form select,
.contact-form textarea {
```

and change the focus rule (line 2762-2763):

```css
.contact-form input:focus,
.contact-form textarea:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 4px rgba(240, 90, 40, 0.14); }
```

to:

```css
.contact-form input:focus,
.contact-form select:focus,
.contact-form textarea:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 4px rgba(240, 90, 40, 0.14); }
```

- [ ] **Step 3: Static content check (the in-loop verification)**

Run (from `F:\Projects\Shopify\demo-store2`):

```bash
grep -n 'name="contact\[Reason\]"' snippets/contact-modal.liquid
grep -n 'value="partnerships"' snippets/contact-modal.liquid
grep -n '.contact-form select' assets/theme.css
```

Expected: each grep prints a match — the select is present with the `contact[Reason]` name, the `partnerships` token option, and the CSS now covers `select`.

- [ ] **Step 4: Commit (theme repo)**

```bash
git add snippets/contact-modal.liquid assets/theme.css
git commit -m "feat(theme): add What's-this-about Reason dropdown to contact form"
```

---

## Post-plan gated steps (controller, with owner go)

These are NOT plan tasks — they are deploys that require explicit owner approval:

1. **Theme verification + live push** (per `theme-change-process`): `shopify theme pull` to reconcile live vs HEAD → push to a dev theme → Playwright-verify the dropdown renders, defaults to "General enquiry", and submits → push to the **live** theme → re-verify. Never `--only` clobber live-only work.
2. **D1 migration:** `npx wrangler d1 execute pawscout --remote --file migrations/0016_thread_declared_intent.sql`.
3. **Worker deploy:** `npx wrangler deploy`.
4. **End-to-end live proof** (the true verification of the parse path, which no unit test can reach — spec §9/§11): submit the live contact form with Reason = "Creator / affiliate partnership", then confirm the new thread carries `declared_intent='partnerships'` and the qualifying email drafts on the next `*/15` sweep.

## Self-Review

**Spec coverage:** §4 dropdown → Task 5; §5 parse/validate → Task 1, migration/createThread/ThreadRow/ingest → Task 2; §6 first-touch lane fix → Task 3; §7 console surfacing → Task 4; §8 data model → Task 2 (migration); §9 testing → distributed across each task's tests + the gated live proof; §10 gated deploys → Post-plan section; §11 honest constraints → captured as the safe-degradation backstop (Global Constraints) and the live-proof step. No orphaned requirement.

**Placeholder scan:** every code step shows the exact code; every run step shows the command and expected outcome. No TBD/TODO/"handle edge cases".

**Type consistency:** `declared_intent` (snake_case DB/`ThreadRow` field) vs `declaredIntent` (camelCase `createThread` param and `isPartnershipLane` opt) used consistently throughout. `reason` is the `extractContactForm` return field; `form?.reason` is mapped to `declaredIntent` at the `createThread` call (Task 2 Step 6). Token set `{ order, partnerships, wholesale }` matches between Task 1 (`DECLARED_INTENTS`) and Task 5 (option values). Friendly-label map (Task 4) covers all three tokens.
