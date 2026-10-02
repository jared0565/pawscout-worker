import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { importProduct, buildPreview, stripHtml, resolveCategory, confirmAndImport, curateDetailImages, vetOrder, reconcileHeroImages, reconcileCatalogImages, cjPidFromTags, NEEDS_IMAGE_TAG, reconcileDescriptions, needsDescriptionRewrite, mediaSignature, reconcileCategories, type PickHeroFn } from '../src/proxy/import';
import { capTitle } from '../src/debrand';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, DEFAULT_PROFIT, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';
import type { HeroPick } from '../src/llm';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const CFG: TenantConfig = {
  collectionMap: {
    'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' },
    'more-to-love': { handle: 'more-to-love', tag: 'cj-pet-more-to-love' }
  },
  gates: DEFAULT_GATES,
  pricing: DEFAULT_PRICING,
  floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
  target: 12
};

const DETAIL: CjDetail = {
  pid: 'P1',
  nameEn: 'Dog Toy Rope',
  images: ['https://i/1.jpg', 'https://i/2.jpg'],
  descriptionHtml: '<p>Fun <script>alert(1)</script>rope toy</p>',
  variants: [
    { vid: 'v1', name: 'Red', sellPriceUsd: 10, sku: 'S1' },
    { vid: 'v2', name: 'Blue', sellPriceUsd: 12, sku: 'S2' }
  ],
  listedNum: 100,
  categoryName: 'Pet Toys'
};

interface Call { query: string; variables?: Record<string, unknown> }

function fakeAdmin(calls: Call[], overrides: Record<string, unknown> = {}): AdminGraphql {
  return async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('productSet')) {
      return (overrides.productSet as Record<string, unknown>) ?? {
        productSet: { product: { id: 'gid://shopify/Product/1', handle: 'dog-toy-rope' }, userErrors: [] }
      };
    }
    if (query.includes('publications(')) {
      return { publications: { nodes: [{ id: 'gid://shopify/Publication/9', name: 'Online Store' }] } };
    }
    if (query.includes('publishablePublish')) return { publishablePublish: { userErrors: [] } };
    if (query.includes('pawscoutLocation')) return { location: { id: 'gid://shopify/Location/1' } };
    if (query.includes('metafieldsSet')) return { metafieldsSet: { userErrors: [] } };
    if (query.includes('productUpdate')) return { productUpdate: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } };
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };
}

describe('preview building', () => {
  it('strips untrusted HTML from descriptions', () => {
    expect(stripHtml(DETAIL.descriptionHtml)).toBe('Fun rope toy');
  });

  it('prices every variant under the tenant rule and exposes plain text only', () => {
    const p = buildPreview(DETAIL, CFG, 'ghost', null);
    expect(p.variants).toEqual([
      { name: 'Red', price: 19.99 },
      { name: 'Blue', price: 23.99 }
    ]);
    expect(p.priceFrom).toBe(19.99);
    expect(p.descriptionText).not.toContain('<');
    expect(p.url).toBeNull();
  });

  it('resolves the category from CJ data, falling back to more-to-love', () => {
    expect(resolveCategory(CFG, DETAIL)).toBe('pet-toys');
    expect(resolveCategory(CFG, { categoryName: 'Aquarium', nameEn: 'Fish Tank Filter' })).toBe('more-to-love');
  });
});

describe('importProduct', () => {
  it("addon imports get the cj-addon tag, NO collection tag, and seo.hidden", async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL, 'addons');

    const setCall = calls.find((c) => c.query.includes('productSet'))!;
    const input = setCall.variables!.input as Record<string, unknown>;
    expect(input.tags).toEqual(['cj-import', 'cj-pid-P1', 'cj-addon']); // no cj-pet-* tag
    const hide = calls.find((c) => c.query.includes('pawscoutHide'))!;
    const mf = (hide.variables!.metafields as { namespace: string; key: string; value: string }[])[0];
    expect(mf).toMatchObject({ namespace: 'seo', key: 'hidden', value: '1' });
    expect((await store.getLink('P1'))?.category).toBe('addons');
  });

  it('a VISIBLE add-on joins a collection and is un-hidden (suppressFromBrowse=false)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const visibleCfg = { ...CFG, addons: { ...CFG.addons, suppressFromBrowse: false } };
    // DETAIL resolves to a mapped category (pet-toys) so it gets that collection tag.
    await importProduct(store, fakeAdmin(calls), visibleCfg, DETAIL, 'addons');
    const setCall = calls.find((c) => c.query.includes('productSet'))!;
    const tags = (setCall.variables!.input as { tags: string[] }).tags;
    expect(tags).toContain('cj-addon');
    expect(tags.some((t) => t.startsWith('cj-pet-'))).toBe(true); // joined a real collection
    // seo.hidden set to '0' (visible), not '1'
    const hide = calls.find((c) => c.query.includes('pawscoutHide'))!;
    expect((hide.variables!.metafields as { value: string }[])[0].value).toBe('0');
  });

  it('non-addon imports never touch seo.hidden', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL);
    expect(calls.some((c) => c.query.includes('pawscoutHide'))).toBe(false);
  });

  it('creates, publishes, and records the link with tags and computed prices', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL);

    const setCall = calls.find((c) => c.query.includes('productSet'))!;
    const input = setCall.variables!.input as Record<string, unknown>;
    expect(input.tags).toEqual(['cj-import', 'cj-pid-P1', 'cj-pet-toys', 'affiliate-eligible']);
    expect((input.variants as { price: string }[]).map((v) => v.price)).toEqual(['19.99', '23.99']);
    expect(calls.some((c) => c.query.includes('publishablePublish'))).toBe(true);

    const link = await store.getLink('P1');
    expect(link).toMatchObject({ state: 'imported', shopify_product_id: 'gid://shopify/Product/1', handle: 'dog-toy-rope', category: 'pet-toys' });
  });

  it('creates tracked DENY inventory at the primary location when stock is known', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const detail = {
      ...DETAIL,
      stock: 30,
      variants: [
        { vid: 'v1', name: 'Red', sellPriceUsd: 10, sku: 'S1', stock: 30 },
        { vid: 'v2', name: 'Blue', sellPriceUsd: 12, sku: 'S2', stock: 15 }
      ]
    };
    await importProduct(store, fakeAdmin(calls), CFG, detail);

    const input = calls.find((c) => c.query.includes('productSet'))!.variables!.input as {
      variants: { inventoryPolicy?: string; inventoryItem?: { tracked?: boolean; cost?: string }; inventoryQuantities?: { locationId: string; quantity: number }[] }[];
    };
    expect(input.variants[0].inventoryPolicy).toBe('DENY');
    // 1.1: honest landed COGS written to Cost-per-item at import ($10 × 0.78 = £7.80)
    expect(input.variants[0].inventoryItem).toEqual({ tracked: true, cost: '7.80' });
    expect(input.variants[1].inventoryItem!.cost).toBe('9.36'); // $12 × 0.78
    expect(input.variants[0].inventoryQuantities![0]).toMatchObject({ locationId: 'gid://shopify/Location/1', quantity: 30 });
    expect(input.variants[1].inventoryQuantities![0].quantity).toBe(15);
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(true);
  });

  it('imports untracked when stock is unknown (never tracked-at-zero)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL); // DETAIL has no stock
    const input = calls.find((c) => c.query.includes('productSet'))!.variables!.input as {
      variants: { inventoryPolicy?: string }[];
    };
    expect(input.variants[0].inventoryPolicy).toBeUndefined();
    expect(calls.some((c) => c.query.includes('pawscoutLocation'))).toBe(false);
  });

  it('marks the link failed when Shopify rejects the product, without throwing', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const admin = fakeAdmin(calls, { productSet: { productSet: { product: null, userErrors: [{ field: null, message: 'Title taken' }] } } });
    await importProduct(store, admin, CFG, DETAIL);
    expect((await store.getLink('P1'))?.state).toBe('failed');
  });

  it('revives an archived product instead of duplicating it', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'archived', shopifyProductId: 'gid://shopify/Product/1', handle: 'dog-toy-rope' });
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL);

    expect(calls).toHaveLength(1); // single productUpdate, no productSet
    expect(calls[0].query).toContain('productUpdate');
    expect((calls[0].variables!.input as { status: string }).status).toBe('ACTIVE');
    expect((await store.getLink('P1'))?.state).toBe('imported');
  });

  it('is a no-op when already imported', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://1', handle: 'x' });
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL);
    expect(calls).toHaveLength(0);
  });
});

