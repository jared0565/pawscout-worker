import type { AdminGraphql } from './shopify-admin';
import type { TenantStore, CampaignRow } from './tenant-store';
import type { Env, TenantConfig } from './types';
import { sendEmail } from './email';
import { renderReplyHtml, sanitizeOutbound } from './inbox/draft';
import { signUnsubToken } from './retention';
import { defaultFetch } from './safe-fetch';

// Campaigns (2026-07-05): owner-composed marketing broadcasts. Compliance is
// enforced by code, not memory:
// - Buyers are resolved LIVE from Shopify at send time, filtered to
//   emailMarketingConsent SUBSCRIBED (the checkout "news and offers" opt-in).
//   We never keep a copy that could go stale against a Shopify-side opt-out.
// - Partners are active affiliate_partners who explicitly opted in
//   (marketing_consent, flipped by the owner in the Partners view).
// - Every email carries the shared HMAC one-click unsubscribe (same
//   suppression list as reorder reminders) + RFC 8058 headers, an identified
//   sender, and the business postal address (CAN-SPAM readiness).
// - campaign_sends is the ledger: one row per actual send, so re-running a
//   partially-sent campaign resumes instead of double-sending.
// - Sending is owner-clicked HITL only; nothing broadcasts from a cron.

export type CampaignAudience = 'buyers' | 'partners';
export const CAMPAIGN_AUDIENCES: readonly CampaignAudience[] = ['buyers', 'partners'];

// Lifecycle (2026-07-06): draft -> sending -> sent, with two owner controls on
// the way: paused (resumable, /send refuses until Resume) and cancelled
// (terminal; the ledger stays so already-sent recipients are visible, and the
// campaign can be duplicated as a fresh draft). Drafts alone are editable.
export const CAMPAIGN_STATUSES = ['draft', 'sending', 'paused', 'sent', 'cancelled'] as const;

/** Why this campaign cannot send right now, or null when it can. */
export function campaignSendBlock(status: string): string | null {
  if (status === 'sent') return 'This campaign has already been sent';
  if (status === 'cancelled') return 'This campaign was stopped. Duplicate it to send again';
  if (status === 'paused') return 'This campaign is paused - click Resume to continue';
  return null;
}

/** Per-click send cap: keeps one console request comfortably short; the
 * browser auto-continues while the engine reports work remaining. */
export const CAMPAIGN_BATCH_MAX = 25;
/** Resend's default rate limit is 2 req/s; pace sends well inside it. */
export const CAMPAIGN_SEND_GAP_MS = 600;

const BUYERS_FROM = 'Active Paw <support@activepaw.co.uk>';
const PARTNERS_FROM = 'Active Paw Partnerships <sales@activepaw.co.uk>';

