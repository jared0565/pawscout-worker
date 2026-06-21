import { describe, it, expect } from 'vitest';
import { setSupplierMetafields } from '../src/proxy/inventory';
import type { AdminGraphql } from '../src/shopify-admin';

/** Capture the metafields payload setSupplierMetafields sends. */
function captureAdmin(): { admin: AdminGraphql; keys: () => string[]; valueOf: (k: string) => unknown } {
  let captured: Array<{ key: string; value: unknown }> = [];
  const admin: AdminGraphql = async (_q, vars) => {
    captured = ((vars?.metafields as Array<{ key: string; value: unknown }>) ?? []);
    return { metafieldsSet: { userErrors: [] } };
  };
  return {
    admin,
    keys: () => captured.map((f) => f.key),
    valueOf: (k) => captured.find((f) => f.key === k)?.value,
  };
}

const base = { status: 'available' as const, qty: 5, checkedAt: '2026-06-21T00:00:00.000Z', origin: 'CN' };

describe('setSupplierMetafields — delivery_days', () => {
  it('writes a bare day-range when provided', async () => {
    const c = captureAdmin();
    await setSupplierMetafields(c.admin, 'gid://p/1', { ...base, deliveryDays: '6-21' });
    expect(c.keys()).toContain('delivery_days');
    expect(c.valueOf('delivery_days')).toBe('6-21');
  });

  it('writes an EMPTY string to CLEAR it (stale/missing => PDP static fallback)', async () => {
    const c = captureAdmin();
    await setSupplierMetafields(c.admin, 'gid://p/1', { ...base, deliveryDays: '' });
    expect(c.keys()).toContain('delivery_days');
    expect(c.valueOf('delivery_days')).toBe('');
  });

  it('OMITS the field entirely when deliveryDays is undefined (e.g. at import, pre-sync)', async () => {
    const c = captureAdmin();
    await setSupplierMetafields(c.admin, 'gid://p/1', { ...base });
    expect(c.keys()).not.toContain('delivery_days');
    // the established metafields are still written
    expect(c.keys()).toEqual(expect.arrayContaining(['name', 'status', 'available_qty', 'last_checked_at', 'origin']));
  });
});
