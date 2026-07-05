import { describe, it, expect } from 'vitest';
import { listLiveMarkets, ensureMarketCatalog, syncMarketExclusions, chunk, type LiveMarket } from '../../src/shipping/market-catalogs';
import type { AdminGraphql } from '../../src/shopify-admin';
import type { LogisticsRoute } from '../../src/logistics';

interface Call { query: string; variables?: Record<string, unknown> }

// Live market fixtures mirroring the verified 2026-07-03 store state: UK primary
// (now IN scope for the visibility phase - it takes a catalog so cross-lane stock
// can be excluded from the home storefront), EU with the adopted linchpin catalog,
// US+CA and AU with no catalogs yet.
const MARKETS_RESPONSE = {
  markets: {
    nodes: [
      { id: 'gid://shopify/Market/uk', name: 'United Kingdom', primary: true, regions: { nodes: [{ code: 'GB' }] }, catalogs: { nodes: [] } },
      {
        id: 'gid://shopify/Market/eu', name: 'European Union', primary: false,
        regions: { nodes: [{ code: 'DE' }, { code: 'FR' }] },
        catalogs: { nodes: [{ id: 'gid://shopify/MarketCatalog/eu1', status: 'ACTIVE', publication: { id: 'gid://shopify/Publication/eu1' } }] }
      },
      { id: 'gid://shopify/Market/usca', name: 'United States and Canada', primary: false, regions: { nodes: [{ code: 'US' }, { code: 'CA' }] }, catalogs: { nodes: [] } },
      { id: 'gid://shopify/Market/au', name: 'Australia', primary: false, regions: { nodes: [{ code: 'AU' }] }, catalogs: { nodes: [] } }
    ]
  }
};

const THROTTLE_MSG = 'The limit for simultaneous publication updates has been exceeded.';

/** Admin mock: markets read, catalog/publication creation, published-state scan,
 * publication updates. Published-state: every product reports `published` unless
 * listed in `unpublished`, and ACTIVE unless listed in `drafts`. `throttleFirst`
 * makes the first N publicationUpdate calls return the live throttle userError
 * before succeeding. */
function marketsAdmin(calls: Call[], opts: { unpublished?: string[]; products?: string[]; drafts?: string[]; throttleFirst?: number } = {}): AdminGraphql {
  const unpublished = new Set(opts.unpublished ?? []);
  const drafts = new Set(opts.drafts ?? []);
  const products = opts.products ?? [];
  let catalogSeq = 0;
  let pubSeq = 0;
  let throttlesLeft = opts.throttleFirst ?? 0;
  return (async (query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes('pawscoutMarketCatalogs')) return MARKETS_RESPONSE;
    if (query.includes('catalogCreate')) return { catalogCreate: { catalog: { id: `gid://shopify/MarketCatalog/new${++catalogSeq}` }, userErrors: [] } };
    if (query.includes('publicationCreate')) return { publicationCreate: { publication: { id: `gid://shopify/Publication/new${++pubSeq}` }, userErrors: [] } };
    if (query.includes('publicationUpdate')) {
      if (throttlesLeft > 0) {
        throttlesLeft--;
        return { publicationUpdate: { publication: null, userErrors: [{ field: null, message: THROTTLE_MSG }] } };
      }
      return { publicationUpdate: { publication: { id: String(variables?.id) }, userErrors: [] } };
    }
    if (query.includes('pawscoutPublishedState')) {
      return { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: products.map((id) => ({ id, status: drafts.has(id) ? 'DRAFT' : 'ACTIVE', publishedOnPublication: !unpublished.has(id) })) } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  }) as unknown as AdminGraphql;
}

// Store stub: GB products ship GB->GB only; the CN hub ships CN->{GB,DE,US,AU};
// matches the CJ-source-verified reality. Route objects only need to satisfy
// resolveNearestRoute.
const route = (from: string, to: string): LogisticsRoute =>
  ({ from_country: from, to_country: to, channel: 'x', transit_min: 5, transit_max: 10, updated_at: new Date().toISOString() } as unknown as LogisticsRoute);
