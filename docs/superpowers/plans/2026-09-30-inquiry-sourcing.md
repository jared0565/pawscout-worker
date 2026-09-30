# Inquiry Sourcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer asks for something we do not stock, find it at the supplier, tell the customer the real price and delivery time (saying plainly when it ships from overseas), and let the owner import it for them; the storefront search can show overseas items with the same note.

**Architecture:** One shared rule decides which warehouses may serve a buyer (their lane, plus the China hub while the lane is transitional) and one shared route helper turns stock origins into a delivery band, using the same D1 route matrix and band formula as the product page. A supplier-offer builder combines CJ search, stock, route and the import's own pricing chain. The console search, the owner's import action, the product agent and the storefront feed all call these; `confirmAndImport` is unchanged and still runs every gate.

**Tech Stack:** Cloudflare Worker (Hono), D1, TypeScript, vitest with `@cloudflare/vitest-pool-workers`, CJ Dropshipping API, Shopify Admin GraphQL.

**Spec:** `docs/superpowers/specs/2026-09-30-inquiry-sourcing-design.md` (approved 2026-09-30).

## Global Constraints

- No em dash or en dash anywhere (code, comments, copy). Scan every changed file with node for char codes 8211 and 8212 before committing.
- Customer-facing text never names the origin country, the supplier (CJ), a SKU, or a maker brand, and never implies dispatch from the UK.
- Nightly jobs are unchanged: `confirmAndImport` keeps `HOME_MARKET_WAREHOUSES` as its default lane; only the new owner action and the storefront overseas click pass a wider warehouse set.
- Every inquiry import still passes every gate in `confirmAndImport` (curation, pet floor, image vetting, stock floor, profitability, competition).
- No product enters the catalog from an inbound email alone; drafts that offer a sourced item are held with `sourcing_offer`.
- Figures come from existing formulas only: price from `retailPriceGbp(v.sellPriceUsd, cfg.pricing, freightUsd)` with freight from `cj.freightEstimate(vid, chooseOrigin(detail, cfg.floors.stockFloor))`; delivery from `formatBand(doorToDoorBand(route, resolveLogistics(cfg.fulfil)))` over `store.getLogisticsRoute`.
- Overseas storefront cards are returned only when the request carries `overseas=1`.
- Run `python -P -m graphite impact <file>` before editing a shared file and read the call sites it names.
- Run the full suite alone (`npm test`), never in parallel with another run. After editing `src/console/*-js.ts`, also run `npx vitest run tests/console.test.ts` and `npm run lint`; backslashes inside those template literals must be doubled.
- Before each commit: `aramid check --staged`. Never `--no-verify`. Push after each commit, but not from 50 minutes before a drain hour (02, 06, 10, 14, 18, 22 UTC) until a few minutes after that drain finishes.

## Review Focus

1. A customer in a country we have no lane for (for example Japan or Nigeria): no offer, no import, and the draft says we do not deliver there. Tests: Task 1 (`laneRouteFor` null for `NG`), Task 3 (`supplierOffers` empty for `NG`), Task 6 (grounding for a sender in Japan says we do not deliver).
2. An item stocked both in the UK and in China, for a UK buyer: offered and imported as LOCAL (UK route, not overseas, import lane `['GB']`). Tests: Task 1, Task 4.
3. China stock below the stock floor (for example `CN: 3`): never offered and never imported. Tests: Task 3, Task 4.
4. A missing or stale China route to the buyer's country: the overseas item is not offered, not imported, and not shown on the storefront. Tests: Task 1, Task 3 (AU), Task 7.
5. The customer's country is unknown: the draft states the price but no delivery time and asks where it would go. Test: Task 6.
6. A SKU typed in lower case or with spaces around it still finds the product. Test: Task 2.

---

### Task 1: Lane rule and lane route helper

**Files:**
- Modify: `src/local-markets.ts` (add two exports after `sellableToBuyer`)
- Create: `src/sourcing/lane-route.ts`
- Modify: `src/inbox/agents/shipping.ts` (inside `resolveItemShipping`, replace the inline allowed-origins computation)
- Test: `tests/sourcing-lane-route.test.ts`

**Interfaces:**
- Produces:
  - `allowedOriginsFor(origins: Record<string, number> | undefined | null, buyerCountry: string, launched?: string[]): string[]`
  - `inquiryWarehouses(buyerCountry: string, launched?: string[]): string[]`
  - `interface LaneRoute { origin: string; overseas: boolean; days: string | null }`
  - `laneRouteFor(store: TenantStore, cfg: TenantConfig, origins: Record<string, number> | undefined | null, dest: string): Promise<LaneRoute | null>`

- [ ] **Step 1: Graph check**

Run: `python -P -m graphite impact src/local-markets.ts` and `python -P -m graphite impact src/inbox/agents/shipping.ts`. Read the call sites it names; the change adds exports and must not alter `resolveItemShipping`'s results.

- [ ] **Step 2: Write the failing test**

Create `tests/sourcing-lane-route.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { laneRouteFor } from '../src/sourcing/lane-route';
import { allowedOriginsFor, inquiryWarehouses } from '../src/local-markets';
import { resolveLogistics, doorToDoorBand, formatBand } from '../src/logistics';
import { DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG = { fulfil: DEFAULT_FULFIL } as unknown as TenantConfig;

async function seededStore() {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v1', freightCostUsd: 4 });
  await store.upsertLogisticsRoute({ from: 'GB', to: 'GB', channel: 'UK Local', transitMin: 1, transitMax: 3, agingRaw: '1-3', repVid: 'v1', freightCostUsd: 3 });
  return store;
}

describe('allowedOriginsFor', () => {
  it('admits the lane plus CN while the lane is transitional, normalising UK to GB', () => {
    expect(allowedOriginsFor({ UK: 5, CN: 10, US: 50 }, 'GB').sort()).toEqual(['CN', 'GB']);
  });
  it('drops CN once the lane is local-only', () => {
    expect(allowedOriginsFor({ CN: 10 }, 'GB', ['GB'])).toEqual([]);
  });
  it('is empty for a country with no lane', () => {
    expect(allowedOriginsFor({ CN: 10 }, 'NG')).toEqual([]);
  });
});

describe('inquiryWarehouses', () => {
  it('is the lane plus CN while transitional', () => {
    expect(inquiryWarehouses('GB')).toEqual(['GB', 'CN']);
  });
  it('is the lane alone once local-only', () => {
    expect(inquiryWarehouses('GB', ['GB'])).toEqual(['GB']);
  });
  it('is empty for a country with no lane', () => {
    expect(inquiryWarehouses('NG')).toEqual([]);
  });
});

describe('laneRouteFor', () => {
  it('routes a China-only item overseas with the product-page band', async () => {
    const store = await seededStore();
    const r = await laneRouteFor(store, CFG, { CN: 5429 }, 'GB');
    const l = resolveLogistics(DEFAULT_FULFIL);
    const route = await store.getLogisticsRoute('CN', 'GB', l.stalenessHours);
    expect(r).toEqual({ origin: 'CN', overseas: true, days: formatBand(doorToDoorBand(route, l)) });
    expect(r?.days).toMatch(/^\d+-\d+$/);
  });
  it('prefers local stock when the item is stocked both locally and in China', async () => {
    const store = await seededStore();
    const r = await laneRouteFor(store, CFG, { GB: 40, CN: 900 }, 'GB');
    expect(r?.origin).toBe('GB');
    expect(r?.overseas).toBe(false);
  });
  it('is null when no route exists to the destination', async () => {
    const store = await seededStore();
    expect(await laneRouteFor(store, CFG, { CN: 5429 }, 'AU')).toBeNull();
  });
  it('is null for a country with no lane', async () => {
    const store = await seededStore();
    expect(await laneRouteFor(store, CFG, { CN: 5429 }, 'NG')).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/sourcing-lane-route.test.ts`
Expected: FAIL, `allowedOriginsFor` / `inquiryWarehouses` are not exported and `../src/sourcing/lane-route` does not exist.

- [ ] **Step 4: Add the lane rule to `src/local-markets.ts`**

Insert directly after the `sellableToBuyer` function:

```ts
/** Origins that may serve this buyer under local-for-local: stocked (qty > 0)
 *  warehouses in the buyer's lane, plus the CN scaffolding hub while that lane
 *  is transitional. Normalized (UK -> GB) and de-duplicated. The same rule
 *  computeMarketExclusions applies to whole catalogs. */
export function allowedOriginsFor(
  origins: Record<string, number> | undefined | null,
  buyerCountry: string,
  launched: string[] = LOCAL_ONLY_MARKETS
): string[] {
  const lane = localWarehousesFor(buyerCountry);
  if (!lane.length || !origins) return [];
  const mode = laneVisibilityModeFor(buyerCountry, launched);
  const stocked = Object.keys(origins).filter((o) => (origins[o] ?? 0) > 0).map(normalizeOriginCode);
  return [...new Set(stocked)].filter((cc) => lane.includes(cc) || (mode === 'transitional' && cc === 'CN'));
}

/** Warehouses an inquiry-driven import may draw on for this buyer (owner rule
 *  2026-09-30): the lane, plus CN while the lane is transitional. Nightly jobs
 *  never use this; they keep HOME_MARKET_WAREHOUSES. */
export function inquiryWarehouses(buyerCountry: string, launched: string[] = LOCAL_ONLY_MARKETS): string[] {
  const lane = localWarehousesFor(buyerCountry);
  if (!lane.length) return [];
  return laneVisibilityModeFor(buyerCountry, launched) === 'transitional' ? [...lane, 'CN'] : lane;
}
```

- [ ] **Step 5: Create `src/sourcing/lane-route.ts`**

