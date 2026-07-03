// src/shipping/market-catalogs.ts
//
// Admin wiring for the per-market product-availability fix (Task 12). For every
// NON-PRIMARY market it adopts (or creates) the market's catalog + ALL_PRODUCTS
// publication, computes which products are unfulfillable to every country in the
// market via the pure computeMarketExclusions engine, and reconciles the
// publication with minimal publishablesToRemove / publishablesToAdd diffs.
//
// Mutation input shapes (catalogCreate context.marketIds, publicationCreate
// defaultState/autoPublish, publicationUpdate publishablesTo*) were verified
// against the LIVE Admin API on 2026-07-03 (the EU catalog linchpin probe):
// catalog gid://shopify/MarketCatalog/194716467538 + publication
// gid://shopify/Publication/355273867602 exist and enforce at checkout.
//
// The UK primary (merchant-managed) market is deliberately untouched: GB and CN
// products are UK-fulfillable, and the two US-only products are an owner-level
// decision (recommended archive), not an automated exclusion from the primary
// storefront market.

import type { AdminGraphql } from '../shopify-admin';
import type { LogisticsRoute } from '../logistics';
import { computeMarketExclusions, type MarketDef } from './market-exclusion';
import { resolveNearestRoute } from './nearest-route';

export interface LiveMarket extends MarketDef {
  primary: boolean;
  catalogId: string | null;
  publicationId: string | null;
}

const MARKETS_QUERY = `query pawscoutMarketCatalogs {
  markets(first: 20) {
    nodes {
      id name primary
      regions(first: 250) { nodes { ... on MarketRegionCountry { code } } }
      catalogs(first: 5) { nodes { id status publication { id } } }
    }
  }
}`;

/** Live markets with concrete country lists and any already-attached catalog +
 * publication. Defensive parsing: a market whose regions cannot be read yields
 * countries: [] and is later skipped (the engine treats empty as "cannot
 * determine" and never over-excludes). */
export async function listLiveMarkets(admin: AdminGraphql): Promise<LiveMarket[]> {
  const data = await admin(MARKETS_QUERY);
  const nodes = ((data.markets as { nodes?: Record<string, unknown>[] })?.nodes) ?? [];
  return nodes.map((n) => {
    const regions = ((n.regions as { nodes?: { code?: string }[] })?.nodes) ?? [];
    const catalogs = ((n.catalogs as { nodes?: { id?: string; status?: string; publication?: { id?: string } | null }[] })?.nodes) ?? [];
    // Adopt the first ACTIVE catalog that already has a publication, else the
    // first catalog of any shape (its missing publication is created later).
    const withPub = catalogs.find((c) => c.status === 'ACTIVE' && c.publication?.id) ?? catalogs[0];
    return {
      id: String(n.id ?? ''),
      name: String(n.name ?? ''),
      primary: n.primary === true,
      countries: regions.map((r) => r.code).filter((c): c is string => !!c),
      catalogId: withPub?.id ?? null,
      publicationId: withPub?.publication?.id ?? null,
    };
  }).filter((m) => m.id);
}

const CATALOG_CREATE = `mutation pawscoutCatalogCreate($input: CatalogCreateInput!) {
  catalogCreate(input: $input) { catalog { id } userErrors { field message } }
}`;
const PUBLICATION_CREATE = `mutation pawscoutPublicationCreate($input: PublicationCreateInput!) {
  publicationCreate(input: $input) { publication { id } userErrors { field message } }
}`;
const PUBLICATION_UPDATE = `mutation pawscoutPublicationUpdate($id: ID!, $input: PublicationUpdateInput!) {
  publicationUpdate(id: $id, input: $input) { publication { id } userErrors { field message } }
}`;

function firstErr(data: Record<string, unknown>, key: string): string | null {
  const errs = ((data[key] as { userErrors?: { message: string }[] })?.userErrors) ?? [];
  return errs.length ? errs.map((e) => e.message).join('; ') : null;
}