describe('hero-image QA (vision)', () => {
  const cjStub = () => ({
    stockByPid: async () => new Map([['v1', 50]]),
    // local-for-local (2026-07-05): confirmAndImport verifies a home-local
    // warehouse really stocks the item; the fixture is GB-stocked.
    originsByPid: async () => ({ GB: 50 }),
    freightEstimate: async () => null
  } as unknown as CjClient);

  it('confirmAndImport promotes the pickHero-chosen image to the featured slot', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    // DETAIL.images = [.../1.jpg, .../2.jpg]; pickHero returns index 1 → it moves to front.
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), CFG, DETAIL, 'pet-toys', undefined, async () => ({ ok: true, index: 1 }));
    const files = (calls.find((c) => c.query.includes('productSet'))!.variables!.input as { files: { originalSource: string }[] }).files;
    expect(files.map((f) => f.originalSource)).toEqual(['https://i/2.jpg', 'https://i/1.jpg']);
  });

  // --- Local-for-local gate (owner's governing model, 2026-07-05) ---

  it('confirmAndImport blocks a CN-only product: no home-local warehouse, no import', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cnOnly = { ...DETAIL, pid: 'CNONLY', origins: { CN: 900 } };
    const ret = await confirmAndImport(store, cjStub(), fakeAdmin(calls), CFG, cnOnly, 'pet-toys');
    expect(ret).toBeNull(); // a gate rejection returns null - callers must not cache it
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(false);
    expect((await store.getLink('CNONLY'))?.state).toBe('failed');
  });

  it('confirmAndImport fails CLOSED when the origin cannot be verified at all', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cj = {
      stockByPid: async () => new Map([['v1', 50]]),
      originsByPid: async () => { throw new Error('CJ inventory endpoint down'); },
      freightEstimate: async () => null
    } as unknown as CjClient;
    await confirmAndImport(store, cj, fakeAdmin(calls), CFG, { ...DETAIL, pid: 'UNKNOWN' }, 'pet-toys');
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(false);
    expect((await store.getLink('UNKNOWN'))?.state).toBe('failed');
  });

  it('confirmAndImport verifies origins live when the detail lacks them (GB stock admits)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    // DETAIL has no origins map; the cjStub answers { GB: 50 } → import proceeds.
    const ret = await confirmAndImport(store, cjStub(), fakeAdmin(calls), CFG, { ...DETAIL, pid: 'LIVEGB' }, 'pet-toys');
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(true);
    // An attempted import returns the gate-ENRICHED detail (here: the live-verified
    // origins) so callers persist the same numbers the gates judged.
    expect(ret?.origins).toEqual({ GB: 50 });
  });

  it('confirmAndImport blocks a non-pet item on the mechanical fallback (no curation)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const nonPet: CjDetail = { ...DETAIL, pid: 'JUNK', nameEn: 'Kitchen Knife Sharpener', categoryName: 'Home Kitchen' };
    // no curate, no pickHero → mechanical path → pet-relevance floor rejects it.
    await confirmAndImport(store, {} as unknown as CjClient, fakeAdmin(calls), CFG, nonPet, 'pet-toys');
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(false);
    expect((await store.getLink('JUNK'))?.state).toBe('failed');
  });

  it('confirmAndImport leaves order untouched when pickHero returns null', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), CFG, DETAIL, 'pet-toys', undefined, async () => ({ ok: true, index: null }));
    const files = (calls.find((c) => c.query.includes('productSet'))!.variables!.input as { files: { originalSource: string }[] }).files;
    expect(files.map((f) => f.originalSource)).toEqual(['https://i/1.jpg', 'https://i/2.jpg']);
  });

  it('confirmAndImport drops an incongruent image so it never enters Shopify', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    // DETAIL.images = [.../1.jpg, .../2.jpg]; vet keeps hero=1 and drops index 0 → only 2.jpg uploaded.
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), CFG, DETAIL, 'pet-toys', undefined, async () => ({ ok: true, index: 1, drop: [0] }));
    const files = (calls.find((c) => c.query.includes('productSet'))!.variables!.input as { files: { originalSource: string }[] }).files;
    expect(files.map((f) => f.originalSource)).toEqual(['https://i/2.jpg']);
  });

  function heroAdmin(calls: Call[], featuredId: string, nodes: { id: string; url: string }[], sig?: string, title = 'Grooming Set'): AdminGraphql {
    return async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutMedia')) {
        return { product: { title, featuredMedia: { id: featuredId }, metafield: sig ? { value: sig } : null, media: { nodes: nodes.map((n) => ({ id: n.id, image: { url: n.url } })) } } };
      }
      if (query.includes('productDeleteMedia')) return { productDeleteMedia: { deletedMediaIds: (variables!.mediaIds as string[]), mediaUserErrors: [], userErrors: [] } };
      if (query.includes('productReorderMedia')) return { productReorderMedia: { mediaUserErrors: [], userErrors: [] } };
      if (query.includes('productUpdate')) return { productUpdate: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } };
      if (query.includes('metafieldsSet')) return { metafieldsSet: { userErrors: [] } };
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    };
  }

  it('reconcileHeroImages reorders the chosen media to position 0 and records the signature', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }, { id: 'gid://m/2', url: 'https://i/2.jpg' }]);
    const r = await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: 2 }));
    expect(r).toEqual({ scanned: 1, fixed: 1, total: 1, next: null });
    expect(calls.find((c) => c.query.includes('productReorderMedia'))!.variables!.moves).toEqual([{ id: 'gid://m/2', newPosition: '0' }]);
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(true); // signature cached
  });

  it('reconcileHeroImages deletes incongruent media from Shopify and caches the kept signature', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const nodes = [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }, { id: 'gid://m/2', url: 'https://i/2.jpg' }];
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', nodes);
    // vet: hero is index 2 (dog), drop indices 0 and 1 (cats).
    const r = await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: 2, drop: [0, 1] }));
    expect(r).toEqual({ scanned: 1, fixed: 1, total: 1, next: null });
    const del = calls.find((c) => c.query.includes('productDeleteMedia'));
    expect(del!.variables!.mediaIds).toEqual(['gid://m/0', 'gid://m/1']);
    // hero (m/2) promoted, and signature recorded over the KEPT set only (m/2)
    expect(calls.find((c) => c.query.includes('productReorderMedia'))!.variables!.moves).toEqual([{ id: 'gid://m/2', newPosition: '0' }]);
    const sigCall = calls.find((c) => c.query.includes('metafieldsSet'));
    expect((sigCall!.variables!.mf as { value: string }[])[0].value).toBe(mediaSignature(['gid://m/2']));
  });

  it('reconcileHeroImages never deletes the whole gallery (keeps media even if all flagged)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const nodes = [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }];
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', nodes);
    // drop targets both images (hero excluded by the picker contract; here drop = all nodes) → must NOT delete.
    await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: 0, drop: [0, 1] }));
    expect(calls.some((c) => c.query.includes('productDeleteMedia'))).toBe(false);
  });

  it('reconcileHeroImages skips (no LLM call) a product already checked at this media state', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const ids = ['gid://m/0', 'gid://m/1', 'gid://m/2'];
    const sig = mediaSignature(ids); // already carries the CURRENT VET_VERSION → skip
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', ids.map((id) => ({ id, url: id + '.jpg' })), sig);
    let pickCalls = 0;
    const r = await reconcileHeroImages(store, admin, CFG, async () => { pickCalls++; return { ok: true, index: 2 }; });
    expect(r).toEqual({ scanned: 1, fixed: 0, total: 1, next: null });
    expect(pickCalls).toBe(0); // current-version signature matched → no vision call
    expect(calls.some((c) => c.query.includes('productReorderMedia'))).toBe(false);
  });

  it('reconcileHeroImages re-vets a product whose stored signature is from an older vet version', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const ids = ['gid://m/0', 'gid://m/1', 'gid://m/2'];
    // Same media hash, but tagged with a PRIOR VET_VERSION (v2) - the shape a
    // product carries after an earlier sweep, before the overlay-dropping bump.
    const staleSig = 'v2:' + mediaSignature(ids).split(':')[1];
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', ids.map((id) => ({ id, url: id + '.jpg' })), staleSig);
    let pickCalls = 0;
    await reconcileHeroImages(store, admin, CFG, async () => { pickCalls++; return { ok: true, index: 2 }; });
    expect(pickCalls).toBe(1); // older-version signature no longer matches → re-vetted
    const sigCall = calls.find((c) => c.query.includes('metafieldsSet'));
    expect((sigCall!.variables!.mf as { value: string }[])[0].value).toBe(mediaSignature(ids));
  });

  it('reconcileHeroImages caps an over-long product title in place', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const longTitle = ('Durable Dog Chew Toy ').repeat(12).trim(); // 251 chars, > 150
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }], undefined, longTitle);
    await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: 0 }));
    const upd = calls.find((c) => c.query.includes('productUpdate'));
    expect(upd).toBeTruthy();
    const input = upd!.variables!.input as { title: string };
    expect(input.title.length).toBeLessThanOrEqual(150);
    expect(input.title).toBe(capTitle(longTitle));
  });

  it('reconcileHeroImages leaves a short title untouched (no productUpdate)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }], undefined, 'Short Dog Toy');
    await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: 1 }));
    expect(calls.some((c) => c.query.includes('productUpdate'))).toBe(false);
  });

  it('reconcileHeroImages does NOT cache when the model could not decide (ok:false)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }]);
    const r = await reconcileHeroImages(store, admin, CFG, async () => ({ ok: false, index: null }));
    expect(r).toEqual({ scanned: 1, fixed: 0, total: 1, next: null });
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(false); // not cached → retried next run
  });

  it('reconcileHeroImages leaves an all-overlay product untouched (no delete, no signature) for the re-image sweep', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }, { id: 'gid://m/2', url: 'https://i/2.jpg' }]);
    // heroClean:false with a drop list that WOULD strip the gallery - must be ignored.
    const r = await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: null, drop: [1, 2], heroClean: false }));
    expect(r).toEqual({ scanned: 1, fixed: 0, total: 1, next: null });
    expect(calls.some((c) => c.query.includes('productDeleteMedia'))).toBe(false); // no strip-to-one
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(false); // no sig claim → catalog sweep re-images it
  });

  it('reconcileHeroImages records the signature even when no reorder is needed (index already featured)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-toys' });
    const calls: Call[] = [];
    // pickHero picks index 2, but media[2] is already the featured one → no reorder, but still cached.
    const admin = heroAdmin(calls, 'gid://m/2', [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }, { id: 'gid://m/2', url: 'https://i/2.jpg' }]);
    const r = await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: 2 }));
    expect(r).toEqual({ scanned: 1, fixed: 0, total: 1, next: null });
    expect(calls.some((c) => c.query.includes('productReorderMedia'))).toBe(false);
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(true);
  });

  it('reconcileHeroImages never lets one product failure abort the sweep', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'bad', state: 'imported', shopifyProductId: 'gid://shopify/Product/bad', handle: 'b', category: 'pet-toys' });
    await store.putLink({ cjPid: 'ok', state: 'imported', shopifyProductId: 'gid://shopify/Product/ok', handle: 'o', category: 'pet-toys' });
    const calls: Call[] = [];
    const admin: AdminGraphql = async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutMedia')) {
        if ((variables!.id as string).includes('bad')) throw new Error('media fetch boom');
        return { product: { title: 'OK', featuredMedia: { id: 'gid://m/0' }, metafield: null, media: { nodes: [{ id: 'gid://m/0', image: { url: 'https://i/0.jpg' } }, { id: 'gid://m/1', image: { url: 'https://i/1.jpg' } }] } } };
      }
      if (query.includes('productReorderMedia')) return { productReorderMedia: { mediaUserErrors: [], userErrors: [] } };
      if (query.includes('metafieldsSet')) return { metafieldsSet: { userErrors: [] } };
      throw new Error('unexpected');
    };
    const r = await reconcileHeroImages(store, admin, CFG, async () => ({ ok: true, index: 1 }));
    expect(r).toEqual({ scanned: 2, fixed: 1, total: 2, next: null }); // bad product swallowed, ok product fixed
  });
});

