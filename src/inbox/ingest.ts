import type { TenantStore } from '../tenant-store';
import type { ParsedEmail, ThreadStatus } from './types';
import { parseInbound, extractContactForm } from './mime';
import { parseAuthResults, isAutomated, isHardSpam, normalizeSubject, isContentless } from './gates';

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

  const matchedThreadId = await store.matchThread({
    contactEmail: email, inReplyTo: p.inReplyTo, references: p.references, subjectNorm
  });
  const isExistingThread = !!matchedThreadId;

  // Decide the initial status from the gates (LLM never decides spam).
  const auth = parseAuthResults(p.headers);
  // A Shopify contact-form notification arrives from a no-reply relay wrapping a
  // real human - so a form submission must NOT be gated as "automated" on the
  // envelope sender. The DMARC spam gate below still applies to everyone.
  const automated = form ? false : isAutomated(p);
  const spam = isHardSpam(auth);
  // A blank/content-less email has nothing to action: suppress it like automated mail
  // (status closed + pre-classified) so it never reaches the inbox view or the draft
  // sweep. The owner should not waste time on empty messages.
  const blank = !automated && !spam && isContentless(bodyText, p.html, !!p.hasAttachments);
  const initialStatus: ThreadStatus = spam ? 'spam' : automated || blank ? 'closed' : 'new';

  let threadId: string;
  if (!matchedThreadId) {
    threadId = await store.createThread({
      contactEmail: email, subject: p.subject, subjectNorm, receivedAt: p.date, initialStatus,
      declaredIntent: form?.reason ?? null
    });
    // Automated/spam/blank never enter the classify sweep - mark them classified now.
    if (automated || spam || blank) {
      const category = automated ? 'automated' : spam ? 'spam' : 'no_content';
      const summary = automated ? 'Automated/bulk message'
        : spam ? 'Failed DMARC - likely spoofed'
        : 'Empty message - nothing to action';
      await store.setThreadClassification(threadId, {
        status: initialStatus, primaryCategory: category,
        intentScore: 0, summary,
        classifiedAt: new Date().toISOString()
      });
      await store.setThreadLabels(threadId, [category]);
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
    // Multi-turn: an inbound on an active existing thread re-opens it for a fresh reply.
    // Guard: only if this message is genuinely new (inserted) - a duplicate redelivery
    // (same Message-ID, already stored) must NOT re-open the thread or supersede drafts.
    // Only reopen conversations we'd engage with; never resurrect spam/closed/converted.
    if (isExistingThread && !automated && !spam && !blank) {
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

/** Parse raw RFC822 bytes then ingest. The thin core the email() handler calls. */
export async function processInbound(store: TenantStore, raw: ArrayBuffer | Uint8Array | string): Promise<{ threadId: string; deduped: boolean }> {
  const parsed = await parseInbound(raw);
  return ingestParsed(store, parsed);
}
