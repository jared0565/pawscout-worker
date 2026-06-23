import type { AdminGraphql } from './shopify-admin';
import type { TenantStore } from './tenant-store';
import type { Env, TenantConfig } from './types';
import { sendEmail } from './email';
import { defaultFetch } from './safe-fetch';

// Retention reorder reminders (affiliate 1.3). Gives one-and-done dropship
// purchases a second life so affiliate (and ad) CAC has LTV to pay back against.
// Ships DORMANT (env RETENTION_REORDER_ENABLED) and only ever emails customers
// who are emailMarketingConsent SUBSCRIBED, with an HMAC-signed one-click
// unsubscribe. Deterministic template - no LLM, no prices.

const DAY = 86_400_000;
/** Remind on orders this many days old (≈ a typical consumable refill cycle). */
export const REORDER_WINDOW_DAYS = 45;
/** Width of the daily scan band so each order is seen once as it ages past 45d. */
export const REORDER_BAND_DAYS = 7;
/** Consumable lanes worth a reorder nudge (food/health + cleaning run out). */
export const REORDER_CATEGORIES = ['pet-health', 'pet-cleaning'];
const REORDER_FROM = 'Active Paw <support@activepaw.co.uk>';
const STORE_URL = 'https://activepaw.co.uk';

// --- HMAC-signed unsubscribe token (forge-proof; never expires) ---
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}
/** Token binding a (shop, email) pair - unguessable without SHOPIFY_API_SECRET. */
export function signUnsubToken(shop: string, email: string, secret: string): Promise<string> {
  return hmacHex(`${shop}:${email.toLowerCase()}`, secret);
}
export async function verifyUnsubToken(shop: string, email: string, token: string, secret: string): Promise<boolean> {
  if (!shop || !email || !token) return false;
  return timingSafeEqual(await signUnsubToken(shop, email, secret), token);
}

// --- Candidate selection ---
export interface ReorderOrder {
  id: string;
  email: string;
  createdAt: string;
  marketingState: string;       // emailMarketingConsent.marketingState
  customerLastOrderAt?: string; // customer's most-recent order createdAt
  reorderableTitles: string[];  // titles of reorderable consumable line items
}

/**
 * Pure send/skip decision. Marketing consent is mandatory; we only nudge an
 * order that still contains a reorderable consumable and whose customer has NOT
 * already bought again since (their latest order isn't materially newer).
 */
export function shouldRemind(o: ReorderOrder): { ok: boolean; reason?: string } {
  if (!o.email) return { ok: false, reason: 'no email' };
  if (o.marketingState !== 'SUBSCRIBED') return { ok: false, reason: 'not subscribed' };
  if (!o.reorderableTitles.length) return { ok: false, reason: 'no reorderable items' };
  if (o.customerLastOrderAt && new Date(o.customerLastOrderAt).getTime() > new Date(o.createdAt).getTime() + DAY) {
    return { ok: false, reason: 'reordered since' };
  }
  return { ok: true };
}

const REORDER_QUERY = `query pawscoutReorders($q: String!, $cursor: String) {
  orders(first: 50, query: $q, after: $cursor, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      email
      customer { emailMarketingConsent { marketingState } lastOrder { createdAt } }
      lineItems(first: 25) { nodes { title product { tags } } }
    }
  }
}`;

interface RawOrder {
  id: string; createdAt: string; email?: string | null;
  customer?: { emailMarketingConsent?: { marketingState?: string } | null; lastOrder?: { createdAt?: string } | null } | null;
  lineItems?: { nodes?: { title?: string; product?: { tags?: string[] } | null }[] };
}

