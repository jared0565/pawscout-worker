# Inbox reply end state Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read every inbound message, and make no draft for a reply that adds no new words.
A seller who keeps writing gets one friendly final answer, then quiet; nobody else is silenced
without an owner alert.

**Architecture:**
- **Ingest:** a formatted-only email gets its text from its HTML (a new
  `src/inbox/html-text.ts`). A newsletter-shaped one is gated as automated.
- **Drafting:** `composeDraftForThread` gains a "no new words" gate (a new
  `src/inbox/contentless.ts`).
- **Funnel:** the partnership funnel (`maybePartnershipDraft`) loses the one-line pointer.
  Its ladder now ends in:
  - the final answer, for a seller;
  - a once-per-thread owner alert, for anyone else;
  - quiet, after the final answer has been sent.

**Tech Stack:** TypeScript, a Cloudflare Worker, D1, postal-mime, vitest with
`@cloudflare/vitest-plugin`.

**Spec:** `docs/superpowers/specs/2026-11-19-inbox-reply-end-state-design.md`, approved by
the owner 2026-11-19. Code read at `945d88c`.

**Two plan-time decisions the spec allowed** (both reported to the owner):
1. **The staging replay (spec 1a) is replaced by its own fallback: a deterministic guard that
   always ships.**
   - Staging has no inbound route (it was deleted 2026-11-15) and runs no sweep, so the replay
     cannot run there.
   - The guard is measured on the production export. All 19 TikTok Shop mails have 8 or more
     `<img>` and 8 or more `<a>` tags. Of the other 36 formatted-only mails, none has more
     than 4 images or 5 links.
2. **One migration, `0049`,** adds a once-per-thread alert stamp. `maybeAlertOwner` does not
   deduplicate, and nothing else can record "alerted".

**Branch:** keep working on `design/inbox-reply-end-state`, which already holds the spec and
this plan. One PR for all of it.

## Global Constraints

- **Copy:** no em or en dashes anywhere (code, tests, comments, copy).
- **HITL:** every funnel draft stays HITL, returning `send: false`. Nothing in this build
  auto-sends.
- **Apply link:** a body that mentions the programme or the code trial contains
  `AFFILIATE_APPLY_URL`.
- **Voice:** customer-facing text refers to our side as the team, never a person.
- **Final answer:** it is never drafted after it has been sent on the thread. It is drafted
  only in full: no second touch, no pointer.
- **Quiet:** quiet means thread status `awaiting_customer`, never `closed`. Ingest reopens
  only `awaiting_customer` and `needs_reply` threads (`src/inbox/ingest.ts:145`).
- **Force:** `force` (Regenerate, Draft anyway) always lets the owner get a draft. No new gate
  applies under `force`.
- **Fixtures:** test fixtures are synthetic. No real sender names, text or addresses from
  production.
- **Graph first:** before editing a shared function, run `python -P -m graphite impact <file>`
  and `context <file>`. For callers, run `python -P -m graphite query "callers <fn>"`, and
  read `answer.grade`. Grep only for literal text.
- **Console JS:** `src/console/*-js.ts` are template literals. After editing one, run
  `npx vitest run tests/console.test.ts` and `npm run lint`.
- **Commits:**
  - run `aramid check --staged`;
  - `git add` named paths only;
  - put the message in a scratchpad file, commit with `git commit -F <file>`, and end it with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - `git push`;
  - never `--no-verify`.
- **Deploy:** only `npm run deploy -- --env staging`. Production only on the owner's exact
  "deploy <sha> to production".

## Review Focus

1. **A text part that is whitespace or zero-width only, beside a real HTML part,** must use
   the HTML. Test in Task 2.
2. **An Outlook-style HTML quote** (`From:` ... `Sent:` lines) must still be stripped, so that
   a bump quoting our email reads as no new words. Test in Task 1.
3. **A failed reading** (`reading` null) on an applicant whose ladder is used up gets no draft
   plus one alert. It never gets the seller final answer, and it is never silenced. Test in
   Task 8.
4. **Regenerate or Draft anyway on a quiet thread** produces a draft from the generic drafter,
   not `noReply`. Test in Task 8.
5. **A seller who asks a real customer question after the final answer** (the reader says
   `customer`) is answered by the generic drafter. Test in Task 8.

---

### Task 1: HTML to email text, and the newsletter shape

**Files:**
- Create: `src/inbox/html-text.ts`
- Test: `tests/inbox-html-text.test.ts`

**Interfaces:**
- Produces:
  - `htmlToEmailText(html: string, maxChars?: number): string`
  - `HTML_TEXT_MAX_CHARS = 20000`
  - `isNewsletterShaped(html: string): boolean`
  - `NEWSLETTER_MIN_IMAGES = 6`
  - `NEWSLETTER_MIN_LINKS = 6`

