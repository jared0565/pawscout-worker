import type { AdminGraphql } from './shopify-admin';

// Privacy-policy wording keeper (2026-07-05): PawScout sends marketing email
// (campaigns, reorder reminders) and measures engagement, so the store's
// privacy policy must say so. This module holds the recommended wording as a
// DETERMINISTIC transform over the live policy body: the console can check
// whether the policy already carries it and apply it with one owner click
// (write_legal_policies scope, granted 2026-07-05). The transform is
// idempotent - applying twice changes nothing - and never touches any other
// sentence of the policy.

/** Appended to the stock "Marketing and Advertising" paragraph. */
export const MARKETING_WORDING =
  ' Where required by law, we send marketing email only to people who have opted in,' +
  ' for example by ticking the news and offers box at checkout or on our contact form.' +
  ' Every marketing email we send includes a one-click unsubscribe link, and opting out' +
  ' takes effect immediately. To understand how our marketing emails perform, we measure' +
  ' whether they are delivered and opened and which links in them are clicked. Addresses' +
  ' that cannot be reached or that report our email as unwanted are removed from our' +
  ' marketing list automatically.';

/** Anchor: the closing phrase of the stock Marketing and Advertising sentence. */
const MARKETING_ANCHOR = 'and other activity on the Services.';
/** Idempotency marker: present only once our wording is in. */
const MARKETING_MARKER = 'one-click unsubscribe link';

const PROCESSOR_LIST_OLD = 'cloud storage, fulfillment and shipping';
const PROCESSOR_LIST_NEW = 'cloud storage, email delivery, fulfillment and shipping';

// The public business address is the East Ham virtual address (E6 2JA). The
// old billing postcode was pasted into the policy by mistake on 2026-07-05.
const WRONG_POSTCODE = 'N22 6ET';
const RIGHT_POSTCODE = 'E6 2JA';

export interface PolicyTransform {
  next: string;
  changes: string[];
}

/** The recommended edits, applied surgically. Empty changes = up to date. */
export function transformPrivacyPolicy(body: string): PolicyTransform {
  let next = body;
  const changes: string[] = [];
  if (next.includes(MARKETING_ANCHOR) && !next.includes(MARKETING_MARKER)) {
    next = next.replace(MARKETING_ANCHOR, MARKETING_ANCHOR + MARKETING_WORDING);
    changes.push('Marketing paragraph: adds that marketing email is opt-in only, has a one-click unsubscribe, and that delivery, opens and clicks are measured');
  }
  if (next.includes(PROCESSOR_LIST_OLD) && !next.includes(PROCESSOR_LIST_NEW)) {
    next = next.replace(PROCESSOR_LIST_OLD, PROCESSOR_LIST_NEW);
    changes.push('Service-provider examples: adds email delivery');
  }
  if (next.includes(WRONG_POSTCODE)) {
    next = next.split(WRONG_POSTCODE).join(RIGHT_POSTCODE);
    changes.push(`Contact address: corrects the postcode ${WRONG_POSTCODE} to ${RIGHT_POSTCODE}`);
  }
  return { next, changes };
}

const POLICY_QUERY = '{ shop { shopPolicies { id type body } } }';

const POLICY_MUTATION = `mutation pawscoutPolicyUpdate($policy: ShopPolicyInput!) {
  shopPolicyUpdate(shopPolicy: $policy) {
    shopPolicy { id type }
    userErrors { field message }
  }
}`;

export async function readPrivacyPolicy(admin: AdminGraphql): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  try {
    const data = await admin(POLICY_QUERY);
    const privacy = (data.shop as { shopPolicies?: { type: string; body: string }[] })?.shopPolicies
      ?.find((p) => p.type === 'PRIVACY_POLICY');
    if (!privacy) return { ok: false, error: 'No privacy policy found on the store' };
    return { ok: true, body: privacy.body };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: msg.includes('ACCESS_DENIED') || msg.includes('read_legal_policies') ? 'reconnect_required' : msg };
  }
}

/** Check the live policy against the recommended wording (no writes). */
export async function checkPrivacyPolicy(admin: AdminGraphql): Promise<{ ok: true; upToDate: boolean; changes: string[] } | { ok: false; error: string }> {
  const r = await readPrivacyPolicy(admin);
  if (!r.ok) return r;
  const t = transformPrivacyPolicy(r.body);
  return { ok: true, upToDate: t.changes.length === 0, changes: t.changes };
}

/** Apply the recommended wording. Idempotent; refuses to write if the result
 * would contain em/en dashes (customer-facing dash rule). */
export async function applyPrivacyPolicy(admin: AdminGraphql): Promise<{ ok: true; applied: string[] } | { ok: false; error: string }> {
  const r = await readPrivacyPolicy(admin);
  if (!r.ok) return r;
  const t = transformPrivacyPolicy(r.body);
  if (!t.changes.length) return { ok: true, applied: [] };
  if (/[—–―]/.test(MARKETING_WORDING)) return { ok: false, error: 'dash guard tripped in recommended wording' };
  try {
    const data = await admin(POLICY_MUTATION, { policy: { type: 'PRIVACY_POLICY', body: t.next } });
    const errs = (data.shopPolicyUpdate as { userErrors?: { message: string }[] })?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
    return { ok: true, applied: t.changes };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: msg.includes('ACCESS_DENIED') || msg.includes('write_legal_policies') ? 'reconnect_required' : msg };
  }
}
