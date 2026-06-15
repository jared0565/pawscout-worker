import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { importProduct, buildPreview, stripHtml, resolveCategory, confirmAndImport, reconcileHeroImages, reconcileDescriptions, needsDescriptionRewrite, mediaSignature, reconcileCategories } from '../src/proxy/import';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

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
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL,
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
    expect(input.tags).toEqual(['cj-import', 'cj-pid-P1', 'cj-pet-toys']);
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
      variants: { inventoryPolicy?: string; inventoryItem?: { tracked: boolean }; inventoryQuantities?: { locationId: string; quantity: number }[] }[];
    };
    expect(input.variants[0].inventoryPolicy).toBe('DENY');
    expect(input.variants[0].inventoryItem).toEqual({ tracked: true });
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

  function heroAdmin(calls: Call[], featuredId: string, nodes: { id: string; url: string }[], sig?: string): AdminGraphql {
    return async (query, variables) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutMedia')) {
        return { product: { title: 'Grooming Set', featuredMedia: { id: featuredId }, metafield: sig ? { value: sig } : null, media: { nodes: nodes.map((n) => ({ id: n.id, image: { url: n.url } })) } } };
      }
      if (query.includes('productDeleteMedia')) return { productDeleteMedia: { deletedMediaIds: (variables!.mediaIds as string[]), mediaUserErrors: [], userErrors: [] } };
      if (query.includes('productReorderMedia')) return { productReorderMedia: { mediaUserErrors: [], userErrors: [] } };
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
    const sig = mediaSignature(ids);
    const calls: Call[] = [];
    const admin = heroAdmin(calls, 'gid://m/0', ids.map((id) => ({ id, url: id + '.jpg' })), sig);
    let pickCalls = 0;
    const r = await reconcileHeroImages(store, admin, CFG, async () => { pickCalls++; return { ok: true, index: 2 }; });
    expect(r).toEqual({ scanned: 1, fixed: 0, total: 1, next: null });
    expect(pickCalls).toBe(0); // signature matched → no vision call
    expect(calls.some((c) => c.query.includes('productReorderMedia'))).toBe(false);
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

  it('does not move a product already in its signaled category', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P3', state: 'imported', shopifyProductId: 'gid://shopify/Product/3', handle: 'h3', category: 'pet-health' });
    const r = await reconcileCategories(store, catAdmin([], 'Pet Dental Wipes'), CATCFG);
    expect(r.moved).toBe(0);
  });
});