- [ ] **Step 1: Write the failing tests** in `tests/inbox-html-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { htmlToEmailText, isNewsletterShaped } from '../src/inbox/html-text';
import { stripQuotedReply } from '../src/inbox/quote';

describe('htmlToEmailText', () => {
  it('keeps paragraph and line breaks', () => {
    expect(htmlToEmailText('<p>Hi,<br /><br />Are you looking for a mobile app?</p><p>Lara</p>'))
      .toBe('Hi,\n\nAre you looking for a mobile app?\nLara');
  });
  it('decodes entities, including numeric ones', () => {
    expect(htmlToEmailText('<pre>I&#039;d like to know if you have &quot;slow feeders&quot; &amp; bowls</pre>'))
      .toBe('I\'d like to know if you have "slow feeders" & bowls');
  });
  it('drops head, style, script and comments', () => {
    expect(htmlToEmailText('<head><title>x</title><style>p{color:red}</style></head><!-- c --><script>alert(1)</script><div>Hello there</div>'))
      .toBe('Hello there');
  });
  it('prefixes blockquote lines so a Gmail quote is stripped', () => {
    const html = '<div dir="ltr">Thanks, see you</div><div class="gmail_quote"><div>On Mon, 6 Jul 2026, 18:20 Active Paw &lt;sales@activepaw.co.uk&gt; wrote:<br></div><blockquote class="gmail_quote">Hi Sam,<br>The next step is your code.</blockquote></div>';
    const text = htmlToEmailText(html);
    expect(text).toContain('> Hi Sam,');
    expect(stripQuotedReply(text)).toBe('Thanks, see you');
  });
  it('keeps an Outlook From/Sent header on separate lines so it is stripped', () => {
    const html = '<div>Thanks</div><hr><div><b>From:</b> Active Paw &lt;sales@activepaw.co.uk&gt;<br><b>Sent:</b> Monday, 6 July 2026 18:20<br><b>Subject:</b> Re: Hello</div><div>Hi Sam, the next step is your code.</div>';
    expect(stripQuotedReply(htmlToEmailText(html))).toBe('Thanks');
  });
  it('caps the text at maxChars', () => {
    expect(htmlToEmailText(`<p>${'a'.repeat(50)}</p>`, 10)).toHaveLength(10);
  });
});

describe('isNewsletterShaped', () => {
  const tags = (imgs: number, links: number) => '<img src="x">'.repeat(imgs) + '<a href="y">z</a>'.repeat(links);
  it('is true at 6 images and 6 links', () => expect(isNewsletterShaped(tags(6, 6))).toBe(true));
  it('is false for a short personal email', () => expect(isNewsletterShaped('<p>Do you ship to Ireland?</p>')).toBe(false));
  it('is false at 4 images and 5 links (the largest non-newsletter measured)', () => expect(isNewsletterShaped(tags(4, 5))).toBe(false));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-html-text.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement `src/inbox/html-text.ts`**

- **Order of the conversion:**
  1. remove `<head>…</head>`, `<style>…</style>`, `<script>…</script>` and `<!-- -->`
     (all case-insensitive);
  2. turn `<br>` and `<hr>` into `\n`;
  3. turn closing `</p>`, `</div>`, `</li>`, `</tr>` and `</h1-6>` into `\n`;
  4. replace each `<blockquote …>…</blockquote>`, innermost first (loop until none is left),
     by its inner text with `> ` prefixed to every line;
  5. strip every remaining tag;
  6. decode entities: named `nbsp amp lt gt quot apos #39`, plus decimal `&#NNN;` and hex
     `&#xHH;`;
  7. trim each line's trailing spaces, collapse runs of spaces inside a line, collapse 3 or
     more newlines to 2, trim the whole text, then `slice(0, maxChars)`.
- **`isNewsletterShaped`:** counts `<img\b` and `<a\s` (case-insensitive). It is true when
  images ≥ `NEWSLETTER_MIN_IMAGES` and links ≥ `NEWSLETTER_MIN_LINKS`.
- **Comment the thresholds** with the measurement: "2026-11-19 export: all 19 TikTok Shop mails
  have ≥8 of each, and of the other 36 formatted-only mails none has more than 4 images or 5
  links".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-html-text.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**, with the subject
  `feat(inbox): convert a formatted-only email's HTML into quote-aware text`.

---

### Task 2: Ingest reads formatted-only email and gates newsletters

**Files:**
- Modify: `src/inbox/types.ts` (`ParsedEmail`)
- Modify: `src/inbox/mime.ts:93`
- Modify: `src/inbox/gates.ts:23` (`isAutomated`)
- Test: `tests/inbox-mime.test.ts`, `tests/inbox-ingest.test.ts`

**Interfaces:**
- Consumes: `htmlToEmailText` and `isNewsletterShaped` (Task 1).
- Produces: `ParsedEmail.textFromHtml?: boolean`, true when `text` was derived from the HTML.

- [ ] **Step 1: Read the graph first:**
  - `python -P -m graphite query "callers isAutomated"`, and read the grade;
  - `python -P -m graphite impact src/inbox/mime.ts`.

