/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { ensureRecurringDiscount, rotateRecurringEvents, alertRotationErrors, CAMPAIGN_ARM_DAYS } from '../src/recurring-events';
import { templateByKey } from '../src/event-catalogue';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

/** Scripted admin mock: answers the code lookup and records every mutation.
 *  Behaves like Shopify on the two calls that matter here: an UPDATE re-dates
 *  the stored discount and Shopify derives SCHEDULED from a future window; an
 *  ACTIVATE on a future-dated discount sets startsAt to now and makes it
 *  ACTIVE (documented, and the 2026-09-05 SUMMERSALE fault). `afterUpdate`
 *  overrides what the re-read shows, to script a Shopify that misbehaves. */
function mockAdmin(
  existing: { id: string; startsAt: string; endsAt: string; status?: string } | null,
  opts: { afterUpdate?: { status: string; startsAt: string } } = {}
) {
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  const admin: AdminGraphql = async (query, vars) => {
    calls.push({ query, vars: vars ?? {} });
    if (query.includes('codeDiscountNodeByCode')) {
      return { codeDiscountNodeByCode: existing ? { id: existing.id, codeDiscount: { status: existing.status ?? 'SCHEDULED', startsAt: existing.startsAt, endsAt: existing.endsAt } } : null };
    }
    if (query.includes('discountCodeBasicCreate')) return { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://new' }, userErrors: [] } };
    if (query.includes('discountCodeBasicUpdate')) {
      const input = (vars?.basicCodeDiscount ?? {}) as { startsAt?: string; endsAt?: string };
      if (existing) {
        existing.startsAt = opts.afterUpdate?.startsAt ?? input.startsAt ?? existing.startsAt;
        existing.endsAt = input.endsAt ?? existing.endsAt;
        existing.status = opts.afterUpdate?.status ?? 'SCHEDULED';
      }
      return { discountCodeBasicUpdate: { userErrors: [] } };
    }
    if (query.includes('discountCodeActivate')) {
      if (existing) { existing.status = 'ACTIVE'; existing.startsAt = new Date().toISOString(); }
      return { discountCodeActivate: { userErrors: [] } };
    }
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

  // 2026-09-05: the rollover used to follow the update with discountCodeActivate
  // "in case the discount had been retired". Shopify documents that activating
  // a discount set to start in the future sets its startsAt to NOW, so the
  // first real rollover (SUMMERSALE, window ended 31 Aug) went live for a year
  // and the storefront pop-up advertised a Summer bank holiday in September. A
  // retired discount needs no activation: deactivate only expires it, and an
  // update to a future window is SCHEDULED by itself. The rollover therefore
  // never activates, and re-reads Shopify to prove the window landed.
  it("re-dates last year's discount instead of colliding with its code (the yearly rollover), never activating it", async () => {
    const { admin, calls } = mockAdmin({ id: 'gid://d1', startsAt: '2025-08-22T00:00:00Z', endsAt: '2025-08-25T23:59:59Z', status: 'EXPIRED' });
    const r = await ensureRecurringDiscount(admin, t, 15, FAR_FROM_SUMMER);
    expect(r.ok && r.action).toBe('updated');
    const update = calls.find((c) => c.query.includes('discountCodeBasicUpdate'))!;
    const input = update.vars.basicCodeDiscount as Record<string, unknown>;
    expect(input.startsAt).toBe('2026-08-28T00:00:00.000Z');
    expect(calls.some((c) => c.query.includes('discountCodeActivate'))).toBe(false);
    // The window is verified against Shopify after the update, not assumed.
    expect(calls.filter((c) => c.query.includes('codeDiscountNodeByCode')).length).toBe(2);
  });

  it('refuses to report success when Shopify shows the re-dated discount running from now (the SUMMERSALE fault)', async () => {
    const { admin, calls } = mockAdmin(
      { id: 'gid://d1', startsAt: '2025-08-22T00:00:00Z', endsAt: '2025-08-25T23:59:59Z', status: 'EXPIRED' },
      { afterUpdate: { status: 'ACTIVE', startsAt: '2026-07-06T05:00:14Z' } }
    );
    const r = await ensureRecurringDiscount(admin, t, 15, FAR_FROM_SUMMER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/ACTIVE/);
    expect(r.error).toMatch(/2026-08-28/);
    expect(calls.some((c) => c.query.includes('discountCodeActivate'))).toBe(false);
  });

  it('a window that has already started is expected ACTIVE, not flagged', async () => {
    // 29 Aug 2026 05:00, inside the 28-31 Aug window: re-dating an old record lands ACTIVE legitimately.
    const inWindow = Date.parse('2026-08-29T05:00:00Z');
    const { admin } = mockAdmin(
      { id: 'gid://d1', startsAt: '2025-08-22T00:00:00Z', endsAt: '2025-08-25T23:59:59Z', status: 'EXPIRED' },
      { afterUpdate: { status: 'ACTIVE', startsAt: '2026-08-28T00:00:00Z' } }
    );
    const r = await ensureRecurringDiscount(admin, t, 15, inWindow);
    expect(r.ok && r.action).toBe('updated');
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

// 2026-09-05 leftover (a): a rollover that fails verification was only
// console.logged by the nightly stage, so a discount left in the wrong window
// (the SUMMERSALE fault) was invisible until someone opened the Events view.
// The owner gets one email per DISTINCT failure set: the same failure on the
// next night is not news, a changed one is, and after a clean run the original
// failure returning is news again.
describe('alertRotationErrors', () => {
  it('emails once per distinct failure set, again when it changes, and again after a clean run', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const sent: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { sent.push({ subject, text }); };
    const fault = 'summersale: Shopify shows the re-dated discount ACTIVE from 2026-09-05T04:50:00Z';

    expect(await alertRotationErrors(store, [fault], send)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/event rotation/i);
    expect(sent[0].text).toContain(fault);

    expect(await alertRotationErrors(store, [fault], send)).toBe(false);   // same failure next night
    expect(sent).toHaveLength(1);

    expect(await alertRotationErrors(store, [fault, 'easter: userErrors: window in the past'], send)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toContain('easter: userErrors');

    expect(await alertRotationErrors(store, [], send)).toBe(false);        // clean run clears the memory
    expect(await alertRotationErrors(store, [fault], send)).toBe(true);    // so its return is news again
    expect(sent).toHaveLength(3);
  });

  it('is a no-op with no errors and no memory', async () => {
    const store = new TenantStore(env.DB, 'clean.myshopify.com');
    let calls = 0;
    expect(await alertRotationErrors(store, [], async () => { calls++; })).toBe(false);
    expect(calls).toBe(0);
  });
});
