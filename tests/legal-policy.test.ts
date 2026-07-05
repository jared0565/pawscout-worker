import { describe, it, expect } from 'vitest';
import { transformPrivacyPolicy, checkPrivacyPolicy, applyPrivacyPolicy, MARKETING_WORDING } from '../src/legal-policy';
import type { AdminGraphql } from '../src/shopify-admin';

// A minimal stand-in for the stock Shopify template policy, carrying the three
// anchor points the transform targets plus the pasted-postcode mistake.
const STOCK_BODY =
  '<p>We use your personal information for marketing and promotional purposes, ' +
  'including based on items you previously have purchased or added to your cart ' +
  'and other activity on the Services.</p>' +
  '<p>(e.g. IT management, payment processing, data analytics, customer support, ' +
  'cloud storage, fulfillment and shipping)</p>' +
  '<p>Active Paw, 182-184 High Street North, East Ham, London N22 6ET, United Kingdom</p>';

describe('transformPrivacyPolicy', () => {
  it('applies all three recommended edits to the stock policy', () => {
    const t = transformPrivacyPolicy(STOCK_BODY);
    expect(t.changes).toHaveLength(3);
    expect(t.next).toContain('one-click unsubscribe link');
    expect(t.next).toContain('we measure whether they are delivered and opened and which links in them are clicked');
    expect(t.next).toContain('cloud storage, email delivery, fulfillment and shipping');
    expect(t.next).toContain('London E6 2JA');
    expect(t.next).not.toContain('N22 6ET');
  });
  it('is idempotent: a second pass changes nothing', () => {
    const once = transformPrivacyPolicy(STOCK_BODY);
    const twice = transformPrivacyPolicy(once.next);
    expect(twice.changes).toEqual([]);
    expect(twice.next).toBe(once.next);
  });
  it('leaves an unrelated policy body byte-identical', () => {
    const body = '<p>Completely custom policy with no anchors.</p>';
    const t = transformPrivacyPolicy(body);
    expect(t.changes).toEqual([]);
    expect(t.next).toBe(body);
  });
  it('fixes the postcode everywhere it appears', () => {
    const t = transformPrivacyPolicy('a N22 6ET b N22 6ET c');
    expect(t.next).toBe('a E6 2JA b E6 2JA c');
  });
  it('recommended wording carries no em or en dashes', () => {
    expect(/[—–―]/.test(MARKETING_WORDING)).toBe(false);
  });
});

function fakeAdmin(body: string, capture: { mutations: unknown[] } = { mutations: [] }): AdminGraphql {
  return (async (q: string, vars?: Record<string, unknown>) => {
    if (q.includes('shopPolicies')) {
      return { shop: { shopPolicies: [
        { id: 'gid://shopify/ShopPolicy/1', type: 'REFUND_POLICY', body: 'refunds' },
        { id: 'gid://shopify/ShopPolicy/2', type: 'PRIVACY_POLICY', body }
      ] } };
    }
    if (q.includes('shopPolicyUpdate')) {
      capture.mutations.push(vars);
      return { shopPolicyUpdate: { shopPolicy: { id: 'gid://shopify/ShopPolicy/2', type: 'PRIVACY_POLICY' }, userErrors: [] } };
    }
    return {};
  }) as unknown as AdminGraphql;
}

describe('checkPrivacyPolicy / applyPrivacyPolicy', () => {
  it('check reports the missing edits without writing', async () => {
    const capture = { mutations: [] as unknown[] };
    const r = await checkPrivacyPolicy(fakeAdmin(STOCK_BODY, capture));
    expect(r.ok && !r.upToDate && r.changes.length).toBe(3);
    expect(capture.mutations).toHaveLength(0);
  });
  it('check reports up to date once the wording is in', async () => {
    const done = transformPrivacyPolicy(STOCK_BODY).next;
    const r = await checkPrivacyPolicy(fakeAdmin(done));
    expect(r.ok && r.upToDate).toBe(true);
  });
  it('an empty or unrecognized body is NOT up to date - it is unjudgeable', async () => {
    for (const body of ['', '<p>Totally custom policy.</p>']) {
      const r = await checkPrivacyPolicy(fakeAdmin(body));
      expect(r.ok && r.upToDate).toBe(false);
      expect(r.ok && r.templateRecognized).toBe(false);
    }
  });
  it('apply writes the transformed body via shopPolicyUpdate', async () => {
    const capture = { mutations: [] as unknown[] };
    const r = await applyPrivacyPolicy(fakeAdmin(STOCK_BODY, capture));
    expect(r.ok && r.applied).toHaveLength(3);
    expect(capture.mutations).toHaveLength(1);
    const sent = capture.mutations[0] as { policy: { type: string; body: string } };
    expect(sent.policy.type).toBe('PRIVACY_POLICY');
    expect(sent.policy.body).toContain('London E6 2JA');
  });
  it('apply on an up-to-date policy is a no-op', async () => {
    const capture = { mutations: [] as unknown[] };
    const done = transformPrivacyPolicy(STOCK_BODY).next;
    const r = await applyPrivacyPolicy(fakeAdmin(done, capture));
    expect(r.ok && r.applied).toEqual([]);
    expect(capture.mutations).toHaveLength(0);
  });
  it('missing scope surfaces as reconnect_required', async () => {
    const denied = (async () => { throw new Error('Access denied for shopPolicies field. Required access: `read_legal_policies` access scope.'); }) as unknown as AdminGraphql;
    const r = await checkPrivacyPolicy(denied);
    expect(!r.ok && r.error).toBe('reconnect_required');
  });
});
