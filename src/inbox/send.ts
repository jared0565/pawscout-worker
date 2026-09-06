import type { Env, TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import type { ThreadRow, DraftRow } from './types';
import { INBOX_LABELS } from './types';
import { sendEmail } from '../email';
import { renderReplyHtml, sanitizeOutbound, openInboundTexts } from './draft';
import { defaultFetch } from '../safe-fetch';
import { isPartnershipLane, resolveFromAddress } from './partnership';
import { captureAnswerFromSend } from './answer-memory';

/** Send a drafted reply (HITL approve OR Auto). To = the contact; threads via a
 * controlled Message-ID we store; records outbound + flips draft/thread. */
export async function sendReply(
  env: Env, store: TenantStore, _cfg: TenantConfig, thread: ThreadRow, draft: DraftRow,
  bodyTextOverride?: string, fetchImpl: typeof fetch = defaultFetch
): Promise<{ ok: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  const bodyText = sanitizeOutbound((bodyTextOverride ?? draft.body_text).trim()); // strip em/en-dashes - final outbound net (covers owner-edited bodies too)
  if (!bodyText) return { ok: false, error: 'empty reply' };
  const bodyHtml = renderReplyHtml(bodyText);                 // safe HTML, built from text

  // Thread to the customer's latest inbound message.
  const got = await store.getThreadWithMessages(thread.id);
  const lastInbound = [...(got?.messages ?? [])].reverse().find((m) => m.direction === 'inbound');
  const subject = (thread.subject ?? '').replace(/^(re:\s*)+/i, '');
  const headers: Record<string, string> = {};
  if (lastInbound?.message_id) { headers['In-Reply-To'] = lastInbound.message_id; headers['References'] = lastInbound.message_id; }

  // Sender identity: partnership-lane threads reply from sales@ ("Active Paw Partnerships");
  // otherwise from the address the customer wrote to, else the support@ default.
  // The lane is what the sender asked SINCE our last reply, or an applicant row:
  // a thread already in the funnel keeps its identity on a bare "thanks".
  const inboundToAddrs = (got?.messages ?? []).filter((m) => m.direction === 'inbound').map((m) => m.to_addr ?? '');
  const partnershipLane = isPartnershipLane({ inboundToAddrs, declaredIntent: got?.thread.declared_intent ?? null, primaryCategory: thread.primary_category, inboundTexts: openInboundTexts(got?.messages ?? []) })
    || !!(await store.getApplicantByThread(thread.id));
  const from = resolveFromAddress({ partnershipLane, toAddr: lastInbound?.to_addr ?? null });

  const r = await sendEmail(env.RESEND_API_KEY, {
    from, to: thread.contact_email, subject: `Re: ${subject}`.slice(0, 200),
    text: bodyText, html: bodyHtml, headers,
    tags: [{ name: 'kind', value: 'reply' }, { name: 'thread_id', value: thread.id }]
  }, fetchImpl);
  if (!r.ok) return { ok: false, error: r.error };

  const sentAt = new Date().toISOString();
  await store.insertOutboundMessage({ threadId: thread.id, messageId: r.messageId, from: 'support@activepaw.co.uk', to: thread.contact_email, subject: `Re: ${subject}`, bodyText, bodyHtml, sentAt });
  // Answer memory (2026-07-12): the FINAL sent text (owner edits included)
  // becomes a vetted Q->A pair for future recall. Never blocks the send.
  try {
    await captureAnswerFromSend(store, thread, got?.messages ?? [], bodyText, partnershipLane, sentAt);
  } catch (e) { console.warn(`answer capture failed for ${thread.id}: ${(e as Error).message}`); }
  await store.setDraftStatus(draft.id, _cfg.inbox.autosend && bodyTextOverride === undefined ? 'auto_sent' : 'sent', { sentMessageId: r.messageId, sentAt });
  // Intelligent thread bookkeeping on send (HITL approve OR Auto):
  //  - Status: a sent reply puts the ball in the customer's court → awaiting_customer.
  //    Flip ONLY from the pre-reply states (new/needs_reply) so an explicit merchant
  //    choice of converted/closed is never silently stomped by a follow-up send.
  //  - Label: ensure the thread carries its classifier category as a label, so a
  //    processed thread is auto-tagged without the merchant touching the label
  //    control. primary_category is constrained to INBOX_LABELS by the classifier;
  //    re-validate before writing so a stale/garbage value can't dirty the taxonomy.
  if (thread.status === 'new' || thread.status === 'needs_reply') {
    await store.setThreadStatus(thread.id, 'awaiting_customer');
  }
  const cat = thread.primary_category;
  if (cat && (INBOX_LABELS as readonly string[]).includes(cat)) {
    await store.addThreadLabel(thread.id, cat);
  }
  return { ok: true };
}
