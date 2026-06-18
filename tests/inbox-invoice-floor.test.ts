import { describe, it, expect } from 'vitest';
import { invoiceSendDecision } from '../src/inbox/invoice-floor';

const base = {
  autoInvoice: true,
  confidence: 96,
  threshold: 95,
  total: 50,
  ceiling: 250,
  category: 'lead',
  allResolved: true,
  quantitiesWithinCaps: true,
  recentInvoiceCount: 0,
  rateLimit: 2,
};

describe('invoiceSendDecision', () => {
  it('creates when everything passes', () => {
    expect(invoiceSendDecision(base)).toEqual({ create: true, holdReasons: [] });
  });

  it('holds when autoInvoice is off', () => {
    expect(invoiceSendDecision({ ...base, autoInvoice: false }).holdReasons).toContain('auto_invoice_off');
  });

  it('holds on low confidence', () => {
    expect(invoiceSendDecision({ ...base, confidence: 80 }).holdReasons).toContain('low_confidence');
  });

  it('holds over the ceiling', () => {
    expect(invoiceSendDecision({ ...base, total: 999 }).holdReasons).toContain('over_ceiling');
  });

  it('holds on unresolved items', () => {
    expect(invoiceSendDecision({ ...base, allResolved: false }).holdReasons).toContain('unresolved_items');
  });

  it('holds when quantity exceeds caps', () => {
    expect(invoiceSendDecision({ ...base, quantitiesWithinCaps: false }).holdReasons).toContain('qty_over_cap');
  });

  it('holds a complaint/wholesale category', () => {
    expect(invoiceSendDecision({ ...base, category: 'complaint' }).holdReasons).toContain('always_hold_category');
  });

  it('holds order-status category (no longer auto-eligible)', () => {
    const r = invoiceSendDecision({ ...base, category: 'order-status' });
    expect(r.create).toBe(false);
    expect(r.holdReasons).toContain('always_hold_category');
  });

  it('holds shipping-returns category (no longer auto-eligible)', () => {
    const r = invoiceSendDecision({ ...base, category: 'shipping-returns' });
    expect(r.create).toBe(false);
    expect(r.holdReasons).toContain('always_hold_category');
  });

  it('holds when rate limited', () => {
    expect(invoiceSendDecision({ ...base, recentInvoiceCount: 2 }).holdReasons).toContain('rate_limited');
  });
});
