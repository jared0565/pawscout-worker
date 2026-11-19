# Inbox: read every message, and end a conversation cleanly

Date: 2026-11-19. Status: awaiting owner approval. Code read at `945d88c`.
Source: the inbox audit of 2026-11-19 (production D1 export, read only), and the owner's
answers that followed it. Every number below was measured on that export unless it says
otherwise.

## 1. Why

The owner asked for the audit after seeing the De Zimar thread (`b87a0262`) "just repeating
our reply". The audit found that literal copies are rare: 3 of 611 sends repeat an earlier
send on the same thread. The real problems are that a conversation has no end state, and that
some messages are never read at all.

**A conversation with no end state.** De Zimar is one of six addresses used by one agency
(Volt Scale), all sending the same script. Over two months we sent them six replies:
- four pointed at the affiliate form, and two said we keep to email;
- none answered what they actually asked ("did you read my report?", "yes, no, or not right
  now?");
- the last two were the one-line pointer "Our earlier reply on this thread still stands...".
  The pending draft `2f63eca9` is that pointer again, word for word, because the pointer is
  the last step of `chooseTouch` (`src/inbox/repeat.ts`) and it repeats forever.

Three things in the code made this happen:
- The thread reader had it right. It named Zimar a `marketer` and listed their open questions.
  But the in-flight funnel (`maybePartnershipDraft`, `src/inbox/partnership.ts`) only uses the
  reading for a first touch (line 1192).
- The friendly final decline exists (`collaboration_decline`), but it fires only when the
  `detectAlternativeCollaboration` regex matches. "I am not looking for affiliate
  opportunities" does not match, because the regex accepts "looking to/in", not "looking for"
  (line 256). This was verified by running the repo's own detector on the thread.
- After a decline, a declined applicant falls through to the generic AI drafter (line 1340),
  which writes a fresh decline to every later message. Declining a sender does not end the
  thread.

**Messages we never read.** Two kinds:
- **Formatted-only email: 56 inbound messages.** These arrive with an HTML part and no plain
  text part. `parseInbound` keeps only `email.text` (`src/inbox/mime.ts:93`), so `body_text`
  is empty. The inbox shows "(no body)" (`src/console/inbox-js.ts:343`), and the classifier,
  the reader and the drafter see nothing.
  - 54 of the 56 hold a real message of 10 or more words in their HTML.
  - All 56 ended as spam, automated or closed, and none was answered. One (June, `22b8a2d7`)
    asked whether our products were in stock and was filed as spam.
- **Replies that add nothing: 30 inbound messages.** Nothing new is written above our quoted
  email, or the only new text is a greeting, the store name or punctuation ("Hi active paw",
  "?", "Hello 👋").
  - 20 of them came after we had already answered.
  - Drafts were made for 13, mostly discarded by the owner, and 7 replies were sent.
  - The De Zimar message of 2026-11-19 is one of these: "Hi active paw" above our quoted
    25 September email.

## 2. What the owner decided

- **2026-11-19, "go with A":** once we have stated our position and they keep writing, we
  send ONE friendly final answer, then go quiet. This replaces the 2026-09-04 choice of a
  pointer over silence, which the code comment at `partnership.ts:850` still calls "pending
  their approval".
- **2026-11-19, the tone:** "I prefer the response, saying something like not this time, we
  might consider it in the future. Besides, saying straight no, sounds not friendly at all."
- **2026-11-19:** "some messages don't actually have content in it, this must be dealt with
  properly."
- **2026-11-19, "go":** the handling of contentless messages and the build order proposed in
  the conversation (section 5).

Standing rules this design keeps:
- never send the same message twice, and a second touch is shorter (2026-09-04);
- prove-first: a seller is never declined blankly, and the code trial stays open
  (2026-09-17);
- a body that mentions the programme carries the apply link;
- every partnership draft is human-approved (HITL);
- no em or en dashes anywhere;
- our side is "the team", never "a person".

## 3. Goals, non-goals, anti-goals

**Goals**
1. Every inbound message is read as written, including formatted-only email.
2. A message that adds nothing new gets no draft once we have answered.
3. A seller who keeps writing after our position is clear gets exactly one friendly final
   answer, in the owner's tone, and then no more drafts.
4. The one-line "still stands" pointer is no longer sent by the funnel.

**Non-goals** (separate follow-ups, see section 9)
- the affiliate form end-to-end test (1 application row ever, against 108 threads sent the
  link);
- linking threads from one agency across addresses (Volt Scale);
- regenerated identical drafts (churn);
- the "I just submitted my application" claim with no application row;
- re-sorting or answering the 56 old formatted-only messages.

**Anti-goals** (failure even if it technically works)
- A real customer's question goes unanswered because a seller rule or a contentless-message
  rule silenced it.
- The final answer reads as a flat no.
- A guessed or invented detail reaches a customer.
- A seller can still keep us replying forever with a script.

## 4. Approaches considered

For the final answer:
1. **Fixed template, owner's wording.** PICKED (the owner reacted to the template sample and
   set its tone). You approve the wording once, and every send is predictable. It answers the
   usual seller questions ("did you read it", "yes or no") in general terms, but cannot name
   their specific report.
