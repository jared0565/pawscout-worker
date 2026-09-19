import type { AdminGraphql } from './shopify-admin';
import { makeAdminGraphql } from './shopify-admin';
import { defaultFetch } from './safe-fetch';

/** The ONLY list of API-managed topics in the codebase.
 *  CUSTOMERS_REDACT, CUSTOMERS_DATA_REQUEST and SHOP_REDACT are NOT values of
 *  WebhookSubscriptionTopic (checked against the live Admin 2026-04 schema):
 *  they are configured in the app configuration, not through the API, so they
 *  do not belong in this list, and the old registerWebhooks silently failed
 *  on all three at every install. */
export const REQUIRED_TOPICS: readonly { topic: string; path: string }[] = [
  { topic: 'APP_UNINSTALLED', path: '/webhooks/uninstall' },
  { topic: 'ORDERS_PAID', path: '/webhooks/orders-paid' },
  { topic: 'ORDERS_CANCELLED', path: '/webhooks/orders-cancelled' },
  { topic: 'REFUNDS_CREATE', path: '/webhooks/refunds-create' }
];

export const ORDER_EVENT_TOPICS: readonly string[] = ['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'];

export type RegisterResult = { ok: true } | { ok: false; error: string };
export type RegisterWebhook = (shop: string, accessToken: string) => Promise<RegisterResult>;

export interface WebhookStatus {
  ok: boolean; // true when nothing required is missing after the read-back. Can only be true when verified is true.
  verified: boolean; // true when present/missing come from a successful read of the FINAL state:
  // the first list succeeded and nothing needed creating, or the read-back after the creates succeeded.
  // False when the first list threw, or the read-back threw - "unknown" is not "missing".
  present: string[]; // required topics registered at OUR uri
  created: string[]; // topics this call created
  missing: string[]; // required topics still absent after the read-back (or the pre-create list, when unverified)
  errors: string[]; // one message per failed create or list
  checkedAt: string; // ISO time
}

const LIST_QUERY = `query pawscoutHooks { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`;

const CREATE_MUTATION = `mutation pawscoutHook($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    userErrors { message }
    webhookSubscription { id }
  }
}`;

interface ListNode {
  id: string;
  topic: string;
  uri: string;
}

/** Lists every webhook subscription currently registered for the shop. */
export async function listWebhookTopics(admin: AdminGraphql): Promise<{ topic: string; uri: string }[]> {
  const data = await admin(LIST_QUERY);
  const nodes = (data.webhookSubscriptions as { nodes?: ListNode[] } | undefined)?.nodes ?? [];
  return nodes.map((n) => ({ topic: n.topic, uri: n.uri }));
}

function ourUri(appUrl: string, path: string): string {
  return `${appUrl}${path}`;
}

function isOurs(list: { topic: string; uri: string }[], appUrl: string, topic: string, path: string): boolean {
  const uri = ourUri(appUrl, path);
  return list.some((s) => s.topic === topic && s.uri === uri);
}

/** Idempotent webhook assurance: lists what is registered, creates whatever
 *  required topic is missing at our uri, and reports the final state. The
 *  read-back is conditional, not unconditional: when nothing needed
 *  creating, the first list already IS the final state and no
 *  second call is made; only when something needed creating does it list
 *  again and report from that read-back rather than from what the create
 *  calls claimed. Never throws; a failed list or create is recorded in
 *  `errors` and does not stop the remaining topics. */
export async function ensureWebhooks(admin: AdminGraphql, appUrl: string): Promise<WebhookStatus> {
  const baseUrl = appUrl.replace(/\/+$/, '');
  let before: { topic: string; uri: string }[];
  try {
    before = await listWebhookTopics(admin);
  } catch (e) {
    return {
      ok: false,
      verified: false, // nothing is known: the very first read failed
      present: [],
      created: [],
      missing: REQUIRED_TOPICS.map((t) => t.topic),
      errors: [(e as Error).message],
      checkedAt: new Date().toISOString()
    };
  }

  const created: string[] = [];
  const errors: string[] = [];
  let neededCreate = false;

  for (const { topic, path } of REQUIRED_TOPICS) {
    if (isOurs(before, baseUrl, topic, path)) continue;
    neededCreate = true;
    try {
      const data = await admin(CREATE_MUTATION, { topic, uri: ourUri(baseUrl, path) });
      const userErrors =
        (data.webhookSubscriptionCreate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
      const real = userErrors.filter((e) => !/already been taken/i.test(e.message));
      if (real.length) {
        errors.push(real.map((e) => e.message).join('; '));
      } else if (userErrors.length === 0) {
        // A genuine creation: no userErrors at all.
        created.push(topic);
      }
      // Otherwise every userError matched "already been taken": the
      // subscription already exists at this uri. Not an error, but nothing
      // was created either. Whether it ends up `present` is decided by the
      // read-back below, like everything else.
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  // "unknown" is not "missing". When nothing needed
  // creating, the first list already IS the final state - no second call is
  // needed or made, and the state is verified. When something did need
  // creating, only a successful read-back can confirm the final state; a
  // failed read-back falls back to the pre-create snapshot (unchanged from
  // before) but is marked unverified, since what it reports as missing might
  // only be unconfirmed, not actually missing.
  let after = before;
  let verified: boolean;
  if (!neededCreate) {
    verified = true;
  } else {
    try {
      after = await listWebhookTopics(admin);
      verified = true;
    } catch (e) {
      errors.push((e as Error).message);
      verified = false;
    }
  }

  const present = REQUIRED_TOPICS.filter((t) => isOurs(after, baseUrl, t.topic, t.path)).map((t) => t.topic);
  const missing = REQUIRED_TOPICS.map((t) => t.topic).filter((t) => !present.includes(t));

  return {
    ok: verified && missing.length === 0,
    verified,
    present,
    created,
    missing,
    errors,
    checkedAt: new Date().toISOString()
  };
}

/** Kept for /auth/callback: same signature as today, now a thin wrapper over
 *  ensureWebhooks. */
export async function registerWebhooks(
  shop: string,
  accessToken: string,
  appUrl: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<RegisterResult> {
  const admin = makeAdminGraphql(shop, accessToken, fetchImpl);
  const status = await ensureWebhooks(admin, appUrl);
  if (status.ok) return { ok: true };
  return { ok: false, error: `missing: ${status.missing.join(', ')}` };
}
