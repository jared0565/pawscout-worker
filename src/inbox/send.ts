import type { Env, TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import type { ThreadRow, DraftRow } from './types';
import { INBOX_LABELS, parseDraftMeta } from './types';
import { sendEmail } from '../email';
import { renderReplyHtml, sanitizeOutbound, openInboundTexts } from './draft';
import { defaultFetch } from '../safe-fetch';
import { isPartnershipLane, resolveFromAddress } from './partnership';
import { captureAnswerFromSend } from './answer-memory';

/** The bare mailbox inside a display-name From ("Active Paw <x@y>" -> "x@y").
 * inbox_messages stores addresses without display names, so the outbound row
 * must record what was actually sent from, not the support@ default. */
function bareAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** A held sourcing offer quotes the supplier item as it stood when the draft
 * was written. Once that item is imported, refused, put up for profit review or
 * being imported, the offer may name a price or an item the store no longer
 * honours, so it must be regenerated before it goes out (aramid 53d7292e). */
export async function staleSourcingOffer(store: TenantStore, draft: DraftRow): Promise<string | null> {
  const pid = parseDraftMeta(draft.meta_json).sourcingPid;
  if (!pid) return null;
  const link = await store.getLink(pid);
  if (!link || !(Date.parse(link.updated_at) > Date.parse(draft.created_at))) return null;
  const why = link.state === 'imported' ? 'has been imported since this reply was written, so it should link the real product and price'
    : link.state === 'failed' ? 'was refused by the import checks after this reply was written'
    : link.state === 'draft' ? 'is waiting for your profit review in Shopify (publish or archive it first)'
    : 'is being imported right now (wait for it to finish)';
  return `The offered item ${why}. Regenerate this draft before sending it.`;
}

/** Send a drafted reply (HITL approve OR Auto). To = the contact; threads via a
 * controlled Message-ID we store; records outbound + flips draft/thread. */
export async function sendReply(
  env: Env, store: TenantStore, _cfg: TenantConfig, thread: ThreadRow, draft: DraftRow,
  bodyTextOverride?: string, fetchImpl: typeof fetch = defaultFetch
): Promise<{ ok: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  const stale = await staleSourcingOffer(store, draft);
  if (stale) return { ok: false, error: stale };
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
  // A supplier who happens to write to sales@ is not thereby in the partnership
  // funnel: the lane on-ramp only counts for a non-supplier thread, unless an
  // applicant row already exists (the thread genuinely is in the funnel and
  // must stay there, e.g. a supplier the reader later relabels).
  const applicant = await store.getApplicantByThread(thread.id);
  // A template's applicant stage is written only once its reply is sent
  // (aramid 785e4f91); 'if-none' applies only to a thread with no applicant
  // whose contact is not already a partner, judged now rather than when the
  // template was picked. A reply that will stage the sender counts as in the
  // funnel for its From, as the applicant row it creates would.
  const stageOnSend = parseDraftMeta(draft.meta_json).stageOnSend;
  const pendingStage = stageOnSend && (stageOnSend.mode === 'set'
    || (!applicant && (await store.partnerPoolState(thread.contact_email)) === 'none'))
    ? stageOnSend.stage : null;
  const partnershipLane = (thread.primary_category !== 'supplier'
    && isPartnershipLane({ inboundToAddrs, declaredIntent: got?.thread.declared_intent ?? null, primaryCategory: thread.primary_category, inboundTexts: openInboundTexts(got?.messages ?? []) }))
    || !!applicant || !!pendingStage;
  const from = resolveFromAddress({ partnershipLane, toAddr: lastInbound?.to_addr ?? null });

  const r = await sendEmail(env.RESEND_API_KEY, {
    from, to: thread.contact_email, subject: `Re: ${subject}`.slice(0, 200),
    text: bodyText, html: bodyHtml, headers,
    tags: [{ name: 'kind', value: 'reply' }, { name: 'thread_id', value: thread.id }]
  }, fetchImpl);
  if (!r.ok) return { ok: false, error: r.error };

  if (pendingStage) {
    if (!applicant) await store.upsertApplicant({ threadId: thread.id, contactEmail: thread.contact_email, stage: pendingStage });
    else await store.setApplicantStage(thread.id, pendingStage, null);
  }
  const sentAt = new Date().toISOString();
  await store.insertOutboundMessage({ threadId: thread.id, messageId: r.messageId, from: bareAddress(from), to: thread.contact_email, subject: `Re: ${subject}`, bodyText, bodyHtml, sentAt });
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