2. **AI-written from the reader's notes.** This can answer their exact questions. But it is a
   new customer-facing writer whose every final reply needs checking, with more failure modes
   (an invented detail, a missing link). Not picked.

For where "quiet" lives:
3. **One "closed" switch for every kind of thread.** Rejected: a seller rule could then silence
   a customer lane, which is anti-goal 1.

## 5. Design

Build order: Part 1 first, because Part 2 decides on what people actually wrote.

### Part 1: read every message

**1a. Formatted-only email, at ingest.**
- When the plain text part is empty and an HTML part exists, `parseInbound` derives `text`
  from the HTML. Everything downstream (`body_text`, the repeat rule, the classifier, the
  reader, the drafter) then works unchanged.
- The conversion must keep the shape that `stripQuotedReply` relies on:
  - block elements and `<br>` become line breaks;
  - `<blockquote>` content is prefixed with `> `;
  - entities are decoded;
  - `<style>`, `<script>` and `<head>` are dropped.

  `htmlToText` in `src/blog/quality.ts` is NOT suitable: it collapses all whitespace, which
  would defeat quote stripping.
- Cap the derived text at the same length the plain text path allows. If it has none, cap it
  at a sensible limit and say what was chosen.
- **Risk, and a gate before production.** Of the 56, 41 were filed by the AI classifier, not
  by an ingest gate. Many of its summaries read "Empty email...", so it saw a blank.
  - 19 are TikTok Shop marketing mails. None of the stored headers carries List-Unsubscribe,
    Precedence or Auto-Submitted, so the classifier is the only thing keeping them out of the
    reply queue.
  - Once 1a gives the classifier real text, such a mail could land in `needs_reply` and get a
    draft. That is anti-goal 1 in reverse.
  - The builder replays three synthetic mails shaped like them through the classifier on
    staging. If any lands in `needs_reply`, a deterministic guard ships with this build: for
    example, a marketing-sender rule at ingest, tested.

**1b. Old formatted-only rows, display only.** `getInboxThread` (`src/inbox/routes.ts`) shows
the converted HTML text when `body_text` is empty, so the 56 old messages are readable in the
inbox.
- No data write and no backfill.
- No change to `getThreadWithMessages`, which has many callers.
- Those threads are spam, closed or automated, and ingest never reopens such a thread
  (`ingest.ts:142`), so the drafter never needs their text.

**1c. What counts as "no new words".**
- Take every inbound since our last outbound, apply `stripQuotedReply` to each, then remove:
  - greetings (hi, hello, hey, dear, good morning/afternoon/evening);
  - the store name (active paw, activepaw);
  - salutation words (there, team, sir, madam, all, buddy, friend);
  - mobile signatures ("Sent from my iPhone" and the like);
  - punctuation and emoji.
- If no letters remain, the latest batch has no new words.
- The filler list is a closed allowlist. Any other word counts as content, so in doubt we
  draft. "Are you there?" counts as content; "Hello?" and "?" do not.
- If we have never replied on the thread, the subject's words count as content too. A first
  message with an empty body and a real subject is answered from the subject.

**1d. What happens to a message with no new words** (in `composeDraftForThread`,
`src/inbox/sweep.ts`, after the reader so the reading is still saved):
- **We have replied before:** no draft. The thread goes to `awaiting_customer`, as the
  existing "no reply needed" path does (sweep.ts:382).
  - `awaiting_customer` and not `closed`, because ingest reopens only `awaiting_customer` and
    `needs_reply` threads. A closed thread would never see the customer's next real message.
  - The owner can still press Draft anyway (`force`).
- **We have never replied, and the subject has no words either** (a truly empty email): no
  draft, thread `awaiting_customer`, and the inbox marks it as an empty message, with a label
  or chip, builder's choice.
- **Exception:** when the seller final answer is due (2b), the funnel runs first and the bump
  counts as "still writing". This is how De Zimar's 2026-11-19 message gets the final answer.
  So the bump gate sits after `maybePartnershipDraft` returns `null`. For a thread with no
  applicant, it sits before the funnel's first-touch branch, so a bump on a sales@ thread
  never earns a fresh introduction.

