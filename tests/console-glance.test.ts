/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { getGlance } from '../src/console/routes';
import { JOB_STAMP_DAILY, JOB_STAMP_PIPELINE, JOB_STAMP_MARKETS, LOW_STOCK_BAND, sellableQty } from '../src/jobs';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

function store() { return new TenantStore(env.DB, SHOP); }

async function seedTenant() {
  const s = store();
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  return s;
}

describe('getGlance', () => {
  it('renders an honest empty state for a fresh shop (no fabricated numbers)', async () => {
    await seedTenant();
    const g = await getGlance(env.DB, SHOP);
    expect(g.ok).toBe(true);
    expect(g.kpis).toEqual({
      pendingDrafts: 0, oldestPendingAt: null, autoSent24h: 0,
      ordersHeld: 0, ordersInPipeline: 0, pipeline: {}, liveProducts: 0, lowStock: 0
    });
    // The only attention item on a fresh shop is the real "CJ not connected" fact.
    expect(g.attention).toHaveLength(1);
    expect(g.attention[0].level).toBe('crit');
    expect(g.attention[0].route).toBe('settings');
    expect(g.activity).toEqual([]);
    expect(g.health.cjConnected).toBe(false);
    expect(g.health.dailyLastRunAt).toBeNull();
    expect(g.health.pipelineLastRunAt).toBeNull();
    expect(g.health.lastInboundAt).toBeNull();
    expect(g.health.lastOutboundAt).toBeNull();
    expect(g.markets).toBeNull();
  });

  it('aggregates drafts, orders, stock, activity, health stamps and markets from real rows', async () => {
    const s = await seedTenant();
    await s.putSupplierCredential('cj', 'sealed-key', 'cj');

    // Inbox: one inbound thread with a pending draft; one auto-sent reply.
    await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-07-03T10:00:00Z', initialStatus: 'needs_reply' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<m1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Hi', bodyText: 'hello', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-03T10:00:00Z' });
    await s.insertDraft({ threadId: tid, bodyText: 'Draft', bodyHtml: '<p>Draft</p>', confidence: 80, quotesPriceOrder: false, holdReasons: ['autosend_off'], model: 'm', status: 'pending' });
    const tid2 = await s.createThread({ contactEmail: 'mia@y.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-07-03T11:00:00Z', initialStatus: 'awaiting_customer' });
    const autoId = await s.insertDraft({ threadId: tid2, bodyText: 'Decline', bodyHtml: '<p>Decline</p>', confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'template', status: 'pending' });
    await s.setDraftStatus(autoId, 'auto_sent', { sentAt: new Date().toISOString() });

    // Orders: one held (crit), one queued + one awaiting payment (pipeline), one fulfilled (terminal).
    await s.insertOrderIfNew({ shopifyOrderId: '1', orderName: '#1001', totalPrice: 20, currency: 'GBP', financialStatus: 'paid', riskLevel: 'LOW', status: 'held', holdReasons: ['stockout: item sold out at source'], addressJson: null, lineItemsJson: '[]', fulfilAfter: null });
    await s.insertOrderIfNew({ shopifyOrderId: '2', orderName: '#1002', totalPrice: 30, currency: 'GBP', financialStatus: 'paid', riskLevel: 'LOW', status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: '[]', fulfilAfter: null });
    await s.insertOrderIfNew({ shopifyOrderId: '3', orderName: '#1003', totalPrice: 40, currency: 'GBP', financialStatus: 'paid', riskLevel: 'LOW', status: 'awaiting-payment', holdReasons: [], addressJson: null, lineItemsJson: '[]', fulfilAfter: null });
    await s.insertOrderIfNew({ shopifyOrderId: '4', orderName: '#1004', totalPrice: 50, currency: 'GBP', financialStatus: 'paid', riskLevel: 'LOW', status: 'fulfilled', holdReasons: [], addressJson: null, lineItemsJson: '[]', fulfilAfter: null });

    // Catalog: two live products, one of them in the low-stock band.
    await s.putLink({ cjPid: 'p1', state: 'imported', handle: 'toy-one' });
    await s.putLink({ cjPid: 'p2', state: 'imported', handle: 'bed-two' });
    await s.putWarehouseProduct({ cjPid: 'p1', category: 'pet-toys', title: 'Plush Toy', detailJson: '{}', priceUsd: 5, listedNum: 10, stock: 500 });
    await s.putWarehouseProduct({ cjPid: 'p2', category: 'pet-health', title: 'Elevated Mesh Bed', detailJson: '{}', priceUsd: 15, listedNum: 10, stock: 3 });

    // Cron completion stamps + the nightly market-exclusion snapshot.
    await s.putSearchCache(JOB_STAMP_DAILY, '2026-07-03T04:20:00Z', 30);
    await s.putSearchCache(JOB_STAMP_PIPELINE, '2026-07-03T19:30:00Z', 30);
    await s.putSearchCache(JOB_STAMP_MARKETS, JSON.stringify({ at: '2026-07-03T04:25:00Z', markets: [{ name: 'European Union', excluded: 42 }, { name: 'Australia', excluded: 42 }] }), 30);

    const g = await getGlance(env.DB, SHOP);
    expect(g.kpis.pendingDrafts).toBe(1);
    expect(g.kpis.oldestPendingAt).not.toBeNull();
    expect(g.kpis.autoSent24h).toBe(1);
    expect(g.kpis.ordersHeld).toBe(1);
    expect(g.kpis.ordersInPipeline).toBe(2); // queued + awaiting-payment (held and fulfilled excluded)
    expect(g.kpis.pipeline).toEqual({ queued: 1, 'awaiting-payment': 1 });
    expect(g.kpis.liveProducts).toBe(2);
    expect(g.kpis.lowStock).toBe(1);

    // Attention: CJ is connected so no settings row; held order leads (crit), with
    // its REAL hold reason; then awaiting payment, drafts, low stock (warn).
    expect(g.attention.some((a) => a.route === 'settings')).toBe(false);
    expect(g.attention[0].level).toBe('crit');
    expect(g.attention[0].title).toContain('#1001');
    expect(g.attention[0].detail).toContain('stockout');
    const titles = g.attention.map((a) => a.title).join(' | ');
    expect(titles).toContain('awaiting payment');
    expect(titles).toContain('draft reply waiting for review');
    expect(titles).toContain('nearly sold out at source');
    // Low-stock detail shows the SELLABLE quantity (reserve applied), not raw CJ stock.
    const low = g.attention.find((a) => a.title.includes('nearly sold out'))!;
    expect(low.detail).toContain(`Elevated Mesh Bed (${sellableQty(3)} left)`);
    expect(sellableQty(3)).toBeLessThanOrEqual(LOW_STOCK_BAND);

    // Activity: newest first, real events only.
    expect(g.activity.length).toBeGreaterThan(0);
    for (let i = 1; i < g.activity.length; i++) expect(g.activity[i - 1].at >= g.activity[i].at).toBe(true);
    expect(g.activity.some((a) => a.kind === 'auto_reply' && a.who === 'mia@y.com')).toBe(true);
    expect(g.activity.some((a) => a.kind === 'inbound' && a.who === 'jane@x.com')).toBe(true);
    expect(g.activity.some((a) => a.kind === 'order' && a.who === '#1001' && a.detail === 'held')).toBe(true);

    // Health: the cron stamps + real mail timestamps.
    expect(g.health.cjConnected).toBe(true);
    expect(g.health.dailyLastRunAt).toBe('2026-07-03T04:20:00Z');
    expect(g.health.pipelineLastRunAt).toBe('2026-07-03T19:30:00Z');
    expect(g.health.lastInboundAt).toBe('2026-07-03T10:00:00Z');
    expect(g.health.lastOutboundAt).not.toBeNull();

    // Markets: parsed from the nightly stamp.
    expect(g.markets?.markets).toEqual([{ name: 'European Union', excluded: 42 }, { name: 'Australia', excluded: 42 }]);
  });

  // 2026-07-04 stale-draft fix: pending drafts on dismissed threads (closed/spam/
  // converted/awaiting_customer) are not actionable - the rail badge and the
  // "Drafts awaiting you" KPI must count only drafts the merchant can act on,
  // matching what the Open (unprocessed) list shows.
  it('excludes pending drafts on dismissed threads from the draft count', async () => {
    const s = await seedTenant();
    await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const closed = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Old pitch', subjectNorm: 'old pitch', receivedAt: '2026-06-20T10:00:00Z', initialStatus: 'needs_reply' });
    await s.insertDraft({ threadId: closed, bodyText: 'Stale', bodyHtml: '<p>Stale</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    await s.setThreadStatus(closed, 'closed');
    const open = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-07-04T00:00:00Z', initialStatus: 'needs_reply' });
    await s.insertDraft({ threadId: open, bodyText: 'Fresh', bodyHtml: '<p>Fresh</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });

    const g = await getGlance(env.DB, SHOP);
    expect(g.kpis.pendingDrafts).toBe(1);
    // oldest must be the actionable draft, not the dead one on the closed thread
    expect(g.kpis.oldestPendingAt).toBe((await s.getPendingDraft(open))!.created_at);
  });

  it('degrades a corrupt markets stamp to null instead of throwing', async () => {
    const s = await seedTenant();
    await s.putSearchCache(JOB_STAMP_MARKETS, 'not-json{', 30);
    const g = await getGlance(env.DB, SHOP);
    expect(g.ok).toBe(true);
    expect(g.markets).toBeNull();
  });

  it('never surfaces a low-stock row for paused or non-imported products', async () => {
    const s = await seedTenant();
    await s.putSupplierCredential('cj', 'sealed-key', 'cj');
    // ghost link + low warehouse stock: not live, must not count
    await s.putLink({ cjPid: 'g1', state: 'ghost' });
    await s.putWarehouseProduct({ cjPid: 'g1', category: null, title: 'Ghost Item', detailJson: '{}', priceUsd: 5, listedNum: 1, stock: 1 });
    const g = await getGlance(env.DB, SHOP);
    expect(g.kpis.lowStock).toBe(0);
    expect(g.attention.some((a) => a.title.includes('nearly sold out'))).toBe(false);
  });
});
