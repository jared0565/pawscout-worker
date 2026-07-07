import { TenantStore } from '../tenant-store';
import { validateThreadStatus, validateLabels, validateInboxPayload } from '../validate';
import { DEFAULT_INBOX, type InboxConfig, type ThreadStatus } from './types';
import type { Env } from '../types';
import { sendReply } from './send';
import { composeDraftForThread } from './sweep';
import {
  maybePartnershipDraft, buildQualifyingEmail, buildPartnershipDecline, buildServiceDecline,
  buildOperationsDecline, buildVoucherInvite, buildHoldingAck, detectVolumePitch, type FunnelVariant
} from './partnership';
import { renderReplyHtml } from './draft';
import { stripQuotedReply } from './quote';
import { defaultFetch } from '../safe-fetch';

export async function listInboxThreads(db: D1Database, shop: string, status: string | null) {
  const store = new TenantStore(db, shop);
  const rows = await store.listThreads(status, 100);
  // Phase 3: per-thread "draft ready" flag + the contact's display name, so the
  // list pane can show a person and a state chip without extra round-trips.
  const draftThreadIds = new Set(await store.pendingDraftThreadIds());
  const names = await store.contactNamesByEmails([...new Set(rows.map((t) => t.contact_email))]);
  return {
    ok: true as const,
    // Fresh Open-queue size on EVERY list load (whatever the filter), so the
    // rail badge re-syncs each time the Inbox fetches instead of only at page
    // load - threads created/recalled mid-session no longer leave a stale badge.
    openCount: await store.openThreadCount(),
    threads: rows.map((t) => ({
      id: t.id, contactEmail: t.contact_email, contactName: names.get(t.contact_email) ?? null,
      subject: t.subject, status: t.status,
      category: t.primary_category, intentScore: t.intent_score, summary: t.summary,
      lastMessageAt: t.last_message_at, hasDraft: draftThreadIds.has(t.id)
    }))
  };
}

export async function getInboxThread(db: D1Database, shop: string, threadId: string) {
  const store = new TenantStore(db, shop);
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  const draft = await store.getPendingDraft(threadId);
  const invoice = await store.getOpenInvoiceForThread(threadId);
  const applicant = await store.getApplicantByThread(threadId);
  const contact = await store.getContactByEmail(got.thread.contact_email);
  const partnerPool = await store.partnerPoolState(got.thread.contact_email);
  const partnerConsent = await store.partnerConsentByEmail(got.thread.contact_email);
  return { ok: true as const, thread: got.thread, messages: got.messages, labels: got.labels, draft, invoice, applicant, contact, partnerPool, partnerConsent };
}

/** Marketing opt-in flipped from the sender's own thread (2026-07-06): the
 *  invite paragraph says "just say yes in your reply and we'll add you", and
 *  the yes arrives in the Inbox - so the switch lives there too. Creates the
 *  partner row when none exists (opt-in only); on an existing row it updates
 *  ONLY consent, never status, so flipping consent can never graduate a queued
 *  partner or resurrect an ended one. The owner clicks it on the partner's own
 *  yes - correspondence alone never puts anyone on the campaign list. */
export async function setPartnerConsentFromThread(db: D1Database, shop: string, threadId: unknown, optIn: unknown) {
  if (typeof threadId !== 'string' || !threadId.trim()) return { ok: false as const, error: 'threadId required' };
  if (typeof optIn !== 'boolean') return { ok: false as const, error: 'on must be true or false' };
  const store = new TenantStore(db, shop);
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  const email = got.thread.contact_email;
  let partnerId = await store.partnerIdByEmail(email);
  if (!partnerId) {
    if (!optIn) return { ok: true as const, consent: false }; // nothing recorded, nothing to remove
    const contact = await store.getContactByEmail(email);
    partnerId = await store.upsertAffiliatePartner({
      contactEmail: email, name: contact?.name ?? null, notes: 'Updates opt-in from the Inbox'
    });
  }
  await store.setPartnerMarketingConsent(partnerId, optIn);
  return { ok: true as const, consent: optIn };
}

/** "Add to the trial code queue" (2026-07-06): parks a qualified applicant in
 *  affiliate_partners as status 'queued' so the owner can issue their code
 *  later from Partners without having to remember who passed screening. Sends
 *  nothing; issuing later stages the code invite back on this thread. */