```ts
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { allowedOriginsFor, localWarehousesFor } from '../local-markets';
import { resolveNearestRoute } from '../shipping/nearest-route';
import { resolveLogistics, doorToDoorBand, formatBand, type LogisticsRoute } from '../logistics';

/** Where an order for this buyer would ship from, and how long it takes. */
export interface LaneRoute {
  /** Warehouse country (internal only; never shown to a customer). */
  origin: string;
  /** True when the origin is outside the buyer's local lane (the CN hub). */
  overseas: boolean;
  /** Door-to-door band as the product page shows it, e.g. "8-21"; null when the route has no parsed transit. */
  days: string | null;
}

/**
 * The nearest allowed warehouse for this buyer and its customer-facing band.
 * Allowed = allowedOriginsFor (lane, plus CN while transitional). Routes come
 * from the D1 matrix only, the same rows the delivery profiles and the
 * product page read, so a quote here matches checkout. Null when nothing
 * allowed is stocked or no fresh route reaches `dest`.
 */
export async function laneRouteFor(
  store: TenantStore,
  cfg: TenantConfig,
  origins: Record<string, number> | undefined | null,
  dest: string
): Promise<LaneRoute | null> {
  const allowed = allowedOriginsFor(origins, dest);
  if (!allowed.length) return null;
  const l = resolveLogistics(cfg.fulfil);
  const candidates: LogisticsRoute[] = [];
  for (const oc of allowed) {
    const r = await store.getLogisticsRoute(oc, dest, l.stalenessHours);
    if (r) candidates.push(r);
  }
  const resolved = resolveNearestRoute(candidates);
  if (!resolved.fulfillable) return null;
  const origin = resolved.nearest.origin;
  return {
    origin,
    overseas: !localWarehousesFor(dest).includes(origin),
    days: formatBand(doorToDoorBand(resolved.nearest.route, l)) || null,
  };
}
```

- [ ] **Step 6: Use the shared rule in `resolveItemShipping`**

In `src/inbox/agents/shipping.ts`, add `allowedOriginsFor` to the existing `../../local-markets` import, then replace:

```ts
    const lane = localWarehousesFor(dest);
    const mode = laneVisibilityModeFor(dest);
    const allowedOrigins = [...new Set(originCodes.map(normalizeOriginCode))].filter(
      (cc) => lane.includes(cc) || (mode === 'transitional' && cc === 'CN')
    );
```

with:

```ts
    const allowedOrigins = allowedOriginsFor(origins, dest);
```

Keep the comment block above it. If `originCodes`, `localWarehousesFor`, `laneVisibilityModeFor` or `normalizeOriginCode` become unused in that file, remove them (the linter will say).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/sourcing-lane-route.test.ts tests/agents/shipping-agent.test.ts tests/agents/shipping-origin.test.ts tests/agents/shipping-prod-proof.test.ts tests/local-markets.test.ts`
Expected: all PASS (the shipping tests prove the refactor kept behaviour).

- [ ] **Step 8: Commit**

```bash
git add src/local-markets.ts src/sourcing/lane-route.ts src/inbox/agents/shipping.ts tests/sourcing-lane-route.test.ts
aramid check --staged
git commit -m "feat(sourcing): one lane rule and route helper for inquiry sourcing"
git push
```

---

### Task 2: CJ lookup by SKU

**Files:**
- Modify: `src/cj.ts` (`detail` at ~line 344 becomes a wrapper; add `detailBySku`; add exported `looksLikeCjSku`)
- Test: `tests/cj.test.ts` (append a describe block)

**Interfaces:**
- Produces:
  - `looksLikeCjSku(q: string): string | null` (normalized SKU or null)
  - `CjClient.detailBySku(sku: string): Promise<CjDetail | null>`

- [ ] **Step 1: Graph check**

Run: `python -P -m graphite impact src/cj.ts`. `detail` has many callers; its signature and result must not change.

- [ ] **Step 2: Write the failing test**

Append to `tests/cj.test.ts` (it already defines `clientWith` and imports `CjClient`; add `looksLikeCjSku` to that import):

```ts
describe('CjClient.detailBySku', () => {
  const PRODUCT = { pid: 'P77', productNameEn: 'Smart GPS Pet Tracker', productImage: 'https://i/t.jpg', variants: [{ vid: 'V1', variantNameEn: 'Black', variantSellPrice: 12.5, variantSku: 'CJPC262132401AZ-B' }] };

  it('queries /product/query by productSku with inventory and maps the product', async () => {
    const { client, urls } = clientWith(() => PRODUCT);
    const d = await client.detailBySku('CJPC262132401AZ');
    expect(d?.pid).toBe('P77');
    expect(urls[0]).toContain('/product/query?');
    expect(urls[0]).toContain('productSku=CJPC262132401AZ');
    expect(urls[0]).toContain('features=enable_inventory');
  });

  it('falls back to variantSku when the productSku lookup finds nothing', async () => {
    const { client, urls } = clientWith((url) => (url.includes('variantSku=') ? PRODUCT : null));
    const d = await client.detailBySku('CJPC262132401AZ-B');
    expect(d?.pid).toBe('P77');
    expect(urls.some((u) => u.includes('variantSku=CJPC262132401AZ-B'))).toBe(true);
  });

  it('returns null when neither lookup finds the product', async () => {
    const { client } = clientWith(() => null);
    expect(await client.detailBySku('CJXX000000000')).toBeNull();
  });
});

