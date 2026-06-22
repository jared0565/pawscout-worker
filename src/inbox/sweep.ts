import type { Env, TenantConfig } from '../types';
import { TenantStore, listActiveShops } from '../tenant-store';
import { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import { defaultFetch } from '../safe-fetch';
import { parseAuthResults } from './gates';
import { classifyEmail, decideDisposition } from './classify';
import { draftReply, renderReplyHtml } from './draft';
import { autoSendDecision, mentionsMoney } from './autosend';
import { sendReply } from './send';
import { maybePartnershipDraft } from './partnership';
import { maybeAlertOwner } from './alert';
import { proposeInvoice } from './propose-invoice';
import { adminForShop } from './invoice-routes';
import { resolveLineRequest } from '../shopify-catalog';
import { invoiceSendDecision } from './invoice-floor';
import { createDraftOrder } from '../shopify-drafts';
import { sendInvoice } from './send-invoice';
import { hasScope } from './scopes';
import { resolveLogistics, doorToDoorBand } from '../logistics';
import { isShippingIntent, deriveDestinationCountry, countryLabel, buildShippingLine } from './freight';
import type { ThreadRow, InvoiceLineItem } from './types';

const SWEEP_BATCH = 15;          // threads classified per shop per run

/** Defensive JSON parse for stored headers_json. Ingest slices to 8000 chars, so a
 * very-long header set can produce truncated invalid JSON. Degrade to {} (→ auth all
 * 'none') rather than throwing and aborting the whole shop's sweep batch. */
function safeHeaders(json: string | null): Record<string, string> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, string>; } catch { return {}; }
}

/** Cron entry (every 15 min): classify each shop's unclassified threads, set
 * status/labels, and alert the owner on a hot lead. LLM-gated and self-healing —
 * an unavailable LLM simply leaves threads pending for the next run. */
export async function runInboxClassifySweep(env: Env, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
  if (!llm.available) return; // nothing to do without a model; threads stay pending
  for (const shop of await listActiveShops(env.DB)) {
    const store = new TenantStore(env.DB, shop);
    try {
      const cfg = await store.getConfig();
      if (!cfg || !cfg.inbox.enabled) continue;
      for (const thread of await store.unclassifiedThreads(SWEEP_BATCH)) {
        await classifyOne(env, store, cfg, shop, thread, fetchImpl);
      }
      for (const thread of await store.threadsNeedingDraft(SWEEP_BATCH)) {
        const handled = await proposeInvoiceOne(env, store, cfg, thread, fetchImpl);
        if (!handled) await draftOne(env, store, cfg, thread, fetchImpl);
      }
    } catch (e) {
      console.warn(`inbox sweep failed for ${shop}: ${(e as Error).message}`);
    }
  }
}

async function classifyOne(env: Env, store: TenantStore, cfg: TenantConfig, shop: string, thread: ThreadRow, fetchImpl: typeof fetch): Promise<void> {
  const got = await store.getThreadWithMessages(thread.id);
  const firstInbound = got?.messages.find((m) => m.direction === 'inbound');
  if (!firstInbound) return;
  const auth = parseAuthResults(safeHeaders(firstInbound.headers_json));
  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);

  const c = await classifyEmail(llm, store, cfg, {
    subject: thread.subject ?? '', body: firstInbound.body_text ?? '', fromEmail: thread.contact_email, auth
  });
  if (!c) return; // degrade: leave pending for the next run

  const d = decideDisposition(c, cfg.inbox.intentThreshold);
  await store.setThreadClassification(thread.id, {
    status: d.status, primaryCategory: d.primaryCategory, intentScore: c.intentScore,
    summary: c.summary, classifiedAt: new Date().toISOString()
  });
  await store.setThreadLabels(thread.id, d.labels);
  if (d.alert) await maybeAlertOwner(env, cfg, shop, thread, c.summary, d.primaryCategory, fetchImpl);
}

/**
 * Attempt to create an invoice proposal for a thread. Returns true when the
 * thread was handled by the invoice path (caller should NOT call draftOne).
 * Returns false to fall through to the reply-draft path.
 *
 * Gate order (§5.7):
 * 1. Idempotency: existing sent invoice → return true (skip).
 * 2. LLM: proposeInvoice → null or !isInvoiceMoment → return false (degrade to reply).
 * 3. Admin scope gate: no write_draft_orders → insert proposed w/ reconnect_required → return true.
 * 4. Catalog: resolveLineRequest for each lineRequest; compute total + caps.
 * 5. Floor: invoiceSendDecision.
 * 6. Insert invoice (proposed).
 * 7. If decision.create → createDraftOrder + sendInvoice. Else leave proposed for HITL.
 *    Return true.
 */
