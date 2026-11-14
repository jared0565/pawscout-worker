# Inbox attachments, reply shell and supplier lane: design

Date: 2026-11-14. Status: awaiting owner approval. Code read at `2d0aea6`.
Source: the inbox and drafter audit of 2026-11-14 (production D1 read 00:01 to 00:23Z), and
the owner's answers that followed it.

## 1. Why

Suppliers email catalogues and price lists as attachments, and some customers attach photos.
The worker throws every attachment away when it parses the email (`parseInbound`,
`src/inbox/mime.ts:30`, never reads postal-mime's `attachments`). Nothing keeps a copy: no
column, no bucket, raw mail is not stored, and `INBOX_FORWARD_TO` is unset. Past files cannot
be recovered.

Our replies then say things that are not true:

- **FOOFEE, thread 2d6559b9:** we sent "Thank you for sending the FOOFEE catalogue... We have
  received the information". We hold no catalogue.
- **Thread de23fa70:** its first message carried the catalogue, and we asked them to "email
  over your catalogue".
- `SUPPLIER_PROMPT` step (3) invites a catalogue on every supplier reply.

Both replies break the governing rule that customer-facing text is only what is real and
defensible.

The same audit found that the owner keeps editing the same things. Of 28 edited sends since
2026-10-05, 26 were mechanical:

- **14 changed only the signature.** Prove-first replies in the general lane were signed
  "Active Paw Customer Support", and the owner retyped a partnerships signature.
- **11 swapped or removed the opener and split paragraphs.** Overall, 18 of the 28 edits add
  paragraphs.

The supplier lane also has these problems:

- It re-asks questions a supplier already answered on an earlier thread.
- It sends off-niche suppliers (door, hat and hair-dryer makers) the full invitation.
- It greets "Hi Cat" for a sender named "Cat Cages/HOMWOOD" who signed "Jennie".

The owner also types the order-processing time by hand: normally within 24 hours, longer at
busy times.

### What success looks like

1. **A file reaches the console.** A supplier emails a PDF catalogue. The owner sees it under
   that message in the console and downloads it. The draft acknowledges it and does not ask
   for a catalogue.
2. **A missing file is called missing.** A sender writes "please find attached" with nothing
   attached. The draft says the file did not reach us and asks them to send it again or share
   a link. Off-niche suppliers are the exception.
3. **A refused file is called refused.** A sender attaches a file we refuse (a macro-enabled
   spreadsheet, say). The draft says we could not accept that file and asks for a PDF or a
   link.
4. **No false receipt.** No draft says a file arrived unless one is stored. Code checks this;
   the prompt alone is not trusted with it.
5. **The right signature.** A prove-first or other partnership reply in the general lane is
   signed "Active Paw Partnerships".
6. **The right opener.** The opener fits the sender, and a reply never thanks twice at the
   top.
7. **Short paragraphs.** No paragraph in a reply runs longer than three sentences.
8. **No repeated questions.** A supplier who gave their link or dropshipping answer on any
   earlier thread from the same address is not asked again.
9. **A short reply to off-niche suppliers.** An off-niche supplier gets one or two sentences:
   thanks, and that their details are kept on file.
10. **The right name in the greeting.** "Cat Cages/HOMWOOD" signing as Jennie gets
    "Hi Jennie,". A role inbox whose sender signs "Sam Li" gets "Hi Sam,".
11. **The owner edits less.** Two weeks after release, signature-only and opener-only edits on
    these lanes are near zero. This is measured the same way the audit measured it.

## 2. Goals, non-goals, anti-goals

**Goals:** everything in section 1, built as the four parts the owner approved, in this
order:

1. attachments,
2. the reply shell,
3. the supplier lane,
4. the store fact.

**Non-goals:**

- **Old files.** Files that arrived before this ships cannot be recovered.
- **File contents.** Nothing reads what is inside a file: no PDF text, no OCR. The reader and
  the drafter learn the file names only.
- **Outbound files.** Replies carry no attachments.
- **The other audit items.** These are left for later:
  - answer memory for suppliers;
  - the confidence chip and confidence calibration;
  - auto-send toggles;
  - the References header (`send.ts:53`);
  - the `headers_json` truncation (`ingest.ts:82`).
- **Duplicate suppliers.** Supplier rows with different emails for one company (Beauty Merry,
  three rows) are not merged.
- **Expiry.** No retention timer: a file lives as long as its thread.
- **Sender addresses.** The From address of replies does not change.

**Anti-goals:** each of these counts as a failure even if everything else works.

- An inbound email is lost, delayed or bounced because file storage failed.
- A stored file renders in the browser. The worker's own origin serves the session-authed
  console, so an HTML or SVG file opened inline would run on that origin.
- A reply claims a file we do not hold, or invites a file we already hold.
- A personal-data erasure leaves files behind.
- The opener wording moves out of the owner's own guidance into code they cannot edit.

## 3. Constraints

- **Size limits.** Cloudflare Email Routing caps a message at 25 MiB, and a Worker has 128 MB
  of memory. `handleInboundEmail` (`src/index.ts:2677`) already reads the whole raw message
  into memory.
- **Opening files from the admin.** The console runs inside the Shopify admin iframe, and
  every `/api/*` route is a POST with a session token. A file download therefore has to be a
  plain top-level link.
- **New tabs already work.** `target="_blank"` links work from the console today: the invoice
  link at `src/console/inbox-js.ts:495` is one.
- **Deploying.** Deploys go only through `npm run deploy`. Staging goes first, and production
  only on the owner's sentence "deploy <sha> to production".
  - The deploy script does not check bindings, so both buckets must exist before the first
    deploy that names them.
  - Named environments do not inherit bindings, so staging needs its own bucket entry.
- **Migrations.** This work adds migration `0048`. A migration file is never edited after any
  environment has applied it.
- **Tests.** The test runtime (miniflare through `vitest.config.ts`) needs the bucket declared
  too.
- **Erasure is never retried.** `gdprWebhook` (`src/index.ts:2576`) catches every error and
  returns 200, so Shopify never retries an erasure. A failed file delete would be lost unless
  we record it ourselves.
- **Model change.** The text model has been Haiku 5.5 since 2026-11-13 22:39Z. Every draft the
  audit measured came from gpt-5.6-luna, so wording findings need re-checking on the new
  model. The deterministic findings do not.
- **Standing rules:**
  - no em or en dashes;
  - only real and defensible facts;
  - never the same message twice on a thread;
  - "team" or "department", never "person";
  - no UK-fulfilment claim;
  - the worker is the only Shopify actor.

## 4. Approaches

The owner handed over the how. These are my picks, as stated before this doc was written.

**Where files live**

- **Picked: R2 bucket plus a D1 table of file records.** R2 is built for files and is cheap at
  this volume. Object keys are grouped by shop and thread, so erasure can delete by prefix.
- **Ruled out: files in D1 itself.** A D1 row holds about 2 MB, and supplier catalogues run 5
  to 20 MB.
- **Ruled out: forwarding every email to a mailbox.** The files would sit outside the console,
  and the drafter still would not know a file arrived.

**How the owner opens a file**

- **Picked: signed, short-lived links, opened in a new tab and served as a download.** They
  use the same HMAC pattern as the newsletter unsubscribe link (`signUnsubToken` /
  `unsubUrlFor` in `campaigns.ts`).
  - **Refinement:** the links are signed when the thread loads, not when Download is clicked.
    Fetching a link first and opening the tab after it returns loses the click's user-gesture
    status, and the browser would likely block the tab.
- **Ruled out: downloading inside the admin iframe.** Whether Shopify's iframe sandbox allows
  it is unverified, so it might fail silently.

**Short paragraphs**

- **Picked: prompt instruction plus a code split.** The code split works whatever the model
  does.
- **Ruled out: prompt only.** It depends on the model following it.
- **Ruled out: code only.** It could split oddly where the model already wrote good
  paragraphs.

## 5. Part 1: attachments

### 5.1 Parse

`parseInbound` returns a new field, `attachments: InboundAttachment[]`, built from
postal-mime's `email.attachments` with `attachmentEncoding: 'arraybuffer'`:

```ts
interface InboundAttachment {
  filename: string;            // sanitised, see below
  contentType: string;         // as declared by the sender (untrusted)
  disposition: 'attachment' | 'inline' | null;
  contentId: string | null;
  related: boolean;
  bytes: Uint8Array;
}
```

The parse failure path returns `attachments: []`.

**Filename sanitising:**

- Take the last path segment.
- Drop control characters, quotes, angle brackets and backslashes.
- Collapse whitespace.
- Cap at 120 characters, keeping the extension.
- When the name is empty, use `attachment-N` plus an extension mapped from the content type.

### 5.2 Keep or skip

One pure function decides each part: `attachmentDisposition(part, index)`. It returns
`'store'`, a skip reason, or `'drop'`.

- **Drop silently (no record):** an inline or related part with a `contentId`, an `image/*`
  type and under 100 KB. These are signature logos and tracking pixels. *(The 100 KB
  threshold is my call.)*
- **Type check.** The extension decides. A declared type contradicts the extension only when
  it names a refused family: `text/html`, `image/svg+xml`, any `*xml`, or a script or
  executable type. An empty declared type, or `application/octet-stream`, never contradicts.
  - **Kept:** pdf, doc, docx, xls, xlsx, csv, ppt, pptx, odt, ods, txt, rtf, jpg, jpeg, png,
    gif, webp, heic, zip.
  - **Refused, recorded as `skipped_type`:** everything else. The list explicitly names html,
    htm, svg, xml, js, exe, msi, bat, cmd, scr, vbs, jar, ps1, lnk, iso, img, hta, and the
    macro-enabled Office types docm, xlsm, pptm and dotm. A double extension counts by its
    last part. Fake "supplier catalogues" carrying macros are a known malware route.
  - *(zip is my call: suppliers send image packs, and only the owner downloads. Strike it to
    refuse zip.)*
- **Size.** A part over 20 MB is recorded as `skipped_size`.
- **Count.** Up to 10 parts are kept per message; any further kept-type part is recorded as
  `skipped_count`.

**Threads that keep nothing:** a thread whose final status after ingest is spam (DMARC fail,
blocked sender, or caught by the repeat rule) or automated stores nothing and records
nothing. Those threads are never drafted, and nobody reads them. *(My call.)*

### 5.3 Storage

**Migration `0048_inbox_attachments.sql`:**

```sql
CREATE TABLE inbox_attachments (
  shop         TEXT NOT NULL,
  id           TEXT NOT NULL,   -- uuid; also the last segment of the R2 key
  thread_id    TEXT NOT NULL,
  message_id   TEXT NOT NULL,   -- inbox_messages.id
  filename     TEXT NOT NULL,   -- sanitised, untrusted
  content_type TEXT NOT NULL,   -- as declared, untrusted, never used to serve
  size_bytes   INTEGER NOT NULL,
  status       TEXT NOT NULL,   -- stored | skipped_type | skipped_size | skipped_count | store_failed
  r2_key       TEXT,            -- set only when stored
  created_at   TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_inbox_attachments_thread ON inbox_attachments (shop, thread_id);

-- Erasures still owed in R2 (see 5.8). One row per key prefix.
CREATE TABLE inbox_file_erasures (
  shop       TEXT NOT NULL,
  prefix     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop, prefix)
);
```

**R2 keys:** `inbox/{shop}/{threadId}/{attachmentId}`. The filename never appears in a key,
because it is untrusted and may be personal data.

**Buckets:** `pawscout-inbox-files` for production and `pawscout-inbox-files-staging` for
staging, both with location hint `weur` *(my call: keeps the data in Western Europe)*.

**Binding:** `INBOX_FILES`, declared optional in `Env` (`INBOX_FILES?: R2Bucket`). With no
binding, storage is skipped, and kept-type parts are recorded as `store_failed` so the
console and the drafter stay truthful.

### 5.4 Ingest order

1. **`insertInboundMessageIfNew` returns the new row id, or null for a duplicate.** Today it
   returns a boolean. This is a shared function, so run graphite impact on it first and
   update every caller.
2. **Store files after the insert and the repeat-rule decision,** and only when:
   - the message was newly inserted (a redelivered duplicate stores nothing), and
   - the thread did not end as spam or automated.
3. **`processInbound(store, raw, opts?: { files?: R2Bucket })`.** `handleInboundEmail` passes
   `env.INBOX_FILES`.
4. **Each kept part: R2 `put` first, then its D1 row.**
   - If the put fails, the row is written as `store_failed`.
   - If the row fails after a successful put, the object is an orphan under the thread's
     prefix, so erasure still finds it.
5. **No failure here can fail ingest.** All attachment work sits in one try/catch that logs
   `inbox attachment store failed` and returns. The email is stored, threaded and drafted
   exactly as today.
6. **Buffers are dropped after each put.**

### 5.5 Download

**Signed links in the thread response.** `/api/inbox/thread` returns
`attachments: [{ id, messageId, filename, sizeBytes, status, url }]`. `url` is set only for
`stored` rows and is signed when the response is built, valid for 30 minutes *(my call)*.

**URL and signature:**

- URL: `{SHOPIFY_APP_URL}/inbox-file/{id}?shop={shop}&exp={unix}&sig={hex}`. In production
  that is `https://pawscout.activepaw.co.uk/...`, and staging gets its own host.
- `sig` is HMAC-SHA256 over the string `inbox-file:v1|{shop}|{id}|{exp}`, keyed with
  `SHOPIFY_API_SECRET`. The prefix keeps it from being swapped with any other signed token.
- The comparison is constant-time.

**The GET route** sits outside session auth:

1. Check the signature and the expiry.
2. Check that `shop` is a valid myshopify domain.
3. Load the row by `(shop, id)` with status `stored`.
4. Read `r2_key` from R2 and return it with these headers:
   - `Content-Type: application/octet-stream`. The declared type is never used.
   - `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>`.
   - `X-Content-Type-Options: nosniff`.
   - `Content-Security-Policy: default-src 'none'; sandbox`.
   - `Cache-Control: private, no-store`.
   - `Referrer-Policy: no-referrer`.

**Error pages:**

- An expired link returns 410 with one plain line: "This link has expired. Open the thread
  in PawScout again for a fresh link."
- A bad signature returns 403.
- A missing row or object (for example after erasure) returns 404.

### 5.6 Console

Under each inbound bubble, the files for that message:

```
 jennie@nongshine.com · 2026-11-14 09:12
 | Dear Sir, please find our 2026 catalogue attached ...
 | Files: Catalogue-2026.pdf (4.2 MB)  Download ↗
 |        prices.xlsm  not kept: file type not accepted
```

- A Download link is an `<a target="_blank" rel="noopener noreferrer">` to the signed URL.
- The reason labels are fixed text:
  - `skipped_type`: "file type not accepted"
  - `skipped_size`: "over 20 MB"
  - `skipped_count`: "more than 10 files"
  - `store_failed`: "could not be saved"
- `inbox-js.ts` is a template-literal script. After editing it, run `tests/console.test.ts`
  and `npm run lint`.

### 5.7 What the reader and the drafter are told

**The file line.** `buildDraftTranscript(messages, files?)` adds a system line after an
inbound turn's text:

```
Customer: Dear Sir, please find our 2026 catalogue attached ...
[Files with this message: Catalogue-2026.pdf]
[Files sent but not kept: prices.xlsm (file type not accepted)]
```

**Both readers see it.** `readThread` and `draftReply` both read this transcript, so one
change reaches both.

- **Every caller passes the file rows.** Callers of `buildDraftTranscript` include both
  `readThread` calls in `sweep.ts` (around lines 158 and 362). The builder lists them all
  with graphite.
- **Where the rows come from:** a new store method, `listAttachmentsForThread(threadId)`.

**Filename limits.** Names are sanitised, capped at 80 characters each, and at most 10 are
listed.

**The marker cannot be faked.** A sender who types `[Files with this message: ...]` in their
own text must not forge a receipt. `neutralizeRoleMarkers` downgrades that pattern in inbound
text the same way it downgrades role labels.

**Prompt sentence.** One sentence is added where `buildDraftSystem` and `READER_SYSTEM`
explain the transcript: a bracketed "Files with this message" line is added by our system and
lists the only files we hold; a "Files sent but not kept" line lists files that arrived but
were refused.

### 5.8 Erasure

`TenantStore` has no bucket, and the erasure webhook can never be retried (section 3).
Erasure is therefore recorded in D1 first and finished in R2:

**`redactContact` (one customer).** Its existing atomic batch gains, at the front, before the
thread delete:

```sql
INSERT OR IGNORE INTO inbox_file_erasures (shop, prefix, created_at)
  SELECT ?1, 'inbox/' || ?1 || '/' || id || '/', <now>
  FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2;
```

It also gains `DELETE FROM inbox_attachments ... thread_id IN (sub)`.

**`redactShop` (whole shop).** It records the prefix `inbox/{shop}/` and deletes every
`inbox_attachments` row for the shop.

**Finishing the R2 delete.**

- The webhook handlers call `eraseOwedFiles(bucket, db, shop)` through
  `c.executionCtx.waitUntil`, so Shopify's response is not delayed. It lists each owed
  prefix, deletes up to 1000 keys per call, and removes the erasure row once the prefix is
  empty.
- The daily maintenance chain gets a stage that runs the same function over every row of
  `inbox_file_erasures`. That covers rows a failed or slow attempt left behind, including a
  shop whose tenant row is already gone.

**Data summary.** `inboxDataSummary` also counts attachments.

**Found while designing: `supplier_register` is never erased.** Neither `redactContact` nor
`redactShop` deletes it, and it holds a contact's name and email. Since this work edits both
functions, I have included the two deletes. Strike this if you would rather it ship
separately.

## 6. Part 1, continued: honest replies about files

These rules apply in every lane. A complaint with "photo attached" counts as much as a
supplier catalogue.

The context comes from the file rows:

- `filesHeld`: stored files from this contact, on any of their threads. A supplier's second
  thread that says "thanks for the catalogue we sent last week" must not trip rule A. This
  needs a new store method, `listAttachmentsForContact(email)`.
- `filesRefused`: on the open inbound messages, the rows with status `skipped_type`,
  `skipped_size` or `store_failed`. `skipped_count` is left out: the first 10 files arrived,
  and the owner sees the rest flagged in the console.
- Whether the open inbound messages have any file record at all. Logos dropped under 5.2
  have no record and do not count.

Each rule is checked in code in `findDraftIssues` and fed to the reviser. A rule still broken
after the revisions either gets a fixed sentence or holds the draft, as listed.

| Rule | Fires when | Reviser told | After revisions |
|---|---|---|---|
| A. No false receipt | The reply says we received, or thanks them for sending, a file, catalogue, catalog, price list, brochure, attachment, document, PDF or spreadsheet, and `filesHeld` is empty | Remove every claim that a file arrived; nothing did | Hold, reason `file_claim` |
| B. No invite for a file we hold | Supplier lane: a file from this contact is stored (any thread), and the reply invites a catalogue, price list or specification | Do not ask for what they already sent; acknowledge the files by name, briefly | Hold, reason `file_reinvite` |
| C. Missing file | The open inbound text mentions an attachment ("attached", "attachment", "enclosed", "please find", "see the file") and none of those messages has a file record, and `filesHeld` is empty | Add one sentence: the file did not reach us; ask them to send it again or share a link | Append: "Unfortunately the file you mentioned did not reach us. Could you send it again, or share a link to it?" |
| D. Refused file | `filesRefused` is not empty (refused for type or size, or could not be saved) | Add one sentence: we could not accept that file; ask for a PDF or a link | Append: "We were not able to accept the file you sent. Could you send it as a PDF, or share a link to it?" |

**Notes on the rules:**

- **Off-niche suppliers** (section 8.2) skip rules C and D; the owner's ruling is that they
  get nothing about files.
- **Fixed sentences never echo a filename.** The name is sender-controlled.
- **FOOFEE is the test case for rule A:** "Thank you for sending the FOOFEE catalogue ... We
  have received the information". Rule A targets file nouns, so "thank you for the
  information in your email" does not fire.
- **Holds in the supplier lane** go through `withExtraHolds`, the same way
  `supplier_commitment` does.

**Every place that invites a catalogue changes.** The invitation appears in four places, and
fixing one leaves the others to put it back:

1. `SUPPLIER_PROMPT` step (3) becomes: if the thread lists files received, acknowledge them
   briefly by name and do not ask for a catalogue; if a file was mentioned but did not
   arrive, or was not accepted, follow the file line; otherwise say they are welcome to email
   their catalogue, price list or specifications.
2. `otherAgent`'s GOODS SUPPLIERS rule (`src/inbox/agents/other.ts:34`) gets the same
   condition.
3. The `promisesSupplier` issue text in `findDraftIssues`, which today tells the reviser to
   keep "welcome to email their catalogue", gets the same condition.
4. The `supplier_ack` template (`SUPPLIER_ACK_BODY`, `partnership.ts:487`; graphite shows its
   only live caller is the owner's template picker, `applyDraftTemplate`).
   `buildSupplierAck(name, { filesHeld })` drops the catalogue sentence when files are held,
   and opens "Thank you for informing us!" to match the owner's supplier opener *(my call)*.

## 7. Part 2: the reply shell

### 7.1 Signature

A new pure function, `signingDepartment(agent, body, reading)`, returns `'partnership'` when
both of these hold:

- the agent is `other`, and
- the reading's sender role is `marketer` or `creator`, or the body contains
  `AFFILIATE_APPLY_URL`. The body check covers a failed reading.

Otherwise it returns `agent.department`.

`composeDraftForThread` passes it to `composeAgentDraft` instead of `agent.department`.
`otherAgent.department` stays `service`, so a genuine customer enquiry in that lane is still
signed "Active Paw Customer Support". The owner chose the wording "Active Paw Partnerships";
it already exists as `DEPARTMENT_SIGNATURES.partnership`.

### 7.2 Opener

The opener stays prompt-owned, so the owner can edit it. The owner's `inbox.replyGuidance` is
rewritten; the full text is in appendix A. It encodes:

- "Thank you for your enquiry!" only when they asked us something;
- "Thank you for getting in touch!" for a pitch;
- "Thank you for informing us!" for a supplier;
- the opener on its own line, once only;
- no repeated opener on a follow-up.

The guidance is applied through the system's own route (POST `/api/inbox/config` from the
admin iframe), never by a D1 write, and only after the code deploy (section 11).

### 7.3 No double thank-you

- **The supplier prompt stops thanking.** `SUPPLIER_PROMPT` step (2) no longer thanks: it
  names the range or service in a few words, because the opener already thanks them.
- **A code check.** A new issue in `findDraftIssues` fires when the first sentence thanks
  them and the next sentence also starts with "Thank you" or "Thanks". The reviser is told to
  keep only the first.
- **A backstop if the reviser misses it.** `collapseRepeatedThanks` removes that second
  sentence. *(My call: removing it is safer than rewriting it, and the reviser usually fixes
  it first.)*

### 7.4 Short paragraphs

**Prompt instruction,** added in code (`OUTPUT_CONTRACT`) so it applies whatever the
guidance says: write short paragraphs of one to three sentences, with a blank line between
them.

**Backstop,** `paragraphize(body)`, run on the model's body before the greeting and the
footer:

- **The opener stands alone.** A first sentence that is a short thank-you ending in "!" and
  followed by more text in the same paragraph becomes its own paragraph, as the owner does in
  their edits.
- **Long paragraphs are split.** A paragraph of more than three sentences is cut into runs of
  two (the last run may hold three).
- **Sentence boundaries.** A boundary is `.`, `!` or `?` followed by a space and a capital
  letter or digit. These never count as a boundary:
  - common abbreviations (e.g., i.e., Mr, Mrs, Ms, Dr, St, No., approx., etc.);
  - text inside a URL or an email address;
  - a decimal number.
- **Lists stay as written.** Lines that start like a list (`-`, `*`, `1.`) are left alone.

### 7.5 Order of steps at the end of `draftReply`

1. `refineUntilClean`.
2. `stripTrailingSignoff`.
3. `appendSupplierAsks` (exists today).
4. The file sentences for rules C and D.
5. `collapseRepeatedThanks`.
6. `paragraphize`.
7. `applySalutation` with the chosen name (section 8.3).

`composeAgentDraft` then adds the footer, using `signingDepartment`.

## 8. Part 3: the supplier lane

### 8.1 Asks backed by the register

**Fresh register row.** In `composeDraftForThread`, after `upsertSupplier`, read
`store.getSupplier(email)` and pass the row into `draftReply`.

**Merged facts.** A pure function, `supplierFactsFor(reading, row)`, merges the two:

- **Website:** the reading's, else the register's.
- **Store links:** combined from both.
- **Dropshipping answer:** a yes or no from either side wins over unknown.
- **Kind and niche fit:** the reading's, else the register's.

**Past replies from every thread.** `supplierAsksOwed` gets the outbound bodies from every
thread with this contact, not only this one. This uses a new store method,
`outboundBodiesForContact(email, limit = 20)`. The thread-level `priorOutbound` used by the
repeat check is unchanged.

**Test case:** FOOFEE's second thread would not have re-asked for the link and the
dropshipping answer.

### 8.2 Off-niche suppliers

**Where the flag comes from.** `supplierAgent.ground(ctx)` reads the register row, freshly
written just before. It sets `offNiche` in the grounding when `niche_fit` is `off-niche`.

**Reply.** `promptFragment` then returns the off-niche prompt:

> This sender offers goods or services outside our range (dog and cat products). Write one or
> two short sentences after the opener: say we have noted their details and keep them on
> file for reference. Answer a direct question only from the store facts. Do not invite a
> catalogue or any file, do not ask for links, do not ask about dropshipping, do not mention
> files, and promise nothing.

**Code checks for off-niche replies:**

- `supplierAsksOwed` returns no asks.
- File rules C and D are off.
- `promisesSupplier` still applies.
- An invitation to send a catalogue or files is an issue for the reviser.
- `maxWords` is 40.

**Not enough to decide.** "Adjacent" suppliers keep the full flow *(my call)*. When the
register write failed, there is no row, so the full flow runs.

**Risk:** an on-niche supplier misread as off-niche gets the short reply. Today the register
holds 15 off-niche rows of 28. The owner still sees every supplier draft, since auto-send is
off for every lane.

### 8.3 Greeting name

**New reader field.** The reader returns a top-level `senderName`: the sender's own name as
they sign or introduce themselves, else null. It is capped at 60 characters, and the reader
is told never to guess.

**Choosing the name.** A pure function, `greetingName(fromName, readerName, email,
company)`:

- `fromPick = salutationName(fromName, email)`.
- `readerPick` is `salutationName(readerName)`, and only when that name appears word for word
  (case-insensitive, whole words) in the sender's own inbound text. Otherwise it is null.
- **The From name is poor** when any of these holds:
  - `fromPick` is null;
  - the From name contains `/`, `|`, `@` or a digit;
  - `fromPick` equals the email's domain label (Growvia at growvia...);
  - `fromPick` matches the company name in the reading or the register.
- **Result:**
  - when the From name is poor, `readerPick` if there is one, else null ("Hi there,");
  - otherwise `fromPick`.

When both are good and differ, the From name wins *(my call: it is the lower risk)*.

**Checked against what the code does today:**

| From name | Signed as | Today | With this |
|---|---|---|---|
| Cat Cages/HOMWOOD | Jennie | Hi Cat | Hi Jennie (contains `/`) |
| sales | Sam Li | Hi there | Hi Sam |
| Growvia | (none) | Hi Growvia | Hi there (domain label) |
| Wendy2 | Wendy | Hi there | Hi Wendy (no usable From name) |

**Used everywhere a reply greets.** That covers the drafter, the partnership funnel's
templates, and the owner's template picker (which reads the saved reading). The builder lists
every caller of `applySalutation` and of the `build*` template functions with graphite and
passes the chosen name.

### 8.4 Naming their range

`SUPPLIER_PROMPT` step (2) becomes: mention the range or service they described in a few
words (for example "your pet grooming tools"), not a list of every product, and without
thanking them again.

## 9. Part 4: store fact

Owner-sourced text, from the owner's own reply on thread f835069a (2026-10-29). In
`STORE_FACTS`, add after the "fulfilled through our supplier network" sentence:

> Orders are normally processed within 24 hours; at busy times it can take a little longer.

The same owner reply also said "Delivery from our warehouse". That part is **not** added: it
breaks the no-UK-fulfilment rule.

The builder checks for any test that pins the `STORE_FACTS` text.

## 10. Configuration and infrastructure

**Buckets.** Create both before the first deploy that names them:

- `wrangler r2 bucket create pawscout-inbox-files --location weur`
- the same for `-staging`

**`wrangler.toml`:**

- top level: `[[r2_buckets]] binding = "INBOX_FILES", bucket_name = "pawscout-inbox-files"`;
- staging: `[[env.staging.r2_buckets]]`, pointing at the staging bucket.

**`vitest.config.ts`:** add `r2Buckets: ['INBOX_FILES']` to the miniflare options.

**`Env`:** add `INBOX_FILES?: R2Bucket`.

**No new secret.** Link signing reuses `SHOPIFY_API_SECRET`, with its own prefix.

## 11. Release order

1. **Branch, build and test.** Build on a feature branch off master. Tests, lint and CI must
   be green.
2. **Create the buckets.**
3. **Staging deploy:** `npm run deploy -- --env staging`. It applies migration 0048 to
   staging.
4. **Production deploy,** on the owner's sentence only: `npm run deploy -- --env production`.
5. **New guidance.** Then apply the appendix A guidance through POST `/api/inbox/config` in
   the admin iframe. This order is safe either way round: the double-thank-you backstop
   covers the window when the old guidance still asks for "Thank you for your enquiry!".
6. **Check on production:**
   1. Send a test email to contact@ from an outside mailbox, carrying a small PDF, a `.docm`
      and an inline signature logo. Sending it needs the owner's go, because it is an
      outward action.
   2. Check what the console shows, that the download works, and the headers on the
      download.
   3. Check the draft text, and that no file record exists for the logo.
7. **Re-draft supplier threads.** Regenerate (which never sends) three of the 11 supplier
   drafts pending since 2026-11-05, and compare. Then offer the owner a regeneration of all
   11, since they were drafted under the old prompt and the old model.
8. **Two weeks later:** re-measure the owner's edit rate on these lanes.

## 12. Tests

- **Parsing:** MIME fixtures built in the test with:
  - a base64 PDF part;
  - an inline cid PNG under 100 KB;
  - a `.docm`;
  - an `.html` part;
  - 12 small PDFs;
  - an oversize part (size faked through the function boundary rather than 20 MB of
    fixture);
  - a missing filename.
- **`attachmentDisposition`:** every rule in 5.2.
- **Ingest:**
  - a kept file is stored and its row written;
  - a duplicate delivery stores nothing;
  - a spam thread or an automated thread stores nothing;
  - a failed put records `store_failed`;
  - a missing binding still ingests;
  - a throwing bucket never fails ingest.
- **Download route:**
  - a good signature;
  - an expired link gives 410;
  - a tampered `sig`, `shop` or `id` gives 403;
  - another shop's id with a valid signature for that shop returns only that shop's row;
  - every response header listed in 5.5;
  - a non-ASCII filename is encoded correctly.
- **Erasure:**
  - `redactContact` writes the erasure rows in the same batch and deletes the attachment and
    `supplier_register` rows;
  - `eraseOwedFiles` deletes by prefix and clears its row;
  - a failed R2 delete leaves the row for the daily stage;
  - `redactShop` deletes everything for the shop.
- **Transcript:**
  - the file lines are rendered;
  - a forged marker in inbound text is neutralised;
  - long filenames are capped.
- **Honesty rules A to D:** each fires and stays quiet on its cases, with the FOOFEE and
  de23fa70 wording as fixtures.
- **Reply shell:**
  - `signingDepartment`;
  - `collapseRepeatedThanks`;
  - `paragraphize`: abbreviations, URLs, decimals, lists, and the opener standing alone.
- **Supplier lane:**
  - `supplierFactsFor`;
  - `supplierAsksOwed` with past replies from other threads;
  - off-niche: no asks, the short prompt, rules C and D off;
  - `greetingName` with the four rows in 8.3, plus a reader name that is not in the text
    (rejected).
- **Console:** `tests/console.test.ts` covers the file list, and lint runs.

## 13. Left to the builder

- The exact regular expressions for rules A to D and for the thank-you check.
- The abbreviation list for the sentence splitter.
- Paging details for R2 list and delete.
- Function and file names, beyond the ones this doc fixes.
- Whether the file line sits above or below the message text in the transcript.

## 14. Calls I made, for the owner to check

1. Inline images under 100 KB with a content id are dropped as signature logos.
2. zip files are kept.
3. A refused file gets "we were not able to accept it, please send a PDF or a link". It
   reached us, so it is not "did not reach us".
4. Spam and automated threads store and record no files.
5. Download links last 30 minutes. An expired link says to reopen the thread.
6. The buckets sit in Western Europe (`weur`).
7. The supplier template opens "Thank you for informing us!" and drops the catalogue sentence
   when files are held.
8. On a double thank-you, the second sentence is removed rather than rewritten.
9. "Adjacent" suppliers keep the full flow.
10. When the From name and the reader's name are both good and differ, the From name wins.
11. `supplier_register` is now erased with a contact or a shop (found while designing).
12. The follow-up rule in the guidance: no repeated opener on a follow-up. This is my
    addition to the owner's three openers.

## Appendix A: the new `inbox.replyGuidance`

The current text is replaced with this. Changes from the current text:

- the opener rules are now conditional;
- the opener stands on its own line, once only;
- a complaint opens by acknowledging the problem;
- a follow-up gets no repeated opener;
- the closing offer of help is for customers only.

Everything else is kept word for word.

> Reply in a warm, professional voice (UK English). Do NOT add a greeting line; one is added
> automatically. Do NOT add a sign-off, signature or team name of any kind; the department
> signature is added automatically after your reply. Never invent specific prices, delivery
> dates, discounts, or stock. Never refer to an individual person on our side: never write
> "the right person", "I am not the right person", "the person who handles this", or "I will
> pass this on". Always say the team or the department instead. Open the first reply on a
> thread with ONE short thank-you on its own line, chosen by who is writing, in this order:
> "Thank you for informing us!" when they are a supplier telling us about their products or
> services; "Thank you for getting in touch!" when they offer us a service, a collaboration
> or a partnership; "Thank you for your enquiry!" when they ask us a question or make a
> request; otherwise "Thank you for getting in touch!". For a complaint, open by
> acknowledging the problem instead. Never thank them a second time in the same reply. On a
> follow-up in a thread we have already answered, do not repeat the opening thank-you;
> acknowledge what is new. Then answer clearly and concisely. When the sender is a customer,
> close with an offer of further help, e.g. "If you have any other questions or need any
> further assistance, please do not hesitate to get in touch.". If someone asks who they are
> speaking to, whether they have reached the owner, or who handles business, marketing or
> technical decisions, do NOT treat that as a private business detail and do NOT deflect it:
> answer plainly that their query will be passed to the right team here, and invite them to
> share the detail so it can be directed to the proper department.