export async function queuePartnerFromThread(db: D1Database, shop: string, threadId: unknown) {
  if (typeof threadId !== 'string' || !threadId.trim()) return { ok: false as const, error: 'threadId required' };
  const store = new TenantStore(db, shop);
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  const contact = await store.getContactByEmail(got.thread.contact_email);
  const state = await store.queueAffiliatePartner({
    contactEmail: got.thread.contact_email,
    name: contact?.name ?? null,
    notes: 'Queued from the Inbox'
  });
  return { ok: true as const, state, email: got.thread.contact_email };
}

export async function setInboxStatus(db: D1Database, shop: string, threadId: string, status: unknown) {
  if (!validateThreadStatus(status)) return { ok: false as const, error: 'Invalid status' };
  const store = new TenantStore(db, shop);
  if (!(await store.getThreadWithMessages(threadId))) return { ok: false as const, error: 'Thread not found' };
  await store.setThreadStatus(threadId, status as ThreadStatus);
  // Dismissing a thread retires its pending draft too: Phase 2 removed the
  // standalone draft-Discard control, so a draft left 'pending' here could never
  // be acted on again and would inflate the pending-draft badge forever.
  if (status === 'closed' || status === 'spam' || status === 'converted') {
    await store.discardPendingDrafts(threadId);
  }
  return { ok: true as const, status };
}

export async function setInboxLabels(db: D1Database, shop: string, threadId: string, labels: unknown) {
  const v = validateLabels(labels);
  if (!v.ok) return { ok: false as const, error: v.error };
  const store = new TenantStore(db, shop);
  if (!(await store.getThreadWithMessages(threadId))) return { ok: false as const, error: 'Thread not found' };
  await store.setThreadLabels(threadId, v.value);
  return { ok: true as const, labels: v.value };
}

export async function getInboxConfig(db: D1Database, shop: string): Promise<InboxConfig> {
  const cfg = await new TenantStore(db, shop).getConfig();
  return cfg?.inbox ?? DEFAULT_INBOX;
}

export async function saveInboxConfig(db: D1Database, shop: string, body: unknown) {
  const v = validateInboxPayload(body);
  if (!v.ok) return { ok: false as const, error: v.error };
  const store = new TenantStore(db, shop);
  // postalAddress is edited from the Campaigns view, not the Settings form, so a
  // Settings save that OMITS the key must not wipe it: omitted → preserve current;
  // explicit '' → clear; a non-empty string → the validator already set it.
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (v.value.postalAddress === undefined && raw.postalAddress === undefined) {
    const cur = (await store.getConfig())?.inbox.postalAddress;
    if (cur) v.value.postalAddress = cur;
  }
  await store.saveInbox(v.value);
  return { ok: true as const };
}

/**
 * Regenerate: discard the current draft and immediately produce a fresh one with
 * the LLM. Unlike the old "discard" (which closed the thread), this NEVER closes
 * the thread and NEVER auto-sends. The replacement is generated FIRST, so if the
 * LLM is unavailable the current draft is left untouched (no data loss). To
 * dismiss a thread without replying, set its status to closed via the status
 * control instead.
 */
export async function regenerateDraft(db: D1Database, env: Env, shop: string, draftId: string, fetchImpl: typeof fetch = defaultFetch) {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  const old = await store.getDraft(draftId);
  if (!cfg || !old || old.status !== 'pending') return { ok: false as const, error: 'No pending draft' };
  const got = await store.getThreadWithMessages(old.thread_id);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  // Route EXACTLY like the sweep: the partnership funnel screens first (its
  // pitch on-ramp reads the latest inbound text, wherever the thread is
  // filed), then the generic category drafter. Before this, Regenerate re-ran
  // only the category agent, so a commission-for-volume pitch on an 'other'
  // thread could never reach the qualifying email - every click reproduced
  // the same decline template (Ishola case, 2026-07-06). The funnel's send
  // flag is ignored on purpose: Regenerate never sends.
  const funnel = await maybePartnershipDraft(env, store, cfg, got.thread, got, fetchImpl);
  if (!funnel) {
    // Generate the replacement FIRST so an LLM failure never loses the current draft.
    const r = await composeDraftForThread(env, store, cfg, got.thread, fetchImpl);
    if (!r) return { ok: false as const, error: 'Could not generate a new draft - model unavailable, try again.' };
  }
  // Replacement is in (pending). Retire the old draft and keep the thread OPEN
  // for review - never close it (that was the discard trap). Regenerate never sends.
  await store.setDraftStatus(draftId, 'discarded');
  if (got.thread.status === 'closed') await store.setThreadStatus(old.thread_id, 'needs_reply');
  return { ok: true as const, draft: await store.getPendingDraft(old.thread_id) };
}