// A failed auto-invoice backs off this long before the sweep re-proposes — stops a
// thread that keeps failing (catalog miss, send error, scope loss) from triggering a
// fresh LLM call + draft attempt every 15-min sweep.
const FAILED_INVOICE_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h
// Hard backstop on an auto-invoice line quantity, used when a variant's inventory is
// untracked/unknown; tracked stock caps below this.
const HARD_INVOICE_QTY_CAP = 20;

export async function proposeInvoiceOne(
  env: Env,
  store: TenantStore,
  cfg: TenantConfig,
  thread: ThreadRow,
  fetchImpl: typeof fetch = defaultFetch
): Promise<boolean> {
  try {
    // 1. Idempotency: skip if any active (proposed or sent) invoice already exists.
    //    proposed covers the HITL case where the floor held last sweep — avoids
    //    a new LLM call + duplicate proposed row every 15 min until the owner acts.
    if (await store.hasActiveInvoice(thread.id)) return true;

    // 1b. Backoff: a recent FAILED invoice suppresses re-proposal so a persistently-
    //     failing thread isn't re-attempted (LLM + draft) every sweep until cooldown.
    const failedSince = new Date(Date.now() - FAILED_INVOICE_BACKOFF_MS).toISOString();
    if (await store.hasRecentFailedInvoice(thread.id, failedSince)) return true;

    // 2. Build conversation and call proposeInvoice.
    const got = await store.getThreadWithMessages(thread.id);
    if (!got) return false;
    const conversation = got.messages.filter((m) => m.direction === 'inbound').map((m) => m.body_text ?? '').join('\n\n---\n\n');
    const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
    const proposal = await proposeInvoice(llm, store, cfg, {
      subject: thread.subject ?? '',
      conversation,
      category: thread.primary_category ?? 'other'
    });
    if (!proposal) return false;        // LLM failure — degrade to reply path
    if (!proposal.isInvoiceMoment) return false; // Not a buying moment — reply instead

    // 3. Admin scope gate: need write_draft_orders.
    const tenant = await store.getTenant();
    const admin = await adminForShop(env, store, fetchImpl);
    if (!admin || !hasScope(tenant?.scopes, 'write_draft_orders')) {
      await store.insertInvoice({
        threadId: thread.id,
        lineItems: [],
        total: 0,
        currency: 'GBP',
        coverText: proposal.coverText,
        confidence: proposal.confidence,
        holdReasons: ['reconnect_required'],
        status: 'proposed'
      });
      return true; // handled — do not fall through to reply
    }

    // 4. Resolve each lineRequest via the catalog.
    const resolvedItems: InvoiceLineItem[] = [];
    let allResolved = true;
    let quantitiesWithinCaps = true;
    for (const req of proposal.lineRequests) {
      const result = await resolveLineRequest(admin, req.query);
      if (result.status === 'resolved' && result.variant) {
        resolvedItems.push({
          variantId: result.variant.variantId,
          sku: result.variant.sku,
          title: result.variant.title || result.variant.variantTitle,
          qty: req.qty,
          priceGbp: result.variant.priceGbp
        });
        // Inventory-aware qty cap: never auto-invoice more than is in stock, bounded by a
        // hard backstop. availableQty<=0 = untracked/unknown (the variant already passed
        // the availableForSale filter) → fall back to the hard cap rather than block.
        const tracked = result.variant.availableQty;
        const cap = tracked > 0 ? Math.min(tracked, HARD_INVOICE_QTY_CAP) : HARD_INVOICE_QTY_CAP;
        if (req.qty < 1 || req.qty > cap) quantitiesWithinCaps = false;
      } else {
        allResolved = false;
        // Unresolved line requests are omitted from resolvedItems; allResolved=false
        // causes invoiceSendDecision to hold the invoice for HITL review.
      }
    }

    const rawTotal = resolvedItems.reduce((sum, li) => sum + li.priceGbp * li.qty, 0);
    const total = Math.round(rawTotal * 100) / 100;

    // 4b. Guard: if catalog resolved nothing, force hold — never call createDraftOrder with empty items.
    const noResolvedItems = resolvedItems.length === 0 || total <= 0;

    // 5. Floor decision.
    const sinceIso = new Date(Date.now() - 86400_000).toISOString();
    const recent = await store.recentInvoiceCount(thread.id, sinceIso);
    const decision = invoiceSendDecision({
      autoInvoice: cfg.inbox.autoInvoice,
      confidence: proposal.confidence,
      threshold: cfg.inbox.invoiceConfidenceThreshold,
      total,
      ceiling: cfg.inbox.invoiceValueCeiling,
      category: thread.primary_category ?? 'other',
      allResolved,
      quantitiesWithinCaps,
      recentInvoiceCount: recent,
      rateLimit: cfg.inbox.invoiceRateLimit
    });

    // 6. Insert invoice row (proposed). Merge no_resolved_items into holdReasons when blocked.
    const finalHoldReasons = noResolvedItems
      ? [...decision.holdReasons, ...(!decision.holdReasons.includes('no_resolved_items') ? ['no_resolved_items'] : [])]
      : decision.holdReasons;
    const invoiceId = await store.insertInvoice({
      threadId: thread.id,
      lineItems: resolvedItems,
      total,
      currency: 'GBP',
      coverText: proposal.coverText,
      confidence: proposal.confidence,
      holdReasons: finalHoldReasons,
      status: 'proposed'
    });

    // 7. If floor passes AND we have items: create draft order + send invoice. Else leave proposed for HITL.
    //    sendInvoice internally flips the invoice to 'sent' and the thread to
    //    'awaiting_customer', so the local path intentionally does not call
    //    setInvoiceStatus('sent') after a successful send.
    const create = decision.create && !noResolvedItems;
    if (create) {
      try {
        const draft = await createDraftOrder(admin, {
          email: thread.contact_email,
          lineItems: resolvedItems.map((li) => ({ variantId: li.variantId, quantity: li.qty })),
          pawscoutInvoiceId: invoiceId
        });
        await store.setInvoiceStatus(invoiceId, 'proposed', {
          draftOrderId: draft.draftOrderId,
          invoiceUrl: draft.invoiceUrl
        });
        const inv = await store.getInvoice(invoiceId);
        if (inv) {
          const res = await sendInvoice(env, store, thread, inv, fetchImpl);
          if (!res.ok) await store.setInvoiceStatus(invoiceId, 'failed');
        }
      } catch (e) {
        console.warn(`inbox invoice send failed for thread ${thread.id}: ${(e as Error).message}`);
        await store.setInvoiceStatus(invoiceId, 'failed');
      }
    }
    // Else: floor held; invoice stays `proposed` for HITL review.

    return true;
  } catch (e) {
    // Defensive: never let a proposal error abort the shop's sweep.
    console.warn(`inbox proposeInvoiceOne failed for thread ${thread.id}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Build and persist a fresh PENDING draft for a thread — conversation → optional
 * freight line → LLM draft → compose → insert. Returns the new draftId and
 * whether the sweep should auto-send it, or null if there is nothing to draft /
 * the LLM is unavailable. NEVER sends (the caller decides). Shared by the nightly
 * sweep (which may then auto-send) and the manual Regenerate action (which never
 * does), so both paths produce drafts identically.
 */
export async function composeDraftForThread(
  env: Env, store: TenantStore, cfg: TenantConfig, thread: ThreadRow, fetchImpl: typeof fetch = defaultFetch
): Promise<{ draftId: string; send: boolean } | null> {
  const got = await store.getThreadWithMessages(thread.id);
  if (!got) return null;

  // Partnership/affiliate funnel intercept — supersedes the generic drafter for lane threads.
  const partnership = await maybePartnershipDraft(env, store, cfg, thread, got, fetchImpl);
  if (partnership) return partnership;

  const conversation = got.messages.filter((m) => m.direction === 'inbound').map((m) => m.body_text ?? '').join('\n\n---\n\n');

  // Freight-grounded delivery line: when the customer asks about shipping to a
  // confidently-derived destination, read the SYNCED CJ logistics matrix from D1
  // (no live CJ call) and append a time-only line deterministically (the LLM never
  // emits the figure). Resilient — a missing/stale row or ambiguous destination
  // leaves shippingLine null and the drafter keeps its safe hedge.
  const shippingLine = await buildShippingLineForThread(store, cfg, thread, conversation);

  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
  const contact = await store.getContactByEmail(thread.contact_email);
  const draft = await draftReply(llm, store, cfg, {
    subject: thread.subject ?? '', conversation, category: thread.primary_category ?? 'other',
    shippingHandledSeparately: !!shippingLine, customerName: contact?.name ?? null
  });
  if (!draft) return null; // degrade: retry next sweep

  // Auto-send gating is computed on the LLM body ONLY (not the appended freight
  // line) so the trusted worker figure doesn't itself trip mentionsMoney. The
  // freight line is a PROXY estimate, so when present we force HITL review (see
  // composeDeliveryDraft) until the figure is trusted in practice.
  const sinceIso = new Date(Date.now() - 86400_000).toISOString();
  const recentAutoCount = await store.recentAutoSendCount(thread.contact_email, sinceIso);
  const decision = autoSendDecision({
    autosend: cfg.inbox.autosend, confidence: draft.confidence, threshold: cfg.inbox.autoConfidenceThreshold,
    quotesPriceOrOrder: draft.quotesPriceOrOrder, bodyText: draft.bodyText, category: thread.primary_category ?? 'other', recentAutoCount
  });
  const composed = composeDeliveryDraft(draft, shippingLine);
  const draftId = await store.insertDraft({
    threadId: thread.id, bodyText: composed.bodyText, bodyHtml: renderReplyHtml(composed.bodyText),
    confidence: draft.confidence, quotesPriceOrder: composed.quotesPriceOrder,
    holdReasons: decision.holdReasons, model: (resolveChain(cfg, 'text')[0] as { models: string[] }).models[0], status: 'pending'
  });
  // A proxy freight figure always gets human review, even under Auto.
  return { draftId, send: decision.send && !shippingLine };
}

async function draftOne(env: Env, store: TenantStore, cfg: TenantConfig, thread: ThreadRow, fetchImpl: typeof fetch): Promise<void> {
  const r = await composeDraftForThread(env, store, cfg, thread, fetchImpl);
  if (!r) return;
  if (r.send) {
    const draftRow = await store.getDraft(r.draftId);
    if (draftRow) await sendReply(env, store, cfg, thread, draftRow, undefined, fetchImpl);
  }
}

/**
 * Combine the LLM draft with an optional worker-computed freight line into the
 * final reply body + the money-hold flag. PURE (no I/O) so the deliberate
 * decisions are unit-testable:
 *  - the trusted, claim-safe freight figure is appended AFTER the LLM body and is
 *    NOT fed into mentionsMoney — only the LLM body can trip the money-hold;
 *  - quotesPriceOrder still becomes true when a freight line is present, so the
 *    draft is flagged as quoting a figure (and held for review under Auto).
 */
export function composeDeliveryDraft(
  draft: { bodyText: string; quotesPriceOrOrder: boolean },
  shippingLine: string | null
): { bodyText: string; quotesPriceOrder: boolean } {
  const llmQuotes = draft.quotesPriceOrOrder || mentionsMoney(draft.bodyText);
  if (!shippingLine) return { bodyText: draft.bodyText, quotesPriceOrder: llmQuotes };
  return {
    bodyText: `${draft.bodyText.trimEnd()}\n\n${shippingLine}`,
    // The line is ours (trusted) and time-only, but it IS a worker-computed figure —
    // flag it so the draft is reviewed before sending (HITL is also forced upstream
    // while the door-to-door model is unvalidated against real fulfilment data).
    quotesPriceOrder: true
  };
}

/**
 * Resolve a real CJ freight line for the thread's destination, or null. Fully
 * guarded: never throws and never blocks the draft. Returns null fast when the
 * enquiry isn't shipping-related, the destination is ambiguous/GB, CJ isn't
 * connected, or the lookup fails.
 */
async function buildShippingLineForThread(
  store: TenantStore, cfg: TenantConfig, thread: ThreadRow, conversation: string
): Promise<string | null> {
  try {
    const subject = thread.subject ?? '';
    if (!isShippingIntent(thread.primary_category, subject, conversation)) return null;
    const country = deriveDestinationCountry(conversation, subject, thread.contact_email);
    if (!country) return null; // ambiguous/unknown destination → safe hedge
    const l = resolveLogistics(cfg.fulfil);
    // Origin is CN for this catalog; the freshness-gated accessor returns null when
    // the matrix row is missing or stale, so doorToDoorBand → null → safe hedge.
    const route = await store.getLogisticsRoute('CN', country, l.stalenessHours);
    return buildShippingLine(countryLabel(country), doorToDoorBand(route, l));
  } catch (e) {
    console.warn(`inbox shipping-line resolve failed for ${thread.id}: ${(e as Error).message}`);
    return null;
  }
}