- [ ] **Step 2: Write the failing tests**
  - **In `tests/inbox-mime.test.ts`,** build raw emails in the file's existing style:
    - `it('an HTML-only email gets its text from the HTML')`: a `text/html` single-part
      message with body `<p>Hi,<br>Do you ship the slow feeder to Ireland?</p>` gives
      `p.text === 'Hi,\nDo you ship the slow feeder to Ireland?'` and
      `p.textFromHtml === true`.
    - `it('a text part that is only whitespace or zero-width uses the HTML part')`: a
      `multipart/alternative` whose `text/plain` is `'​ \r\n'` and whose `text/html` is
      `<p>Do you ship to Ireland?</p>` gives `p.text === 'Do you ship to Ireland?'`.
    - `it('a real plain part still wins')`: the existing `RAW` gives `p.textFromHtml` falsy
      and the same text as today.
  - **In `tests/inbox-ingest.test.ts`,** follow the pattern of
    `it('marks bulk/auto mail as automated and pre-classified')`:
    - `it('an HTML-only newsletter-shaped email is automated at ingest')`: HTML with 8
      `<img>` and 8 `<a>` and no list headers gives a thread status of `closed` and a primary
      category of `automated`.
    - `it('an HTML-only personal email is stored with its text and enters the queue')`: the
      stored `body_text` is the derived text, and the thread status is `new`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-mime.test.ts tests/inbox-ingest.test.ts`
Expected: the new tests FAIL. Today `p.text` is `''`, and the newsletter is `new`.

- [ ] **Step 4: Implement**
  - **`types.ts`:** add `textFromHtml?: boolean` to `ParsedEmail`, with a one-line comment.
  - **`mime.ts`:** remove zero-width characters (`​-‍﻿`) from `email.text`
    before the emptiness check:
    - if what remains is empty and `email.html` is set, then
      `text = htmlToEmailText(email.html)` and `textFromHtml = true`;
    - otherwise `text = (email.text ?? '').trim()` as today, with `textFromHtml` absent.
    - The parse-failure return is unchanged.
  - **`gates.ts` `isAutomated`:** add
    `if (p.textFromHtml && p.html && isNewsletterShaped(p.html)) return true;`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-mime.test.ts tests/inbox-ingest.test.ts tests/inbox-html-text.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**, with the subject
  `feat(inbox): read formatted-only email at ingest; a newsletter-shaped one is automated`.

---

### Task 3: The inbox shows old formatted-only messages

**Files:**
- Modify: `src/inbox/routes.ts:59` (`getInboxThread`)
- Modify: `src/console/inbox-js.ts:343`
- Test: `tests/inbox-routes.test.ts`, plus `tests/console.test.ts` if it asserts `(no body)`

**Interfaces:**
- Consumes: `htmlToEmailText` (Task 1).
- Produces: `getInboxThread(...).messages[i].body_text` is the HTML-derived text when the
  stored `body_text` is empty and `body_html` is set. Display only: the stored row is
  unchanged.

- [ ] **Step 1: Write the failing test** in `tests/inbox-routes.test.ts`:
  `it('shows the text of a stored formatted-only message without changing the row')`.
  - **Setup:** seed an inbound with `bodyText: ''` and
    `bodyHtml: '<p>Do you have this in stock?</p>'`.
  - **Assert:**
    - `(await getInboxThread(env.DB, SHOP, tid)).messages[0].body_text === 'Do you have this in stock?'`;
    - `(await store.getThreadWithMessages(tid))!.messages[0].body_text === ''`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/inbox-routes.test.ts -t "formatted-only"`
Expected: FAIL. `body_text` is `''`.

- [ ] **Step 3: Implement**
  - In `getInboxThread`, return
    `messages: got.messages.map((m) => (m.body_text ?? '').trim() || !m.body_html ? m : { ...m, body_text: htmlToEmailText(m.body_html) })`.
  - In `inbox-js.ts:343`, change the fallback text `'(no body)'` to `'(empty message)'`.
  - Grep `tests/console.test.ts` for the literal `(no body)` and update it if it is there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-routes.test.ts tests/console.test.ts && npm run lint`
Expected: PASS, and lint clean.

- [ ] **Step 5: Commit**, with the subject
  `feat(console): show the text of stored formatted-only messages`.

---

### Task 4: Detect a reply that adds no new words

**Files:**
- Create: `src/inbox/contentless.ts`
- Test: `tests/inbox-contentless.test.ts`

**Interfaces:**
- Consumes: `stripQuotedReply` (`src/inbox/quote.ts`), `normalizeSubject`
  (`src/inbox/gates.ts`), and `MessageRow` (`src/inbox/types.ts`).
- Produces:
  - `hasNoNewWords(ownText: string): boolean`
  - `openBatchHasNoNewWords(messages: ReadonlyArray<Pick<MessageRow, 'direction' | 'body_text'>>, subject: string | null): boolean`

- [ ] **Step 1: Write the failing tests** in `tests/inbox-contentless.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hasNoNewWords, openBatchHasNoNewWords } from '../src/inbox/contentless';

describe('hasNoNewWords', () => {
  it.each(['', 'Hi active paw', 'Hello 👋', '?', '???', 'Activepaw', 'Good morning team', 'Hi\n\nSent from my iPhone', 'Get Outlook for Android'])
    ('%j adds no new words', (t) => expect(hasNoNewWords(t)).toBe(true));
  it.each(['Are you there?', 'Yes', 'Hola', 'Thanks', '𝑯𝒆𝒍𝒍𝒐', 'Can I order 3?'])
    ('%j counts as content', (t) => expect(hasNoNewWords(t)).toBe(false));
});

