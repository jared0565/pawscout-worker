import type { Env, TenantConfig } from './types';
import { sendEmail } from './email';
import { sanitizeOutbound } from './inbox/draft';
import { defaultFetch } from './safe-fetch';

/** One plain-text operational email to the owner's alert address
 * (`inbox.alertEmail`, else `fulfil.alertEmail`). Silent without a Resend
 * key or an address; a delivery failure is logged, never thrown, because an
 * alert must not take down the job that raised it. Extracted 2026-09-07 from
 * the affiliate screen so the nightly event rotation can alert through the
 * same door. The inbox's own thread-shaped nudge stays in inbox/alert.ts. */
export async function alertOwner(env: Env, cfg: TenantConfig, subject: string, text: string, fetchImpl: typeof fetch = defaultFetch): Promise<void> {
  const to = cfg.inbox.alertEmail || cfg.fulfil.alertEmail;
  if (!to || !env.RESEND_API_KEY) return;
  const result = await sendEmail(env.RESEND_API_KEY, {
    from: 'Active Paw <support@activepaw.co.uk>', to, subject: sanitizeOutbound(subject), text: sanitizeOutbound(text)
  }, fetchImpl);
  if (!result.ok) console.warn(`[owner-alert] "${subject}" not delivered: ${result.error}`);
}
