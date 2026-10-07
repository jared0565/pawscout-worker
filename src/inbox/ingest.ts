import type { TenantStore } from '../tenant-store';
import type { ParsedEmail, ThreadStatus } from './types';
import { parseInbound, extractContactForm } from './mime';
import { parseAuthResults, isAutomated, isHardSpam, normalizeSubject } from './gates';
import { repeatVerdict, isRepeatOf, looksLikeCustomerMessage, PROTECTED_CATEGORIES } from './repeat';

/** Store one parsed inbound email: resolve the real sender, match-or-create the
 * thread, insert the message (deduped), and set the thread's initial status from
 * the mechanical gates. Automated/spam threads are pre-classified so the LLM
 * sweep skips them. Returns the thread id and whether the message was a dup. */
export async function ingestParsed(store: TenantStore, p: ParsedEmail): Promise<{ threadId: string; deduped: boolean }> {
  // Resolve the true visitor (a Shopify form notification hides them behind a no-reply sender).
  const form = extractContactForm(p);
  const email = form?.email ?? p.from.email;
  const name = form?.name ?? p.from.name;
  const phone = form?.phone ?? null;
  const bodyText = form?.body ?? p.text;
  const subjectNorm = normalizeSubject(p.subject);

  await store.upsertContact({ email, name, phone });
  // Sender-level block (owner rule 2026-09-04): a contact the repeat rule (or the
  // owner) blocked lands as spam before classification, drafting or alerting.
  const contact = await store.getContactByEmail(email);
  let blocked = !!contact?.blocked_at;

  const matchedThreadId = await store.matchThread({
    contactEmail: email, inReplyTo: p.inReplyTo, references: p.references, subjectNorm
  });
  const isExistingThread = !!matchedThreadId;

  // Decide the initial status from the gates (LLM never decides spam).
  const auth = parseAuthResults(p.headers);
  // A block is re-read on every arrival, not set once and forgotten (aramid
  // review b4b33fbf): the same deterministic guard that keeps a customer from
  // being blocked, an order-shaped message from an AUTHENTICATED sender, lets a
  // wrongly blocked one back in. The block lifts here and the message is handled
  // as a normal inbound. A contact-form post lifts it too (2026-10-07): its
  // DMARC is the relay's and the address is whatever was typed, but lifting is
  // the safe direction, and a form post can never set a block.
  if (blocked && (form || auth.dmarc === 'pass') && looksLikeCustomerMessage(bodyText)) {
    await store.unblockContact(email);
    blocked = false;
  }
  // A Shopify contact-form notification arrives from a no-reply relay wrapping a
  // real human - so a form submission must NOT be gated as "automated" on the
  // envelope sender. The DMARC spam gate below still applies to everyone.
  const automated = form ? false : isAutomated(p);
  const spam = isHardSpam(auth) || blocked;
  const initialStatus: ThreadStatus = spam ? 'spam' : automated ? 'closed' : 'new';
  // Read the sender's earlier messages BEFORE the new one is stored, so the
  // repeat check below compares the new text against genuinely earlier copies.
  const earlier = (!form && !automated && !spam) ? await store.recentInboundBySender(email) : [];

  let threadId: string;
  if (!matchedThreadId) {
    threadId = await store.createThread({
      contactEmail: email, subject: p.subject, subjectNorm, receivedAt: p.date, initialStatus,
      declaredIntent: form?.reason ?? null
    });
    // Automated/spam never enter the classify sweep - mark them classified now.
    if (automated || spam) {
      await store.setThreadClassification(threadId, {
        status: initialStatus, primaryCategory: automated ? 'automated' : 'spam',
        intentScore: 0, summary: automated ? 'Automated/bulk message' : blocked ? 'Blocked sender' : 'Failed DMARC - likely spoofed',
        classifiedAt: new Date().toISOString()
      });
      await store.setThreadLabels(threadId, [automated ? 'automated' : 'spam']);
    }
  } else {
    threadId = matchedThreadId;
  }

  const inserted = await store.insertInboundMessageIfNew({
    threadId, messageId: p.messageId, inReplyTo: p.inReplyTo, references: p.references,
    from: email, to: p.to[0] ?? null, subject: p.subject, bodyText, bodyHtml: p.html,
    headersJson: JSON.stringify(p.headers).slice(0, 8000), receivedAt: p.date
  });

  if (inserted) {
    await store.touchThread(threadId, p.date);

    // Repeat-message rule (owner 2026-09-04): the same text again, after we
    // already replied to it (or a 3rd copy regardless), makes the sender spam
    // and blocks their later messages. Never for customers: a linked Shopify
    // customer or a thread in a customer-service lane is protected.
    // Three deterministic guards (aramid review of the first cut, 2026-09-04):
    // a block is punitive, so only an AUTHENTICATED sender (DMARC pass) can earn
    // one - a spoofer must never be able to silence a third party; and a message
    // that reads like a customer's order or delivery query is never blocked, so
    // the protection does not wait on the LLM sweep's classification.
    let repeat = false;
    if (!form && !automated && !spam && earlier.length > 0 && auth.dmarc === 'pass' && !looksLikeCustomerMessage(bodyText)) {
      repeat = repeatVerdict(bodyText, earlier.map((e) => ({ text: e.body_text, repliedAfter: e.replied_after })));
      if (repeat && await store.senderIsProtected(email, PROTECTED_CATEGORIES)) repeat = false;
      // The protection reads thread categories the sweep writes later (aramid
      // 114e2e7b): while a thread holding an earlier copy is still unclassified,
      // the sender might be a customer the protection cannot see yet, so the
      // block waits for the sweep. A copy after classification decides it.
      if (repeat) {
        const copyThreads = [...new Set(earlier.filter((e) => isRepeatOf(bodyText, e.body_text)).map((e) => e.thread_id))];
        if (await store.anyThreadUnclassified(copyThreads)) repeat = false;
      }
    }
    if (repeat) {
      const copies = earlier.length + 1;
      await store.blockContact(email, `repeat message: same text sent ${copies} times, blocked at ingest`);
      await markThreadSpam(store, threadId, 'Repeated the same message after our reply - sender blocked');
    } else if (blocked && isExistingThread) {
      // A blocked sender writing on one of their OLD threads: that thread joins
      // the spam pile too, so it cannot sit in the queue asking for a reply.
      await markThreadSpam(store, threadId, 'Blocked sender');
    } else if (isExistingThread && !automated && !spam) {
      // Multi-turn: an inbound on an active existing thread re-opens it for a fresh reply.
      // Guard: only if this message is genuinely new (inserted) - a duplicate redelivery
      // (same Message-ID, already stored) must NOT re-open the thread or supersede drafts.
      // Only reopen conversations we'd engage with; never resurrect spam/closed/converted.
      const existing = await store.getThreadWithMessages(threadId);
      const st = existing?.thread.status;
      if (st === 'awaiting_customer' || st === 'needs_reply') {
        await store.supersedePendingDrafts(threadId);
        await store.reopenThread(threadId); // → needs_reply (classified_at kept; category persists)
      }
    }
  }

  return { threadId, deduped: !inserted };
}

/** Spam disposition for a thread the block rule caught: classified spam (so the
 * LLM sweep skips it), labelled, and any pending draft retired so it cannot be
 * sent or inflate the pending badge. */
async function markThreadSpam(store: TenantStore, threadId: string, summary: string): Promise<void> {
  await store.setThreadClassification(threadId, {
    status: 'spam', primaryCategory: 'spam', intentScore: 0, summary, classifiedAt: new Date().toISOString()
  });
  await store.setThreadLabels(threadId, ['spam']);
  await store.discardPendingDrafts(threadId);
}

/** Parse raw RFC822 bytes then ingest. The thin core the email() handler calls. */
export async function processInbound(store: TenantStore, raw: ArrayBuffer | Uint8Array | string): Promise<{ threadId: string; deduped: boolean }> {
  const parsed = await parseInbound(raw);
  return ingestParsed(store, parsed);
}
