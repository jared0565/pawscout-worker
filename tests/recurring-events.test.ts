/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { ensureRecurringDiscount, rotateRecurringEvents, CAMPAIGN_ARM_DAYS } from '../src/recurring-events';
import { templateByKey } from '../src/event-catalogue';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

/** Scripted admin mock: answers the code lookup and records every mutation. */
function mockAdmin(existing: { id: string; startsAt: string; endsAt: string; status?: string } | null) {
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  const admin: AdminGraphql = async (query, vars) => {
    calls.push({ query, vars: vars ?? {} });
    if (query.includes('codeDiscountNodeByCode')) {
      return { codeDiscountNodeByCode: existing ? { id: existing.id, codeDiscount: { status: existing.status ?? 'SCHEDULED', startsAt: existing.startsAt, endsAt: existing.endsAt } } : null };
    }
    if (query.includes('discountCodeBasicCreate')) return { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://new' }, userErrors: [] } };
    if (query.includes('discountCodeBasicUpdate')) return { discountCodeBasicUpdate: { userErrors: [] } };
    if (query.includes('discountCodeActivate')) return { discountCodeActivate: { userErrors: [] } };
    if (query.includes('automaticDiscountNodes')) return { automaticDiscountNodes: { nodes: [] }, codeDiscountNodes: { nodes: [] } };
    return {};
  };
  return { admin, calls };
}

// 10 days before the Summer 2026 window starts (28 Aug): inside the arm horizon.
const NEAR_SUMMER = Date.parse('2026-08-18T05:00:00Z');
// Far from any Summer occurrence: outside the horizon.
const FAR_FROM_SUMMER = Date.parse('2026-07-06T05:00:00Z');

describe('ensureRecurringDiscount', () => {
  const t = templateByKey('summer-bank-holiday')!;

  it('creates the scheduled discount when none exists (window baked in)', async () => {
    const { admin, calls } = mockAdmin(null);
    const r = await ensureRecurringDiscount(admin, t, 15, FAR_FROM_SUMMER);
    expect(r.ok && r.action).toBe('created');
    const create = calls.find((c) => c.query.includes('discountCodeBasicCreate'))!;
    const input = create.vars.basicCodeDiscount as Record<string, unknown>;
    expect(input.code).toBe('SUMMERSALE');
    expect(input.startsAt).toBe('2026-08-28T00:00:00.000Z');
    expect(input.endsAt).toBe('2026-08-31T23:59:59.000Z');
  });

  it('leaves a correctly-scheduled discount alone', async () => {
    const { admin, calls } = mockAdmin({ id: 'gid://d1', startsAt: '2026-08-28T00:00:00Z', endsAt: '2026-08-31T23:59:59Z' });
    const r = await ensureRecurringDiscount(admin, t, 15, FAR_FROM_SUMMER);
    expect(r.ok && r.action).toBe('unchanged');
    expect(calls.some((c) => c.query.includes('Update'))).toBe(false);
  });

  it("re-dates last year's discount instead of colliding with its code (the yearly rollover)", async () => {
    const { admin, calls } = mockAdmin({ id: 'gid://d1', startsAt: '2025-08-22T00:00:00Z', endsAt: '2025-08-25T23:59:59Z', status: 'EXPIRED' });
    const r = await ensureRecurringDiscount(admin, t, 15, FAR_FROM_SUMMER);
    expect(r.ok && r.action).toBe('updated');
    const update = calls.find((c) => c.query.includes('discountCodeBasicUpdate'))!;
    const input = update.vars.basicCodeDiscount as Record<string, unknown>;
    expect(input.startsAt).toBe('2026-08-28T00:00:00.000Z');
    expect(calls.some((c) => c.query.includes('discountCodeActivate'))).toBe(true);
  });
});

describe('rotateRecurringEvents', () => {
  it('keeps enabled events scheduled, skips disabled ones, and stages the campaign once per occurrence', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.setRecurringEvent('summer-bank-holiday', true, 12);
    await s.setRecurringEvent('black-friday', false, null);
    const { admin, calls } = mockAdmin(null);

    const first = await rotateRecurringEvents(s, admin, NEAR_SUMMER);
    expect(first.ensured).toBe(1);   // summer created; black friday untouched (disabled)
    expect(first.staged).toBe(1);    // within CAMPAIGN_ARM_DAYS -> draft staged
    expect(first.errors).toEqual([]);
    expect(calls.filter((c) => c.query.includes('discountCodeBasicCreate')).length).toBe(1);
    const drafts = await s.listCampaigns();
    expect(drafts.length).toBe(1);
    expect(drafts[0].subject).toContain('12% off everything');
    expect(drafts[0].body_text).toContain('SUMMERSALE');
    expect(drafts[0].status).toBe('draft'); // HITL: never sent by the rotation

    // Second night: discount now "exists" with the right window; nothing re-staged.
    const again = mockAdmin({ id: 'gid://d1', startsAt: '2026-08-28T00:00:00Z', endsAt: '2026-08-31T23:59:59Z' });
    const second = await rotateRecurringEvents(s, again.admin, NEAR_SUMMER + 86_400_000);
    expect(second.ensured).toBe(0);
    expect(second.staged).toBe(0);   // armed_for cursor: once per occurrence
    expect((await s.listCampaigns()).length).toBe(1);
  });

  it('does not stage the announcement while the occurrence is far away', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.setRecurringEvent('summer-bank-holiday', true, null);
    const { admin } = mockAdmin(null);
    const r = await rotateRecurringEvents(s, admin, FAR_FROM_SUMMER);
    expect(r.ensured).toBe(1);       // discount still kept scheduled
    expect(r.staged).toBe(0);        // 28 Aug is more than CAMPAIGN_ARM_DAYS away
    expect(CAMPAIGN_ARM_DAYS).toBe(14);
  });
});
