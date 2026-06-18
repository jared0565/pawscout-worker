import type { Env, TenantConfig } from '../types';
import { TenantStore, listActiveShops } from '../tenant-store';
import { LlmClient } from '../llm';
import { sendEmail } from '../email';
import { defaultFetch } from '../safe-fetch';
import { parseAuthResults } from './gates';
import { classifyEmail, decideDisposition } from './classify';
import type { ThreadRow } from './types';

const SWEEP_BATCH = 15;          // threads classified per shop per run
const FROM = 'Active Paw <support@activepaw.co.uk>';

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
    html: `<p><strong>${summary}</strong></p><p>From: ${thread.contact_email}<br>Subject: ${thread.subject ?? '(none)'}</p><p><a href="${consoleUrl}">Review &amp; reply in PawScout →</a></p>`
  }, fetchImpl);
}
