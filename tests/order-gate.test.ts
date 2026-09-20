import { describe, it, expect } from 'vitest';
import { decideGate, readOrderGate, ORDER_GATE_QUERY, type OrderSnapshot } from '../src/order-gate';
import type { OrderAddress } from '../src/fulfil';
import type { AdminGraphql } from '../src/shopify-admin';

const ADDR: OrderAddress = {
  name: 'Jane Doe', address1: '1 High St', address2: '', city: 'London', province: 'England', zip: 'E1 1AA', countryCode: 'GB', phone: '07000000000'
};

function snapshot(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    exists: true, cancelledAt: null, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
    riskRecommendation: 'ACCEPT', address: ADDR, ...over
  };
}

function stored(over: Partial<{ address: OrderAddress | null; totalPrice: number; skipRisk: boolean }> = {}) {
  return { address: ADDR, totalPrice: 20, skipRisk: false, ...over };
}

describe('decideGate', () => {
  it('a live paid unfulfilled ACCEPT order with the same address proceeds', () => {
    expect(decideGate(snapshot(), stored())).toEqual({ action: 'proceed', address: ADDR, addressChanged: false, riskLevel: 'LOW' });
  });

  it('exists: false holds order-missing', () => {
    expect(decideGate(snapshot({ exists: false }), stored())).toMatchObject({ action: 'hold', reason: 'order-missing' });
  });

  it('cancelledAt set cancels shopify-cancelled', () => {
    expect(decideGate(snapshot({ cancelledAt: '2026-09-01T00:00:00Z' }), stored())).toEqual({ action: 'cancel', reason: 'shopify-cancelled' });
  });

  it('cancelled AND refunded cancels (precedence)', () => {
    const s = snapshot({ cancelledAt: '2026-09-01T00:00:00Z', financialStatus: 'REFUNDED' });
    expect(decideGate(s, stored())).toEqual({ action: 'cancel', reason: 'shopify-cancelled' });
  });

  it('REFUNDED holds refunded', () => {
    expect(decideGate(snapshot({ financialStatus: 'REFUNDED' }), stored())).toMatchObject({ action: 'hold', reason: 'refunded' });
  });

  it('PARTIALLY_REFUNDED holds refunded', () => {
    expect(decideGate(snapshot({ financialStatus: 'PARTIALLY_REFUNDED' }), stored())).toMatchObject({ action: 'hold', reason: 'refunded' });
  });

  it('VOIDED holds refunded', () => {
    expect(decideGate(snapshot({ financialStatus: 'VOIDED' }), stored())).toMatchObject({ action: 'hold', reason: 'refunded' });
  });

  it('FULFILLED holds already-fulfilled', () => {
    expect(decideGate(snapshot({ fulfillmentStatus: 'FULFILLED' }), stored())).toMatchObject({ action: 'hold', reason: 'already-fulfilled' });
  });

  it('PARTIALLY_FULFILLED holds already-fulfilled', () => {
    expect(decideGate(snapshot({ fulfillmentStatus: 'PARTIALLY_FULFILLED' }), stored())).toMatchObject({ action: 'hold', reason: 'already-fulfilled' });
  });

  it('Shopify address differs: proceeds with the Shopify address and addressChanged: true', () => {
    const shopifyAddr: OrderAddress = { ...ADDR, city: 'Manchester' };
    const decision = decideGate(snapshot({ address: shopifyAddr }), stored());
    expect(decision).toEqual({ action: 'proceed', address: shopifyAddr, addressChanged: true, riskLevel: 'LOW' });
  });

  it('Shopify address differs only in case and surrounding spaces: addressChanged: false', () => {
    const shopifyAddr: OrderAddress = {
      name: '  JANE DOE  ', address1: '1 HIGH ST', address2: '', city: 'LONDON', province: 'england', zip: ' e1 1aa ', countryCode: 'gb', phone: '07000000000'
    };
    const decision = decideGate(snapshot({ address: shopifyAddr }), stored());
    expect(decision).toEqual({ action: 'proceed', address: shopifyAddr, addressChanged: false, riskLevel: 'LOW' });
  });

  it('Shopify address null, stored complete: proceeds with the stored address, addressChanged: false', () => {
    const decision = decideGate(snapshot({ address: null }), stored());
    expect(decision).toEqual({ action: 'proceed', address: ADDR, addressChanged: false, riskLevel: 'LOW' });
  });

  it('Shopify address present but missing zip: holds incomplete-address', () => {
    const decision = decideGate(snapshot({ address: { ...ADDR, zip: '' } }), stored());
    expect(decision).toMatchObject({ action: 'hold', reason: 'incomplete-address' });
  });

  it('both addresses null: holds incomplete-address', () => {
    const decision = decideGate(snapshot({ address: null }), stored({ address: null }));
    expect(decision).toMatchObject({ action: 'hold', reason: 'incomplete-address' });
  });

  it('CANCEL recommendation holds high-risk with riskLevel: HIGH', () => {
    const decision = decideGate(snapshot({ riskRecommendation: 'CANCEL' }), stored());
    expect(decision).toEqual({ action: 'hold', reason: 'high-risk', riskLevel: 'HIGH' });
  });

  it('INVESTIGATE at GBP 41 holds medium-risk-value; at GBP 39 proceeds with riskLevel: MEDIUM', () => {
    const s = snapshot({ riskRecommendation: 'INVESTIGATE' });
    expect(decideGate(s, stored({ totalPrice: 41 }))).toEqual({ action: 'hold', reason: 'medium-risk-value', riskLevel: 'MEDIUM' });
    expect(decideGate(s, stored({ totalPrice: 39 }))).toEqual({ action: 'proceed', address: ADDR, addressChanged: false, riskLevel: 'MEDIUM' });
  });

  it('skipRisk: true with CANCEL proceeds', () => {
    const decision = decideGate(snapshot({ riskRecommendation: 'CANCEL' }), stored({ skipRisk: true }));
    expect(decision).toMatchObject({ action: 'proceed' });
  });

  it('skipRisk: true with cancelledAt set STILL cancels', () => {
    const decision = decideGate(snapshot({ cancelledAt: '2026-09-01T00:00:00Z' }), stored({ skipRisk: true }));
    expect(decision).toEqual({ action: 'cancel', reason: 'shopify-cancelled' });
  });
});

