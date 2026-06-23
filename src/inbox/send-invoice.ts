import type { Env } from '../types';
import type { TenantStore } from '../tenant-store';
import type { ThreadRow, InvoiceRow, InvoiceLineItem } from './types';
import { sendEmail } from '../email';
import { defaultFetch } from '../safe-fetch';

const FROM = 'Active Paw <support@activepaw.co.uk>';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export async function sendInvoice(
  env: Env, store: TenantStore, thread: ThreadRow, invoice: InvoiceRow, fetchImpl: typeof fetch = defaultFetch
): Promise<{ ok: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  if (!invoice.invoice_url) return { ok: false, error: 'invoice has no invoice_url' };

  const items: InvoiceLineItem[] = JSON.parse(invoice.line_items_json);
  const lines = items.map((i) => `${i.qty} × ${i.title} - £${i.priceGbp.toFixed(2)}`).join('\n');
  const cover = (invoice.cover_text ?? '').trim();
  const text = `${cover ? cover + '\n\n' : ''}${lines}\n\nTotal: £${invoice.total.toFixed(2)}\n\nComplete your order securely here:\n${invoice.invoice_url}`;
  const html = `${cover ? `<p>${esc(cover)}</p>` : ''}<ul>${items.map((i) => `<li>${esc(`${i.qty} × ${i.title}`)} - £${i.priceGbp.toFixed(2)}</li>`).join('')}</ul><p><strong>Total: £${invoice.total.toFixed(2)}</strong></p><p><a href="${esc(invoice.invoice_url)}">Complete your order →</a></p>`;

  // Thread to the customer's latest inbound message.
  const got = await store.getThreadWithMessages(thread.id);
  const lastInbound = [...(got?.messages ?? [])].reverse().find((m) => m.direction === 'inbound');
  const subject = (thread.subject ?? '').replace(/^(re:\s*)+/i, '');
  const headers: Record<string, string> = {};
  if (lastInbound?.message_id) { headers['In-Reply-To'] = lastInbound.message_id; headers['References'] = lastInbound.message_id; }

  const r = await sendEmail(env.RESEND_API_KEY, {
    from: FROM, to: thread.contact_email, subject: `Re: ${subject}`.slice(0, 200),
    text, html, headers
  }, fetchImpl);
  if (!r.ok) return { ok: false, error: r.error };

  const sentAt = new Date().toISOString();
  await store.insertOutboundMessage({ threadId: thread.id, messageId: r.messageId, from: 'support@activepaw.co.uk', to: thread.contact_email, subject: `Re: ${subject}`, bodyText: text, bodyHtml: html, sentAt });
  await store.setInvoiceStatus(invoice.id, 'sent', { sentAt });
  await store.setThreadStatus(thread.id, 'awaiting_customer');
  return { ok: true };
}
