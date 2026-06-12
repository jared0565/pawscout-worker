import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { cullStaleProducts, refillCollections } from '../src/jobs';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, type TenantConfig } from '../src/types';
import type { CjClient, CjSearchItem, CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const DAY = 86400_000;

// Tests write rows directly so they can backdate timestamps (the store API
// always stamps "now"); production code still goes through TenantStore only.
async function insertLink(cjPid: string, state: string, createdAgoDays: number): Promise<void> {
  const ts = new Date(Date.now() - createdAgoDays * DAY).toISOString();
  await env.DB.prepare(
    `INSERT INTO product_links (shop, cj_pid, shopify_product_id, handle, category, state, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?6)`
  ).bind(SHOP, cjPid, `gid://shopify/Product/${cjPid}`, `h-${cjPid}`, state, ts).run();
}

async function insertEvent(cjPid: string, event: string, agoDays: number): Promise<void> {
  const ts = new Date(Date.now() - agoDays * DAY).toISOString();
  await env.DB.prepare(`INSERT INTO product_events (shop, cj_pid, event, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(SHOP, cjPid, event, ts).run();
}

function archivingAdmin(archived: string[]): AdminGraphql {
  return async (query, variables) => {
    if (query.includes('productUpdate')) {
      archived.push((variables!.input as { id: string }).id);
      return { productUpdate: { product: { id: 'x' }, userErrors: [] } };
    }
    if (query.includes('productSet')) {
      const title = (variables!.input as { title: string }).title;
      return { productSet: { product: { id: `gid://shopify/Product/${title}`, handle: title.toLowerCase().replace(/\s+/g, '-') }, userErrors: [] } };
    }
    if (query.includes('publications(')) return { publications: { nodes: [{ id: 'gid://p/1', name: 'Online Store' }] } };
    if (query.includes('publishablePublish')) return { publishablePublish: { userErrors: [] } };
    throw new Error('unexpected query');
  };
}

describe('cullStaleProducts', () => {
  it('archives only old products with no qualifying events in the window', async () => {
    await insertLink('stale', 'imported', 45);          // old, silent → archive
    await insertLink('fresh', 'imported', 5);           // grace period → keep
    await insertLink('active', 'imported', 45);         // old but viewed recently → keep
    await insertEvent('active', 'view', 3);
    await insertLink('sold', 'imported', 45);           // old but ATC in window → keep
    await insertEvent('sold', 'atc', 20);
    await insertLink('ghost', 'ghost', 45);             // never imported → not cull's business

    const store = new TenantStore(env.DB, SHOP);
    const archived: string[] = [];
    const n = await cullStaleProducts(store, archivingAdmin(archived));

    expect(n).toBe(1);
    expect(archived).toEqual(['gid://shopify/Product/stale']);
    expect((await store.getLink('stale'))?.state).toBe('archived');
    expect((await store.getLink('active'))?.state).toBe('imported');
    expect((await store.getLink('sold'))?.state).toBe('imported');
    expect((await store.getLink('fresh'))?.state).toBe('imported');
  });
});

describe('refillCollections', () => {
  const CFG: TenantConfig = {
    collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys' } },
    gates: DEFAULT_GATES,
    pricing: DEFAULT_PRICING,
    floors: DEFAULT_FLOORS,
    target: 2
  };

  function fakeCj(items: CjSearchItem[]): CjClient {
    return {
      search: async () => items,
      detail: async (pid: string): Promise<CjDetail> => ({
        pid,
        nameEn: `Pet Toys ${pid}`,
        images: ['https://i/1.jpg'],
        descriptionHtml: 'desc',
        variants: [{ vid: 'v1', name: 'Default', sellPriceUsd: 10, sku: pid }],
        listedNum: 100,
        categoryName: 'Pet Toys'
      })
    } as unknown as CjClient;
  }

  const items = (n: number) =>
    Array.from({ length: n }, (_, i): CjSearchItem => ({
      pid: `p${i}`, nameEn: `Pet Toys ${i}`, image: 'https://i/1.jpg',
      sellPriceUsd: 10, listedNum: 100 + i, categoryName: 'Pet Toys'
    }));

  it('fills a collection up to target and records categorized links', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const archived: string[] = [];
    const n = await refillCollections(store, fakeCj(items(5)), archivingAdmin(archived), CFG, { pause: async () => {} });
    expect(n).toBe(2); // deficit = target 2 − 0 imported
    expect(await store.countImportedByCategory('pet-toys')).toBe(2);
  });

  it('does nothing when the collection already meets target', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putLink({ cjPid: 'a', state: 'imported', category: 'pet-toys', shopifyProductId: 'gid://a', handle: 'a' });
    await store.putLink({ cjPid: 'b', state: 'imported', category: 'pet-toys', shopifyProductId: 'gid://b', handle: 'b' });
    const n = await refillCollections(store, fakeCj(items(5)), archivingAdmin([]), CFG, { pause: async () => {} });
    expect(n).toBe(0);
  });

  it('honors the per-run import cap', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const n = await refillCollections(store, fakeCj(items(5)), archivingAdmin([]), { ...CFG, target: 5 }, { maxImports: 1, pause: async () => {} });
    expect(n).toBe(1);
  });

  it('prioritizes under-served search keywords from the demand log', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.logSearch('rope toy', 1, 0); // under target → demand
    const cj = fakeCj(items(3));
    const n = await refillCollections(store, cj, archivingAdmin([]), { ...CFG, collectionMap: {} }, { pause: async () => {} });
    expect(n).toBeGreaterThan(0); // imported from keyword demand despite no collections mapped
  });
});