describe('decideGate - payment whitelist', () => {
  it('exists true, every other snapshot field null: holds not-paid', () => {
    const s: OrderSnapshot = { exists: true, cancelledAt: null, financialStatus: null, fulfillmentStatus: null, riskRecommendation: null, address: null };
    expect(decideGate(s, stored())).toMatchObject({ action: 'hold', reason: 'not-paid' });
  });

  it('financialStatus PENDING holds not-paid', () => {
    expect(decideGate(snapshot({ financialStatus: 'PENDING' }), stored())).toMatchObject({ action: 'hold', reason: 'not-paid' });
  });

  it('financialStatus AUTHORIZED holds not-paid', () => {
    expect(decideGate(snapshot({ financialStatus: 'AUTHORIZED' }), stored())).toMatchObject({ action: 'hold', reason: 'not-paid' });
  });

  it('financialStatus PARTIALLY_PAID holds not-paid', () => {
    expect(decideGate(snapshot({ financialStatus: 'PARTIALLY_PAID' }), stored())).toMatchObject({ action: 'hold', reason: 'not-paid' });
  });

  it('financialStatus "paid" (lower case), otherwise live, proceeds (case-insensitive)', () => {
    expect(decideGate(snapshot({ financialStatus: 'paid' }), stored())).toMatchObject({ action: 'proceed' });
  });

  it('financialStatus "refunded" (lower case) holds refunded', () => {
    expect(decideGate(snapshot({ financialStatus: 'refunded' }), stored())).toMatchObject({ action: 'hold', reason: 'refunded' });
  });

  it('fulfillmentStatus "fulfilled" (lower case) holds already-fulfilled', () => {
    expect(decideGate(snapshot({ fulfillmentStatus: 'fulfilled' }), stored())).toMatchObject({ action: 'hold', reason: 'already-fulfilled' });
  });

  it('fulfillmentStatus ON_HOLD holds on-hold', () => {
    expect(decideGate(snapshot({ fulfillmentStatus: 'ON_HOLD' }), stored())).toMatchObject({ action: 'hold', reason: 'on-hold' });
  });

  it('fulfillmentStatus null with PAID proceeds', () => {
    expect(decideGate(snapshot({ fulfillmentStatus: null }), stored())).toMatchObject({ action: 'proceed' });
  });

  it('fulfillmentStatus UNFULFILLED proceeds', () => {
    expect(decideGate(snapshot({ fulfillmentStatus: 'UNFULFILLED' }), stored())).toMatchObject({ action: 'proceed' });
  });

  it('skipRisk: true with financialStatus null still holds not-paid', () => {
    const decision = decideGate(snapshot({ financialStatus: null }), stored({ skipRisk: true }));
    expect(decision).toMatchObject({ action: 'hold', reason: 'not-paid' });
  });

  it('skipRisk: true with ON_HOLD still holds on-hold', () => {
    const decision = decideGate(snapshot({ fulfillmentStatus: 'ON_HOLD' }), stored({ skipRisk: true }));
    expect(decision).toMatchObject({ action: 'hold', reason: 'on-hold' });
  });
});