describe('reconcileCatalogImages (full-catalog re-image)', () => {
  type Node = { id: string; title?: string; tags?: string[]; featuredMedia?: { id: string } | null; heroSig?: string | null; reimaged?: string | null; media: { id: string; url: string }[] };
  function node(over: Partial<Node> & { id: string }): Node {
    return { title: 'Pet Dental Wipes', tags: ['cj-pid-PID1'], featuredMedia: { id: over.media?.[0]?.id ?? 'gid://m/0' }, heroSig: null, reimaged: null, media: [], ...over };
  }
  function catalogAdmin(calls: Call[], nodes: Node[], hasNextPage = false, endCursor: string | null = null): AdminGraphql {
    return async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutCatalogPage')) {
        return { products: { pageInfo: { hasNextPage, endCursor }, nodes: nodes.map((n) => ({
          id: n.id, title: n.title, tags: n.tags, featuredMedia: n.featuredMedia,
          heroSig: n.heroSig ? { value: n.heroSig } : null,
          reimaged: n.reimaged ? { value: n.reimaged } : null,
          media: { nodes: n.media.map((m) => ({ id: m.id, image: { url: m.url } })) },
        })) } };
      }
      if (query.includes('productUpdate')) return { productUpdate: { product: { id: 'x' }, userErrors: [] } };
      if (query.includes('productReorderMedia')) return { productReorderMedia: { mediaUserErrors: [], userErrors: [] } };
      if (query.includes('productCreateMedia')) return { productCreateMedia: { media: [{ id: 'gid://m/new' }], mediaUserErrors: [] } };
      if (query.includes('tagsAdd')) return { tagsAdd: { userErrors: [] } };
      if (query.includes('metafieldsSet')) return { metafieldsSet: { userErrors: [] } };
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    };
  }
  // A pickHero stub that returns queued results and records how it was called.
  function pickStub(results: HeroPick[]): { fn: PickHeroFn; calls: { title: string; urls: string[]; opts?: { maxImages?: number } }[] } {
    const calls: { title: string; urls: string[]; opts?: { maxImages?: number } }[] = [];
    let i = 0;
    const fn: PickHeroFn = async (title, urls, opts) => { calls.push({ title, urls, opts }); return results[Math.min(i++, results.length - 1)]; };
    return { fn, calls };
  }
  const cjWith = (images: string[]): Pick<CjClient, 'detail'> => ({ detail: async () => ({ images } as unknown as CjDetail) });
  const media3 = [{ id: 'gid://m/0', url: 'https://i/0.jpg' }, { id: 'gid://m/1', url: 'https://i/1.jpg' }, { id: 'gid://m/2', url: 'https://i/2.jpg' }];

  it('promotes a clean shot already in the gallery to primary (no CJ fetch)', async () => {
    const calls: Call[] = [];
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', featuredMedia: { id: 'gid://m/0' }, media: media3 })]);
    const cj = cjWith(['should-not-be-used']);
    let cjHits = 0;
    const wrapped: Pick<CjClient, 'detail'> = { detail: async (p) => { cjHits++; return cj.detail(p); } };
    const pick = pickStub([{ ok: true, index: 2, heroClean: true }]);
    const r = await reconcileCatalogImages(admin, wrapped, pick.fn, {});
    expect(r.reordered).toBe(1);
    expect(r.reimaged).toBe(0);
    expect(cjHits).toBe(0); // clean shot present → supplier never consulted
    expect(calls.some((c) => c.query.includes('productReorderMedia'))).toBe(true);
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(true); // sig recorded
  });

  it('re-images an all-overlay product from the supplier gallery and marks it', async () => {
    const calls: Call[] = [];
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', tags: ['cj-pid-PID1'], featuredMedia: { id: 'gid://m/0' }, media: media3 })]);
    // current-media pick: all overlay (heroClean false) → CJ pick: clean at index 9
    const pick = pickStub([{ ok: true, index: null, heroClean: false }, { ok: true, index: 9, heroClean: true }]);
    const cjImgs = Array.from({ length: 13 }, (_, i) => `https://cj/${i}.jpg`);
    const r = await reconcileCatalogImages(admin, cjWith(cjImgs), pick.fn, {});
    expect(r.reimaged).toBe(1);
    expect(r.worklisted).toBe(0);
    const created = calls.find((c) => c.query.includes('productCreateMedia'));
    expect(created).toBeTruthy();
    expect((created!.variables!.media as { originalSource: string }[])[0].originalSource).toBe('https://cj/9.jpg');
    // the CJ re-pick must be given the larger cap so it can see image #9 (past the default 8)
    expect(pick.calls[1].opts?.maxImages).toBe(16);
    // cj_reimaged marker set; hero_sig NOT recorded (media changed → re-vet next pass)
    const metas = calls.filter((c) => c.query.includes('metafieldsSet')).map((c) => (c.variables!.mf as { key: string }[])[0].key);
    expect(metas).toContain('cj_reimaged');
    expect(metas).not.toContain('hero_sig');
  });

  it('worklist-tags an all-overlay product when the supplier has no clean shot either', async () => {
    const calls: Call[] = [];
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', media: media3 })]);
    const pick = pickStub([{ ok: true, index: null, heroClean: false }, { ok: true, index: 0, heroClean: false }]);
    const r = await reconcileCatalogImages(admin, cjWith(['https://cj/0.jpg', 'https://cj/1.jpg']), pick.fn, {});
    expect(r.worklisted).toBe(1);
    expect(r.reimaged).toBe(0);
    const tag = calls.find((c) => c.query.includes('tagsAdd'));
    expect((tag!.variables!.tags as string[])).toContain(NEEDS_IMAGE_TAG);
    expect(calls.some((c) => c.query.includes('productCreateMedia'))).toBe(false);
  });

  it('worklist-tags an all-overlay product with no cj-pid tag (no re-image possible)', async () => {
    const calls: Call[] = [];
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', tags: ['cj-import'], media: media3 })]);
    const pick = pickStub([{ ok: true, index: null, heroClean: false }]);
    const r = await reconcileCatalogImages(admin, cjWith(['x', 'y']), pick.fn, {});
    expect(r.worklisted).toBe(1);
    expect(calls.some((c) => c.query.includes('productCreateMedia'))).toBe(false);
  });

  it('does not re-add when the product is already cj_reimaged (all-overlay marker set)', async () => {
    const calls: Call[] = [];
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', reimaged: '1', media: media3 })]);
    const pick = pickStub([{ ok: true, index: null, heroClean: false }]);
    const r = await reconcileCatalogImages(admin, cjWith(['x', 'y', 'z']), pick.fn, {});
    expect(calls.some((c) => c.query.includes('productCreateMedia'))).toBe(false);
    expect(r.worklisted).toBe(1);
  });

  it('caps an over-long title in place regardless of image state', async () => {
    const calls: Call[] = [];
    const longTitle = ('Durable Dog Chew Toy ').repeat(12).trim(); // > 150
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', title: longTitle, heroSig: mediaSignature(['gid://m/0', 'gid://m/1', 'gid://m/2']), media: media3 })]);
    const pick = pickStub([{ ok: true, index: 1, heroClean: true }]);
    const r = await reconcileCatalogImages(admin, cjWith([]), pick.fn, {});
    expect(r.titleFixed).toBe(1);
    const upd = calls.find((c) => c.query.includes('productUpdate'));
    expect((upd!.variables!.input as { title: string }).title).toBe(capTitle(longTitle));
  });

  it('skips vision when the stored signature already matches the current media', async () => {
    const calls: Call[] = [];
    const sig = mediaSignature(['gid://m/0', 'gid://m/1', 'gid://m/2']);
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', title: 'Short Toy', heroSig: sig, media: media3 })]);
    const pick = pickStub([{ ok: true, index: 2, heroClean: true }]);
    let vision = 0;
    const spy: PickHeroFn = async (t, u, o) => { vision++; return pick.fn(t, u, o); };
    await reconcileCatalogImages(admin, cjWith([]), spy, {});
    expect(vision).toBe(0); // sig match → no vision, no reorder
    expect(calls.some((c) => c.query.includes('productReorderMedia'))).toBe(false);
  });

  it('returns the endCursor as nextCursor only when another page remains', async () => {
    const more = catalogAdmin([], [node({ id: 'gid://shopify/Product/1', media: media3 })], true, 'CURSOR2');
    const last = catalogAdmin([], [node({ id: 'gid://shopify/Product/1', media: media3 })], false, null);
    const pick = pickStub([{ ok: true, index: null, heroClean: true }]);
    expect((await reconcileCatalogImages(more, cjWith([]), pick.fn, {})).nextCursor).toBe('CURSOR2');
    expect((await reconcileCatalogImages(last, cjWith([]), pick.fn, {})).nextCursor).toBe(null);
  });

  it('leaves single-image products untouched (nothing to reorder)', async () => {
    const calls: Call[] = [];
    const admin = catalogAdmin(calls, [node({ id: 'gid://shopify/Product/1', title: 'Short', media: [{ id: 'gid://m/0', url: 'https://i/0.jpg' }] })]);
    const pick = pickStub([{ ok: true, index: 0, heroClean: false }]);
    let vision = 0;
    const spy: PickHeroFn = async (t, u, o) => { vision++; return pick.fn(t, u, o); };
    const r = await reconcileCatalogImages(admin, cjWith(['x', 'y']), spy, {});
    expect(vision).toBe(0);
    expect(r.reimaged).toBe(0);
    expect(r.worklisted).toBe(0);
  });

  it('cjPidFromTags reads the universal cj-pid-<pid> tag', () => {
    expect(cjPidFromTags(['cj-import', 'cj-pid-123456', 'x'])).toBe('123456');
    expect(cjPidFromTags(['cj-import'])).toBe(null);
    expect(cjPidFromTags(undefined)).toBe(null);
  });
});

