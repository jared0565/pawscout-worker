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

  it('OMITS delivery_days when empty (Shopify rejects an empty value — never write "")', async () => {
    const c = captureAdmin();
    await setSupplierMetafields(c.admin, 'gid://p/1', { ...base, deliveryDays: '' });
    expect(c.keys()).not.toContain('delivery_days');
  });

  it('OMITS delivery_days when undefined (e.g. at import, pre-sync)', async () => {
    const c = captureAdmin();
    await setSupplierMetafields(c.admin, 'gid://p/1', { ...base });
    expect(c.keys()).not.toContain('delivery_days');
    expect(c.keys()).toEqual(expect.arrayContaining(['name', 'status', 'available_qty', 'last_checked_at', 'origin']));
  });

  it('writes delivery_days_actual (per-product, for checkout) when provided, omits when empty', async () => {
    const withActual = captureAdmin();
    await setSupplierMetafields(withActual.admin, 'gid://p/1', { ...base, deliveryDaysActual: '12-30' });
    expect(withActual.valueOf('delivery_days_actual')).toBe('12-30');

    const empty = captureAdmin();
    await setSupplierMetafields(empty.admin, 'gid://p/1', { ...base, deliveryDaysActual: '' });
    expect(empty.keys()).not.toContain('delivery_days_actual');
  });
});
