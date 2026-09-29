import { TenantStore } from '../tenant-store';
import { validateThreadStatus, validateLabels, validateInboxPayload } from '../validate';
import { DEFAULT_INBOX, type InboxConfig, type ThreadStatus } from './types';
import type { Env } from '../types';
import { sendReply } from './send';
import { composeDraftForThread } from './sweep';
import { startSupplierBackfill, readBackfillCursor } from './supplier-backfill';
import { SUPPLIER_STATUSES, type SupplierStatus } from './supplier-register';
import { buildServiceProveFirst, buildSupplierAck, buildAccessDecline, buildOperationsDecline, buildCollaborationDecline, buildKeepToEmail, buildSignupInvite, detectRateAboveStandard, detectOffPlatformRequest, buildSecondTouch, buildPointerBack, type TouchTemplate } from './partnership';
import { chooseTouch, outboundBodies, type TouchKind } from './repeat';
import { renderReplyHtml, openInboundText } from './draft';
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
  // Email engagement (2026-07-12): this thread's delivery/open/click events,
  // matched by the send-time thread_id tag - the rail's engagement block.
  const events = await store.listThreadEmailEvents(threadId);
  return { ok: true as const, thread: got.thread, messages: got.messages, labels: got.labels, draft, invoice, applicant, contact, partnerPool, partnerConsent, events };
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

/** Lift a sender-level block from the thread it shows on (owner rule
 *  2026-09-04). The block is set by the repeat rule at ingest (src/inbox/repeat.ts)
 *  and lives on the contact, so lifting it here re-admits every later message
 *  from that address. The thread's own status is left alone: the owner can
 *  reopen it with the status control if the last message deserved an answer. */