describe('curateDetailImages (preview + cache)', () => {
  const D3: CjDetail = { ...DETAIL, pid: 'C1', images: ['https://i/a.jpg', 'https://i/b.jpg', 'https://i/c.jpg'] };

  it('drops incongruent images, promotes the hero, caches, and reuses the cache (one vision call)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    let calls = 0;
    const vet = async () => { calls++; return { ok: true, index: 2, drop: [0] }; }; // hero=c, drop a
    const r1 = await curateDetailImages(store, D3, vet);
    expect(r1.congruent).toBe(true);
    expect(r1.detail.images).toEqual(['https://i/c.jpg', 'https://i/b.jpg']);
    // second call at the same media state: served from cache, no vision call
    const r2 = await curateDetailImages(store, D3, vet);
    expect(calls).toBe(1);
    expect(r2.detail.images).toEqual(['https://i/c.jpg', 'https://i/b.jpg']);
    // and the search grid can read that hero
    expect((await store.getHeroImages(['C1'])).get('C1')).toBe('https://i/c.jpg');
  });

  it('reports congruent=false when no image matches the title', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const r = await curateDetailImages(store, D3, async () => ({ ok: true, index: null, drop: [0, 1, 2] }));
    expect(r.congruent).toBe(false);
  });

  it('leaves images raw (no cache) when there is no LLM', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const r = await curateDetailImages(store, D3, undefined);
    expect(r.detail.images).toEqual(D3.images);
    expect((await store.getHeroImages(['C1'])).size).toBe(0);
  });

  it('vetOrder keeps hero-first and drops incongruent indices', () => {
    expect(vetOrder(['a', 'b', 'c'], { ok: true, index: 2, drop: [0] })).toEqual([2, 1]);
    expect(vetOrder(['a', 'b'], { ok: true, index: null })).toEqual([0, 1]);
    expect(vetOrder(['a', 'b'], { ok: true, index: null, drop: [0, 1] })).toEqual([]);
  });
});

