// Monthly affiliate-payout reminder (2026-07-14). The partner-facing copy
// promises cleared commission is "paid out monthly", but the payout itself is a
// manual owner action (createAffiliatePayout runs only from the console). To
// keep that promise honest without auto-marking unsent money as paid, this
// fires once a month and emails the owner what has CLEARED and is awaiting
// payout - a prompt, not an automatic transfer. Owner-facing internal email
// only; it never sends anything to a partner and never records a payout.
import type { Env } from './types';
import { TenantStore, listActiveShops } from './tenant-store';
import { sendEmail } from './email';
import { sanitizeOutbound } from './inbox/draft';
import { defaultFetch } from './safe-fetch';
import { COMMISSION_CLEARANCE_DAYS } from './types';

/** No-op except on the 1st of the month (UTC), and except when a shop actually
 *  has cleared, unpaid commission. `nowMs` and `fetchImpl` are injectable for
 *  tests; production passes neither (daily cron). Never throws past a shop -
 *  one shop's failure must not abort the others. */
export async function maybeAffiliatePayoutReminder(
  env: Env, nowMs: number = Date.now(), fetchImpl: typeof fetch = defaultFetch
): Promise<void> {
  if (new Date(nowMs).getUTCDate() !== 1) return; // monthly cadence, on the 1st
  if (!env.RESEND_API_KEY) return;
  for (const shop of await listActiveShops(env.DB)) {
    try {
      const store = new TenantStore(env.DB, shop);
      const cfg = await store.getConfig();
      if (!cfg) continue;
      const to = cfg.inbox.alertEmail || cfg.fulfil.alertEmail;
      if (!to) continue;
      // Same cutoff as the payout/console/portal (server-side, injectable now).
      const cleared = (await store.listAffiliateVouchers(nowMs)).filter((v) => v.owed_cleared > 0);
      if (!cleared.length) continue;
      const total = Math.round(cleared.reduce((s, v) => s + v.owed_cleared, 0) * 100) / 100;
      const lines = cleared
        .map((v) => `- ${v.name || v.contact_email} (${v.code}): GBP ${v.owed_cleared.toFixed(2)}`)
        .join('\n');
      await sendEmail(env.RESEND_API_KEY, {
        from: 'Active Paw <support@activepaw.co.uk>',
        to,
        subject: sanitizeOutbound(`Affiliate payouts due: GBP ${total.toFixed(2)} cleared`),
        text: sanitizeOutbound(
          `Cleared affiliate commission awaiting payout (orders past the ${COMMISSION_CLEARANCE_DAYS}-day return-window hold):\n\n${lines}\n\nTotal cleared: GBP ${total.toFixed(2)}.\n\nSend each partner their payment, then record it in Console -> Partners so the ledger stays accurate. Amounts still maturing are not included here.`
        ),
      }, fetchImpl);
    } catch (e) {
      console.warn(`affiliate payout reminder failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