### Part 2: the seller end state

**2a. The new ladder.** Every deterministic funnel template keeps its first body and its
shorter second touch. The third step is no longer the one-line pointer:
- **Seller thread** (defined in 2b): the final answer (2c), and the applicant is declined.
- **Any other thread** (a real applicant waiting on review, a supplier, a reader failure):
  no draft, and one owner alert per thread: "Both replies on this point have gone out; reply
  by hand if anything is needed."
  - The builder checks whether `maybeAlertOwner` already deduplicates; if not, add a per-thread
    record so the alert fires once.
- `insertTouched` changes accordingly. `chooseTouch` keeps working for the LLM path's
  `repeats_prior_reply` hold.
- `POINTER_BACK` is removed, or left unused. The compose test "a pointer shorter still" is
  updated to match.

**2b. When the final answer fires.** On any new message, including one with no new words,
when ALL of these hold:
- the applicant is at `passed_to_form` or `escalated`, and is not a live partner
  (`partnerPoolState !== 'live'`);
- 2 or more programme introductions have gone out (`countProgrammeIntroductions`);
- it is a **seller thread**: the reader says `marketer` on this reading (new; it mirrors the
  first-touch use at line 1192), or `detectAlternativeCollaboration` or `detectAccessRequest`
  fires on the latest text (the existing paths, now ending in the new wording).

The same seller-thread test decides the third step in 2a. A bump alone never makes a thread a
seller thread, so a real applicant waiting on review who writes "Hello?" is never sent the
final answer. `screen_sent` applicants are untouched by 2b; their ladder follows 2a.

De Zimar: 4 of our 6 replies carried the apply link, and the reader says `marketer`, so their
"Hi active paw" gets the final answer.

**2c. The final answer.** One template, which replaces the `collaboration_decline` body (key
kept, so the existing call sites and the console picker carry the new wording). The wording
was approved in the conversation:

```
Hi <name>,

Thank you for your messages, and for the time you have put into
your proposal. We have read your messages. It is not something
we will take forward this time, but we may consider it in the
future. In the meantime, the code trial stays open to you
whenever you would like to try it: <AFFILIATE_APPLY_URL>

No reply is needed, and we wish you every success.

Best Regards,
Active Paw Partnerships
```

- **One change from the wording shown in the conversation:** "We have read everything you
  sent" became "We have read your messages".
  - Zimar's "report" was two Google Drive links and an attachment that arrived before
    attachments were kept. We opened none of them.
  - Under the governing rule (only real and defensible), we cannot claim to have read them.
- HITL, with an owner alert like today's ("...the friendly final answer is ready for your
  review").
- It is never sent twice on a thread: when it would repeat, the thread is quiet (2d) instead.
- Its `SECOND_TOUCH` entry is no longer reachable from the funnel.

**2d. Quiet after the final answer.**
- **How we know the final answer went out.** Record the template key on the draft (the
  existing `DraftMeta`, which already carries `stageOnSend`). The final answer counts as given
  when a draft on the thread with that key has status `sent`.
  - This is edit-proof: the owner's edits to the text do not matter.
  - It has no timing race. The console path writes the stage on send (`routes.ts:348`), so a
    timestamp comparison against `affiliate_applicants.updated_at` could see a sent final as
    older than the decline and draft it a second time.
  - Declines sent before this build carry no key. For those, the fallback is: stage
    `declined` and any outbound on the thread after `updated_at`. The builder documents that
    this fallback is for history only.
- A declined applicant whose decline draft was discarded unsent therefore gets the final
  answer drafted again, not silence.
- **What happens once it is given** depends on who is writing:
  - **Seller thread** (2b): every later message gets no draft (`{ noReply: true }`) and thread
    status `awaiting_customer`, silently. This is the owner's "then quiet".
  - **Not a seller** (a creator declined on screen score at line 1276, or by `decline_all`): no
    draft, plus one owner alert per thread, as in 2a. They are never silenced without the
    owner knowing.
  - **Either kind**, when the reader says `customer` (an order or product question): the
    funnel returns `null`, and the generic drafter answers in the thread's lane.
- This replaces today's fall-through for declined applicants (line 1340).
- `maybePartnershipDraft`'s return type gains `{ noReply: true }`, which
  `composeDraftForThread` already returns to its callers.