describe('decideGate - null address fields do not throw', () => {
  it('a stored address with null address2/phone does not throw, and null vs empty string is not a change', () => {
    const storedAddr = { ...ADDR, address2: null, phone: null } as unknown as OrderAddress;
    const shopifyAddr: OrderAddress = { ...ADDR, address2: '', phone: '' };
    const run = () => decideGate(snapshot({ address: shopifyAddr }), stored({ address: storedAddr }));
    expect(run).not.toThrow();
    expect(run()).toMatchObject({ action: 'proceed', addressChanged: false });
  });

  it('a Shopify-side address with null address2/phone does not throw, and null vs empty string is not a change', () => {
    const shopifyAddr = { ...ADDR, address2: null, phone: null } as unknown as OrderAddress;
    const storedAddr: OrderAddress = { ...ADDR, address2: '', phone: '' };
    const run = () => decideGate(snapshot({ address: shopifyAddr }), stored({ address: storedAddr }));
    expect(run).not.toThrow();
    expect(run()).toMatchObject({ action: 'proceed', addressChanged: false });
  });
});

describe('decideGate - riskHold reason mapped explicitly, no unchecked cast', () => {
  it('CANCEL maps to high-risk and INVESTIGATE-over-threshold maps to medium-risk-value', () => {
    expect(decideGate(snapshot({ riskRecommendation: 'CANCEL' }), stored())).toMatchObject({ reason: 'high-risk' });
    expect(decideGate(snapshot({ riskRecommendation: 'INVESTIGATE' }), stored({ totalPrice: 41 }))).toMatchObject({ reason: 'medium-risk-value' });
  });
});

describe('readOrderGate', () => {
  it('an admin that throws gives { ok: false } and does not throw', async () => {
    const admin = (async () => { throw new Error('boom'); }) as unknown as AdminGraphql;
    await expect(readOrderGate(admin, '123')).resolves.toMatchObject({ ok: false, error: 'boom' });
  });

  it('{ order: null } gives exists: false', async () => {
    const admin = (async () => ({ order: null })) as unknown as AdminGraphql;
    const result = await readOrderGate(admin, '123');
    expect(result).toEqual({ ok: true, snapshot: { exists: false, cancelledAt: null, financialStatus: null, fulfillmentStatus: null, riskRecommendation: null, address: null } });
  });

  it('maps countryCodeV2 to countryCode and sends the id as gid://shopify/Order/123', async () => {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const admin = (async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      return {
        order: {
          cancelledAt: null, closed: false, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
          risk: { recommendation: 'ACCEPT' },
          shippingAddress: { name: 'Jane Doe', address1: '1 High St', address2: '', city: 'London', province: 'England', zip: 'E1 1AA', countryCodeV2: 'GB', phone: '07000000000' }
        }
      };
    }) as unknown as AdminGraphql;
    const result = await readOrderGate(admin, '123');
    expect(calls[0].query).toBe(ORDER_GATE_QUERY);
    expect(calls[0].variables).toEqual({ id: 'gid://shopify/Order/123' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.snapshot.address).toMatchObject({ countryCode: 'GB' });
  });

  // A customer who gives a phone as their contact detail and none on the
  // address has it stored on the order, not on the shipping address. Reading
  // the address alone would read that as "the phone was removed", replace the
  // stored address with one that has no phone, and send the supplier an empty
  // one. The order's own phone is the same fallback the order was first
  // recorded with.
  it('falls back to the order phone when the shipping address carries none', async () => {
    const admin = (async () => ({
      order: {
        cancelledAt: null, closed: false, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
        phone: '07123456789',
        risk: { recommendation: 'ACCEPT' },
        shippingAddress: { name: 'Jane Doe', address1: '1 High St', address2: '', city: 'London', province: 'England', zip: 'E1 1AA', countryCodeV2: 'GB', phone: null }
      }
    })) as unknown as AdminGraphql;
    const result = await readOrderGate(admin, '123');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.address?.phone).toBe('07123456789');
  });

  it('prefers the shipping address phone over the order phone', async () => {
    const admin = (async () => ({
      order: {
        cancelledAt: null, closed: false, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
        phone: '07123456789',
        risk: { recommendation: 'ACCEPT' },
        shippingAddress: { name: 'Jane Doe', address1: '1 High St', address2: '', city: 'London', province: 'England', zip: 'E1 1AA', countryCodeV2: 'GB', phone: '07000000000' }
      }
    })) as unknown as AdminGraphql;
    const result = await readOrderGate(admin, '123');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.address?.phone).toBe('07000000000');
  });

  it('asks Shopify for the order phone, not only the address one', () => {
    expect(ORDER_GATE_QUERY).toMatch(/\n\s{4}phone\n/); // on the order, at its own indent level
    expect(ORDER_GATE_QUERY).toContain('shippingAddress { name address1 address2 city province zip countryCodeV2 phone }');
  });
});