/** Adopt the market's existing catalog/publication or create what is missing.
 * Idempotent: an existing pair is returned untouched (never duplicated). */
export async function ensureMarketCatalog(
  admin: AdminGraphql, market: LiveMarket
): Promise<{ catalogId: string; publicationId: string }> {
  let { catalogId, publicationId } = market;
  if (!catalogId) {
    const data = await admin(CATALOG_CREATE, {
      input: { title: market.name, status: 'ACTIVE', context: { marketIds: [market.id] } }
    });
    const err = firstErr(data, 'catalogCreate');
    if (err) throw new Error(`catalogCreate(${market.name}): ${err}`);
    catalogId = String((data.catalogCreate as { catalog?: { id?: string } })?.catalog?.id ?? '');
    if (!catalogId) throw new Error(`catalogCreate(${market.name}): no catalog id returned`);
    publicationId = null; // a fresh catalog has no publication yet
  }
  if (!publicationId) {
    const data = await admin(PUBLICATION_CREATE, {
      input: { catalogId, defaultState: 'ALL_PRODUCTS', autoPublish: true }
    });
    const err = firstErr(data, 'publicationCreate');
    if (err) throw new Error(`publicationCreate(${market.name}): ${err}`);
    publicationId = String((data.publicationCreate as { publication?: { id?: string } })?.publication?.id ?? '');
    if (!publicationId) throw new Error(`publicationCreate(${market.name}): no publication id returned`);
  }
  return { catalogId, publicationId };
}

const PUBLISHED_STATE_QUERY = `query pawscoutPublishedState($pid: ID!, $cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id publishedOnPublication(publicationId: $pid) }
  }
}`;