const ROUTES = new Map<string, LogisticsRoute>([
  ['GB|GB', route('GB', 'GB')],
  ['CN|GB', route('CN', 'GB')],
  ['CN|DE', route('CN', 'DE')],
  ['CN|US', route('CN', 'US')],
  ['CN|AU', route('CN', 'AU')]
]);
const storeStub = (memberships: Map<string, string[]>) => ({
  listSignatureMemberships: async () => memberships,
  getLogisticsRoute: async (from: string, to: string) => ROUTES.get(`${from}|${to}`) ?? null
});

const GB_PRODUCT = 'gid://shopify/Product/gb1';
const CN_PRODUCT = 'gid://shopify/Product/cn1';
const MEMBERSHIPS = new Map<string, string[]>([
  ['GB', [GB_PRODUCT]],
  ['CN', [CN_PRODUCT]]
]);

describe('listLiveMarkets', () => {
  it('parses markets with countries, primary flag, and any adopted catalog/publication', async () => {
    const calls: Call[] = [];
    const markets = await listLiveMarkets(marketsAdmin(calls));
    expect(markets).toHaveLength(4);
    const eu = markets.find((m) => m.name === 'European Union')!;
    expect(eu.primary).toBe(false);
    expect(eu.countries).toEqual(['DE', 'FR']);
    expect(eu.catalogId).toBe('gid://shopify/MarketCatalog/eu1');
    expect(eu.publicationId).toBe('gid://shopify/Publication/eu1');
    const uk = markets.find((m) => m.name === 'United Kingdom')!;
    expect(uk.primary).toBe(true);
    expect(uk.catalogId).toBeNull();
  });
});

describe('ensureMarketCatalog', () => {
  it('adopts an existing catalog + publication without creating anything', async () => {
    const calls: Call[] = [];
    const admin = marketsAdmin(calls);
    const market: LiveMarket = { id: 'gid://shopify/Market/eu', name: 'European Union', primary: false, countries: ['DE'], catalogId: 'gid://shopify/MarketCatalog/eu1', publicationId: 'gid://shopify/Publication/eu1' };
    const r = await ensureMarketCatalog(admin, market);
    expect(r).toEqual({ catalogId: 'gid://shopify/MarketCatalog/eu1', publicationId: 'gid://shopify/Publication/eu1' });
    expect(calls).toHaveLength(0); // pure adoption - no mutations
  });

  it('creates catalog then publication when the market has neither', async () => {
    const calls: Call[] = [];
    const admin = marketsAdmin(calls);
    const market: LiveMarket = { id: 'gid://shopify/Market/au', name: 'Australia', primary: false, countries: ['AU'], catalogId: null, publicationId: null };
    const r = await ensureMarketCatalog(admin, market);
    expect(r.catalogId).toMatch(/MarketCatalog\/new/);
    expect(r.publicationId).toMatch(/Publication\/new/);
    const create = calls.find((c) => c.query.includes('catalogCreate'))!;
    const input = create.variables!.input as { title: string; status: string; context: { marketIds: string[] } };
    expect(input.title).toBe('Australia');
    expect(input.context.marketIds).toEqual(['gid://shopify/Market/au']);
    const pub = calls.find((c) => c.query.includes('publicationCreate'))!;
    const pinput = pub.variables!.input as { defaultState: string; autoPublish: boolean };
    expect(pinput.defaultState).toBe('ALL_PRODUCTS');
    expect(pinput.autoPublish).toBe(true);
  });
});