describe('description QA', () => {
  it('needsDescriptionRewrite flags raw CJ copy but not clean prose', () => {
    expect(needsDescriptionRewrite('<img src="https://cf.cjdropshipping.com/x.jpg">')).toBe(true);
    expect(needsDescriptionRewrite('<p>We accept returns and refunds within 30 days</p>')).toBe(true);
    expect(needsDescriptionRewrite('<p>delivered within 1-3 working days</p>')).toBe(true);
    expect(needsDescriptionRewrite('<div class="cj-description">...</div>')).toBe(true);
    expect(needsDescriptionRewrite('<p>A soft finger toothbrush that helps maintain fresh breath.</p>')).toBe(false);
  });

  function descAdmin(calls: Call[], html: string): AdminGraphql {
    return async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutDesc') && query.includes('query')) {
        return { product: { title: 'Finger Toothbrush', descriptionHtml: html } };
      }
      if (query.includes('productUpdate')) return { productUpdate: { product: { id: 'x' }, userErrors: [] } };
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    };
  }

  it('rewrites a raw legacy description and skips an already-clean one', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'raw', state: 'imported', shopifyProductId: 'gid://shopify/Product/raw', handle: 'r', category: 'pet-health' });
    const callsRaw: Call[] = [];
    const rewrite = async () => '<p>Clean copy.</p>';
    const r1 = await reconcileDescriptions(store, descAdmin(callsRaw, '<div class="cj-description">prevent oral diseases</div>'), CFG, rewrite);
    expect(r1).toEqual({ scanned: 1, rewritten: 1, total: 1, next: null });
    expect(callsRaw.some((c) => c.query.includes('productUpdate'))).toBe(true);

    const callsClean: Call[] = [];
    const r2 = await reconcileDescriptions(store, descAdmin(callsClean, '<p>A soft toothbrush that helps maintain fresh breath.</p>'), CFG, rewrite);
    expect(r2).toEqual({ scanned: 1, rewritten: 0, total: 1, next: null }); // clean → no LLM, no update
    expect(callsClean.some((c) => c.query.includes('productUpdate'))).toBe(false);
  });

  it('skips when the rewrite returns null (LLM failure leaves the listing untouched)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'raw', state: 'imported', shopifyProductId: 'gid://shopify/Product/raw', handle: 'r', category: 'pet-health' });
    const calls: Call[] = [];
    const r = await reconcileDescriptions(store, descAdmin(calls, '<p>Keywords: cheap toy</p>'), CFG, async () => null);
    expect(r).toEqual({ scanned: 1, rewritten: 0, total: 1, next: null });
    expect(calls.some((c) => c.query.includes('productUpdate'))).toBe(false);
  });

  it('pages through the catalog with the offset/next cursor', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    for (const pid of ['p1', 'p2', 'p3']) {
      await store.putLink({ cjPid: pid, state: 'imported', shopifyProductId: `gid://shopify/Product/${pid}`, handle: pid, category: 'pet-health' });
    }
    const admin = descAdmin([], '<div class="cj-description">raw</div>');
    const rewrite = async () => '<p>Clean.</p>';
    const b1 = await reconcileDescriptions(store, admin, CFG, rewrite, { offset: 0, limit: 2 });
    expect(b1).toMatchObject({ scanned: 2, rewritten: 2, total: 3, next: 2 });
    const b2 = await reconcileDescriptions(store, admin, CFG, rewrite, { offset: b1.next!, limit: 2 });
    expect(b2).toMatchObject({ scanned: 1, rewritten: 1, total: 3, next: null });
  });
});