/** productId -> currently published on this publication? (paged, defensive) */
async function publishedState(admin: AdminGraphql, publicationId: string): Promise<Map<string, boolean>> {
  const state = new Map<string, boolean>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data = await admin(PUBLISHED_STATE_QUERY, { pid: publicationId, cursor });
    const conn = data.products as { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: { id?: string; publishedOnPublication?: boolean }[] };
    for (const n of conn?.nodes ?? []) {
      if (n.id) state.set(n.id, n.publishedOnPublication === true);
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return state;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// publishablesTo* mutations chunked well under the 250/call association cap
// (lesson from applyVariantMembership: the live API rejects oversized batches).
const PUBLISHABLES_CHUNK = 100;

// publicationUpdate spawns an async background job on Shopify's side; firing the
// next mutation while prior jobs still run trips "The limit for simultaneous
// publication updates has been exceeded" (hit live on the 2026-07-03 first run,
// processing 3 markets back-to-back). Retry with backoff on exactly that error.
const PUBLICATION_THROTTLE_RE = /limit for simultaneous publication updates/i;
const PUBLICATION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function publicationUpdateWithRetry(
  admin: AdminGraphql,
  publicationId: string,
  input: Record<string, unknown>,
  label: string,
  delaysMs: number[]
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const data = await admin(PUBLICATION_UPDATE, { id: publicationId, input });
    const err = firstErr(data, 'publicationUpdate');
    if (!err) return;
    if (PUBLICATION_THROTTLE_RE.test(err) && attempt < delaysMs.length) {
      await sleep(delaysMs[attempt]);
      continue;
    }
    throw new Error(`publicationUpdate(${label}): ${err}`);
  }
}

export interface MarketExclusionResult {
  name: string;
  catalogId: string;
  excluded: number; // desired exclusion-set size
  removed: number;  // newly removed this run
  readded: number;  // newly re-added this run (became fulfillable again)
}

/**
 * Daily reconcile: quote==checkout for market availability. Products a market
 * cannot be fulfilled to are removed from its catalog publication (checkout-level
 * enforcement that Managed Markets backfill cannot re-introduce); products that
 * become fulfillable again are re-added. Uses the SAME resolveNearestRoute +
 * cj_logistics data as the inbox agent and the delivery-profile sync, so what we
 * sell, quote, and ship stays one consistent truth.
 */
export async function syncMarketExclusions(
  admin: AdminGraphql,
  store: {
    listSignatureMemberships(): Promise<Map<string, string[]>>;
    getLogisticsRoute(from: string, to: string, staleness: number): Promise<LogisticsRoute | null>;
  },
  opts: { stalenessHours: number; retryDelaysMs?: number[] }
): Promise<{ markets: MarketExclusionResult[] }> {
  const retryDelaysMs = opts.retryDelaysMs ?? PUBLICATION_RETRY_DELAYS_MS;
  const live = await listLiveMarkets(admin);
  const managed = live.filter((m) => !m.primary && m.countries.length > 0);
  if (!managed.length) return { markets: [] };

  const memberships = await store.listSignatureMemberships();
  const allProductIds = new Set([...memberships.values()].flat());

  // Prefetch every origin x destination route once (D1 reads), so the pure
  // engine gets a synchronous oracle - identical rule to buildSignatureZones:
  // fulfillable iff the nearest-route resolver finds a usable route.
  const origins = new Set<string>();
  for (const sig of memberships.keys()) for (const o of sig.split(',')) origins.add(o);
  const dests = new Set<string>();
  for (const m of managed) for (const c of m.countries) dests.add(c);
  const routes = new Map<string, LogisticsRoute | null>();
  for (const o of origins) {
    for (const d of dests) {
      routes.set(`${o}|${d}`, await store.getLogisticsRoute(o, d, opts.stalenessHours));
    }
  }
  const isFulfillable = (sig: string, dest: string): boolean =>
    resolveNearestRoute(sig.split(',').map((o) => routes.get(`${o}|${dest}`)).filter((r): r is LogisticsRoute => !!r)).fulfillable;

  const exclusions = new Map(
    computeMarketExclusions(managed, memberships, isFulfillable).map((e) => [e.market.id, e.excludeProductIds])
  );

  const results: MarketExclusionResult[] = [];
  for (const market of managed) {
    // Per-market isolation: one market's failure (e.g. a rejected mutation) must
    // not block the others; the nightly cron retries tomorrow.
    try {
      const desiredExcluded = new Set(exclusions.get(market.id) ?? []);
      const { catalogId, publicationId } = await ensureMarketCatalog(admin, market);
      const state = await publishedState(admin, publicationId);

      // Minimal diff, scoped to OUR catalog products: remove currently-published
      // products that must be excluded; re-add previously-excluded products that
      // are fulfillable again. Unknown products (not in the state scan) are left
      // alone - never a blind write. Live-verified semantics (2026-07-03):
      // ALL_PRODUCTS-included ACTIVE products read publishedOnPublication=true,
      // an excluded product reads false, ARCHIVED products read false (and are
      // never in memberships, so they are never blindly re-added). A freshly
      // created publication may briefly read false everywhere while ALL_PRODUCTS
      // populates - the diff then no-ops or re-adds fulfillable products and
      // CONVERGES on the next nightly run; it can never over-exclude.
      const toRemove = [...desiredExcluded].filter((id) => state.get(id) === true);
      const toAdd = [...allProductIds].filter((id) => !desiredExcluded.has(id) && state.get(id) === false);

      for (const ids of chunk(toRemove, PUBLISHABLES_CHUNK)) {
        await publicationUpdateWithRetry(admin, publicationId, { publishablesToRemove: ids }, 'remove', retryDelaysMs);
      }
      for (const ids of chunk(toAdd, PUBLISHABLES_CHUNK)) {
        await publicationUpdateWithRetry(admin, publicationId, { publishablesToAdd: ids }, 'add', retryDelaysMs);
      }

      results.push({ name: market.name, catalogId, excluded: desiredExcluded.size, removed: toRemove.length, readded: toAdd.length });
    } catch (e) {
      console.warn(`market exclusion failed for ${market.name}: ${(e as Error).message}`);
    }
  }
  return { markets: results };
}
