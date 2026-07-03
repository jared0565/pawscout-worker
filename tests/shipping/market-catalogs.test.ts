import { describe, it, expect } from 'vitest';
import { listLiveMarkets, ensureMarketCatalog, syncMarketExclusions, chunk, type LiveMarket } from '../../src/shipping/market-catalogs';
import type { AdminGraphql } from '../../src/shopify-admin';
import type { LogisticsRoute } from '../../src/logistics';

interface Call { query: string; variables?: Record<string, unknown> }

// Live market fixtures mirroring the verified 2026-07-03 store state: UK primary
// (merchant-managed, untouched), EU with the adopted linchpin catalog, US+CA and
// AU with no catalogs yet.
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

/** Admin mock: markets read, catalog/publication creation, published-state scan,
 * publication updates. Published-state: every product reports `published` unless
 * listed in `unpublished`. */
function marketsAdmin(calls: Call[], opts: { unpublished?: string[]; products?: string[] } = {}): AdminGraphql {
  const unpublished = new Set(opts.unpublished ?? []);
  const products = opts.products ?? [];
  let catalogSeq = 0;
  let pubSeq = 0;
  return (async (query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes('pawscoutMarketCatalogs')) return MARKETS_RESPONSE;
    if (query.includes('catalogCreate')) return { catalogCreate: { catalog: { id: `gid://shopify/MarketCatalog/new${++catalogSeq}` }, userErrors: [] } };
    if (query.includes('publicationCreate')) return { publicationCreate: { publication: { id: `gid://shopify/Publication/new${++pubSeq}` }, userErrors: [] } };
    if (query.includes('publicationUpdate')) return { publicationUpdate: { publication: { id: String(variables?.id) }, userErrors: [] } };
    if (query.includes('pawscoutPublishedState')) {
      return { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: products.map((id) => ({ id, publishedOnPublication: !unpublished.has(id) })) } };
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  }) as unknown as AdminGraphql;
}

// Store stub: GB products ship GB->GB only; CN ships CN->{DE,US,AU}; matches the
// CJ-source-verified reality. Route objects only need to satisfy resolveNearestRoute.
const route = (from: string, to: string): LogisticsRoute =>
  ({ from_country: from, to_country: to, channel: 'x', transit_min: 5, transit_max: 10, updated_at: new Date().toISOString() } as unknown as LogisticsRoute);
const ROUTES = new Map<string, LogisticsRoute>([
  ['GB|GB', route('GB', 'GB')],
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
  it('excludes the GB-only product from every managed market and never touches the UK primary', async () => {
    const calls: Call[] = [];
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT] }); // everything currently published
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720 });

    expect(r.markets.map((m) => m.name).sort()).toEqual(['Australia', 'European Union', 'United States and Canada']);
    for (const m of r.markets) {
      expect(m.excluded).toBe(1); // the GB-only product
      expect(m.removed).toBe(1);
      expect(m.readded).toBe(0);
    }
    // Every publicationUpdate removes exactly the GB product; the CN product is never touched.
    const updates = calls.filter((c) => c.query.includes('publicationUpdate'));
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect((u.variables!.input as { publishablesToRemove: string[] }).publishablesToRemove).toEqual([GB_PRODUCT]);
    }
    // The UK primary market gets no catalog, no publication, no update.
    const created = calls.filter((c) => c.query.includes('catalogCreate'));
    for (const c of created) {
      expect((c.variables!.input as { context: { marketIds: string[] } }).context.marketIds).not.toContain('gid://shopify/Market/uk');
    }
  });

  it('is idempotent: an already-excluded product produces no publication writes', async () => {
    const calls: Call[] = [];
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT], unpublished: [GB_PRODUCT] });
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720 });
    for (const m of r.markets) {
      expect(m.removed).toBe(0);
      expect(m.readded).toBe(0);
    }
    expect(calls.filter((c) => c.query.includes('publicationUpdate'))).toHaveLength(0);
  });

  it('re-adds a previously excluded product that became fulfillable again', async () => {
    const calls: Call[] = [];
    // The CN product is currently UNPUBLISHED in every market catalog, but CN routes
    // reach DE/US/AU -> it must be re-added everywhere.
    const admin = marketsAdmin(calls, { products: [GB_PRODUCT, CN_PRODUCT], unpublished: [GB_PRODUCT, CN_PRODUCT] });
    const r = await syncMarketExclusions(admin, storeStub(MEMBERSHIPS), { stalenessHours: 720 });
    for (const m of r.markets) {
      expect(m.readded).toBe(1);
      expect(m.removed).toBe(0); // GB product already excluded
    }
    const adds = calls.filter((c) => c.query.includes('publicationUpdate'));
    for (const u of adds) {
      expect((u.variables!.input as { publishablesToAdd: string[] }).publishablesToAdd).toEqual([CN_PRODUCT]);
    }
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