describe('reconcileCategories (re-audit)', () => {
  const CATCFG: TenantConfig = {
    ...CFG,
    collectionMap: {
      'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' },
      'pet-health': { handle: 'pet-health', tag: 'cj-pet-health' },
      'pet-grooming': { handle: 'pet-grooming', tag: 'cj-pet-grooming' },
      'pet-accessories': { handle: 'pet-accessories', tag: 'cj-pet-accessories' },
      'more-to-love': { handle: 'more-to-love', tag: 'cj-pet-more-to-love' }
    }
  };
  function catAdmin(calls: Call[], title: string): AdminGraphql {
    return async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutTitle')) return { product: { title } };
      if (query.includes('tagsAdd')) return { tagsAdd: { userErrors: [] } };
      if (query.includes('tagsRemove')) return { tagsRemove: { userErrors: [] } };
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    };
  }

  it('re-files a product whose title clearly belongs elsewhere', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://shopify/Product/1', handle: 'h1', category: 'pet-grooming' });
    const calls: Call[] = [];
    const r = await reconcileCategories(store, catAdmin(calls, 'Pet Dental Wipes for Teeth & Gum Care'), CATCFG);
    expect(r).toMatchObject({ scanned: 1, moved: 1 });
    expect(calls.find((c) => c.query.includes('tagsRemove'))!.variables!.tags).toEqual(['cj-pet-grooming']);
    expect(calls.find((c) => c.query.includes('tagsAdd'))!.variables!.tags).toEqual(['cj-pet-health']);
    expect((await store.getLink('P1'))?.category).toBe('pet-health');
  });

  it('leaves a product with mixed signals where it is', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P2', state: 'imported', shopifyProductId: 'gid://shopify/Product/2', handle: 'h2', category: 'pet-toys' });
    const calls: Call[] = [];
    const r = await reconcileCategories(store, catAdmin(calls, 'Tug Ball Tooth-Cleaning Dog Toy'), CATCFG);
    expect(r.moved).toBe(0);
    expect(calls.some((c) => c.query.includes('tagsAdd'))).toBe(false);
    expect((await store.getLink('P2'))?.category).toBe('pet-toys');
  });

  it('assigns an orphan (no collection) when its title gives a clear signal', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P3', state: 'imported', shopifyProductId: 'gid://shopify/Product/3', handle: 'h3', category: null });
    const calls: Call[] = [];
    const r = await reconcileCategories(store, catAdmin(calls, 'Pet Tooth Cleaning Pen'), CATCFG);
    expect(r).toMatchObject({ scanned: 1, moved: 1 });
    expect(calls.some((c) => c.query.includes('tagsRemove'))).toBe(false); // orphan has no old tag to drop
    expect(calls.find((c) => c.query.includes('tagsAdd'))!.variables!.tags).toEqual(['cj-pet-health']);
    expect((await store.getLink('P3'))?.category).toBe('pet-health');
  });

  it('leaves an orphan with no clear signal uncategorised', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P4', state: 'imported', shopifyProductId: 'gid://shopify/Product/4', handle: 'h4', category: null });
    const calls: Call[] = [];
    const r = await reconcileCategories(store, catAdmin(calls, 'Mystery Gadget'), CATCFG);
    expect(r.moved).toBe(0);
    expect(calls.some((c) => c.query.includes('tagsAdd'))).toBe(false);
    expect((await store.getLink('P4'))?.category ?? null).toBeNull();
  });

  it('does not move a product already in its signaled category', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P3', state: 'imported', shopifyProductId: 'gid://shopify/Product/3', handle: 'h3', category: 'pet-health' });
    const r = await reconcileCategories(store, catAdmin([], 'Pet Dental Wipes'), CATCFG);
    expect(r.moved).toBe(0);
  });
});