describe('openBatchHasNoNewWords', () => {
  const inb = (t: string) => ({ direction: 'inbound', body_text: t });
  const out = (t: string) => ({ direction: 'outbound', body_text: t });
  const quoted = 'On Fri, Sep 25, 2026, 12:34 PM Active Paw <sales@activepaw.co.uk> wrote:\n> Hi Sam,\n> Thanks for writing.';
  it('a bump that only quotes our reply', () => expect(openBatchHasNoNewWords([inb('Do you ship to Ireland?'), out('Yes, we do.'), inb(`Hi active paw\n\n${quoted}`)], 'Shipping')).toBe(true));
  it('content anywhere in the open batch counts', () => expect(openBatchHasNoNewWords([inb('Hi'), out('Hello!'), inb('Hi'), inb('Can I order 3?')], 'Hello')).toBe(false));
  it('nothing open (our reply is last) is not a bump', () => expect(openBatchHasNoNewWords([inb('Hi'), out('Hello!')], 'Hello')).toBe(false));
  it('never replied: the subject counts as content', () => expect(openBatchHasNoNewWords([inb('')], 'Do you ship to Ireland?')).toBe(false));
  it('never replied: an empty body and a filler subject', () => expect(openBatchHasNoNewWords([inb('Hi')], 'Re: Hello')).toBe(true));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-contentless.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement `src/inbox/contentless.ts`**
- **`hasNoNewWords`:**
  1. remove whole lines starting `sent from my` or `get outlook for` (case-insensitive,
     multiline);
  2. lower-case the text and replace `/active\s*paw/g` with a space;
  3. collect `/\p{L}+/gu`;
  4. return true when every word is in this closed allowlist:
     `FILLER = hi hello hey hiya dear good morning afternoon evening there team sir madam all buddy friend h`.
- **`openBatchHasNoNewWords`:**
  - `open` = the inbound messages after the last outbound. If there are none, return
    `false`.
  - If any `stripQuotedReply(body_text)` has new words, return `false`.
  - If an outbound exists, return `true`.
  - Otherwise return `hasNoNewWords(normalizeSubject(subject ?? ''))`.
- Add a header comment citing the spec (1c), the closed allowlist, and the rule that in doubt
  we draft.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-contentless.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**, with the subject
  `feat(inbox): detect a reply that adds no new words`.

---

### Task 5: Store support: template key, sent-final lookup, once-per-thread alert

**Files:**
- Create: `migrations/0049_thread_hand_reply_alert.sql`
- Modify: `src/inbox/types.ts` (`DraftMeta`, `ThreadRow`)
- Modify: `src/tenant-store.ts` (two new methods near `setThreadStatus`, line 2403)
- Test: `tests/inbox-drafts-store.test.ts`

**Interfaces:**
- Produces:
  - `DraftMeta.template?: string`, the funnel or console template key that produced the draft;
  - `ThreadRow.hand_reply_alert_at?: string | null`;
  - `TenantStore.hasSentTemplateDraft(threadId: string, templates: readonly string[]): Promise<boolean>`,
    true when a draft on the thread has status `sent` or `auto_sent` and
    `json_extract(meta_json, '$.template')` is in `templates`;
  - `TenantStore.claimHandReplyAlert(threadId: string): Promise<boolean>`, which sets
    `hand_reply_alert_at` only where it is NULL and returns true only for the call that set
    it.

- [ ] **Step 1: Write the failing tests** in `tests/inbox-drafts-store.test.ts`:
  - `it('hasSentTemplateDraft finds a sent draft by its template key, never a pending one')`:
    - insert a draft with `meta: { template: 'collaboration_decline' }` and
      `status: 'pending'`, and expect `false`;
    - `setDraftStatus(id, 'sent', { sentMessageId: '<x>', sentAt: '2026-11-19T10:00:00Z' })`,
      and expect `true`;
    - `hasSentTemplateDraft(tid, ['partnership_decline'])` stays `false`.
  - `it('claimHandReplyAlert is true once per thread')`: the first call is `true`, the second
    `false`, and another thread is `true`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-drafts-store.test.ts`
Expected: FAIL. The methods do not exist.

- [ ] **Step 3: Implement**
  - **Migration:**
    `ALTER TABLE inbox_threads ADD COLUMN hand_reply_alert_at TEXT; -- once-per-thread "reply by hand" alert (design 2026-11-19, 2a)`.
  - **Types:** add the field docs.
  - **Store:** add the methods.
    - `claimHandReplyAlert` runs
      `UPDATE inbox_threads SET hand_reply_alert_at = ?3 WHERE shop = ?1 AND id = ?2 AND hand_reply_alert_at IS NULL`
      and returns `(r.meta.changes ?? 0) === 1`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-drafts-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**, with the subject
  `feat(inbox): record a draft's template key and a once-per-thread alert stamp`.

---

### Task 6: No draft for a reply that adds nothing

**Files:**
- Modify: `src/inbox/partnership.ts:1030-1081` (signature and early return)
- Modify: `src/inbox/sweep.ts:381-404` (`composeDraftForThread`)
- Test: `tests/inbox-thread-read-sweep.test.ts`

**Interfaces:**
- Consumes: `openBatchHasNoNewWords` (Task 4) and `TenantStore.addThreadLabel` (existing,
  `tenant-store.ts:2416`).
- Produces:
  - `export type PartnershipResult = { draftId: string; send: boolean } | { noReply: true } | null;`
  - `maybePartnershipDraft(env, store, cfg, thread, got, _fetchImpl, modeOverride?, reading?, opts: { force?: boolean; contentless?: boolean } = {}): Promise<PartnershipResult>`
  - The thread label `no-content`.

- [ ] **Step 1: Read the graph:** `python -P -m graphite impact src/inbox/sweep.ts` and
  `python -P -m graphite query "callers maybePartnershipDraft"`. Read the grade.

- [ ] **Step 2: Write the failing tests** in `tests/inbox-thread-read-sweep.test.ts`, using
  the file's `seed` and `llm`. The reading must have `replyNeeded: true` and
  `senderRole: 'customer'`, so that the reader gate is not what stops the draft.
  - `it('a bump after our reply gets no draft and waits')`:
    - inbound `['Do you ship to Ireland?', 'Hi active paw']`, with an outbound after the
      first;
    - `composeDraftForThread` returns `{ noReply: true }`;
    - status `awaiting_customer`, and `getPendingDraft` is null.
  - `it('Regenerate (force) still drafts a bump')`: the same seed with `{ force: true }`
    returns a `draftId`.
  - `it('an empty first message with a real subject is answered')`: seed the subject
    `Do you ship to Ireland?` and inbound `['']`; the result has a `draftId`.
  - `it('an empty first message with an empty subject gets no draft and the no-content label')`:
    - the subject is `Hi` and the inbound is `['?']`;
    - the result is `{ noReply: true }`;
    - status `awaiting_customer`, and the labels contain `no-content`.
  - Add an optional `subject` field to `seed`, defaulting to `'Hello'`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-thread-read-sweep.test.ts`
Expected: the new tests FAIL. Drafts are made today.

- [ ] **Step 4: Implement**
  - **In `composeDraftForThread`:**
    - compute `const contentless = !opts.force && openBatchHasNoNewWords(got.messages, thread.subject);`;
    - pass `{ force: opts.force, contentless }` to `maybePartnershipDraft`;
    - return its result when it is non-null, both `draftId` and `noReply`;
    - after it returns `null`, if `contentless`:
      - set status `awaiting_customer`;
      - when no outbound exists, `addThreadLabel(thread.id, 'no-content')`;
      - return `{ noReply: true }`.
  - **In `maybePartnershipDraft`:** add the `opts` parameter and the `PartnershipResult`
    return type, and add `if (!applicant && opts.contentless) return null;` just before the
    lane check at line 1080. A bump never earns a fresh introduction.

- [ ] **Step 5: Run the full inbox and partnership suites**

Run: `npx vitest run tests/inbox-thread-read-sweep.test.ts tests/inbox-sweep.test.ts tests/partnership-draft-screen.test.ts tests/partnership-draft-score.test.ts tests/agents && npm run typecheck`
Expected: PASS.
- An existing test may fail because its first message is filler-only by accident (for
  example a body of `'Hi'` with a filler subject). Give that test a real question, unless the
  test is about contentless input. Note each change in the commit message.

- [ ] **Step 6: Commit**, with the subject
  `feat(inbox): no draft for a reply that adds nothing once we have answered`.

---

### Task 7: The seller final answer

**Files:**
- Modify: `src/inbox/partnership.ts`:
  - `COLLABORATION_DECLINE_BODY` (670-680);
  - `insertTouched` (1097-1118);
  - the access intercept (1167-1179);
  - the `passed_to_form`/`escalated` block (1346-1388).
- Test: `tests/partnership-draft-screen.test.ts`

**Interfaces:**
- Consumes: `PartnershipResult` and `opts` (Task 6), and `DraftMeta.template` (Task 5).
- Produces:
  - `export function isSellerThread(reading: ThreadReading | null | undefined, latestNewText: string): boolean`:
    `reading?.senderRole === 'marketer' || detectAlternativeCollaboration(latestNewText) || detectAccessRequest(latestNewText)`;
  - `export const FINAL_TEMPLATES = ['collaboration_decline', 'partnership_decline'] as const;`;
  - inside `maybePartnershipDraft`, the local helpers `quiet(): Promise<{ noReply: true }>`
    (status `awaiting_customer`) and `draftFinalAnswer(alert: string): Promise<PartnershipResult>`;
  - every `insertTouched` draft carries `meta: { template: key }`.

- [ ] **Step 1: Write the failing tests** in `tests/partnership-draft-screen.test.ts`.
  - Add a helper: an applicant at `passed_to_form`, N outbounds each containing
    `AFFILIATE_APPLY_URL`, a latest inbound, and a `ThreadReading` with
    `senderRole: 'marketer'`.
  - `it('a seller with two introductions gets the final answer, once, in the owner tone')`:
    - the pending draft body equals `buildCollaborationDecline('Kasim')`;
    - it contains `'It is not something we will take forward this time, but we may consider it in the future.'`
      and `AFFILIATE_APPLY_URL`;
    - it does not match `/our answer is no|we do not skip the trial/i`;
    - `parseDraftMeta(draft.meta_json).template === 'collaboration_decline'`;
    - the applicant stage is `declined`, and the result has `send: false`.
  - `it('with one introduction a seller still gets the shorter reminder')`: the existing
    reminder, with stage unchanged.
  - `it('a creator with two introductions is not sent the final answer')`: reading
    `senderRole: 'creator'`, an ordinary question; no draft body equals
    `buildCollaborationDecline`.
  - `it('an access request after two introductions gets the final answer')`: the existing
    access path, new wording.
  - `it('the final answer is never drafted again once its text has gone out')`: an outbound
    whose body is the new final text, then a new seller message, gives `{ noReply: true }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/partnership-draft-screen.test.ts`
Expected: the new tests FAIL. The old wording is still in place, a marketer reading is
ignored in flight, and there is no `noReply`.

- [ ] **Step 3: Implement**
  - **`COLLABORATION_DECLINE_BODY`:** set exactly this approved copy, keeping
    `applySalutation` as today:

```
Thank you for your messages, and for the time you have put into your proposal. We have read your messages. It is not something we will take forward this time, but we may consider it in the future. In the meantime, the code trial stays open to you whenever you would like to try it: ${AFFILIATE_APPLY_URL}

No reply is needed, and we wish you every success.

Best Regards,
Active Paw Partnerships
```

  - **The comment above it:** cite the owner's 2026-11-19 tone rule.
  - **`insertTouched`:** passes `meta: { template: key }`.
  - **`draftFinalAnswer`:**
    - if `repeatsPriorOutbound(body, prior)`, return `quiet()`;
    - otherwise insert the full body as a first touch with
      `meta: { template: 'collaboration_decline' }`, `setApplicantStage(thread.id, 'declined', null)`,
      alert, and return `{ draftId, send: false }`.
  - **The access intercept's `>= 2` branch** calls `draftFinalAnswer` with its existing alert
    text.
  - **In the `passed_to_form`/`escalated` block,** after the `pool === 'live'` branch:
    - `if (countProgrammeIntroductions(got.messages) >= 2 && isSellerThread(reading, latestNewText)) return draftFinalAnswer('A seller kept writing after two introductions - the friendly final answer is ready for your review.');`
    - The old `detectAlternativeCollaboration(...) && >= 2` sub-branch is then removed. The
      `< 2` reminder stays.
  - **Grep `tests/`** for the literal `we do not skip the trial for anyone`, and update every
    assertion that pinned the old wording.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/partnership-draft-screen.test.ts tests/partnership-compose.test.ts tests/partnership-pitch-routing.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**, with the subject
  `feat(inbox): a seller who keeps writing gets one friendly final answer`.

---

### Task 8: Quiet after the final answer, and the end of the ladder

**Files:**
- Modify: `src/inbox/partnership.ts`:
  - a new declined branch before `decline_all` (line 1132);
  - `insertTouched`'s ladder;
  - each `insertTouched` call site;
  - a contentless quiet for applicants.
- Test: `tests/partnership-draft-screen.test.ts`, plus an end-to-end test in
  `tests/inbox-thread-read-sweep.test.ts`

**Interfaces:**
- Consumes:
  - `hasSentTemplateDraft` and `claimHandReplyAlert` (Task 5);
  - `quiet` and `draftFinalAnswer` (Task 7);
  - `opts.force` and `opts.contentless` (Task 6).
- Produces:
  - `insertTouched` returns `{ draftId: string; touch: 'first' | 'second' } | { exhausted: true }`;
  - the local helpers
    - `finalAnswerGiven(): Promise<boolean>`,
    - `handReplyOnce(summary: string): Promise<{ noReply: true }>`,
    - `onExhausted(): Promise<PartnershipResult>`;
  - the alert copy:
    - `'Both replies on this point have gone out; reply by hand if anything is needed.'`
    - `'A declined applicant wrote again; reply by hand if anything is needed.'`

- [ ] **Step 1: Write the failing tests.** Use `{ ...env, RESEND_API_KEY: 'k' }`, a config
  with `inbox.alertEmail` set, and a fetch spy that counts calls to the Resend URL. Each test
  below asserts that count.
  - `it('after the final answer is sent, a seller gets no draft and no alert')`:
    - the final draft is marked `sent` via `setDraftStatus`, plus an outbound row;
    - a new inbound `'So is it yes or no?'` gives `{ noReply: true }`, status
      `awaiting_customer`, and 0 alert calls.
  - `it('after the final answer, a customer question is answered by the generic drafter')`:
    a reading with `senderRole: 'customer'` makes `maybePartnershipDraft` return `null`.
  - `it('Regenerate on a quiet seller thread still produces a draft')`: `force: true` returns
    `null`, so the generic drafter runs.
  - `it('a creator declined on score who writes again gets no draft and one alert, once')`:
    - stage `declined`, with a sent draft carrying `meta.template: 'partnership_decline'`;
    - two later messages give `noReply` both times, and 1 alert call in total.
  - `it('a declined applicant whose decline was discarded unsent gets it drafted again')`:
    - for a seller, `buildCollaborationDecline`;
    - for a non-seller, `buildPartnershipDecline`.
  - `it('declines sent before the template key existed still count')`: stage `declined`, no
    keyed draft, and an outbound with `received_at >=` the applicant's `updated_at`, give
    quiet.
  - `it('a non-seller at the end of the ladder gets no draft and one alert')`: a holding ack
    and its second touch are already sent; the next message gives `noReply` and 1 alert.
  - `it('a failed reading at the end of the ladder is treated as a non-seller')`: `reading`
    is null, which gives `noReply` and 1 alert, and the body is never
    `buildCollaborationDecline`.
  - `it('an applicant bump gets no draft unless the seller final answer is due')`:
    - a real applicant at `escalated` writing `'Hello?'` gives `noReply`;
    - a marketer with 2 introductions writing `'Hi active paw'` gets the final answer.
  - End to end, in `tests/inbox-thread-read-sweep.test.ts`:
    `it('the De Zimar shape: a seller bump gets the final answer, then quiet')`.
    - **Setup:** a synthetic seller, 4 link-carrying outbounds, and an applicant at
      `passed_to_form`.
    - **Run 1:** a latest `'Hi active paw\n\n<quoted>'` with a mocked marketer reading.
      `composeDraftForThread` drafts the final answer.
    - **Run 2:** mark it sent and add a new `'Hi'`. The next compose gives `{ noReply: true }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/partnership-draft-screen.test.ts tests/inbox-thread-read-sweep.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
  - **`insertTouched`:** drop `chooseTouch` and the pointer.
    - The ladder is `opts.startAtSecond ? [second] : [first, second]`.
    - Pick the first body for which `!repeatsPriorOutbound(body, prior)`. If there is none,
      return `{ exhausted: true }`.
    - `repeat_touch` is held when the pick is the second touch.
  - **`finalAnswerGiven`:**
    `await store.hasSentTemplateDraft(thread.id, FINAL_TEMPLATES) || got.messages.some((m) => m.direction === 'outbound' && m.received_at >= applicant!.updated_at)`.
    Comment that the second half is for declines sent before this build.
  - **`handReplyOnce(summary)`:** `if (await store.claimHandReplyAlert(thread.id)) await maybeAlertOwner(...)`,
    then `quiet()`.
  - **`onExhausted`:**
    - if `opts.force`, return `null`;
    - if `isSellerThread(reading, latestNewText)`, return `draftFinalAnswer(<the Task 7 seller alert>)`;
    - otherwise return `handReplyOnce('Both replies on this point have gone out; reply by hand if anything is needed.')`.
  - **Each `insertTouched` call site** handles `'exhausted' in r` by returning `onExhausted()`.
    The `send` flags stay as today.
  - **The new declined branch, placed before `if (mode === 'decline_all')`, when
    `applicant?.stage === 'declined'`:**
    - if `opts.force || reading?.senderRole === 'customer'`, return `null`;
    - if `await finalAnswerGiven()`:
      - a seller thread returns `quiet()`;
      - otherwise return `handReplyOnce('A declined applicant wrote again; reply by hand if anything is needed.')`;
    - otherwise, for a seller, return `draftFinalAnswer(...)`. For a non-seller, insert the
      full `buildPartnershipDecline(name)` with `meta: { template: 'partnership_decline' }`,
      and return `{ draftId, send: false }`.
  - **Remove** the now-unreachable `if (applicant?.stage === 'declined') return null;` inside
    `decline_all` and the `return null` fall-through comment at line 1340. The decline_all
    draft also carries `meta.template: 'partnership_decline'`, through `insertTouched`.
  - **Before the first-touch block** (`if (!applicant)`, line 1223), add the contentless quiet
    for applicants:
    `if (applicant && opts.contentless && !(sellerFinalDue)) return quiet();`.
    - `sellerFinalDue` = the stage is `passed_to_form` or `escalated`, the pool is not
      `'live'`, there are 2 or more introductions, and `isSellerThread(...)`.
    - Hoist the `partnerPoolState` call so that it is computed once.
  - **Update `tests/partnership-draft-screen.test.ts:53`**
    (`'a follow-up AFTER the decline falls through to the generic drafter'`). It now expects
    the declined branch. Rename it to say what it proves.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/partnership-draft-screen.test.ts tests/partnership-draft-score.test.ts tests/inbox-thread-read-sweep.test.ts tests/partnership-compose.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**, with the subject
  `feat(inbox): quiet after the final answer; the funnel no longer sends the pointer`.

---

### Task 9: Console template picker, and retiring the pointer

**Files:**
- Modify: `src/inbox/routes.ts:309-361` (`applyDraftTemplate`)
- Modify: `src/inbox/partnership.ts:849-874` (remove `POINTER_BACK` and `buildPointerBack`)
- Modify: `src/inbox/repeat.ts:97-...` (`TouchKind` and `chooseTouch`)
- Modify: `src/console/inbox-js.ts`, if it reads `touch === 'pointer'`
- Test: `tests/inbox-routes.test.ts`, `tests/partnership-compose.test.ts`,
  `tests/inbox-repeat.test.ts`

**Interfaces:**
- Produces:
  - `applyDraftTemplate` returns `{ ok: false, error }` instead of a pointer;
  - `TouchKind = 'first' | 'second'`;
  - drafts carry `meta.template = touchKey`, alongside any `stageOnSend`.

- [ ] **Step 1: Write the failing tests** in `tests/inbox-routes.test.ts`:
  - `it('a template already sent twice is refused, not turned into a pointer')`: the error is
    `'This reply has already gone out twice on this thread. Write the next one by hand.'`.
  - `it('the final answer is offered in full, and never a second time')`:
    - the first apply of `collaboration_decline` renders `buildCollaborationDecline(name)`;
    - once that text is sent, the next apply gives
      `'The final answer has already gone out on this thread. Write the next one by hand.'`.
  - `it('a picked template records its key')`:
    `parseDraftMeta(draft.meta_json).template === 'service_prove_first'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/inbox-routes.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
  - **`applyDraftTemplate`:**
    - uses the same explicit ladder as `insertTouched`: `[first]` only for
      `collaboration_decline`, `[second]` for `signup_followup`, and `[first, second]`
      otherwise;
    - returns the two exact errors above when the ladder is exhausted;
    - merges `template: touchKey` into `meta`.
  - **Delete** `POINTER_BACK`, `buildPointerBack` and their test assertions. The test
    `'every template has a second touch shorter than the first'` keeps its second-touch half.
  - **`python -P -m graphite query "callers chooseTouch"`:** if only its own test remains,
    delete `chooseTouch` and that test, and narrow `TouchKind`.
  - **Grep `src/console/inbox-js.ts`** for the literal `pointer` and update the label. Then
    run the console test and lint.
  - **Remove the comment at `partnership.ts:849-850`**, which says "still pending their
    approval": the owner decided on 2026-11-19.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/inbox-routes.test.ts tests/partnership-compose.test.ts tests/inbox-repeat.test.ts tests/console.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**, with the subject
  `feat(console): the template picker refuses a third send instead of a pointer`.

---

### Task 10: The two small fixes

**Files:**
- Modify: `src/inbox/partnership.ts:256` (the refusal regex)
- Modify: `src/inbox/draft.ts:133-147` (`greetingName`)
- Test: the file that tests `detectAlternativeCollaboration`
  (`python -P -m graphite query "callers detectAlternativeCollaboration"`), and
  `tests/inbox-sanitize.test.ts` (`describe('greetingName ...')`)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**
  - `expect(detectAlternativeCollaboration('Hello, as I said before, I am not looking for affiliate opportunities.')).toBe(true)`.
    Keep the existing control for Paul's phrasing, and add
    `expect(detectAlternativeCollaboration('Thanks, I filled in the form today.')).toBe(false)`.
  - `expect(greetingName('DE SOUZA', 'Marta', 'ms@example.com', { senderText: 'Best regards, Marta' })).toBe('Marta')`.
  - `expect(greetingName('Jo Smith', null, 'jo@example.com', { senderText: 'Thanks, Jo' })).toBe('Jo')`,
    because a two-letter first name is real.

- [ ] **Step 2: Run them to verify the first two fail**

Run: `npx vitest run tests/inbox-sanitize.test.ts` plus the detector's test file.
Expected: the regex test and the `DE SOUZA` test FAIL, and `Jo` passes.

- [ ] **Step 3: Implement**
  - **The regex:** `(?:to|in)` becomes `(?:to|in|for)` in the first `refusesProgramme`
    pattern.
  - **`greetingName`:** add to `poor` the test
    `/^(?:de|da|di|du|del|della|der|van|von|la|le|dos|das)$/i.test(fromPick)`.
  - **Plan call, narrowing the spec's "one or two letters":** short first names such as Jo,
    Ed and Al are real, so only name particles count as poor.

- [ ] **Step 4: Run the tests to verify they pass**, with the same commands. Expected: PASS.

- [ ] **Step 5: Commit**, with the subject
  `fix(inbox): "not looking for affiliate" is a refusal; a name particle is not a first name`.

---

### Task 11: Verify, open the PR, deploy to staging

- [ ] **Step 1: Run the full gate**

Run: `npm test > <scratchpad>/test.txt 2>&1; echo rc=$?`, then
`npm run typecheck`, `npm run lint` and `aramid check --staged`.
Expected: rc=0 everywhere. Read the test summary line from the file, not from a pipe.

- [ ] **Step 2: Check the dashes:** the whole diff (`git diff master...HEAD`) has no U+2013
  or U+2014. Use a node one-liner with a control string that must hit 1.

- [ ] **Step 3: Push, and open the PR**
  - Run `gh pr create --base master` with a body that summarises the spec sections, lists the
    two plan-time decisions, and ends with
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
  - The merge is the owner's call, with `--no-ff`.

- [ ] **Step 4: Deploy to staging** with `npm run deploy -- --env staging`. It applies
  `0049` to the staging database. Expected: the script reports success.
  - Check that `/healthz` on staging reports the new commit.

- [ ] **Step 5: Hand off to the owner**
  - Ask for "deploy <sha> to production".
  - After production:
    1. Wait for the owner's say.
    2. Press Regenerate on thread `b87a0262`.
    3. Confirm the pending draft is the final answer. It replaces `2f63eca9`.
    4. Never approve it ourselves.
