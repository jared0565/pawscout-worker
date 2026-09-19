import type { Env, TenantConfig } from './types';
import { sendEmail } from './email';
import { sanitizeOutbound } from './inbox/draft';
import { defaultFetch } from './safe-fetch';

/** What happened to one send attempt: 'sent' when the provider accepted it,
 *  'unconfigured' when there is nobody to tell (no alert address or no
 *  Resend key), 'failed' when the provider rejected it or the send itself
 *  threw. A caller that needs to confirm delivery before marking an order's
 *  trail as "the owner was told" reads this instead of assuming success. */
export type AlertResult = 'sent' | 'failed' | 'unconfigured';

/** One plain-text operational email to the owner's alert address
 * (`inbox.alertEmail`, else `fulfil.alertEmail`). Never throws - a delivery
 * failure is logged and answered as 'failed', because an alert must not take
 * down the job that raised it. Extracted 2026-09-07 from the affiliate
 * screen so the nightly event rotation can alert through the same door. The
 * inbox's own thread-shaped nudge stays in inbox/alert.ts. */
export async function alertOwner(env: Env, cfg: TenantConfig, subject: string, text: string, fetchImpl: typeof fetch = defaultFetch): Promise<AlertResult> {
  const to = cfg.inbox.alertEmail || cfg.fulfil.alertEmail;
  if (!to || !env.RESEND_API_KEY) return 'unconfigured';
  let result;
  try {
    result = await sendEmail(env.RESEND_API_KEY, {
      from: 'Active Paw <support@activepaw.co.uk>', to, subject: sanitizeOutbound(subject), text: sanitizeOutbound(text)
    }, fetchImpl);
  } catch (e) {
    console.warn(`[owner-alert] "${subject}" not delivered: ${(e as Error).message}`);
    return 'failed';
  }
  if (!result.ok) {
    console.warn(`[owner-alert] "${subject}" not delivered: ${result.error}`);
    return 'failed';
  }
  return 'sent';
}