export function campaignFromAddress(audience: CampaignAudience): string {
  return audience === 'partners' ? PARTNERS_FROM : BUYERS_FROM;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Audience resolution ---

const BUYERS_QUERY = `query pawscoutCampaignBuyers($cursor: String) {
  customers(first: 100, after: $cursor, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { email emailMarketingConsent { marketingState } }
  }
}`;

interface RawCustomer { email?: string | null; emailMarketingConsent?: { marketingState?: string } | null }

/** Marketing-consented buyer emails, live from Shopify. The consent FIELD is
 * the truth (never a search-index filter): only SUBSCRIBED passes - pending,
 * unsubscribed, redacted and null all fail closed. Lowercased + deduped. */
export async function fetchSubscribedBuyers(admin: AdminGraphql, maxPages = 10): Promise<string[]> {
  const out = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await admin(BUYERS_QUERY, { cursor });
    const conn = data.customers as { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: RawCustomer[] } | undefined;
    for (const cst of conn?.nodes ?? []) {
      if (!cst.email) continue;
      if (cst.emailMarketingConsent?.marketingState !== 'SUBSCRIBED') continue;
      out.add(cst.email.trim().toLowerCase());
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return [...out];
}

/** The campaign's recipient list. buyers needs a live Admin client; partners
 * reads the opted-in active partners from D1. */
export async function resolveCampaignAudience(
  store: TenantStore, admin: AdminGraphql | null, audience: CampaignAudience
): Promise<{ ok: true; emails: string[] } | { ok: false; error: string }> {
  if (audience === 'partners') {
    return { ok: true, emails: await store.listConsentingPartnerEmails() };
  }
  if (!admin) return { ok: false, error: 'Shopify connection unavailable - cannot read buyer marketing consent' };
  return { ok: true, emails: await fetchSubscribedBuyers(admin) };
}

// --- Email build ---

/** One campaign email: owner body (sanitized) + deterministic compliance
 * footer - identified sender, business postal address, one-click unsubscribe. */
export function buildCampaignEmail(opts: {
  to: string; subject: string; bodyText: string; unsubUrl: string;
  postalAddress: string; audience: CampaignAudience; testTag?: boolean;
}): { to: string; subject: string; html: string; text: string; from: string; headers: Record<string, string> } {
  const body = sanitizeOutbound(opts.bodyText).trim();
  const subject = sanitizeOutbound(opts.testTag ? `[Test] ${opts.subject}` : opts.subject);
  const postal = sanitizeOutbound(opts.postalAddress).trim();
  const text =
    `${body}\n\n- The Active Paw team\n\n` +
    `Active Paw, ${postal}\n` +
    `Unsubscribe from marketing emails: ${opts.unsubUrl}\n`;
  const html =
    renderReplyHtml(body) +
    `\n<p>- The Active Paw team</p>` +
    `\n<p style="font-size:12px;color:#888">Active Paw, ${escapeHtml(postal)}<br>` +
    `<a href="${opts.unsubUrl}">Unsubscribe</a> from marketing emails.</p>`;
  return {
    to: opts.to, subject, html, text,
    from: campaignFromAddress(opts.audience),
    headers: { 'List-Unsubscribe': `<${opts.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  };
}

async function unsubUrlFor(env: Env, shop: string, email: string): Promise<string> {
  const token = await signUnsubToken(shop, email, env.SHOPIFY_API_SECRET);
  return `${env.SHOPIFY_APP_URL}/unsubscribe?shop=${encodeURIComponent(shop)}&email=${encodeURIComponent(email)}&token=${token}`;
}

// --- Send ---

export interface CampaignBatchResult {
  ok: true;
  total: number;      // deduped audience size
  sent: number;       // sends that succeeded THIS batch
  already: number;    // in the ledger from earlier batches
  suppressed: number; // on the unsubscribe list - never sent
  failed: number;     // send errors this batch (retryable on the next click)
  remaining: number;  // still to send after this batch
  status: string;     // campaign status after this batch
}

/**
 * Send (or resume) one campaign in a bounded batch. Suppression and the
 * per-campaign ledger are checked per recipient at send time; the campaign
 * flips to 'sent' only when nothing remains. Failures are not recorded in the
 * ledger, so the next batch retries them.
 */
export async function sendCampaignBatch(
  env: Env, store: TenantStore, campaign: CampaignRow, recipients: string[], postalAddress: string,
  opts: { now?: number; fetchImpl?: typeof fetch; batchMax?: number; sendGapMs?: number } = {}
): Promise<CampaignBatchResult | { ok: false; error: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY secret not set on the Worker' };
  if (!postalAddress.trim()) return { ok: false, error: 'Business postal address required before sending' };
  const audience = campaign.audience as CampaignAudience;
  if (!CAMPAIGN_AUDIENCES.includes(audience)) return { ok: false, error: `Unknown audience ${campaign.audience}` };

  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const batchMax = opts.batchMax ?? CAMPAIGN_BATCH_MAX;
  const gap = opts.sendGapMs ?? CAMPAIGN_SEND_GAP_MS;
  const nowIso = new Date(opts.now ?? Date.now()).toISOString();
  const emails = [...new Set(recipients.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))];

  let sent = 0, already = 0, suppressed = 0, failed = 0, remaining = 0;
  for (const email of emails) {
    if (await store.hasCampaignSend(campaign.id, email)) { already++; continue; }
    if (await store.isEmailUnsubscribed(email)) { suppressed++; continue; }
    if (sent + failed >= batchMax) { remaining++; continue; }
    const msg = buildCampaignEmail({
      to: email, subject: campaign.subject, bodyText: campaign.body_text,
      unsubUrl: await unsubUrlFor(env, store.shop, email), postalAddress, audience
    });
    // Tags round-trip inside every Resend webhook event, so an open/click/bounce
    // finds its campaign again without us storing anything per-recipient extra.
    const r = await sendEmail(env.RESEND_API_KEY, {
      ...msg, tags: [{ name: 'kind', value: 'campaign' }, { name: 'campaign_id', value: campaign.id }]
    }, fetchImpl);
    if (r.ok) {
      await store.recordCampaignSend(campaign.id, email, nowIso, r.id);
      sent++;
    } else {
      console.warn(`campaign ${campaign.id} send failed for ${email}: ${r.error}`);
      failed++;
    }
    if (gap > 0) await new Promise((res) => setTimeout(res, gap));
  }

  remaining += failed; // failures stay sendable on the next batch
  const status = remaining === 0 ? 'sent' : 'sending';
  await store.updateCampaignProgress(campaign.id, {
    recipientCount: emails.length - suppressed,
    sentDelta: sent,
    status,
    sentAt: remaining === 0 ? nowIso : null
  });
  return { ok: true, total: emails.length, sent, already, suppressed, failed, remaining, status };
}

/** Test send to the owner: the EXACT production email ([Test] subject aside),
 * including the real unsubscribe link and footer. Never touches the ledger. */
export async function sendCampaignTest(
  env: Env, store: TenantStore, campaign: CampaignRow, to: string, postalAddress: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY secret not set on the Worker' };
  if (!postalAddress.trim()) return { ok: false, error: 'Business postal address required before sending' };
  const msg = buildCampaignEmail({
    to, subject: campaign.subject, bodyText: campaign.body_text,
    unsubUrl: await unsubUrlFor(env, store.shop, to.toLowerCase()),
    postalAddress, audience: campaign.audience as CampaignAudience, testTag: true
  });
  // kind=campaign_test keeps owner previews OUT of the campaign's engagement stats.
  const r = await sendEmail(env.RESEND_API_KEY, {
    ...msg, tags: [{ name: 'kind', value: 'campaign_test' }, { name: 'campaign_id', value: campaign.id }]
  }, fetchImpl);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// --- Console API helpers (wired in index.ts) ---

export function validateCampaignPayload(body: unknown): { ok: true; value: { audience: CampaignAudience; subject: string; bodyText: string } } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.audience !== 'string' || !CAMPAIGN_AUDIENCES.includes(b.audience as CampaignAudience)) {
    return { ok: false, error: 'audience must be buyers or partners' };
  }
  const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
  if (!subject || subject.length > 150) return { ok: false, error: 'subject required (up to 150 chars)' };
  const bodyText = typeof b.bodyText === 'string' ? b.bodyText.trim() : '';
  if (bodyText.length < 10 || bodyText.length > 5000) return { ok: false, error: 'bodyText must be 10 to 5000 chars' };
  return { ok: true, value: { audience: b.audience as CampaignAudience, subject, bodyText } };
}

export function campaignForUi(r: CampaignRow) {
  return {
    id: r.id, audience: r.audience, subject: r.subject, bodyText: r.body_text,
    status: r.status, recipientCount: r.recipient_count, sentCount: r.sent_count,
    createdAt: r.created_at, sentAt: r.sent_at
  };
}

/** The owner's test-send default: the alert address they already gave us. */
export function ownerTestAddress(cfg: TenantConfig): string | null {
  return cfg.inbox.alertEmail ?? cfg.fulfil.alertEmail ?? null;
}