**2e. Console template picker** (`applyDraftTemplate`, `routes.ts:330`).
- A template already sent once still renders as its shorter second touch.
- A third application no longer renders the pointer. It returns a clear refusal ("this has
  already gone out twice on this thread; write the reply by hand"), except that
  `collaboration_decline`, which has never gone out on the thread, renders in full.
- The owner's manual choice is never silently swapped for a different template.

**2f. Two small fixes found in the audit.**
- **The "looking for" miss:** the refusal regex at `partnership.ts:256` also accepts
  "looking for" ("not looking for affiliate opportunities"). Add a test with Zimar's 09-21
  sentence and keep Paul's phrasing as a control.
- **"Hi De":**
  - `greetingName` (`src/inbox/draft.ts:133`) takes "De" from the From name "DE ZIMAR".
  - The fix treats a From first word of one or two letters, or a name particle (de, da, di,
    du, van, von, el, al, la, le, dos), as poor, which falls back to the reader's name when
    it appears in their own text ("Zimar").
  - The existing `greetingName` tests stay green.

## 6. Constraints

- No em or en dashes in code, tests or any customer-facing text (`sanitizeOutbound` enforces
  this at runtime too).
- Every funnel draft stays HITL. Nothing in this design auto-sends.
- No migration is expected. If one becomes necessary, it is a new file, staging first.
- Deploy only through `npm run deploy -- --env staging`, then production on the owner's exact
  "deploy <sha> to production".
- Test fixtures are synthetic. No real sender text or addresses from production go into the
  repo.

## 7. Tests the builder must add

- **mime:** an HTML-only email yields text with line breaks and `> `-quoted blockquotes, and
  `stripQuotedReply` then removes the quote. An email with both parts still uses the plain
  part.
- **No-new-words detection:** greeting-only, store-name-only, "?", an empty-above-quote reply
  and "Sent from my iPhone" are all bumps. "Are you there?" and a one-word real answer ("Yes")
  are not.
- **composeDraftForThread:**
  - a bump after our reply means no draft, status `awaiting_customer`;
  - an empty first message with a real subject gets a draft;
  - an empty first message with an empty subject gets no draft.
- **Funnel:**
  - marketer with 2 or more introductions gets the final answer, and the applicant is
    declined;
  - a non-marketer applicant at `escalated` who sends "Hello?" does NOT get the final answer;
  - after the final answer is sent, a later message gets no draft, and a customer-role
    reading falls through;
  - a non-seller at the third step gets no draft and one alert;
  - a creator declined on screen score who writes again gets no draft and one alert, and a
    second message from them raises no second alert;
  - a discarded unsent decline is drafted again;
  - a sent final answer (keyed draft) is never drafted a second time, even when the stage
    write lands after the outbound row;
  - the De Zimar shape end to end: the bump on 11-19 gets the final answer.
- **Console:** the third application of a template is refused, and `collaboration_decline`
  renders in full when it has never been sent.
- **Updated:** the existing test "a follow-up AFTER the decline falls through to the generic
  drafter" (`tests/partnership-draft-screen.test.ts:53`) now expects quiet, and the compose
  pointer test is updated to match 2a.

## 8. Rollout

1. Build on a branch, run the gate, open a PR. The merge is the owner's call.
2. Deploy to staging, then production on the owner's go.
3. **De Zimar:** after production, Regenerate on `b87a0262` replaces the pending pointer draft
   `2f63eca9` with the final answer for the owner to review. Until then, the owner should not
   approve `2f63eca9`.
4. The other live Volt Scale threads get the same treatment on their next message, or by
   Regenerate on the owner's say.

## 9. Follow-ups (not in this build)

- **The affiliate form end-to-end test.** One test submission, on the owner's go, settles
  whether sellers do not apply or the form drops submissions (its anti-bot checks report
  success without saving).
- **Linking one agency's threads across addresses.**
- **Draft churn:** 40 drafts identical to an earlier draft on the same thread.
- **An "I just submitted" claim with no application row:** decide after the form test.
- **July report:** one sender said our reply arrived empty, though the saved copy had text.
  This is unverified, and the database cannot say what arrived.

## 10. Calls I made (for the owner to check)

- **Quiet means status `awaiting_customer`, not `closed`.** The next real message still
  reopens the thread.
- **A thread reopens after the final answer only when the reader says `customer`.** "Yes or
  no?" from a scripted seller never reopens it.
- **Real applicants and suppliers at the third step get no draft, plus one alert to you.**
  So do creators we declined on score or by "decline all" who write again. Only sellers go
  silently quiet.
- **Your approved line "We have read everything you sent" became "We have read your
  messages".** We never opened Zimar's Drive links or the attached report.
- **The 56 old formatted-only messages become readable in the inbox,** but are not re-sorted
  or answered.
- **"Are you there?" still counts as a real message.** Only greetings, the store name and
  punctuation count as empty.
- **The final answer reuses the `collaboration_decline` slot,** so the console picker offers it
  under its existing name.