/**
 * Owner-pickable draft templates (2026-07-06, Paul Joseph case): the funnel's
 * detectors only claim a thread when the latest inbound carries pitch
 * vocabulary, so a plain follow-up ("what are you looking into?") gets a
 * generic LLM draft even when the owner knows this person belongs in the
 * partnership funnel. The dropdown lets the owner swap the pending draft for a
 * canonical template WITHOUT leaving the Inbox - server-rendered so the
 * salutation, the qualifying marker sentence, and the applicant bookkeeping
 * stay exactly what the funnel itself would have produced.
 */
export const DRAFT_TEMPLATES: { key: string; label: string }[] = [
  { key: 'qualifying', label: 'Partnership screening questions' },
  { key: 'voucher_invite', label: 'Trial invite (code on its way)' },
  { key: 'partnership_decline', label: 'Partnership decline' },
  { key: 'service_decline', label: 'Service pitch decline' },
  { key: 'operations_decline', label: 'Internal operations decline' },
  { key: 'holding_ack', label: 'Holding note (we are reviewing)' },
];

/**
 * Replace the thread's pending draft with a rendered template. Mirrors the
 * funnel's own moves so a manually templated thread behaves identically from
 * then on: the qualifying email carries the marker sentence (so replies are
 * scored, never re-asked) and stamps the applicant at screen_sent; declines
 * stamp declined (which stops the funnel re-pitching); the voucher invite
 * stamps passed_to_form. Never sends - the result is a pending draft the
 * owner still has to approve.
 */
export async function applyDraftTemplate(db: D1Database, shop: string, threadId: unknown, key: unknown) {
  if (typeof threadId !== 'string' || !threadId) return { ok: false as const, error: 'threadId required' };
  if (typeof key !== 'string' || !DRAFT_TEMPLATES.some((t) => t.key === key)) return { ok: false as const, error: 'Unknown template' };
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  if (!cfg) return { ok: false as const, error: 'Tenant not found' };
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  const contact = await store.getContactByEmail(got.thread.contact_email);
  const name = contact?.name ?? null;

  let body: string;
  if (key === 'qualifying') {
    const variant: FunnelVariant = cfg.inbox.affiliateMode === 'funnel_link' ? 'link' : 'voucher';
    // Same tier-ladder trigger as the funnel: if ANY inbound negotiated
    // commission against volume, the earned-tiers paragraph rides along.
    const inboundText = got.messages.filter((m) => m.direction === 'inbound')
      .map((m) => stripQuotedReply(m.body_text ?? '')).join('\n\n');
    body = buildQualifyingEmail(name, variant, { volumePitch: detectVolumePitch(inboundText) });
  } else if (key === 'voucher_invite') body = buildVoucherInvite(name);
  else if (key === 'partnership_decline') body = buildPartnershipDecline(name);
  else if (key === 'service_decline') body = buildServiceDecline(name);
  else if (key === 'operations_decline') body = buildOperationsDecline(name);
  else body = buildHoldingAck(name);

  await store.supersedePendingDrafts(threadId);
  await store.insertDraft({
    threadId, bodyText: body, bodyHtml: renderReplyHtml(body),
    confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'template', status: 'pending'
  });

  const applicant = await store.getApplicantByThread(threadId);
  const stage = key === 'qualifying' ? 'screen_sent'
    : key === 'voucher_invite' ? 'passed_to_form'
    : (key === 'partnership_decline' || key === 'service_decline' || key === 'operations_decline') ? 'declined'
    : null;
  if (stage) {
    if (!applicant) await store.upsertApplicant({ threadId, contactEmail: got.thread.contact_email, stage });
    else await store.setApplicantStage(threadId, stage, null);
  }
  if (got.thread.status === 'closed') await store.setThreadStatus(threadId, 'needs_reply');
  return { ok: true as const, draft: await store.getPendingDraft(threadId) };
}

export async function approveDraft(db: D1Database, shop: string, env: Env, draftId: string, editedBody?: string) {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  const draft = await store.getDraft(draftId);
  if (!cfg || !draft || draft.status !== 'pending') return { ok: false as const, error: 'No pending draft' };
  const got = await store.getThreadWithMessages(draft.thread_id);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  const body = typeof editedBody === 'string' && editedBody.trim() ? editedBody : undefined;
  const r = await sendReply(env, store, cfg, got.thread, draft, body);
  return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
}
