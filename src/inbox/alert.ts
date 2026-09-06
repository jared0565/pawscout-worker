import type { Env, TenantConfig } from '../types';
import type { ThreadRow } from './types';
import { sendEmail } from '../email';
import { defaultFetch } from '../safe-fetch';

const FROM = 'Active Paw <support@activepaw.co.uk>';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One short high-signal nudge to the owner's Gmail (never per-enquiry noise). Lives in
 * its own module so both the classify sweep and the partnership funnel can alert without
 * a sweep.ts <-> partnership.ts import cycle. */
export async function maybeAlertOwner(env: Env, cfg: TenantConfig, _shop: string, thread: ThreadRow, summary: string, category?: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
  const to = cfg.inbox.alertEmail || cfg.fulfil.alertEmail;
  if (!to || !env.RESEND_API_KEY) return;
  const consoleUrl = `${env.SHOPIFY_APP_URL}/app`;
  const subject = category === 'affiliate'
    ? `🤝 Affiliate enquiry: ${thread.contact_email}`
    : `🔥 Hot lead: ${thread.contact_email}`;
  await sendEmail(env.RESEND_API_KEY, {
    from: FROM,
    to,
    subject,
    text: `${summary}\n\nFrom: ${thread.contact_email}\nSubject: ${thread.subject ?? '(none)'}\n\nReview & reply in PawScout: ${consoleUrl}`,
    html: `<p><strong>${escapeHtml(summary)}</strong></p><p>From: ${escapeHtml(thread.contact_email)}<br>Subject: ${escapeHtml(thread.subject ?? '(none)')}</p><p><a href="${escapeHtml(consoleUrl)}">Review &amp; reply in PawScout →</a></p>`
  }, fetchImpl);
}
