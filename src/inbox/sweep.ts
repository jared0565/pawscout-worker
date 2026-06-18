import type { Env, TenantConfig } from '../types';
import { TenantStore, listActiveShops } from '../tenant-store';
import { LlmClient } from '../llm';
import { sendEmail } from '../email';
import { defaultFetch } from '../safe-fetch';
import { parseAuthResults } from './gates';
import { classifyEmail, decideDisposition } from './classify';
import { draftReply, renderReplyHtml } from './draft';
import { autoSendDecision, mentionsMoney } from './autosend';
import { sendReply } from './send';
import type { ThreadRow } from './types';

const SWEEP_BATCH = 15;          // threads classified per shop per run
const FROM = 'Active Paw <support@activepaw.co.uk>';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
  const llm = new LlmClient(env.OPENROUTER_API_KEY, fetchImpl);
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
        await draftOne(env, store, cfg, thread, fetchImpl);
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
  const llm = new LlmClient(env.OPENROUTER_API_KEY, fetchImpl);

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
  if (d.alert) await maybeAlertOwner(env, cfg, shop, thread, c.summary, fetchImpl);
}

async function draftOne(env: Env, store: TenantStore, cfg: TenantConfig, thread: ThreadRow, fetchImpl: typeof fetch): Promise<void> {
  const got = await store.getThreadWithMessages(thread.id);
  if (!got) return;
  const conversation = got.messages.filter((m) => m.direction === 'inbound').map((m) => m.body_text ?? '').join('\n\n---\n\n');
  const llm = new LlmClient(env.OPENROUTER_API_KEY, fetchImpl);
  const draft = await draftReply(llm, store, cfg, { subject: thread.subject ?? '', conversation, category: thread.primary_category ?? 'other' });
  if (!draft) return; // degrade: retry next sweep

  const sinceIso = new Date(Date.now() - 86400_000).toISOString();
  const recentAutoCount = await store.recentAutoSendCount(thread.contact_email, sinceIso);
  const decision = autoSendDecision({
    autosend: cfg.inbox.autosend, confidence: draft.confidence, threshold: cfg.inbox.autoConfidenceThreshold,
    quotesPriceOrOrder: draft.quotesPriceOrOrder, bodyText: draft.bodyText, category: thread.primary_category ?? 'other', recentAutoCount
  });
  const draftId = await store.insertDraft({
    threadId: thread.id, bodyText: draft.bodyText, bodyHtml: renderReplyHtml(draft.bodyText),
    confidence: draft.confidence, quotesPriceOrder: draft.quotesPriceOrOrder || mentionsMoney(draft.bodyText),
    holdReasons: decision.holdReasons, model: cfg.inbox.replyModel || cfg.llm.model, status: 'pending'
  });
  if (decision.send) {
    const draftRow = await store.getDraft(draftId);
    if (draftRow) await sendReply(env, store, cfg, thread, draftRow, undefined, fetchImpl);
  }
}

/** One short high-signal nudge to the owner's Gmail (never per-enquiry noise). */
export async function maybeAlertOwner(env: Env, cfg: TenantConfig, shop: string, thread: ThreadRow, summary: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
  const to = cfg.inbox.alertEmail || cfg.fulfil.alertEmail;
  if (!to || !env.RESEND_API_KEY) return;
  const consoleUrl = `${env.SHOPIFY_APP_URL}/app`;
  await sendEmail(env.RESEND_API_KEY, {
    from: FROM,
    to,
    subject: `🔥 Hot lead: ${thread.contact_email}`,
    text: `${summary}\n\nFrom: ${thread.contact_email}\nSubject: ${thread.subject ?? '(none)'}\n\nReview & reply in PawScout: ${consoleUrl}`,
    html: `<p><strong>${escapeHtml(summary)}</strong></p><p>From: ${escapeHtml(thread.contact_email)}<br>Subject: ${escapeHtml(thread.subject ?? '(none)')}</p><p><a href="${escapeHtml(consoleUrl)}">Review &amp; reply in PawScout →</a></p>`
  }, fetchImpl);
}