/** Fetch paid orders in the window and reduce each to a ReorderOrder. */
export async function fetchReorderCandidates(
  admin: AdminGraphql,
  q: string,
  reorderableTags: string[],
  maxPages = 5
): Promise<ReorderOrder[]> {
  const tagSet = new Set(reorderableTags);
  const out: ReorderOrder[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await admin(REORDER_QUERY, { q, cursor });
    const conn = data.orders as { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: RawOrder[] } | undefined;
    for (const o of conn?.nodes ?? []) {
      const reorderableTitles = (o.lineItems?.nodes ?? [])
        .filter((li) => (li.product?.tags ?? []).some((t) => tagSet.has(t)))
        .map((li) => li.title ?? '')
        .filter(Boolean);
      out.push({
        id: o.id,
        email: o.email ?? '',
        createdAt: o.createdAt,
        marketingState: o.customer?.emailMarketingConsent?.marketingState ?? '',
        customerLastOrderAt: o.customer?.lastOrder?.createdAt ?? undefined,
        reorderableTitles
      });
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

/** Deterministic reorder email with a one-click unsubscribe. No prices/SKUs. */
export function buildReorderEmail(email: string, titles: string[], unsubUrl: string): {
  to: string; subject: string; html: string; text: string; from: string; headers: Record<string, string>;
} {
  const items = titles.slice(0, 3);
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  const subject = 'Running low? Reorder your Active Paw favourites';
  const text =
    `Hi,\n\nA little while ago you picked up ${list} from Active Paw. ` +
    `If you're running low, it might be time to restock so your pet never goes without.\n\n` +
    `Shop again: ${STORE_URL}\n\n` +
    `- The Active Paw team\n\nUnsubscribe from reminders: ${unsubUrl}\n`;
  const html =
    `<p>Hi,</p>` +
    `<p>A little while ago you picked up <strong>${list}</strong> from Active Paw. ` +
    `If you're running low, it might be time to restock so your pet never goes without.</p>` +
    `<p><a href="${STORE_URL}">Shop again</a></p>` +
    `<p>- The Active Paw team</p>` +
    `<p style="font-size:12px;color:#888">Don't want reminders? <a href="${unsubUrl}">Unsubscribe</a>.</p>`;
  return {
    to: email,
    subject,
    html,
    text,
    from: REORDER_FROM,
    headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  };
}

/**
 * Send reorder reminders for orders that aged past the window. Dormant unless
 * the caller has confirmed RETENTION_REORDER_ENABLED + RESEND_API_KEY. Returns
 * the number of reminders actually sent. Each order is reminded at most once
 * (ledger dedup); unsubscribed emails are suppressed.
 */
export async function sendReorderReminders(
  store: TenantStore,
  admin: AdminGraphql,
  cfg: TenantConfig,
  env: Env,
  opts: { now?: number; fetchImpl?: typeof fetch; maxPages?: number } = {}
): Promise<number> {
  if (!env.RESEND_API_KEY) return 0;
  const reorderableTags = REORDER_CATEGORIES.map((c) => cfg.collectionMap[c]?.tag).filter((t): t is string => !!t);
  if (!reorderableTags.length) return 0;

  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const lo = new Date(now - (REORDER_WINDOW_DAYS + REORDER_BAND_DAYS) * DAY).toISOString().slice(0, 10);
  const hi = new Date(now - REORDER_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const q = `financial_status:paid created_at:>=${lo} created_at:<=${hi}`;

  const candidates = await fetchReorderCandidates(admin, q, reorderableTags, opts.maxPages);
  let sent = 0;
  for (const o of candidates) {
    if (!shouldRemind(o).ok) continue;
    const email = o.email.toLowerCase();
    if (await store.hasReorderReminder(o.id)) continue;
    if (await store.isEmailUnsubscribed(email)) continue;

    const token = await signUnsubToken(store.shop, email, env.SHOPIFY_API_SECRET);
    const unsubUrl = `${env.SHOPIFY_APP_URL}/unsubscribe?shop=${encodeURIComponent(store.shop)}&email=${encodeURIComponent(email)}&token=${token}`;
    const msg = buildReorderEmail(email, o.reorderableTitles, unsubUrl);
    const r = await sendEmail(env.RESEND_API_KEY, msg, fetchImpl);
    if (r.ok) {
      await store.recordReorderReminder(o.id, email, new Date(now).toISOString());
      sent++;
    } else {
      console.warn(`reorder reminder send failed for ${o.id}: ${r.error}`);
    }
  }
  return sent;
}