describe('confirmAndImport profitability gate (dormant unless cfg.profit.enabled)', () => {
  // GB-stocked so the local-for-local + live-stock gates pass and the profit
  // gate is what decides. Uses the LIVE capped pricing (2.2x + GBP30 margin cap):
  // a $140 unit is capped at GBP30 margin yet ads (~33% of gross) exceed the cap,
  // so its net-after-ads is deeply negative - a per-unit money-loser. (The default
  // 2.5x/uncapped pricing would net this positive, which is why the cap matters.)
  const CAPPED = { ...DEFAULT_PRICING, multiplier: 2.2, maxMarginGbp: 30 };
  const cjStub = () => ({
    stockByPid: async () => new Map([['v1', 50]]),
    originsByPid: async () => ({ GB: 50 }),
    freightEstimate: async () => null
  } as unknown as CjClient);
  const lossDetail = (pid: string): CjDetail => ({
    ...DETAIL, pid, variants: [{ vid: 'v1', name: 'Default', sellPriceUsd: 140, sku: 'S1' }]
  });

  it('hard-blocks a per-unit money-loser when enabled + hardBlock (no import)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cfg = { ...CFG, pricing: CAPPED, profit: { ...DEFAULT_PROFIT, enabled: true, hardBlock: true } };
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, lossDetail('LOSS1'), 'pet-toys');
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(false);
    expect((await store.getLink('LOSS1'))?.state).toBe('failed');
  });

  it('imports a money-loser as a REVIEW DRAFT when enabled without hardBlock (observe mode)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cfg = { ...CFG, pricing: CAPPED, profit: { ...DEFAULT_PROFIT, enabled: true, hardBlock: false } };
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, lossDetail('LOSS2'), 'pet-toys');
    const setCall = calls.find((c) => c.query.includes('productSet'))!;
    const input = setCall.variables!.input as { status: string; tags: string[] };
    expect(input.status).toBe('DRAFT');
    expect(input.tags).toContain('cj-profit-review');
    expect(calls.some((c) => c.query.includes('publishablePublish'))).toBe(false); // draft, not published
    expect((await store.getLink('LOSS2'))?.state).toBe('draft');
  });

  it('ignores profit entirely when disabled (default cfg) - the same money-loser still imports normally', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cfg = { ...CFG, pricing: CAPPED }; // no profit block => dormant
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, lossDetail('OK1'), 'pet-toys');
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(true);
    expect((await store.getLink('OK1'))?.state).toBe('imported');
  });
});

describe('confirmAndImport competition check at entry (competitionCheckOnImport)', () => {
  // DETAIL's rule stickers are 19.99/23.99 (DEFAULT_PRICING); at the live ad share
  // (0.10) they net ~GBP 4.20/5.04 so the DETERMINISTIC gate passes and the
  // competition check is what decides. A ~GBP12 delivered market forces pricing to
  // GBP10.99 (5% undercut, .99), where the worst variant nets ~-GBP1.44 -> fail; a
  // ~GBP40 market prices to GBP37.99, worst net ~GBP15 -> pass.
  const PROFIT = { ...DEFAULT_PROFIT, enabled: true, competitionCheckOnImport: true, adShareOfRevenue: 0.10 };
  const cjStub = () => ({
    stockByPid: async () => new Map([['v1', 50]]),
    originsByPid: async () => ({ GB: 50 }),
    freightEstimate: async () => null
  } as unknown as CjClient);
  const signalOf = (estimateGbp: number, confidence: 'high' | 'medium' | 'low') =>
    async () => ({ estimateGbp, confidence, sources: ['amazon.co.uk'] });

  it('hard-blocks a product that cannot clear the floor under a HIGH-confidence market', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cfg = { ...CFG, profit: { ...PROFIT, hardBlock: true } };
    const ret = await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, { ...DETAIL, pid: 'MKT1' }, 'pet-toys', undefined, undefined, { competitorCheck: signalOf(12, 'high') });
    expect(ret).toBeNull();
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(false);
    expect((await store.getLink('MKT1'))?.state).toBe('failed');
  });

  it('imports the same failing product as a REVIEW DRAFT without hardBlock', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cfg = { ...CFG, profit: { ...PROFIT, hardBlock: false } };
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, { ...DETAIL, pid: 'MKT2' }, 'pet-toys', undefined, undefined, { competitorCheck: signalOf(12, 'medium') });
    const input = calls.find((c) => c.query.includes('productSet'))!.variables!.input as { status: string; tags: string[] };
    expect(input.status).toBe('DRAFT');
    expect(input.tags).toContain('cj-profit-review');
    expect((await store.getLink('MKT2'))?.state).toBe('draft');
  });

  it('a generous market leaves the import untouched (ACTIVE)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cfg = { ...CFG, profit: { ...PROFIT, hardBlock: true } };
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, { ...DETAIL, pid: 'MKT3' }, 'pet-toys', undefined, undefined, { competitorCheck: signalOf(40, 'high') });
    const input = calls.find((c) => c.query.includes('productSet'))!.variables!.input as { status: string };
    expect(input.status).toBe('ACTIVE');
    expect((await store.getLink('MKT3'))?.state).toBe('imported');
  });

  it('a LOW-confidence signal is no market data: the import proceeds (fail-open)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const cfg = { ...CFG, profit: { ...PROFIT, hardBlock: true } };
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, { ...DETAIL, pid: 'MKT4' }, 'pet-toys', undefined, undefined, { competitorCheck: signalOf(12, 'low') });
    expect((await store.getLink('MKT4'))?.state).toBe('imported');
  });

  it('never consults the closure while the flag is off (no spend without opt-in)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    let consulted = 0;
    const cfg = { ...CFG, profit: { ...PROFIT, competitionCheckOnImport: false, hardBlock: true } };
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), cfg, { ...DETAIL, pid: 'MKT5' }, 'pet-toys', undefined, undefined, {
      competitorCheck: async () => { consulted++; return { estimateGbp: 12, confidence: 'high', sources: [] }; }
    });
    expect(consulted).toBe(0);
    expect((await store.getLink('MKT5'))?.state).toBe('imported');
  });
});