describe('looksLikeCjSku', () => {
  it('normalizes case and surrounding space', () => {
    expect(looksLikeCjSku('  cjpc262132401az ')).toBe('CJPC262132401AZ');
  });
  it('accepts a variant suffix', () => {
    expect(looksLikeCjSku('CJPC262132401AZ-Black')).toBe('CJPC262132401AZ-BLACK');
  });
  it('rejects ordinary words and short codes', () => {
    expect(looksLikeCjSku('gps dog collar')).toBeNull();
    expect(looksLikeCjSku('CJ123')).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/cj.test.ts`
Expected: FAIL, `detailBySku` is not a function and `looksLikeCjSku` is not exported.

- [ ] **Step 4: Implement**

In `src/cj.ts`, rename the body of `detail` into a private method and add the SKU lookup. Replace the first lines of `detail`:

```ts
  async detail(pid: string): Promise<CjDetail | null> {
    // enable_inventory embeds per-variant inventories in the SAME response -
    // saving the separate stock call that CJ renamed out from under us once.
    const p = (await this.get('/product/query', { pid, features: 'enable_inventory' })) as Record<string, unknown> | null;
```

with:

```ts
  async detail(pid: string): Promise<CjDetail | null> {
    return this.detailQuery({ pid });
  }

  /**
   * Look a product up by the SKU the owner copied from CJ's site: the product
   * SKU first, then a variant SKU. A CJ "not found" error is a miss, not a
   * failure, so each lookup's error is swallowed and the next one runs.
   */
  async detailBySku(sku: string): Promise<CjDetail | null> {
    for (const key of ['productSku', 'variantSku'] as const) {
      try {
        const d = await this.detailQuery({ [key]: sku });
        if (d) return d;
      } catch (e) {
        console.warn(`CJ ${key} lookup failed for ${sku}: ${(e as Error).message}`);
      }
    }
    return null;
  }

  private async detailQuery(params: Record<string, string>): Promise<CjDetail | null> {
    // enable_inventory embeds per-variant inventories in the SAME response -
    // saving the separate stock call that CJ renamed out from under us once.
    const p = (await this.get('/product/query', { ...params, features: 'enable_inventory' })) as Record<string, unknown> | null;
```

The rest of the old `detail` body stays as the body of `detailQuery`. Add this exported function next to `chooseOrigin`:

```ts
/** A CJ SKU as the owner pastes it (e.g. "CJPC262132401AZ", or a variant SKU
 *  with a suffix). Returns it upper-cased and trimmed, or null for anything
 *  else, so ordinary search words never trigger a SKU lookup. */
export function looksLikeCjSku(q: string): string | null {
  const s = q.trim().toUpperCase();
  return /^CJ[A-Z0-9][A-Z0-9-]{7,40}$/.test(s) ? s : null;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/cj.test.ts tests/cj-token.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cj.ts tests/cj.test.ts
aramid check --staged
git commit -m "feat(cj): look a product up by the SKU the owner pastes"
git push
```

The live endpoint is confirmed in Task 8 Step 6 with SKU `CJPC262132401AZ`.

---

### Task 3: Supplier offers

**Files:**
- Modify: `src/proxy/search.ts` (export `queryTermHits` next to `titleAnswersQuery`)
- Create: `src/sourcing/offers.ts`
- Test: `tests/sourcing-offers.test.ts`

**Interfaces:**
- Consumes: `laneRouteFor`, `inquiryWarehouses` (Task 1); `looksLikeCjSku`, `CjClient.detailBySku` (Task 2).
- Produces:
  - `queryTermHits(keyword: string, title: string): number`
  - `interface SupplierOffer { pid: string; title: string; image: string; priceGbp: number; origin: string; overseas: boolean; days: string | null; descriptionText: string; handle: string | null }`
  - `supplierOffers(store: TenantStore, cj: CjClient, cfg: TenantConfig, query: string, dest: string, opts: { limit: number; pause?: (ms: number) => Promise<void> }): Promise<SupplierOffer[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/sourcing-offers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { supplierOffers } from '../src/sourcing/offers';
import { retailPriceGbp } from '../src/pricing';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail, CjSearchItem } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG = { pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, fulfil: DEFAULT_FULFIL } as unknown as TenantConfig;
const noPause = async () => {};

function det(pid: string, nameEn: string, origins: Record<string, number>, usd = 12): CjDetail {
  return { pid, nameEn, images: [`https://i/${pid}.jpg`], descriptionHtml: '<p>GPS unit clips to the collar.</p>', variants: [{ vid: `${pid}-v`, name: 'Black', sellPriceUsd: usd, sku: `${pid}-SKU` }], listedNum: 10, categoryName: 'Pet', origins };
}
const item = (d: CjDetail): CjSearchItem => ({ pid: d.pid, nameEn: d.nameEn, image: d.images[0], sellPriceUsd: d.variants[0].sellPriceUsd, listedNum: d.listedNum, categoryName: 'Pet' });

const TRACKER = det('T1', 'Smart GPS Wireless Pet Tracker', { CN: 5429 });
const LOCAL_COLLAR = det('C1', 'Dog Collar GPS Tracker Holder', { GB: 40, CN: 900 });
const THIN = det('T2', 'Pet GPS Tracker Mini', { CN: 3 });
const NECKLACE = det('N1', 'Love Pendant Necklace', { CN: 999 });

function fakeCj(details: CjDetail[], calls: string[] = []): CjClient {
  const byPid = new Map(details.map((d) => [d.pid, d]));
  return {
    search: async (kw: string) => { calls.push(`search:${kw}`); return details.map(item); },
    detail: async (pid: string) => { calls.push(`detail:${pid}`); return byPid.get(pid) ?? null; },
    detailBySku: async (sku: string) => { calls.push(`sku:${sku}`); return sku === 'CJPC262132401AZ' ? TRACKER : null; },
    originsByPid: async (pid: string) => byPid.get(pid)?.origins ?? {},
    freightEstimate: async () => ({ priceUsd: 4, days: '5-9', name: 'CJPacket' }),
  } as unknown as CjClient;
}

async function seededStore() {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
  await store.upsertLogisticsRoute({ from: 'GB', to: 'GB', channel: 'UK Local', transitMin: 1, transitMax: 3, agingRaw: '1-3', repVid: 'v', freightCostUsd: 3 });
  return store;
}

describe('supplierOffers', () => {
  it('offers a China-only item overseas with the import price and a delivery band', async () => {
    const store = await seededStore();
    const offers = await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker dog collar', 'GB', { limit: 3, pause: noPause });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ pid: 'T1', overseas: true, origin: 'CN', handle: null });
    expect(offers[0].priceGbp).toBe(retailPriceGbp(12, DEFAULT_PRICING, 4));
    expect(offers[0].days).toMatch(/^\d+-\d+$/);
    expect(offers[0].descriptionText).toContain('GPS unit');
  });

  it('offers an item stocked locally as local', async () => {
    const store = await seededStore();
    const offers = await supplierOffers(store, fakeCj([LOCAL_COLLAR]), CFG, 'gps dog collar', 'GB', { limit: 3, pause: noPause });
    expect(offers[0]).toMatchObject({ pid: 'C1', overseas: false, origin: 'GB' });
  });

  it('skips China stock below the stock floor', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([THIN]), CFG, 'gps tracker', 'GB', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('drops a result that is not a pet product', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([NECKLACE]), CFG, 'love pendant', 'GB', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('looks a pasted SKU up directly instead of searching', async () => {
    const store = await seededStore();
    const calls: string[] = [];
    const offers = await supplierOffers(store, fakeCj([TRACKER], calls), CFG, ' cjpc262132401az ', 'GB', { limit: 3, pause: noPause });
    expect(offers[0]?.pid).toBe('T1');
    expect(calls).toContain('sku:CJPC262132401AZ');
    expect(calls.some((c) => c.startsWith('search:'))).toBe(false);
  });

  it('offers nothing where no China route reaches the buyer', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker', 'AU', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('offers nothing to a country with no lane', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker', 'NG', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('links an item that is already imported', async () => {
    const store = await seededStore();
    await store.putLink({ cjPid: 'T1', state: 'imported', handle: 'smart-gps-pet-tracker' });
    const offers = await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker', 'GB', { limit: 3, pause: noPause });
    expect(offers[0]?.handle).toBe('smart-gps-pet-tracker');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/sourcing-offers.test.ts`
Expected: FAIL, `../src/sourcing/offers` does not exist.

- [ ] **Step 3: Export `queryTermHits` from `src/proxy/search.ts`**

Insert directly after `titleAnswersQuery`:

```ts
/** How many of the query's product words (families folded) the title carries;
 *  ranks supplier results so the closest match comes first. */
export function queryTermHits(keyword: string, title: string): number {
  const have = new Set(keywordTokens(title).map(foldTerm));
  return productTerms(keyword).filter((t) => have.has(t)).length;
}
```

- [ ] **Step 4: Create `src/sourcing/offers.ts`**

```ts
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { chooseOrigin, looksLikeCjSku, type CjClient, type CjDetail } from '../cj';
import { retailPriceGbp } from '../pricing';
import { bestLocalQty, inquiryWarehouses } from '../local-markets';
import { getDetailPreferWarehouse, stripHtml } from '../proxy/import';
import { isPetProductStrict, titleAnswersQuery, queryTermHits } from '../proxy/search';
import { laneRouteFor } from './lane-route';

const CJ_GAP_MS = 1100; // CJ allows about one request a second

/** One supplier item we could sell this buyer, with the figures the import would use. */
export interface SupplierOffer {
  pid: string;
  title: string;
  image: string;
  /** Lowest variant price under the import's own pricing rule (GBP). */
  priceGbp: number;
  /** Warehouse country it would ship from (internal only). */
  origin: string;
  overseas: boolean;
  /** Door-to-door band as the product page shows it, or null. */
  days: string | null;
  /** Supplier copy, stripped, at most 600 characters (grounding only, never pasted to a customer). */
  descriptionText: string;
  /** Set when the item is already in the catalog. */
  handle: string | null;
}

/**
 * Supplier items that answer `query` and can reach `dest` (owner rule
 * 2026-09-30: local stock when it exists, otherwise the real overseas facts).
 * A pasted SKU is looked up directly; anything else runs CJ's relevance search,
 * kept to pet products whose titles answer the query, closest first. Each
 * candidate needs stock at or above the stock floor in the buyer's inquiry
 * warehouses and a fresh route to `dest`.
 */
export async function supplierOffers(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  query: string,
  dest: string,
  opts: { limit: number; pause?: (ms: number) => Promise<void> }
): Promise<SupplierOffer[]> {
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warehouses = inquiryWarehouses(dest);
  if (!warehouses.length) return [];

  const sku = looksLikeCjSku(query);
  const skuDetail = sku ? await cj.detailBySku(sku) : null;
  let pids: string[];
  if (sku) {
    pids = skuDetail ? [skuDetail.pid] : [];
  } else {
    const items = await cj.search(query, 40);
    pids = items
      .filter((i) => isPetProductStrict(i.nameEn) && titleAnswersQuery(query, i.nameEn, 'title'))
      .map((i) => ({ i, hits: queryTermHits(query, i.nameEn) }))
      .sort((a, b) => b.hits - a.hits || b.i.listedNum - a.i.listedNum)
      .map((r) => r.i.pid);
  }

  const offers: SupplierOffer[] = [];
  for (const pid of pids.slice(0, opts.limit * 3)) {
    if (offers.length >= opts.limit) break;
    await pause(CJ_GAP_MS);
    const detail: CjDetail | null = skuDetail?.pid === pid ? skuDetail : await getDetailPreferWarehouse(store, cj, pid);
    if (!detail) continue;
    const origins = detail.origins ?? await cj.originsByPid(pid).catch(() => undefined);
    if (bestLocalQty(origins, warehouses) < cfg.floors.stockFloor) continue;
    const route = await laneRouteFor(store, cfg, origins, dest);
    if (!route) continue;

    // The import's own pricing chain (confirmAndImport): origin by chooseOrigin,
    // freight quoted from that origin, retail from the variant's CJ price.
    const priced = { ...detail, origins };
    let freightUsd = priced.freightUsd;
    const vid = priced.variants[0]?.vid;
    if (freightUsd === undefined && vid && vid !== 'default') {
      await pause(CJ_GAP_MS);
      const origin = priced.origin ?? chooseOrigin(priced, cfg.floors.stockFloor);
      freightUsd = (await cj.freightEstimate(vid, origin).catch(() => null))?.priceUsd;
    }
    const prices = priced.variants.filter((v) => Number.isFinite(v.sellPriceUsd) && v.sellPriceUsd > 0)
      .map((v) => retailPriceGbp(v.sellPriceUsd, cfg.pricing, freightUsd));
    if (!prices.length) continue;

    const link = await store.getLink(pid);
    offers.push({
      pid,
      title: detail.nameEn,
      image: detail.images[0] ?? '',
      priceGbp: Math.min(...prices),
      origin: route.origin,
      overseas: route.overseas,
      days: route.days,
      descriptionText: stripHtml(detail.descriptionHtml ?? '').slice(0, 600),
      handle: link?.state === 'imported' ? link.handle : null,
    });
  }
  return offers;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/sourcing-offers.test.ts tests/search.test.ts`
Expected: PASS. If `isPetProductStrict('Dog Collar GPS Tracker Holder')` or the tracker title fails the pet floor, adjust the TEST titles to real pet titles, never the floor.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/search.ts src/sourcing/offers.ts tests/sourcing-offers.test.ts
aramid check --staged
git commit -m "feat(sourcing): supplier offers with the import's price and the page's delivery band"
git push
```

---

### Task 4: Owner import for an inquiry (part A)

**Files:**
- Create: `src/sourcing/destination.ts`
- Create: `src/sourcing/inquiry-import.ts`
- Modify: `src/index.ts` (two routes next to `/api/inbox/catalog`, ~line 1852)
- Test: `tests/sourcing-inquiry-import.test.ts`

**Interfaces:**
- Consumes: `laneRouteFor`, `inquiryWarehouses` (Task 1).
- Produces:
  - `inquiryDestination(store: TenantStore, threadId: string): Promise<string | null>`
  - `type InquiryImportResult = { ok: true; state: 'importing' | 'imported'; handle: string | null } | { ok: false; error: 'unknown_product' | 'not_deliverable' | 'no_stock' }`
  - `startInquiryImport(deps: InquiryImportDeps, pid: string, dest: string): Promise<InquiryImportResult>`
  - `inquiryImportStatus(store: TenantStore, pid: string): Promise<{ ok: true; state: string; handle: string | null; failReason: string | null; failDetail: string | null }>`
  - Routes: `POST /api/inbox/source-import { pid, threadId }`, `POST /api/inbox/source-status { pid }`

- [ ] **Step 1: Write the failing test**

Create `tests/sourcing-inquiry-import.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { startInquiryImport, inquiryImportStatus } from '../src/sourcing/inquiry-import';
import { inquiryDestination } from '../src/sourcing/destination';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG = { pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, fulfil: DEFAULT_FULFIL } as unknown as TenantConfig;
const det = (pid: string, origins: Record<string, number>): CjDetail => ({ pid, nameEn: 'Smart GPS Pet Tracker', images: [], descriptionHtml: '', variants: [{ vid: 'v', name: 'x', sellPriceUsd: 12, sku: 's' }], listedNum: 1, categoryName: 'Pet', origins });

async function setup(details: CjDetail[]) {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
  await store.upsertLogisticsRoute({ from: 'GB', to: 'GB', channel: 'UK Local', transitMin: 1, transitMax: 3, agingRaw: '1-3', repVid: 'v', freightCostUsd: 3 });
  const byPid = new Map(details.map((d) => [d.pid, d]));
  const cj = { detail: async (pid: string) => byPid.get(pid) ?? null, originsByPid: async () => ({}) } as unknown as CjClient;
  const imports: { pid: string; localWarehouses: string[] }[] = [];
  const pending: Promise<unknown>[] = [];
  let runImport = async (d: CjDetail, localWarehouses: string[]) => { imports.push({ pid: d.pid, localWarehouses }); };
  const deps = {
    store, cj, cfg: CFG,
    runImport: (d: CjDetail, lw: string[]) => runImport(d, lw),
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
  };
  return { store, deps, imports, pending, setRunImport: (f: typeof runImport) => { runImport = f; } };
}

describe('startInquiryImport', () => {
  it('imports a China-only item with the lane plus CN', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    expect(await startInquiryImport(t.deps, 'T1', 'GB')).toEqual({ ok: true, state: 'importing', handle: null });
    await Promise.all(t.pending);
    expect(t.imports).toEqual([{ pid: 'T1', localWarehouses: ['GB', 'CN'] }]);
    expect((await t.store.getLink('T1'))?.state).toBe('importing');
  });

  it('imports a locally stocked item on the lane alone', async () => {
    const t = await setup([det('C1', { GB: 40, CN: 900 })]);
    await startInquiryImport(t.deps, 'C1', 'GB');
    await Promise.all(t.pending);
    expect(t.imports[0].localWarehouses).toEqual(['GB']);
  });

  it('refuses when no route reaches the buyer, without touching the link', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    expect(await startInquiryImport(t.deps, 'T1', 'AU')).toEqual({ ok: false, error: 'not_deliverable' });
    expect(t.imports).toEqual([]);
    expect(await t.store.getLink('T1')).toBeNull();
  });

  it('refuses stock below the floor', async () => {
    const t = await setup([det('T2', { CN: 3 })]);
    expect(await startInquiryImport(t.deps, 'T2', 'GB')).toEqual({ ok: false, error: 'no_stock' });
  });

  it('refuses an unknown product', async () => {
    const t = await setup([]);
    expect(await startInquiryImport(t.deps, 'NOPE', 'GB')).toEqual({ ok: false, error: 'unknown_product' });
  });

  it('returns the handle of an item already imported, without importing again', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    await t.store.putLink({ cjPid: 'T1', state: 'imported', handle: 'smart-gps-pet-tracker' });
    expect(await startInquiryImport(t.deps, 'T1', 'GB')).toEqual({ ok: true, state: 'imported', handle: 'smart-gps-pet-tracker' });
    expect(t.imports).toEqual([]);
  });

  it('marks the link failed when the import throws, so the next click can retry', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    t.setRunImport(async () => { throw new Error('Shopify timeout'); });
    await startInquiryImport(t.deps, 'T1', 'GB');
    await Promise.all(t.pending);
    const s = await inquiryImportStatus(t.store, 'T1');
    expect(s).toMatchObject({ ok: true, state: 'failed', failReason: 'import-error' });
    expect(s.failDetail).toContain('Shopify timeout');
  });
});

describe('inquiryDestination', () => {
  it('reads the country from the inbound messages, ignoring our quoted footer', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const tid = await store.createThread({ contactEmail: 'aloha@example.com', subject: 'Collar', subjectNorm: 'collar', receivedAt: '2026-09-29T10:00:00Z', initialStatus: 'new' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<a@x>', inReplyTo: null, references: [], from: 'aloha@example.com', to: 'contact@activepaw.co.uk', subject: 'Collar', bodyText: 'Do you sell a trackable dog collar? I live in Texas.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-29T10:00:00Z' });
    expect(await inquiryDestination(store, tid)).toBe('US');
  });
  it('is null for an unknown thread', async () => {
    expect(await inquiryDestination(new TenantStore(env.DB, 'a.myshopify.com'), 'missing')).toBeNull();
  });
});
```

Checked 2026-09-30: `deriveDestinationCountry` maps a US state name ("texas" is in `US_STATES`) to `US`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/sourcing-inquiry-import.test.ts`
Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Create `src/sourcing/destination.ts`**

```ts
import type { TenantStore } from '../tenant-store';
import { deriveDestinationCountry } from '../inbox/freight';
import { stripQuotedReply } from '../inbox/quote';

/** The inquirer's country from the thread's INBOUND text, quoted replies
 *  stripped (our own "activepaw.co.uk" footer would otherwise read as the UK),
 *  exactly as the draft composer derives it. Null when the thread names none. */
export async function inquiryDestination(store: TenantStore, threadId: string): Promise<string | null> {
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return null;
  const conversation = got.messages
    .filter((m) => m.direction === 'inbound')
    .map((m) => stripQuotedReply(m.body_text ?? ''))
    .filter(Boolean)
    .join('\n\n---\n\n');
  return deriveDestinationCountry(conversation, got.thread.subject ?? '', got.thread.contact_email);
}
```

- [ ] **Step 4: Create `src/sourcing/inquiry-import.ts`**

```ts
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import type { CjClient, CjDetail } from '../cj';
import { bestLocalQty, inquiryWarehouses, localWarehousesFor } from '../local-markets';
import { getDetailPreferWarehouse } from '../proxy/import';
import { laneRouteFor } from './lane-route';

export interface InquiryImportDeps {
  store: TenantStore;
  cj: CjClient;
  cfg: TenantConfig;
  /** confirmAndImport with the route's curate/pickHero/competitorCheck and the given warehouses. */
  runImport: (detail: CjDetail, localWarehouses: string[]) => Promise<unknown>;
  waitUntil: (p: Promise<unknown>) => void;
}

export type InquiryImportResult =
  | { ok: true; state: 'importing' | 'imported'; handle: string | null }
  | { ok: false; error: 'unknown_product' | 'not_deliverable' | 'no_stock' };

/**
 * Owner-triggered import of a supplier item for a customer's inquiry (owner
 * rule 2026-09-30). Local stock uses the lane alone; an item only the China
 * hub stocks may use the lane plus CN, and only when a fresh route reaches
 * the buyer. confirmAndImport runs in the background with every gate intact.
 */
export async function startInquiryImport(deps: InquiryImportDeps, pid: string, dest: string): Promise<InquiryImportResult> {
  const { store, cj, cfg } = deps;
  const link = await store.getLink(pid);
  if (link?.state === 'imported') return { ok: true, state: 'imported', handle: link.handle };
  if (link?.state === 'importing') return { ok: true, state: 'importing', handle: null };

  const detail = await getDetailPreferWarehouse(store, cj, pid);
  if (!detail) return { ok: false, error: 'unknown_product' };
  const origins = detail.origins ?? await cj.originsByPid(pid).catch(() => undefined);
  const route = await laneRouteFor(store, cfg, origins, dest);
  if (!route) return { ok: false, error: 'not_deliverable' };
  const warehouses = route.overseas ? inquiryWarehouses(dest) : localWarehousesFor(dest);
  if (bestLocalQty(origins, warehouses) < cfg.floors.stockFloor) return { ok: false, error: 'no_stock' };

  await store.putLink({ cjPid: pid, state: 'importing' });
  deps.waitUntil(
    deps.runImport({ ...detail, origins }, warehouses).catch(async (e) => {
      // A thrown import would otherwise leave the link 'importing' forever and
      // block every retry; the gates' own refusals already write 'failed'.
      await store.putLink({ cjPid: pid, state: 'failed', failReason: 'import-error', failDetail: String((e as Error).message).slice(0, 200) });
    })
  );
  return { ok: true, state: 'importing', handle: null };
}

/** The console's poll: where the import stands, and why it failed if it did. */
export async function inquiryImportStatus(store: TenantStore, pid: string): Promise<{ ok: true; state: string; handle: string | null; failReason: string | null; failDetail: string | null }> {
  const link = await store.getLink(pid);
  return {
    ok: true,
    state: link?.state ?? 'unknown',
    handle: link?.state === 'imported' ? link.handle : null,
    failReason: link?.fail_reason ?? null,
    failDetail: link?.fail_detail ?? null,
  };
}
```

`ProductLink` (`src/tenant-store.ts`) carries `fail_reason` and `fail_detail` (checked 2026-09-30).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/sourcing-inquiry-import.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the two routes to `src/index.ts`**

Directly after the `/api/inbox/catalog` route, add (imports: `startInquiryImport`, `inquiryImportStatus` from `./sourcing/inquiry-import`, `inquiryDestination` from `./sourcing/destination`; add `type CjDetail` to the existing `./cj` import if it is not there):

```ts
// Inquiry sourcing (owner rule 2026-09-30): the owner imports a supplier item a
// customer asked for. Local stock uses the lane alone; China-only stock may be
// imported for a transitional lane with a real route. Every import gate still runs.
app.post('/api/inbox/source-import', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { pid?: unknown; threadId?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const pid = typeof body.pid === 'string' ? body.pid.trim() : '';
  const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
  if (!PID_RE.test(pid) || !threadId) return c.json({ ok: false, error: 'pid and threadId required' }, 400);
  const store = new TenantStore(c.env.DB, s);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  const dest = (await inquiryDestination(store, threadId)) ?? 'GB';
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const admin = makeAdminGraphql(s, await vault.open(tenant.dek_wrapped, tenant.access_token_enc));
  const f = cjFetchFromEnv(c.env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
  const llm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
  const on = llm.available && cfg.llm.enabled;
  const curate = on ? (d: CjDetail, ctx: string) => curateProduct(llm, store, cfg, d, ctx) : undefined;
  const pickHero = on ? (title: string, urls: string[]) => pickHeroImage(llm, store, cfg, title, urls) : undefined;
  const market = ebayFromEnv(c.env);
  const competitorCheck = on
    ? (d: { pid: string; nameEn: string }, ourRetailGbp: number) => competitorSignal(llm, store, cfg, { pid: d.pid, title: d.nameEn, ourRetailGbp, market })
    : undefined;
  return c.json(await startInquiryImport({
    store, cj, cfg,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
    runImport: (detail, localWarehouses) => confirmAndImport(store, cj, admin, cfg, detail, undefined, curate, pickHero, { competitorCheck, localWarehouses }),
  }, pid, dest));
});
app.post('/api/inbox/source-status', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { pid?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const pid = typeof body.pid === 'string' ? body.pid.trim() : '';
  if (!PID_RE.test(pid)) return c.json({ ok: false, error: 'pid required' }, 400);
  return c.json(await inquiryImportStatus(new TenantStore(c.env.DB, s), pid));
});
```

`PID_RE` is a module-level `const` declared further down the file; the handlers run after module load, so the reference is safe. Run `npx tsc --noEmit` and fix any missing import it names.

- [ ] **Step 7: Run the suite and commit**

Run: `npx tsc --noEmit` then `npm test` (alone).
Expected: PASS.

```bash
git add src/sourcing/destination.ts src/sourcing/inquiry-import.ts src/index.ts tests/sourcing-inquiry-import.test.ts
aramid check --staged
git commit -m "feat(sourcing): owner imports a supplier item for a customer's inquiry"
git push
```

---

### Task 5: Supplier results in the inbox catalog search (part B)

**Files:**
- Create: `src/sourcing/console-search.ts`
- Modify: `src/index.ts` (one route after `/api/inbox/source-status`)
- Modify: `src/console/inbox-js.ts` (`runCatalogSearch`, plus two new functions after it)
- Test: `tests/console.test.ts` (append), `tests/sourcing-offers.test.ts` (no change)

**Interfaces:**
- Consumes: `supplierOffers` (Task 3), `inquiryDestination` (Task 4), `/api/inbox/source-import` and `/api/inbox/source-status` (Task 4).
- Produces:
  - `supplierSearchForThread(deps: { store: TenantStore; cj: CjClient; cfg: TenantConfig }, q: string, threadId: string | null): Promise<{ ok: true; dest: string; destKnown: boolean; offers: SupplierOffer[] } | { ok: false; error: string }>`
  - Route `POST /api/inbox/supplier-search { q, threadId? }`
  - Browser functions `renderSupplierOffers(offers, dest, destKnown)` (returns an HTML string) and `importForInquiry(pid, threadId)`

- [ ] **Step 1: Write the failing console test**

Append to `tests/console.test.ts`, reusing the file's brace-matching extraction pattern (see the `renderHookLine` test, ~line 90):

```ts
describe('inbox supplier results', () => {
  async function renderFn() {
    const html = await consolePage('test-api-key').text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const start = scripts.indexOf('function renderSupplierOffers(');
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0; let end = scripts.indexOf('{', start);
    for (let i = end; i < scripts.length; i++) {
      if (scripts[i] === '{') depth++;
      else if (scripts[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const esc = (s: unknown) => String(s).replace(/</g, '&lt;');
    return new Function('esc', scripts.slice(start, end) + '\nreturn renderSupplierOffers;')(esc);
  }

  it('labels an overseas offer with its delivery band and an Import button', async () => {
    const render = await renderFn();
    const out = render([{ pid: 'T1', title: 'Smart GPS Pet Tracker', image: '', priceGbp: 26.99, origin: 'CN', overseas: true, days: '9-20', descriptionText: '', handle: null }], 'GB', true);
    expect(out).toContain('Smart GPS Pet Tracker');
    expect(out).toContain('£26.99');
    expect(out).toContain('ships from overseas');
    expect(out).toContain('9-20 days to GB');
    expect(out).toContain('data-src-import="T1"');
  });

  it('links an offer already in the catalog instead of offering an import', async () => {
    const render = await renderFn();
    const out = render([{ pid: 'T1', title: 'Tracker', image: '', priceGbp: 26.99, origin: 'CN', overseas: true, days: '9-20', descriptionText: '', handle: 'smart-gps-pet-tracker' }], 'GB', true);
    expect(out).toContain('/products/smart-gps-pet-tracker');
    expect(out).not.toContain('data-src-import=');
  });

  it('says so when the country was assumed', async () => {
    const render = await renderFn();
    expect(render([], 'GB', false)).toContain('No supplier match');
    const out = render([{ pid: 'T1', title: 'Tracker', image: '', priceGbp: 1, origin: 'GB', overseas: false, days: '2-5', descriptionText: '', handle: null }], 'GB', false);
    expect(out).toContain('country not stated, UK assumed');
    expect(out).toContain('local stock');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/console.test.ts`
Expected: FAIL at `expect(start).toBeGreaterThanOrEqual(0)` (the function does not exist yet).

- [ ] **Step 3: Create `src/sourcing/console-search.ts`**

```ts
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import type { CjClient } from '../cj';
import { supplierOffers, type SupplierOffer } from './offers';
import { inquiryDestination } from './destination';

/** The console's supplier lookup for one thread: the customer's country from
 *  the thread (UK assumed, and said so, when it names none) and up to five
 *  offers. Never throws; a CJ failure is reported as an error line. */
export async function supplierSearchForThread(
  deps: { store: TenantStore; cj: CjClient; cfg: TenantConfig },
  q: string,
  threadId: string | null
): Promise<{ ok: true; dest: string; destKnown: boolean; offers: SupplierOffer[] } | { ok: false; error: string }> {
  try {
    const found = threadId ? await inquiryDestination(deps.store, threadId) : null;
    const dest = found ?? 'GB';
    const offers = await supplierOffers(deps.store, deps.cj, deps.cfg, q, dest, { limit: 5 });
    return { ok: true, dest, destKnown: found !== null, offers };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
```

- [ ] **Step 4: Add the route to `src/index.ts`**

After `/api/inbox/source-status`:

```ts
// Supplier results under the inbox catalog search (inquiry sourcing, part B).
// Separate from /api/inbox/catalog so our own catalog answers at once; this
// one makes paced CJ calls and can take several seconds.
app.post('/api/inbox/supplier-search', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { q?: unknown; threadId?: unknown } = {};
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const q = typeof body.q === 'string' ? body.q.trim().slice(0, 120) : '';
  if (!q) return c.json({ ok: false, error: 'q required' }, 400);
  const threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : null;
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const f = cjFetchFromEnv(c.env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
  return c.json(await supplierSearchForThread({ store, cj, cfg }, q, threadId));
});
```

Import `supplierSearchForThread` from `./sourcing/console-search`.

- [ ] **Step 5: Add the console functions to `src/console/inbox-js.ts`**

This file is a template literal: no backticks inside, and any backslash must be doubled. Insert after `runCatalogSearch`:

```js
// Inquiry sourcing (part B): supplier items for this thread's customer, under
// our own catalog results. Overseas items say so; the owner imports with one click.
function renderSupplierOffers(offers,dest,destKnown){
  if(!offers||!offers.length) return '<div class="muted" style="margin-top:6px">No supplier match.</div>';
  var head='<div class="muted" style="margin:8px 0 4px">From our supplier, delivery to '+esc(dest)+(destKnown?'':' (country not stated, UK assumed)')+':</div>';
  return head+offers.map(function(o){
    var where=o.overseas?'ships from overseas':'local stock';
    var days=o.days?(' · about '+esc(o.days)+' days to '+esc(dest)):'';
    var action=o.handle
      ?'<a href="https://activepaw.co.uk/products/'+esc(o.handle)+'" target="_blank" rel="noopener">View</a>'
      :'<button class="ghost" type="button" style="padding:2px 8px" data-src-import="'+esc(o.pid)+'">Import</button>';
    return '<div class="row" style="margin-bottom:4px;font-size:13px"><span class="grow">'+esc(o.title)+' · £'+esc(Number(o.priceGbp).toFixed(2))+' · '+where+days+'</span>'+action+'</div>';
  }).join('');
}
async function runSupplierSearch(threadId,q){
  var box=el('inbox-supplier-results');
  if(!box) return;
  box.textContent='Checking the supplier…';
  try{
    var r=await api('/inbox/supplier-search',{q:q,threadId:threadId});
    if(!r.ok){ box.textContent='Supplier search failed: '+(r.error||'unknown'); return; }
    box.innerHTML=renderSupplierOffers(r.offers,r.dest,r.destKnown);
    var btns=box.querySelectorAll('button[data-src-import]');
    for(var i=0;i<btns.length;i++){
      (function(btn){ btn.onclick=function(){ btn.disabled=true; importForInquiry(btn.getAttribute('data-src-import'),threadId); }; })(btns[i]);
    }
  }catch(e){ box.textContent='Supplier search failed: '+errText(e); }
}
async function importForInquiry(pid,threadId){
  setMsg('ibx-msg','Importing for this customer. This runs every import check and can take a minute…','muted');
  try{
    var r=await api('/inbox/source-import',{pid:pid,threadId:threadId});
    if(!r.ok){ setMsg('ibx-msg','Not imported: '+(r.error||'unknown'),'no'); return; }
    for(var n=0;n<40;n++){
      if(r.state==='imported'){ setMsg('ibx-msg','Imported: https://activepaw.co.uk/products/'+(r.handle||''),'ok'); return; }
      if(r.state==='failed'){ setMsg('ibx-msg','Import refused: '+(r.failReason||'unknown')+(r.failDetail?' ('+r.failDetail+')':''),'no'); return; }
      await new Promise(function(res){ setTimeout(res,4000); });
      r=await api('/inbox/source-status',{pid:pid});
    }
    setMsg('ibx-msg','Still importing. Search again in a minute to see the result.','muted');
  }catch(e){ setMsg('ibx-msg','Import failed: '+errText(e),'no'); }
}
```

In `runCatalogSearch`, after the catalog results are rendered (and also in the `No products found.` branch), call `runSupplierSearch(threadId,q);`. Add the mount right after the catalog results element in the context-rail HTML (search `src/console/` for `id="inbox-catalog-results"` and add a sibling `<div id="inbox-supplier-results"></div>` directly after it).

- [ ] **Step 6: Run the console checks**

Run: `npx vitest run tests/console.test.ts` then `npm run lint`
Expected: PASS, and lint reports no `no-useless-escape`.

- [ ] **Step 7: Run the suite and commit**

Run: `npm test` (alone). Expected: PASS.

```bash
git add src/sourcing/console-search.ts src/index.ts src/console/ tests/console.test.ts
aramid check --staged
git commit -m "feat(inbox): catalog search shows supplier items with an Import button"
git push
```

---

### Task 6: The drafter offers a sourced item on a catalog miss (part C)

**Files:**
- Modify: `src/inbox/thread-read.ts` (`ThreadReading`, `validateReading`, `READER_SYSTEM`)
- Modify: `src/inbox/agents/types.ts` (`AgentContext.productQuery?`, `Grounding.holdReason?`)
- Create: `src/inbox/agents/sourcing.ts`
- Modify: `src/inbox/agents/product.ts` (query choice and the no-match branch)
- Modify: `src/inbox/autosend.ts` (add `withExtraHolds`)
- Modify: `src/inbox/sweep.ts` (`composeDraftForThread`: pass `productQuery`, merge the grounding hold)
- Test: `tests/agents/product-agent.test.ts` (append), `tests/inbox-thread-read.test.ts` (append), `tests/inbox/autosend.test.ts` or the existing `tests/agents/autosend.test.ts` (append)

**Interfaces:**
- Consumes: `supplierOffers`, `SupplierOffer` (Task 3); `localWarehousesFor`.
- Produces:
  - `ThreadReading.productQuery: string | null`
  - `AgentContext.productQuery?: string | null`, `Grounding.holdReason?: string`
  - `sourcingGrounding(ctx: AgentContext, query: string): Promise<Grounding>`, `offerFacts(o: SupplierOffer, dest: string | null): string`, `NO_MATCH_FACTS: string`
  - `withExtraHolds(decision: { send: boolean; holdReasons: string[] }, extra: string[]): { send: boolean; holdReasons: string[] }`

- [ ] **Step 1: Graph check**

Run: `python -P -m graphite impact src/inbox/sweep.ts`, `python -P -m graphite impact src/inbox/agents/types.ts`, `python -P -m graphite impact src/inbox/thread-read.ts`. Both new fields are optional or nullable so no other agent changes.

- [ ] **Step 2: Write the failing tests**

Append to `tests/inbox-thread-read.test.ts`:

```ts
import { validateReading } from '../src/inbox/thread-read';

describe('productQuery', () => {
  it('keeps a customer product phrase, trimmed and capped', () => {
    const r = validateReading({ senderRole: 'customer', openAsks: [], offered: '', alreadyAnswered: [], replyNeeded: true, productQuery: '  gps tracker dog collar ' });
    expect(r?.productQuery).toBe('gps tracker dog collar');
  });
  it('is null for a non-customer and when absent', () => {
    expect(validateReading({ senderRole: 'marketer', openAsks: [], productQuery: 'seo' })?.productQuery).toBeNull();
    expect(validateReading({ senderRole: 'customer', openAsks: [] })?.productQuery).toBeNull();
  });
});
```

(If `validateReading` is already imported at the top of that file, drop the duplicate import line.)

Append to `tests/agents/autosend.test.ts`:

```ts
import { withExtraHolds } from '../../src/inbox/autosend';

describe('withExtraHolds', () => {
  it('adds the reasons and stops the send', () => {
    expect(withExtraHolds({ send: true, holdReasons: [] }, ['sourcing_offer'])).toEqual({ send: false, holdReasons: ['sourcing_offer'] });
  });
  it('leaves the decision alone when there is nothing extra', () => {
    expect(withExtraHolds({ send: true, holdReasons: [] }, [])).toEqual({ send: true, holdReasons: [] });
  });
});
```

Append to `tests/agents/product-agent.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { TenantStore } from '../../src/tenant-store';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_FULFIL } from '../../src/types';
import type { CjClient, CjDetail } from '../../src/cj';

describe('productAgent on a catalog miss (inquiry sourcing)', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  const emptyAdmin = async () => ({ products: { edges: [] } });
  const TRACKER: CjDetail = { pid: 'T1', nameEn: 'Smart GPS Wireless Pet Tracker', images: ['https://i/t.jpg'], descriptionHtml: '<p>Clips to the collar. Needs a SIM card.</p>', variants: [{ vid: 'v', name: 'Black', sellPriceUsd: 12, sku: 's' }], listedNum: 10, categoryName: 'Pet', origins: { CN: 5429 } };
  const cj = {
    search: async () => [{ pid: 'T1', nameEn: TRACKER.nameEn, image: '', sellPriceUsd: 12, listedNum: 10, categoryName: 'Pet' }],
    detail: async () => TRACKER, detailBySku: async () => null, originsByPid: async () => TRACKER.origins,
    freightEstimate: async () => ({ priceUsd: 4, days: '5-9', name: 'CJPacket' }),
  } as unknown as CjClient;
  const cfg = { pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, fulfil: DEFAULT_FULFIL } as any;

  async function ctx(message: string, withCj = true) {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
    return { store, cfg, admin: emptyAdmin, cj: withCj ? cj : null, thread: { subject: 'Collar' }, conversation: message, latestMessage: message, contactEmail: 'aloha@example.com', customerName: 'Aloha', productQuery: 'gps tracker dog collar' } as any;
  }

  it('offers the supplier item with price, overseas note and delivery band, held for the owner', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar? I live in England.'));
    expect(g.confident).toBe(true);
    expect(g.holdReason).toBe('sourcing_offer');
    expect(g.facts).toContain('Smart GPS Wireless Pet Tracker');
    expect(g.facts).toMatch(/GBP \d+\.\d{2}/);
    expect(g.facts).toContain('ships from overseas');
    expect(g.facts).toMatch(/\d+-\d+ days/);
    expect(g.facts).not.toMatch(/\bChina\b|\bCJ\b/);
  });

  it('states no delivery time and asks for the country when it is unknown', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar?'));
    expect(g.holdReason).toBe('sourcing_offer');
    expect(g.facts).toContain('do not state a delivery time');
    expect(g.facts).not.toMatch(/\d+-\d+ days/);
  });

  it('never sends the customer to the website search when nothing matches', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar?', false));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).not.toContain('website');
    expect(g.facts).toContain('team will look into');
  });

  it('says we do not deliver to a country with no lane', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar? I live in Japan.'));
    expect(g.facts).toContain('do not currently deliver');
    expect(g.holdReason).toBeUndefined();
  });
});
```

Checked 2026-09-30 in `src/inbox/freight.ts`: "England" maps to `GB`, "Japan" to `JP` (no lane), and a `.com` address gives no country. Do not write "the UK." at a sentence end in a test: the parser's lookahead rejects "uk" followed by a full stop. Put the three new imports at the top of the file with the others.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/inbox-thread-read.test.ts tests/agents/autosend.test.ts tests/agents/product-agent.test.ts`
Expected: FAIL (`productQuery` undefined, `withExtraHolds` not exported, no `holdReason`, facts still say "website").

- [ ] **Step 4: Thread reader field**

In `src/inbox/thread-read.ts`: add `productQuery: string | null;` to `ThreadReading`; in `validateReading`'s returned object add:

```ts
    productQuery: senderRole === 'customer' ? str(o.productQuery, 80) : null,
```

In `READER_SYSTEM`, after the `"replyNeeded"` clause, add:

```ts
  '"productQuery": only when senderRole is customer and they ask about a product, that product as a short shop search phrase of 2 to 5 words (for example "gps tracker dog collar"), else null; ' +
```

- [ ] **Step 5: Types**

In `src/inbox/agents/types.ts`: add to `AgentContext`:

```ts
  productQuery?: string | null; // the thread reader's product phrase; null/absent -> agents use the message text
```

and to `Grounding`:

```ts
  holdReason?: string;     // a named reason this draft must wait for the owner (e.g. 'sourcing_offer')
```

- [ ] **Step 6: `withExtraHolds`**

Append to `src/inbox/autosend.ts`:

```ts
/** Named holds decided outside the money/confidence floor (a supplier promise,
 *  a sourcing offer). Any one of them stops the send. */
export function withExtraHolds(decision: { send: boolean; holdReasons: string[] }, extra: string[]): { send: boolean; holdReasons: string[] } {
  if (!extra.length) return decision;
  return { send: false, holdReasons: [...decision.holdReasons, ...extra] };
}
```

- [ ] **Step 7: Create `src/inbox/agents/sourcing.ts`**

```ts
import type { AgentContext, Grounding } from './types';
import { deriveDestinationCountry, countryLabel } from '../freight';
import { localWarehousesFor } from '../../local-markets';
import { supplierOffers, type SupplierOffer } from '../../sourcing/offers';

/** A catalog miss with no supplier match either. Never sends them to the website search. */
export const NO_MATCH_FACTS = 'We do not stock a matching item right now. Say so plainly and that the team will look into sourcing it; do not send them to the website search.';

/** Grounded facts for a sourced item. Local-for-local wording: overseas stock is
 *  said plainly; the origin country, the supplier and any SKU are never named. */
export function offerFacts(o: SupplierOffer, dest: string | null): string {
  const where = o.overseas
    ? 'It is not held in a local warehouse: it ships from overseas. Say that plainly.'
    : (dest ? 'It is stocked in a warehouse that serves their country.' : '');
  const delivery = dest && o.days
    ? `Estimated delivery to ${countryLabel(dest)}: ${o.days} days from order. You MAY state this.`
    : 'Their country is not known: do not state a delivery time; ask which country it would be delivered to.';
  return `Not in our catalog yet, but the team can source "${o.title}" for them at GBP ${o.priceGbp.toFixed(2)} (our price). You MAY state that price. ${where} ${delivery} `
    + `Describe the item only from these supplier notes, and never quote a brand name from them: ${o.descriptionText || 'none'}. `
    + 'Never name the country it ships from, the supplier, or any product code, and never suggest it is sent from the UK. Ask whether they would like one; the team will send the link.';
}

/**
 * Owner rule 2026-09-30: when our catalog has no match, look the item up at the
 * supplier and tell the customer the real situation. The draft is held
 * (`sourcing_offer`) so the owner imports the item before it is sent.
 */
export async function sourcingGrounding(ctx: AgentContext, query: string): Promise<Grounding> {
  const none: Grounding = { confident: false, quotesFigure: false, facts: NO_MATCH_FACTS };
  if (!ctx.cj || !query.trim()) return none;
  const dest = deriveDestinationCountry(ctx.conversation, ctx.thread.subject ?? '', ctx.contactEmail);
  if (dest && !localWarehousesFor(dest).length) {
    return { confident: true, quotesFigure: false, facts: `We do not stock that item, and the sender appears to be in ${countryLabel(dest)}, which we do not currently deliver to. Say so plainly and apologise briefly.` };
  }
  let offers: SupplierOffer[] = [];
  try {
    offers = await supplierOffers(ctx.store, ctx.cj, ctx.cfg, query, dest ?? 'GB', { limit: 1 });
  } catch (e) {
    console.warn(`sourcing lookup failed: ${(e as Error).message}`);
  }
  const o = offers[0];
  if (!o) return none;
  return { confident: true, quotesFigure: true, holdReason: 'sourcing_offer', facts: offerFacts(o, dest), data: { sourcingPid: o.pid } };
}
```

- [ ] **Step 8: Product agent**

In `src/inbox/agents/product.ts`, import `sourcingGrounding` and `NO_MATCH_FACTS` from `./sourcing`, then replace:

```ts
      const query = linked ? `/products/${linked}` : ctx.latestMessage.slice(0, 80);
      if (!query.trim()) return hedge('No specific product named; ask which item they mean or point them to the website.');
      const r = await resolveLineRequest(ctx.admin, query);
```

with:

```ts
      // The thread reader's product phrase ("gps tracker dog collar") searches far
      // better than the first 80 characters of a chatty message; the raw text is
      // the fallback when the phrase finds nothing.
      const typed = ctx.latestMessage.slice(0, 80);
      const query = linked ? `/products/${linked}` : (ctx.productQuery || typed);
      if (!query.trim()) return hedge('No specific product named; ask which item they mean or point them to the website.');
      let r = await resolveLineRequest(ctx.admin, query);
      if (r.status === 'none' && !linked && ctx.productQuery && typed.trim()) r = await resolveLineRequest(ctx.admin, typed);
```

and replace:

```ts
      return hedge('No matching product found; point them to the website search and offer to help once they name the item.');
```

with:

```ts
      if (linked) return hedge(NO_MATCH_FACTS);
      return await sourcingGrounding(ctx, ctx.productQuery || typed);
```

- [ ] **Step 9: Composer wiring**

In `src/inbox/sweep.ts` `composeDraftForThread`: add `withExtraHolds` to the `./autosend` import; in the `ctx` object literal add `productQuery: reading?.productQuery ?? null,`; replace:

```ts
  const supplierHold = agent.category === 'supplier' && promisesSupplier(draft.bodyText);
  const holdReasons = supplierHold ? [...decision.holdReasons, 'supplier_commitment'] : decision.holdReasons;
  const send = decision.send && !supplierHold;
```

with:

```ts
  const supplierHold = agent.category === 'supplier' && promisesSupplier(draft.bodyText);
  // Named holds: a supplier promise, or a sourced item the owner must import
  // before the offer goes out (owner decision 2026-09-30).
  const held = withExtraHolds(decision, [
    ...(supplierHold ? ['supplier_commitment'] : []),
    ...(grounding.holdReason ? [grounding.holdReason] : []),
  ]);
  const holdReasons = held.holdReasons;
  const send = held.send;
```

- [ ] **Step 10: Run the tests**

Run: `npx vitest run tests/inbox-thread-read.test.ts tests/agents/autosend.test.ts tests/agents/product-agent.test.ts tests/inbox-thread-read-sweep.test.ts tests/agents/dispatch-integration.test.ts`
Expected: PASS. The existing "no match" behaviour now returns `NO_MATCH_FACTS` when `ctx.cj` is absent; if an older test asserted "website" on that path, update it to the new wording and say so in the commit message.

- [ ] **Step 11: Run the suite and commit**

Run: `npx tsc --noEmit` then `npm test` (alone). Expected: PASS.

```bash
git add src/inbox/thread-read.ts src/inbox/agents/types.ts src/inbox/agents/sourcing.ts src/inbox/agents/product.ts src/inbox/autosend.ts src/inbox/sweep.ts tests/
aramid check --staged
git commit -m "feat(inbox): a catalog miss offers the supplier item, held for the owner to import"
git push
```

---

### Task 7: Storefront overseas cards behind `overseas=1` (part D)

**Files:**
- Modify: `src/proxy/search.ts` (`GhostCard`, `searchBackfill` options, every `cards.push`, a new overseas section before the hero swap)
- Modify: `src/sourcing/lane-route.ts` (add `storefrontImportWarehouses`)
- Modify: `src/index.ts` (`/proxy/search` and `/proxy/product`)
- Modify: `src/proxy/import.ts` (`PreviewProduct` gains optional `delivery`)
- Test: `tests/search.test.ts` (append), `tests/sourcing-lane-route.test.ts` (append)

**Interfaces:**
- Consumes: `inquiryWarehouses`, `laneRouteFor` (Task 1).
- Produces:
  - `GhostCard.delivery: { overseas: boolean; days: string | null }`
  - `searchBackfill(..., opts.overseas?: boolean)`
  - `storefrontImportWarehouses(countryRaw: string | undefined, overseasFlag: string | undefined): string[] | undefined`
  - `/proxy/search?overseas=1`, `/proxy/product?country=XX&overseas=1`; `PreviewProduct.delivery?: { overseas: boolean; days: string | null } | null`

- [ ] **Step 1: Write the failing tests**

Append to `tests/search.test.ts` (it already has `fakeCj`, `item`, `CFG`, `TenantStore`, `searchBackfill`):

```ts
describe('storefront overseas cards (owner choice 2026-09-30)', () => {
  const TRACKER = item({ pid: 'T1', nameEn: 'Smart GPS Pet Tracker Dog Collar', sellPriceUsd: 12 });
  function laneCj(byCountry: Record<string, CjSearchItem[]>, calls: string[] = []): CjClient {
    return { search: async () => [], searchByWarehouse: async (kw: string, cc: string) => { calls.push(`${kw}@${cc}`); return byCountry[cc] ?? []; } } as unknown as CjClient;
  }
  async function storeWithRoute() {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
    return store;
  }

  it('adds overseas cards with a delivery band only when asked', async () => {
    const store = await storeWithRoute();
    const cards = await searchBackfill(store, laneCj({ CN: [TRACKER] }), CFG, 'gps tracker dog collar', 0, 12, { buyerCountry: 'GB', overseas: true });
    expect(cards.map((c) => c.pid)).toEqual(['T1']);
    expect(cards[0].delivery.overseas).toBe(true);
    expect(cards[0].delivery.days).toMatch(/^\d+-\d+$/);
  });

  it('never returns overseas cards without the flag', async () => {
    const store = await storeWithRoute();
    const calls: string[] = [];
    const cards = await searchBackfill(store, laneCj({ CN: [TRACKER] }, calls), CFG, 'gps tracker dog collar', 0, 12, { buyerCountry: 'GB' });
    expect(cards).toEqual([]);
    expect(calls.some((c) => c.endsWith('@CN'))).toBe(false);
  });

  it('shows no overseas card where no China route reaches the buyer', async () => {
    const store = await storeWithRoute();
    expect(await searchBackfill(store, laneCj({ CN: [TRACKER] }), CFG, 'gps tracker dog collar', 0, 12, { buyerCountry: 'AU', overseas: true })).toEqual([]);
  });

  it('marks local cards as local', async () => {
    const store = await storeWithRoute();
    const cards = await searchBackfill(store, laneCj({ GB: [TRACKER] }), CFG, 'gps tracker dog collar', 0, 12, { buyerCountry: 'GB', overseas: true });
    expect(cards[0].delivery).toEqual({ overseas: false, days: null });
  });
});
```

Append to `tests/sourcing-lane-route.test.ts`:

```ts
import { storefrontImportWarehouses } from '../src/sourcing/lane-route';

describe('storefrontImportWarehouses', () => {
  it('widens to lane plus CN only for an overseas click with a valid country', () => {
    expect(storefrontImportWarehouses('gb', '1')).toEqual(['GB', 'CN']);
  });
  it('keeps the default lane otherwise', () => {
    expect(storefrontImportWarehouses('GB', undefined)).toBeUndefined();
    expect(storefrontImportWarehouses('not a country', '1')).toBeUndefined();
    expect(storefrontImportWarehouses('NG', '1')).toBeUndefined();
  });
});
```

If `DEFAULT_GATES` in `CFG` makes the tracker fail the popularity floor or price gates, raise `listedNum`/adjust `sellPriceUsd` in `TRACKER`, never the gates.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/search.test.ts tests/sourcing-lane-route.test.ts`
Expected: FAIL (`delivery` undefined, `overseas` option ignored, `storefrontImportWarehouses` not exported).

- [ ] **Step 3: `storefrontImportWarehouses`**

Append to `src/sourcing/lane-route.ts` (add `inquiryWarehouses` to its `../local-markets` import):

```ts
/** Warehouses a storefront ghost click may import from: the default (undefined,
 *  meaning the home lane) unless the theme sent overseas=1 with a valid
 *  country whose lane can use the China hub. */
export function storefrontImportWarehouses(countryRaw: string | undefined, overseasFlag: string | undefined): string[] | undefined {
  if (overseasFlag !== '1') return undefined;
  const cc = (countryRaw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return undefined;
  const w = inquiryWarehouses(cc);
  return w.includes('CN') ? w : undefined;
}
```

- [ ] **Step 4: Ghost cards and the overseas section in `src/proxy/search.ts`**

1. `GhostCard` gains:

```ts
  /** Where it ships from, for the card's note: overseas cards carry the door-to-door band. */
  delivery: { overseas: boolean; days: string | null };
```

2. `searchBackfill`'s `opts` type gains `overseas?: boolean`.
3. Every existing `cards.push({...})` in `searchBackfill` gains `delivery: { overseas: false, days: null },`.
4. Add imports: `inquiryWarehouses` from `../local-markets`; `resolveLogistics`, `doorToDoorBand`, `formatBand` from `../logistics`.
5. Insert this section after the live-CJ block and before the hero-image swap:

```ts
  // --- 3) overseas supplement (owner choice 2026-09-30) ---
  // Only when the theme asked (overseas=1, sent once it renders the "ships from
  // overseas" note), only for a lane that may use the China hub, and only with a
  // fresh China route to this buyer: the band is the product page's own formula.
  const buyer = (opts.buyerCountry ?? 'GB').toUpperCase();
  if (opts.overseas && cards.length < limit && (opts.liveFallback ?? true) && inquiryWarehouses(buyer).includes('CN')) {
    const l = resolveLogistics(cfg.fulfil);
    const days = formatBand(doorToDoorBand(await store.getLogisticsRoute('CN', buyer, l.stalenessHours), l));
    if (days) {
      let items: CjSearchItem[];
      const cached = await store.getSearchCache(`kw3:CN:${kw}`);
      if (cached) {
        items = JSON.parse(cached);
      } else {
        items = await cj.searchByWarehouse(kw, 'CN');
        await store.putSearchCache(`kw3:CN:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
      }
      const gated = items.filter((i) => !seen.has(i.pid) && storefrontLivePasses(i, cfg.gates, kw) && categoryAdmitsLiveCj(i.topCategory) && isPetProductStrict(i.nameEn));
      const links = await store.getLinks(gated.map((i) => i.pid));
      for (const item of gated) {
        if (cards.length >= limit) break;
        const link = links.get(item.pid);
        const imported = link?.state === 'imported' && link.handle;
        if (!imported && !ghostCardClearsFloor({ sellPriceUsd: item.sellPriceUsd }, cfg)) continue;
        cards.push({
          pid: item.pid, title: item.nameEn, image: item.image,
          price: retailPriceGbp(item.sellPriceUsd, cfg.pricing),
          state: imported ? 'imported' : 'ghost',
          url: imported ? `/products/${link!.handle}` : null,
          delivery: { overseas: true, days },
        });
        seen.add(item.pid);
      }
    }
  }
```

- [ ] **Step 5: Routes and preview**

In `src/index.ts` `/proxy/search`: read `const overseas = c.req.query('overseas') === '1';` and pass `overseas` in the `searchBackfill` options.

In `/proxy/product`: import `storefrontImportWarehouses` and `laneRouteFor` from `./sourcing/lane-route`; compute

```ts
    const importWarehouses = storefrontImportWarehouses(c.req.query('country'), c.req.query('overseas'));
```

pass `localWarehouses: importWarehouses` in the `confirmAndImport` options object (undefined keeps the default lane), and before the final `return c.json(...)` compute the preview delivery only for overseas requests:

```ts
    const preview = buildPreview(detail, p.cfg, link?.state ?? 'importing', handle);
    if (importWarehouses) {
      const cc = (c.req.query('country') ?? '').trim().toUpperCase();
      const route = await laneRouteFor(p.store, p.cfg, detail.origins, cc);
      preview.delivery = route ? { overseas: route.overseas, days: route.days } : null;
    }
    return c.json({ ok: true, product: preview });
```

In `src/proxy/import.ts` add to `PreviewProduct`:

```ts
  /** Set only for an overseas=1 preview: the note the theme shows. */
  delivery?: { overseas: boolean; days: string | null } | null;
```

- [ ] **Step 6: Run the tests and the suite**

Run: `npx vitest run tests/search.test.ts tests/sourcing-lane-route.test.ts tests/import.test.ts`, then `npx tsc --noEmit`, then `npm test` (alone).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/proxy/search.ts src/sourcing/lane-route.ts src/index.ts src/proxy/import.ts tests/search.test.ts tests/sourcing-lane-route.test.ts
aramid check --staged
git commit -m "feat(search): overseas ghost cards with a delivery note, only when the theme asks"
git push
```

---

### Task 8: Theme recommendation, deploy, and live checks

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-inquiry-sourcing-design.md` (status line only, at the end)

- [ ] **Step 1: Recommend the theme change to the theme's agent**

Post one message over the shared channel to the demo-store2 agent (use the `graphite_channel_post` tool; read `.agent-channel/PROTOCOL.md` in this repo first if the tool asks for fields). Content: the worker now supports `overseas=1` on `/apps/pawscout/search` and `country=XX&overseas=1` on `/apps/pawscout/product`; each ghost card carries `delivery: { overseas, days }` and the preview carries `delivery` on overseas requests; the owner rule (make the customer aware) means the theme should send `overseas=1` only once it shows "Ships from overseas, about N days" on overseas cards and in the preview, never naming a country. The theme's agent decides and builds it. Do not edit the theme repo.

- [ ] **Step 2: Staging**

Run: `npm run deploy -- --env staging`, then `curl -s https://pawscout-worker-staging.bmorris0565.workers.dev/healthz`.
Expected: version = the branch head's first 12 characters.

- [ ] **Step 3: CI**

Run: `gh run list --commit <full 40-character head SHA> --json status,conclusion` until completed.
Expected: `success`.

- [ ] **Step 4: Owner go, merge, production**

Ask the owner for the production go. On the go: `git checkout master && git merge --no-ff --no-commit feat/inquiry-sourcing`, `aramid check --staged`, `git commit`, `git push` (outside a drain hold), wait for CI on the merge SHA, then `npm run deploy -- --env production` away from minutes 0, 15, 30, 45 and 04:17 UTC. A D1 7403 refusal is retried once. Confirm `/healthz` shows the merge SHA.

- [ ] **Step 5: Live check, console search**

Through the admin iframe (app handle `pawscout-1`, `window.shopify.idToken()`, same-origin fetch), call `POST /api/inbox/supplier-search` with `{ q: 'CJPC262132401AZ', threadId: <Aloha's thread id> }`.
Expected: one offer for the P03 GPS tracker, `overseas: true`, a `days` band, a GBP price. If the SKU returns nothing, the `/product/query` SKU parameter is wrong: stop, report, and fix Task 2 before anything else.

- [ ] **Step 6: Live check, import and Aloha**

Only with the owner's agreement: `POST /api/inbox/source-import` with the tracker's pid and Aloha's thread id; poll `source-status` until `imported` or `failed`, and report the fail reason verbatim if refused. Then tell the owner the product link and the delivery band so the held Aloha draft (e31bb9db) can be regenerated or edited with the link.

- [ ] **Step 7: Mark the spec built**

Change the spec's status line to `Status: BUILT and live (<date>, merge <sha>)`, commit, push.