export async function unblockSender(db: D1Database, shop: string, threadId: string) {
  const store = new TenantStore(db, shop);
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  await store.unblockContact(got.thread.contact_email);
  return { ok: true as const, email: got.thread.contact_email };
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
  // Route EXACTLY like the sweep: composeDraftForThread reads the thread, lets
  // the partnership funnel screen first, then runs the category drafter (the
  // Ishola case, 2026-07-06, is why the funnel must run here at all). force:
  // the owner clicked Regenerate, so "no reply needed" never applies. The
  // funnel's send flag is ignored on purpose: Regenerate never sends.
  // Generate the replacement FIRST so an LLM failure never loses the current draft.
  const r = await composeDraftForThread(env, store, cfg, got.thread, fetchImpl, { force: true });
  if (!r || !('draftId' in r)) return { ok: false as const, error: 'Could not generate a new draft - model unavailable, try again.' };
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
  // Owner review 2026-09-04: only what the live self-serve programme needs.
  // The two programme entries come first because they are what the LIVE
  // affiliateMode ('signup_page') produces: the introduction is the funnel's
  // own first touch, and the follow-up is its shorter second touch (the reply
  // drafted for Abdullahi on 2026-09-04, promoted here so the next "I
  // understand, thanks" gets it in one click). Removed as superseded:
  // 'qualifying' and 'voucher_invite' (the FORM now screens and issues codes),
  // 'partnership_decline' (said we take no partnerships, false under the open
  // programme), 'holding_ack' (the July duplicate offender). The funnel keeps
  // those bodies for the legacy funnel modes; only the picker lost them.
  { key: 'signup_invite', label: 'Affiliate programme: introduction (apply link)' },
  { key: 'signup_followup', label: 'Affiliate programme: follow-up (shorter, apply link)' },
  // 2026-09-17 (owner rule, prove-first): the service pitch decline is retired.
  // A growth/marketing/SEO vendor is told that with the number of offers we
  // receive, a tracked code trial is the only way we tell who can deliver, with
  // the link and the rate; it stages them like the signup invite. A goods
  // supplier (catalogue, packaging, "backup supplier") is thanked for the
  // listing and nothing more: neither declined nor sent to a trial that cannot
  // measure them.
  { key: 'service_prove_first', label: 'Service pitch: prove first (code trial, apply link)' },
  { key: 'operations_decline', label: 'Internal operations decline' },
  // 2026-09-04 (later, Paul's thread): for the applicant who was introduced to
  // the programme twice and still insists on a different arrangement. The
  // funnel drafts it by itself in that situation; the picker entry is for the
  // owner to apply it by hand on any other thread.
  { key: 'collaboration_decline', label: 'Friendly decline (programme already introduced)' },
  // 2026-09-17 (later): for the vendor who asks for admin, sub-admin,
  // collaborator or staff access. Never granted; the trial needs none of it.
  { key: 'access_decline', label: 'Access request decline (never granted, trial link)' },
  { key: 'supplier_ack', label: 'Supplier: thanks, link and dropshipping question (no commitment)' },
  { key: 'keep_to_email', label: 'Keep to email (decline WhatsApp)' },
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

  // An accepted partner (a live code, or queued for one) is never re-invited
  // from the picker: the invite would stage them 'passed_to_form' and the next
  // inbound would treat them as a fresh applicant (aramid review 785e4f91).
  // The neutral and decline templates still apply to their thread. The
  // prove-first answer stages passed_to_form too (2026-09-17), so it is
  // guarded the same way.
  if (key === 'signup_invite' || key === 'signup_followup' || key === 'service_prove_first') {
    const pool = await store.partnerPoolState(got.thread.contact_email);
    if (pool === 'live' || pool === 'queued') {
      return { ok: false as const, error: `This contact is already an approved partner (${pool}); manage them from the Partners view instead of re-inviting` };
    }
  }

  // The rate paragraph reads the WHOLE thread, quote-stripped: a counter-offer
  // above our rate is the context the invite answers, whenever it was made. The
  // off-platform paragraph reads only what the sender wrote SINCE our last
  // sent reply (openInboundText): that still covers ca4e307d, where the
  // WhatsApp request sat in the second-to-last inbound and the last one was a
  // bare nudge with no reply between, and it no longer re-answers a channel
  // ask a sent reply already dealt with (aramid review 63df9d97).
  const inboundText = got.messages.filter((m) => m.direction === 'inbound')
    .map((m) => stripQuotedReply(m.body_text ?? '')).join('\n\n');
  const rateAbove = detectRateAboveStandard(inboundText);
  const offPlatform = detectOffPlatformRequest(openInboundText(got.messages));

  // The follow-up is the introduction's own shorter second touch promoted to a
  // picker entry; its next touch is therefore the one-line pointer.
  const followup = key === 'signup_followup';
  const touchKey: TouchTemplate = followup ? 'signup_invite' : (key as TouchTemplate);
  let body: string;
  if (key === 'signup_invite') body = buildSignupInvite(name, { rateAbove, offPlatform });
  else if (followup) body = buildSecondTouch('signup_invite', name);
  else if (key === 'service_prove_first') body = buildServiceProveFirst(name);
  else if (key === 'operations_decline') body = buildOperationsDecline(name);
  else if (key === 'collaboration_decline') body = buildCollaborationDecline(name);
  else if (key === 'supplier_ack') body = buildSupplierAck(name);
  else if (key === 'access_decline') body = buildAccessDecline(name);
  else body = buildKeepToEmail(name);

  // Owner rule 2026-09-04: never the same message twice on a thread. A template
  // already sent here renders as its shorter second touch, then as the one-line
  // pointer back to the earlier reply; either is flagged so the owner sees why.
  const pointer = buildPointerBack(touchKey, name);
  const touched = chooseTouch(outboundBodies(got.messages), {
    first: body, second: followup ? pointer : buildSecondTouch(touchKey, name), pointer,
  });
  const touch: TouchKind = touched.body === pointer ? 'pointer' : touched.touch;
  await store.supersedePendingDrafts(threadId);
  await store.insertDraft({
    threadId, bodyText: touched.body, bodyHtml: renderReplyHtml(touched.body),
    confidence: null, quotesPriceOrder: false, holdReasons: touch === 'first' ? [] : ['repeat_touch'], model: 'template', status: 'pending'
  });

  const applicant = await store.getApplicantByThread(threadId);
  // signup_invite stages 'passed_to_form', exactly as the funnel's own
  // signup_page first-touch branch does - the FORM now does the screening. Left
  // at a stale 'declined' the next inbound would route off a decision we just
  // reversed.
  // The prove-first answer stages passed_to_form too (2026-09-17): the vendor
  // was pointed at the form, so their next reply rides the applicant ladder.
  // The supplier thank-you, like keep-to-email, touches no stage at all.
  const stage = (key === 'signup_invite' || key === 'signup_followup' || key === 'service_prove_first') ? 'passed_to_form'
    : (key === 'operations_decline' || key === 'collaboration_decline') ? 'declined'
    : null;
  if (stage) {
    if (!applicant) await store.upsertApplicant({ threadId, contactEmail: got.thread.contact_email, stage });
    else await store.setApplicantStage(threadId, stage, null);
  } else if (key === 'access_decline' && !applicant && (await store.partnerPoolState(got.thread.contact_email)) === 'none') {
    // The access decline points a fresh sender at the trial, so a thread with
    // no applicant is staged passed_to_form (their next reply rides the
    // ladder). An existing applicant keeps its stage, and an accepted or
    // queued partner is never turned into an applicant by it.
    await store.upsertApplicant({ threadId, contactEmail: got.thread.contact_email, stage: 'passed_to_form' });
  }
  if (got.thread.status === 'closed') await store.setThreadStatus(threadId, 'needs_reply');
  return { ok: true as const, touch, draft: await store.getPendingDraft(threadId) };
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

// --- Supplier register (owner decision 2026-09-27) ---

function parseJsonList(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

export async function listSuppliersRoute(db: D1Database, shop: string) {
  const store = new TenantStore(db, shop);
  const rows = await store.listSuppliers(500);
  return {
    ok: true as const,
    suppliers: rows.map((r) => ({ ...r, storeLinks: parseJsonList(r.store_links), productLines: parseJsonList(r.product_lines) })),
    backfill: await readBackfillCursor(store),
  };
}

export async function updateSupplierRoute(db: D1Database, shop: string, body: unknown) {
  const b = (body ?? {}) as { email?: unknown; status?: unknown; notes?: unknown };
  if (typeof b.email !== 'string' || !b.email.trim()) return { ok: false as const, error: 'email required' };
  if (b.status !== undefined && !(typeof b.status === 'string' && (SUPPLIER_STATUSES as readonly string[]).includes(b.status))) return { ok: false as const, error: 'status must be new, reviewed or dismissed' };
  if (b.notes !== undefined && b.notes !== null && typeof b.notes !== 'string') return { ok: false as const, error: 'notes must be text' };
  const ok = await new TenantStore(db, shop).updateSupplierOwnerFields(b.email, {
    status: b.status as SupplierStatus | undefined,
    notes: b.notes === undefined ? undefined : (b.notes as string | null),
  });
  return ok ? { ok: true as const } : { ok: false as const, error: 'Supplier not found' };
}

/** A finished back-fill may be restarted deliberately, but a running one is never
 *  restarted by a second click: that would reset scanned/found to 0 and re-spend
 *  LLM calls on threads the current pass already read (fix round 1, 2026-09-27). */
export async function startSupplierBackfillRoute(db: D1Database, shop: string) {
  const store = new TenantStore(db, shop);
  const existing = await readBackfillCursor(store);
  if (existing && !existing.done) return { ok: true as const, backfill: existing, alreadyRunning: true as const };
  return { ok: true as const, backfill: await startSupplierBackfill(store) };
}

/** The owner asked for a reply on a thread the reader found needs none. Never sends. */
export async function draftAnyway(db: D1Database, env: Env, shop: string, threadId: unknown, fetchImpl: typeof fetch = defaultFetch) {
  if (typeof threadId !== 'string' || !threadId.trim()) return { ok: false as const, error: 'threadId required' };
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  const got = await store.getThreadWithMessages(threadId);
  if (!cfg || !got) return { ok: false as const, error: 'Thread not found' };
  if (await store.getPendingDraft(threadId)) return { ok: false as const, error: 'A draft is already pending' };
  const r = await composeDraftForThread(env, store, cfg, got.thread, fetchImpl, { force: true });
  if (!r || !('draftId' in r)) return { ok: false as const, error: 'Could not generate a draft - model unavailable, try again.' };
  // An owner's 'converted' or 'spam' call on this thread is a decision, not a
  // reading error: draft-anyway must not erase it. Only a status that was never
  // a decision (new/awaiting_customer/closed) moves to needs_reply.
  if (got.thread.status === 'new' || got.thread.status === 'awaiting_customer' || got.thread.status === 'closed') {
    await store.setThreadStatus(threadId, 'needs_reply');
  }
  return { ok: true as const, draft: await store.getPendingDraft(threadId) };
}