describe('importProduct publish flag', () => {
  it('publish:false revival sets DRAFT status and records link state=draft', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'PA', state: 'archived', shopifyProductId: 'gid://shopify/Product/99', handle: 'archived-product' });
    const ops: { q: string; vars: any }[] = [];
    const admin = (async (q: string, vars: any) => {
      ops.push({ q, vars });
      if (q.includes('productUpdate')) return { productUpdate: { product: { id: 'gid://shopify/Product/99' }, userErrors: [] } };
      return {};
    }) as unknown as AdminGraphql;
    const detail: CjDetail = { pid: 'PA', nameEn: 'Revival Product', images: [], descriptionHtml: 'x', variants: [{ vid: 'VA', name: 'Default', sellPriceUsd: 6, sku: 'SA' }], listedNum: 5, categoryName: 'pet-toys', llmScore: 90 };

    await importProduct(store, admin, CFG, detail, 'pet-toys', { publish: false });

    expect(ops).toHaveLength(1); // single productUpdate, no productSet
    expect(ops[0].q).toContain('productUpdate');
    expect((ops[0].vars.input as { status: string }).status).toBe('DRAFT');
    expect((await store.getLink('PA'))?.state).toBe('draft');
  });

  it('publish:false imports as DRAFT, skips Online-Store publish, and links state=draft', async () => {
    const ops: { q: string; vars: any }[] = [];
    const admin = (async (q: string, vars: any) => {
      ops.push({ q, vars });
      if (q.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/1', handle: 'h' }, userErrors: [] } };
      if (q.includes('publications(')) return { publications: { nodes: [{ id: 'pub1', name: 'Online Store' }] } };
      return {};
    }) as unknown as AdminGraphql;
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const detail: CjDetail = { pid: 'P1', nameEn: 'Dog Brush', images: [], descriptionHtml: 'x', variants: [{ vid: 'V1', name: 'Default', sellPriceUsd: 6, sku: 'S1', stock: 50 }], listedNum: 10, categoryName: 'pet-grooming', stock: 50, llmScore: 90 };

    await importProduct(store, admin, CFG, detail, 'pet-grooming', { publish: false });

    const setOp = ops.find((o) => o.q.includes('productSet'))!;
    expect(setOp.vars.input.status).toBe('DRAFT');
    expect(ops.some((o) => o.q.includes('publishablePublish'))).toBe(false);
    expect((await store.getLink('P1'))?.state).toBe('draft');
  });

  it('default (publish omitted) imports ACTIVE, publishes, links state=imported', async () => {
    const ops: string[] = [];
    const admin = (async (q: string) => {
      ops.push(q);
      if (q.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/2', handle: 'h2' }, userErrors: [] } };
      if (q.includes('publications(')) return { publications: { nodes: [{ id: 'pub1', name: 'Online Store' }] } };
      return {};
    }) as unknown as AdminGraphql;
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const detail: CjDetail = { pid: 'P2', nameEn: 'Cat Toy', images: [], descriptionHtml: 'x', variants: [{ vid: 'V2', name: 'Default', sellPriceUsd: 6, sku: 'S2', stock: 50 }], listedNum: 10, categoryName: 'pet-toys', stock: 50, llmScore: 90 };

    await importProduct(store, admin, CFG, detail, 'pet-toys');

    expect(ops.some((q) => q.includes('publishablePublish'))).toBe(true);
    expect((await store.getLink('P2'))?.state).toBe('imported');
  });
});

describe('confirmAndImport prohibited-item gate (owner 2026-10-02)', () => {
  const cjStub = () => ({
    stockByPid: async () => new Map([['v1', 50]]),
    originsByPid: async () => ({ GB: 50 }),
    freightEstimate: async () => null
  } as unknown as CjClient);

  it('refuses a shock training collar before curation or any Shopify call', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    let curated = 0;
    const detail: CjDetail = { ...DETAIL, pid: 'SHOCK1', nameEn: 'Smart Dog Bark Control Collar', descriptionHtml: '<p>Modes: sound, vibration, shock</p>' };
    const out = await confirmAndImport(store, cjStub(), fakeAdmin(calls), CFG, detail, 'pet-toys', async () => { curated++; return null; });
    expect(out).toBeNull();
    expect(curated).toBe(0);
    expect(calls).toEqual([]);
    const link = await store.getLink('SHOCK1');
    expect(link).toMatchObject({ state: 'failed', fail_reason: 'prohibited-item' });
    expect(link?.fail_detail).toContain('shock');
  });

  it('still imports a shock-absorbing lead', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const detail: CjDetail = { ...DETAIL, pid: 'LEAD1', nameEn: 'Shock Absorbing Bungee Dog Leash' };
    await confirmAndImport(store, cjStub(), fakeAdmin(calls), CFG, detail, 'pet-toys');
    expect(calls.some((c) => c.query.includes('productSet'))).toBe(true);
  });
});