describe('syncMarketExclusions', () => {
  it('reconciles ALL four markets: UK keeps its lane + scaffolding, cross-lane GB stock leaves the rest', async () => {
    const calls: Call[] = [];
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT] }); // everything currently published
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720 });

    expect(r.markets.map((m) => m.name).sort()).toEqual(['Australia', 'European Union', 'United Kingdom', 'United States and Canada']);
    const uk = r.markets.find((m) => m.name === 'United Kingdom')!;
    expect(uk.excluded).toBe(0); // GB local + CN scaffolding both belong
    expect(uk.removed).toBe(0);
    expect(uk.readded).toBe(0);
    for (const m of r.markets.filter((m) => m.name !== 'United Kingdom')) {
      expect(m.excluded).toBe(1); // the GB-only product is cross-lane there
      expect(m.removed).toBe(1);
      expect(m.readded).toBe(0);
    }
    // Every publicationUpdate removes exactly the GB product; the CN product is never touched.
    const updates = calls.filter((c) => c.query.includes('publicationUpdate'));
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect((u.variables!.input as { publishablesToRemove: string[] }).publishablesToRemove).toEqual([GB_PRODUCT]);
    }
    // The UK primary now takes a catalog too (visibility phase): created alongside US+CA and AU.
    const created = calls.filter((c) => c.query.includes('catalogCreate'));
    expect(created.map((c) => (c.variables!.input as { context: { marketIds: string[] } }).context.marketIds[0]).sort())
      .toEqual(['gid://shopify/Market/au', 'gid://shopify/Market/uk', 'gid://shopify/Market/usca']);
  });

  it('is idempotent where the state already matches, and heals the UK catalog by re-adding its own lane', async () => {
    const calls: Call[] = [];
    // GB product unpublished everywhere: correct in EU/US+CA/AU (excluded), but in
    // the UK it BELONGS - the sweep must put it back (fresh-publication population).
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT], unpublished: [GB_PRODUCT] });
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720 });
    const uk = r.markets.find((m) => m.name === 'United Kingdom')!;
    expect(uk.readded).toBe(1);
    expect(uk.removed).toBe(0);
    for (const m of r.markets.filter((m) => m.name !== 'United Kingdom')) {
      expect(m.removed).toBe(0);
      expect(m.readded).toBe(0);
    }
    const updates = calls.filter((c) => c.query.includes('publicationUpdate'));
    expect(updates).toHaveLength(1);
    expect((updates[0].variables!.input as { publishablesToAdd: string[] }).publishablesToAdd).toEqual([GB_PRODUCT]);
  });

  it('re-adds previously excluded products that belong again', async () => {
    const calls: Call[] = [];
    // Everything currently UNPUBLISHED: the CN scaffolding is re-added in every
    // market it reaches, and the GB product is re-added in its own UK lane only.
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT], unpublished: [GB_PRODUCT, CN_PRODUCT] });
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720 });
    const uk = r.markets.find((m) => m.name === 'United Kingdom')!;
    expect(uk.readded).toBe(2); // GB (local) + CN (scaffolding)
    for (const m of r.markets.filter((m) => m.name !== 'United Kingdom')) {
      expect(m.readded).toBe(1);
      expect(m.removed).toBe(0); // GB product already excluded there
    }
    const adds = calls.filter((c) => c.query.includes('publicationUpdate'));
    for (const u of adds) {
      expect((u.variables!.input as { publishablesToAdd: string[] }).publishablesToAdd).toContain(CN_PRODUCT);
    }
  });

  it('a freshly published cross-lane product leaves every wrong market in ONE sweep and stays in its own', async () => {
    const calls: Call[] = [];
    // The market-us publish-day scenario: a US-warehoused product goes ACTIVE and
    // autoPublish drops it into every catalog. The sweep must remove it from
    // UK/EU/AU and leave it in US+CA - within one run, deterministically.
    const US_PRODUCT = 'gid://shopify/Product/us1';
    const m = new Map<string, string[]>([...MEMBERSHIPS, ['US', [US_PRODUCT]]]);
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT, US_PRODUCT] });
    const r = await syncMarketExclusions(admin, storeStub(m), { stalenessHours: 720 });
    const byName = new Map(r.markets.map((x) => [x.name, x]));
    expect(byName.get('United Kingdom')!.removed).toBe(1);  // the US product
    expect(byName.get('European Union')!.removed).toBe(2);  // GB + US products
    expect(byName.get('Australia')!.removed).toBe(2);
    expect(byName.get('United States and Canada')!.removed).toBe(1); // GB only - US product stays
    const removals = calls.filter((c) => c.query.includes('publicationUpdate'))
      .flatMap((c) => (c.variables!.input as { publishablesToRemove?: string[] }).publishablesToRemove ?? []);
    expect(removals.filter((id) => id === US_PRODUCT)).toHaveLength(3); // UK, EU, AU - never US+CA
  });

  it('never re-adds a DRAFT product (seed-lane drafts wait for activation + autoPublish)', async () => {
    const calls: Call[] = [];
    const US_DRAFT = 'gid://shopify/Product/usdraft1';
    const m = new Map<string, string[]>([...MEMBERSHIPS, ['US', [US_DRAFT]]]);
    // The draft reads unpublished everywhere, including the US+CA market where it
    // BELONGS - but as a DRAFT it must not be blindly added to the publication.
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT, US_DRAFT], unpublished: [US_DRAFT], drafts: [US_DRAFT] });
    const r = await syncMarketExclusions(admin, storeStub(m), { stalenessHours: 720 });
    const usca = r.markets.find((x) => x.name === 'United States and Canada')!;
    expect(usca.readded).toBe(0);
    const adds = calls.filter((c) => c.query.includes('publicationUpdate'))
      .flatMap((c) => (c.variables!.input as { publishablesToAdd?: string[] }).publishablesToAdd ?? []);
    expect(adds).not.toContain(US_DRAFT);
  });

  it('retries a throttled publicationUpdate and completes (live 2026-07-03 failure mode)', async () => {
    const calls: Call[] = [];
    // First 2 publicationUpdate calls hit the simultaneous-updates throttle, then succeed.
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT], throttleFirst: 2 });
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720, retryDelaysMs: [1, 1, 1] });
    // All four markets still complete; no market is dropped. The UK issues no
    // writes in this fixture (its lane + scaffolding are already published).
    expect(r.markets.map((m) => m.name).sort()).toEqual(['Australia', 'European Union', 'United Kingdom', 'United States and Canada']);
    for (const m of r.markets.filter((m) => m.name !== 'United Kingdom')) expect(m.removed).toBe(1);
    // 3 successful removals + 2 throttled attempts that were retried.
    expect(calls.filter((c) => c.query.includes('publicationUpdate'))).toHaveLength(5);
  });

  it('a persistent throttle exhausts retries and skips only that market', async () => {
    const calls: Call[] = [];
    // More throttles than markets x (retries+1): the first market exhausts its
    // retries and is skipped; later markets consume the remaining throttles.
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT], throttleFirst: 3 });
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720, retryDelaysMs: [1, 1] });
    // The UK (first, no writes needed) completes untouched; EU burns 3 attempts
    // (initial + 2 retries) all throttled and is skipped; US+CA and AU succeed.
    expect(r.markets.map((m) => m.name).sort()).toEqual(['Australia', 'United Kingdom', 'United States and Canada']);
    for (const m of r.markets.filter((m) => m.name !== 'United Kingdom')) expect(m.removed).toBe(1);
  });

  it('a market with unreadable regions is skipped entirely (fail-safe, never over-excludes)', async () => {
    const calls: Call[] = [];
    const admin = (async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutMarketCatalogs')) {
        return { markets: { nodes: [{ id: 'gid://shopify/Market/x', name: 'Mystery', primary: false, regions: { nodes: [] }, catalogs: { nodes: [] } }] } };
      }
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    }) as unknown as AdminGraphql;
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720 });
    expect(r.markets).toHaveLength(0);
    expect(calls.filter((c) => c.query.includes('catalogCreate'))).toHaveLength(0);
  });
});

describe('chunk', () => {
  it('splits into fixed-size batches with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
