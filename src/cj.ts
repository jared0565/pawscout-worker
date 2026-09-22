import type { Vault } from './vault';
import type { TenantStore } from './tenant-store';
import { defaultFetch } from './safe-fetch';

const CJ_ORIGIN = 'https://developers.cjdropshipping.com';
const CJ_BASE = `${CJ_ORIGIN}/api2.0/v1`;
const CJ_AUTH_URL = `${CJ_BASE}/authentication/getAccessToken`;

export interface CjRelay { url: string; token: string }

/**
 * Route CJ traffic through the dedicated-egress relay (relay/). CJ allows at
 * most 3 API users per source IP and Workers egress IPs are shared, so direct
 * calls 429 with code 1600200 regardless of our own rate. Returns a fetch that
 * rewrites CJ origins to the relay and authenticates with the shared token;
 * non-CJ URLs pass through untouched.
 */
export function relayedFetch(relay: CjRelay, base: typeof fetch = defaultFetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(CJ_ORIGIN)) return base(input as Parameters<typeof fetch>[0], init);
    const rewritten = relay.url.replace(/\/+$/, '') + '/cj' + url.slice(CJ_ORIGIN.length);
    const headers = new Headers(init?.headers);
    headers.set('X-Relay-Token', relay.token);
    return base(rewritten, { ...init, headers });
  }) as typeof fetch;
}

/** The fetch all CJ calls should use: relayed when configured, direct otherwise (local dev). */
export function cjFetchFromEnv(env: { CJ_RELAY_URL?: string; CJ_RELAY_TOKEN?: string }): typeof fetch {
  return env.CJ_RELAY_URL && env.CJ_RELAY_TOKEN
    ? relayedFetch({ url: env.CJ_RELAY_URL, token: env.CJ_RELAY_TOKEN })
    : defaultFetch;
}

// Workers' fetch sends no User-Agent; some gateways throttle UA-less requests.
const CJ_HEADERS = { 'User-Agent': 'PawScout/1.0 (+https://pawscout.activepaw.co.uk)', Accept: 'application/json' };

/** CJ error responses carry the real reason in the body - keep it. */
async function httpError(resp: Response): Promise<Error> {
  let body = '';
  try { body = (await resp.text()).slice(0, 300); } catch { /* body unavailable */ }
  return new Error(`CJ HTTP ${resp.status}${body ? ` - ${body}` : ''}`);
}

// CJ allows roughly one auth refresh per 300s and tokens live ~15 days -
// never authenticate per request; cache the token and refresh early.
const REFRESH_COOLDOWN_MS = 300_000;
const EXPIRY_SAFETY_MS = 3_600_000;

export type ValidateResult = { ok: true } | { ok: false; error: string };

export async function validateCjKey(apiKey: string, fetchImpl: typeof fetch = defaultFetch): Promise<ValidateResult> {
  try {
    const resp = await fetchImpl(CJ_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CJ_HEADERS },
      body: JSON.stringify({ apiKey })
    });
    if (!resp.ok) return { ok: false, error: (await httpError(resp)).message };
    const data = (await resp.json()) as { result?: boolean; message?: string };
    return data.result ? { ok: true } : { ok: false, error: data.message || 'CJ rejected the key' };
  } catch (e) {
    return { ok: false, error: `CJ auth failed: ${(e as Error).message}` };
  }
}

export async function cjAuthenticate(
  apiKey: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<{ token: string; expiresAt: string }> {
  const resp = await fetchImpl(CJ_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CJ_HEADERS },
    body: JSON.stringify({ apiKey })
  });
  if (!resp.ok) throw await httpError(resp);
  const data = (await resp.json()) as {
    result?: boolean;
    message?: string;
    data?: { accessToken?: string; accessTokenExpiryDate?: string };
  };
  if (!data.result || !data.data?.accessToken) throw new Error(data.message || 'CJ auth rejected');
  // Fall back to 14 days if CJ omits the expiry (tokens last ~15).
  const expiresAt = data.data.accessTokenExpiryDate || new Date(Date.now() + 14 * 86400_000).toISOString();
  return { token: data.data.accessToken, expiresAt };
}

/**
 * Serves a valid CJ access token from the sealed D1 cache, re-authenticating
 * only when stale and only if the 300s refresh cooldown has elapsed.
 */
export class CjTokenManager {
  constructor(
    private readonly store: TenantStore,
    private readonly vault: Vault,
    private readonly fetchImpl: typeof fetch = defaultFetch,
    private readonly now: () => number = Date.now
  ) {}

  async getToken(): Promise<string> {
    const tenant = await this.store.getTenant();
    if (!tenant?.dek_wrapped) throw new Error('Tenant not installed');
    const row = await this.store.getCjToken();
    const nowMs = this.now();

    if (row && Date.parse(row.expires_at) - EXPIRY_SAFETY_MS > nowMs) {
      return this.vault.open(tenant.dek_wrapped, row.token_enc);
    }
    if (row && nowMs - Date.parse(row.refreshed_at) < REFRESH_COOLDOWN_MS) {
      // Refresh is rate-limited; keep using the old token while it's still valid.
      if (Date.parse(row.expires_at) > nowMs) return this.vault.open(tenant.dek_wrapped, row.token_enc);
      throw new Error('CJ token expired and refresh is rate-limited; retry shortly');
    }

    const cred = await this.store.getSupplierCredential('cj');
    if (!cred) throw new Error('CJ not connected');
    const apiKey = await this.vault.open(tenant.dek_wrapped, cred.api_key_enc);
    const { token, expiresAt } = await cjAuthenticate(apiKey, this.fetchImpl);
    await this.store.putCjToken(await this.vault.seal(tenant.dek_wrapped, token), expiresAt);
    return token;
  }
}

// --- product API ---

export interface CjSearchItem {
  pid: string;
  nameEn: string;
  image: string;
  sellPriceUsd: number; // lowest variant price when CJ returns a range
  listedNum: number;
  categoryName: string;
  /** CJ top-level category (oneCategoryName), populated only when listV2 is
   *  queried with features=enable_category; '' on the /product/list fallback.
   *  Drives the live-CJ hard-drop category gate in proxy/search.ts. */
  topCategory?: string;
}

export interface CjVariant { vid: string; name: string; sellPriceUsd: number; sku: string; stock?: number }

export interface CjDetail {
  pid: string;
  nameEn: string;
  images: string[];
  descriptionHtml: string;
  variants: CjVariant[];
  listedNum: number;
  categoryName: string;
  /** Max stock across variants. 0 = none or unknown (confirm via stockByPid). */
  stock?: number;
  /** W3 curation audit trail: original CJ title + admission score. */
  originalNameEn?: string;
  llmScore?: number;
  /** LLM-assigned target animal (cat/dog/both/small-pet/other) for species filtering. */
  petClass?: string;
  /** Best stock per origin country (from enable_inventory), e.g. {CN: 1200, GB: 40}. */
  origins?: Record<string, number>;
  /** Cheapest freight (USD) to GB from the chosen origin, captured at admission/import;
   *  feeds the pricing floor. Delivery TIME now lives in the synced cj_logistics matrix,
   *  not here (the old per-detail freightDays was dead - read by nothing). */
  freightUsd?: number;
  origin?: string;
}

/** CJ exposes variant stock under several names depending on endpoint/era. */
function parseVariantStock(v: Record<string, unknown>): number | undefined {
  for (const k of ['variantQuantity', 'storageNum', 'inventoryNum', 'stock']) {
    if (v[k] != null) {
      const n = Number(v[k]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  // features=enable_inventory shape: per-variant `inventories` rows, one per
  // country/warehouse. A single origin must be able to fulfil - take the max.
  if (Array.isArray(v.inventories)) {
    const totals = (v.inventories as Record<string, unknown>[])
      .map((r) => Number(r.totalInventory ?? r.totalInventoryNum ?? 0))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (totals.length) return Math.max(...totals);
  }
  return undefined;
}

/** Aggregate per-country stock across variants (best variant per country). */
function collectOrigins(variants: Record<string, unknown>[]): Record<string, number> | undefined {
  const origins: Record<string, number> = {};
  for (const v of variants) {
    if (!Array.isArray(v.inventories)) continue;
    for (const r of v.inventories as Record<string, unknown>[]) {
      const cc = String(r.countryCode ?? '').toUpperCase();
      const n = Number(r.totalInventory ?? r.totalInventoryNum ?? 0);
      if (cc && Number.isFinite(n) && n > 0) origins[cc] = Math.max(origins[cc] ?? 0, n);
    }
  }
  return Object.keys(origins).length ? origins : undefined;
}

/**
 * Preferred dispatch origin: the UK warehouse when it can genuinely fulfil
 * (stock ≥ floor) - 2-4 day delivery beats CN's 8-15 every time the margin
 * allows - otherwise the best-stocked origin, defaulting to CN.
 */
export function chooseOrigin(detail: CjDetail, stockFloor: number): string {
  const o = detail.origins ?? {};
  if ((o.GB ?? o.UK ?? 0) >= stockFloor) return 'GB';
  let best = 'CN';
  let bestQty = o.CN ?? 0;
  for (const [cc, qty] of Object.entries(o)) {
    if (qty > bestQty) { best = cc; bestQty = qty; }
  }
  return best;
}

/** Map raw CJ product rows (list or listV2 shape) to CjSearchItem; field names vary by endpoint. */
function mapCjSearchItems(list: unknown): CjSearchItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((raw) => {
      const p = raw as Record<string, unknown>;
      return {
        // listV2 returns the product id in `id`; /product/list uses `pid`.
        pid: String(p.pid ?? p.productId ?? p.id ?? ''),
        nameEn: String(p.productNameEn ?? p.nameEn ?? p.productName ?? ''),
        image: String(p.productImage ?? p.bigImage ?? p.image ?? ''),
        sellPriceUsd: parseCjPrice(p.sellPrice ?? p.price),
        listedNum: Number(p.listedNum ?? p.listedCount ?? 0),
        categoryName: String(p.categoryName ?? p.threeCategoryName ?? p.categoryNameEn ?? ''),
        topCategory: String(p.oneCategoryName ?? '')
      };
    })
    .filter((p) => p.pid && p.nameEn);
}

/** listV2 nests products differently across CJ revisions - pull the product array from any known shape. */
function extractV2List(data: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!data) return [];
  if (Array.isArray(data.list)) return data.list as Record<string, unknown>[];
  if (Array.isArray(data.productList)) return data.productList as Record<string, unknown>[];
  if (Array.isArray(data.content)) {
    const out: Record<string, unknown>[] = [];
    for (const c of data.content as Record<string, unknown>[]) {
      if (Array.isArray(c?.productList)) out.push(...(c.productList as Record<string, unknown>[]));
      else out.push(c);
    }
    return out;
  }
  return [];
}

/** CJ price fields can be numbers, strings, or ranges like "5.99 -- 12.99" - take the first number. */
export function parseCjPrice(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v ?? '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

export class CjClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = defaultFetch,
    private readonly pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(params).toString();
    // CJ free tier allows ~1 request/second; a cold-token mint followed
    // immediately by this call can 429. Back off briefly and retry.
    for (let attempt = 0; ; attempt++) {
      const resp = await this.fetchImpl(`${CJ_BASE}${path}?${qs}`, {
        headers: { 'CJ-Access-Token': await this.token(), ...CJ_HEADERS }
      });
      if (resp.status === 429 && attempt < 2) {
        await this.pause(1200 * (attempt + 1));
        continue;
      }
      if (!resp.ok) throw await httpError(resp);
      // CJ is migrating endpoints from a {result} envelope to a {success} one
      // (getInventoryByPid flipped mid-day 2026-07-03, breaking every stock
      // check until this accepted both). Treat either flag as the ok signal.
      const data = (await resp.json()) as { result?: boolean; success?: boolean; message?: string; code?: number; data?: unknown };
      if (!(data.result ?? data.success)) {
        // Keep CJ's numeric code - messages like "Interface not found" are
        // useless without it when debugging endpoint deprecations.
        throw new Error(`${data.message || 'CJ request failed'}${data.code != null ? ` (CJ code ${data.code}, ${path})` : ''}`);
      }
      return data.data;
    }
  }

  async search(keyword: string, pageSize = 40): Promise<CjSearchItem[]> {
    // Prefer listV2 - CJ's elasticsearch search, which powers their website
    // and returns far more relevant results than the legacy keyword endpoint
    // (which OR-matched single words and surfaced advent calendars for "cat
    // toys"). Fall back to /product/list if V2 errors or returns nothing.
    try {
      const v2 = await this.searchV2(keyword, pageSize);
      if (v2.length) return v2;
    } catch (e) {
      console.warn(`CJ listV2 search failed, falling back to /product/list: ${(e as Error).message}`);
    }
    const data = (await this.get('/product/list', {
      productNameEn: keyword,
      pageNum: '1',
      pageSize: String(pageSize)
    })) as { list?: Record<string, unknown>[] } | null;
    return mapCjSearchItems(data?.list);
  }

  /**
   * CJ elasticsearch search (V2) - the relevance-ranked search behind CJ's
   * website. listV2 uses `page`/`size` (NOT pageNum/pageSize), defaults
   * orderBy=0 (best match), and returns the product id in `id` (NOT `pid`) -
   * getting any of these wrong makes it return nothing and silently fall back
   * to the junky keyword endpoint.
   */
  private async searchV2(keyword: string, pageSize: number): Promise<CjSearchItem[]> {
    const data = (await this.get('/product/listV2', {
      keyWord: keyword,
      page: '1',
      size: String(Math.min(pageSize, 100)),
      orderBy: '0', // 0 = best match (relevance) - explicit, matches the website
      features: 'enable_category' // populates oneCategoryName for the pet-category gate (single string, not a JSON array)
    })) as Record<string, unknown> | null;
    return mapCjSearchItems(extractV2List(data));
  }

  /**
   * Warehouse-filtered discovery: products CJ stocks in `countryCode`'s warehouse.
   * Uses /product/list (the legacy keyword endpoint) because it honors the
   * `countryCode` warehouse filter that listV2 does not - the LLM curation gate
   * downstream is the real niche filter, so the endpoint's lower precision is fine.
   */
  async searchByWarehouse(keyword: string, countryCode = 'GB', pageSize = 50): Promise<CjSearchItem[]> {
    const data = (await this.get('/product/list', {
      productNameEn: keyword,
      countryCode,
      pageNum: '1',
      pageSize: String(Math.min(pageSize, 100))
    })) as { list?: Record<string, unknown>[] } | null;
    return mapCjSearchItems(data?.list);
  }

  async detail(pid: string): Promise<CjDetail | null> {
    // enable_inventory embeds per-variant inventories in the SAME response -
    // saving the separate stock call that CJ renamed out from under us once.
    const p = (await this.get('/product/query', { pid, features: 'enable_inventory' })) as Record<string, unknown> | null;
    if (!p?.pid) return null;
    let images: string[] = [];
    const set = p.productImageSet;
    if (Array.isArray(set)) images = set.map(String);
    else if (typeof set === 'string') {
      try { images = (JSON.parse(set) as string[]).map(String); } catch { images = set ? [set] : []; }
    }
    if (!images.length && p.productImage) images = [String(p.productImage)];
    const variants = (Array.isArray(p.variants) ? p.variants : []).map((v: Record<string, unknown>) => ({
      vid: String(v.vid ?? ''),
      // || not ??: some CJ products carry variantNameEn as an EMPTY STRING with
      // the real label in variantKey (e.g. 'Green') - an empty name reaches
      // Shopify as an option value and productSet rejects the whole import
      // with "The name provided is not valid".
      name: String(v.variantNameEn || v.variantName || v.variantKey || 'Default'),
      sellPriceUsd: parseCjPrice(v.variantSellPrice ?? v.sellPrice),
      sku: String(v.variantSku ?? ''),
      stock: parseVariantStock(v)
    })).filter((v) => v.vid && v.sellPriceUsd > 0);
    const known = variants.map((v) => v.stock).filter((s): s is number => s !== undefined);
    return {
      pid: String(p.pid),
      nameEn: String(p.productNameEn ?? ''),
      images,
      descriptionHtml: String(p.description ?? ''),
      variants: variants.length ? variants : [{ vid: 'default', name: 'Default', sellPriceUsd: parseCjPrice(p.sellPrice), sku: String(p.productSku ?? '') }],
      listedNum: Number(p.listedNum ?? 0),
      categoryName: String(p.categoryName ?? ''),
      stock: known.length ? Math.max(...known) : 0,
      origins: collectOrigins(Array.isArray(p.variants) ? (p.variants as Record<string, unknown>[]) : [])
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const resp = await this.fetchImpl(`${CJ_BASE}${path}`, {
        method: 'POST',
        headers: { 'CJ-Access-Token': await this.token(), 'Content-Type': 'application/json', ...CJ_HEADERS },
        body: JSON.stringify(body)
      });
      if (resp.status === 429 && attempt < 2) {
        await this.pause(1200 * (attempt + 1));
        continue;
      }
      if (!resp.ok) throw await httpError(resp);
      // Same dual-envelope acceptance as get() - see the note there.
      const data = (await resp.json()) as { result?: boolean; success?: boolean; message?: string; code?: number; data?: unknown };
      if (!(data.result ?? data.success)) {
        throw new Error(`${data.message || 'CJ request failed'}${data.code != null ? ` (CJ code ${data.code}, ${path})` : ''}`);
      }
      return data.data;
    }
  }

  /**
   * All freight options for one unit of a variant, `fromCountry` → `toCountry`,
   * sorted cheapest-first. Freight varies per variant (weight) so the caller
   * passes a representative vid. `toCountry` defaults to GB (the home market) so
   * existing admission/import callers are unchanged; the console quote passes a
   * real destination (e.g. ES) to see what an international order actually costs.
   */
  async freightQuote(vid: string, fromCountry = 'CN', toCountry = 'GB', quantity = 1): Promise<{ priceUsd: number; days: string; name: string }[]> {
    const data = await this.post('/logistic/freightCalculate', {
      startCountryCode: fromCountry,
      endCountryCode: toCountry,
      products: [{ quantity, vid }]
    });
    const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        priceUsd: parseCjPrice(r.logisticPrice),
        days: String(r.logisticAging ?? ''),
        name: String(r.logisticName ?? '')
      }))
      .filter((o) => o.priceUsd > 0)
      .sort((a, b) => a.priceUsd - b.priceUsd);
  }

  /**
   * Aging-preserving freight quote: identical to freightQuote but does NOT drop
   * price-0 options. US-domestic carriers (USPS/UPS/FedEx/Yunexpress) return
   * logisticPrice=0 in the CJ API even when the service exists -- freightQuote
   * drops those because it is used for margin calculations. Here we only need
   * the delivery-time aging, so a free-$0 domestic option is valid and must be
   * retained. Still sorts cheapest-first so the real cheapest wins when non-zero
   * options also exist.
   */
  async freightQuoteAging(vid: string, fromCountry = 'CN', toCountry = 'GB', quantity = 1): Promise<{ priceUsd: number; days: string; name: string }[]> {
    return this.freightOptions([{ quantity, vid }], fromCountry, toCountry);
  }

  /** One freightCalculate POST for a whole basket, every option cheapest-first,
   *  price-0 rows kept (the callers decide what a $0 row means on their route). */
  private async freightOptions(products: { vid: string; quantity: number }[], fromCountry: string, toCountry: string): Promise<{ priceUsd: number; days: string; name: string }[]> {
    const data = await this.post('/logistic/freightCalculate', {
      startCountryCode: fromCountry,
      endCountryCode: toCountry,
      products: products.map((p) => ({ quantity: p.quantity, vid: p.vid }))
    });
    const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        priceUsd: parseCjPrice(r.logisticPrice),
        days: String(r.logisticAging ?? ''),
        name: String(r.logisticName ?? '')
      }))
      .sort((a, b) => a.priceUsd - b.priceUsd);
  }

  /**
   * Cheapest LIVE freight for a whole basket (every line with its quantity),
   * `fromCountry` -> `toCountry`: the figure the order pipeline counter-checks
   * before it books and pays a supplier order (owner rule 2026-09-22: freight
   * is always counter-checked against live CJ data). Same $0 rule as
   * freightEstimate: a domestic $0 option is a real carrier, a cross-border
   * $0 row is a service that does not carry the shipment. null = no channel
   * serves this basket on this route.
   */
  async freightForBasket(products: { vid: string; quantity: number }[], fromCountry: string, toCountry: string): Promise<{ priceUsd: number; days: string; name: string } | null> {
    const all = await this.freightOptions(products, fromCountry, toCountry);
    const options = fromCountry === toCountry ? all : all.filter((o) => o.priceUsd > 0);
    return options.length ? options[0] : null;
  }

  /**
   * Cheapest freight quote for one unit of a variant, `fromCountry` -> `toCountry`.
   * Used at admission/import to keep the margin floor freight-aware.
   *
   * Domestic routes (fromCountry === toCountry) keep $0 options - they are real
   * carriers (Royal Mail, USPS). Cross-border routes filter to priceUsd > 0
   * because CJ sometimes returns a spurious logisticPrice:0 row for a service
   * that does not actually carry the shipment; keeping it would zero freightUsd
   * and undercut the margin floor.
   */
  async freightEstimate(vid: string, fromCountry = 'CN', toCountry = 'GB', quantity = 1): Promise<{ priceUsd: number; days: string; name: string } | null> {
    const all = await this.freightQuoteAging(vid, fromCountry, toCountry, quantity);
    const options = fromCountry === toCountry ? all : all.filter((o) => o.priceUsd > 0);
    return options.length ? options[0] : null;
  }

  /**
   * Per-variant stock totals from CJ's inventory endpoint. CJ keeps reshaping
   * it: /product/stock/queryByPid died ("Interface not found"), its successor
   * returned flat per-warehouse rows, and on 2026-07-03 it flipped again to an
   * OBJECT {inventories: per-warehouse product rows, variantInventories:
   * [{vid, inventory: per-warehouse rows}]} under a {success} envelope. All
   * shapes are handled: vid stock sums across warehouses per variant; product-
   * level rows fold into a '*' entry only when no variant carries stock
   * (callers take max(values) for product stock; per-vid lookups simply miss
   * '*' and fall back).
   */
  async stockByPid(pid: string): Promise<Map<string, number>> {
    const data = await this.get('/product/stock/getInventoryByPid', { pid });
    const map = new Map<string, number>();
    let productLevel = 0;
    if (data && !Array.isArray(data) && typeof data === 'object') {
      const obj = data as {
        variantInventories?: { vid?: string; inventory?: { totalInventory?: number }[] }[];
        inventories?: { totalInventoryNum?: number; totalInventory?: number }[];
      };
      for (const v of obj.variantInventories ?? []) {
        const vid = String(v.vid ?? '');
        if (!vid) continue;
        const n = (v.inventory ?? []).reduce((s, w) => s + (Number(w.totalInventory ?? 0) || 0), 0);
        if (n > 0) map.set(vid, (map.get(vid) ?? 0) + n);
      }
      for (const w of obj.inventories ?? []) {
        const n = Number(w.totalInventoryNum ?? w.totalInventory ?? 0);
        if (Number.isFinite(n) && n > 0) productLevel += n;
      }
      if (!map.size && productLevel > 0) map.set('*', productLevel);
      return map;
    }
    for (const row of Array.isArray(data) ? data : []) {
      const r = row as Record<string, unknown>;
      const vid = String(r.vid ?? '');
      const n = Number(r.storageNum ?? r.num ?? r.totalInventoryNum ?? r.totalInventory ?? 0);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (vid) map.set(vid, (map.get(vid) ?? 0) + n);
      else productLevel = Math.max(productLevel, n);
    }
    if (!map.size && productLevel > 0) map.set('*', productLevel);
    return map;
  }

  /**
   * Per-WAREHOUSE stock for a product (countryCode → best qty). The same
   * endpoint stockByPid flattens per-variant; this reads the countryCode
   * dimension instead - the authority for the local-for-local gates when a
   * cached detail predates enable_inventory and carries no origins map.
   */
  async originsByPid(pid: string): Promise<Record<string, number>> {
    const data = await this.get('/product/stock/getInventoryByPid', { pid });
    const origins: Record<string, number> = {};
    const take = (r: Record<string, unknown>) => {
      const cc = String(r.countryCode ?? '').toUpperCase();
      const n = Number(r.totalInventoryNum ?? r.totalInventory ?? r.storageNum ?? 0);
      if (cc && Number.isFinite(n) && n > 0) origins[cc] = Math.max(origins[cc] ?? 0, n);
    };
    if (data && !Array.isArray(data) && typeof data === 'object') {
      const obj = data as { variantInventories?: { inventory?: Record<string, unknown>[] }[]; inventories?: Record<string, unknown>[] };
      for (const v of obj.variantInventories ?? []) for (const w of v.inventory ?? []) take(w);
      for (const w of obj.inventories ?? []) take(w);
    } else {
      for (const row of Array.isArray(data) ? data : []) take(row as Record<string, unknown>);
    }
    return origins;
  }

  // --- order API (W-FULFIL Stage B) ---

  /**
   * Create a CJ order (unpaid). Returns the CJ order id; pay it separately via
   * payBalance. Field names per the CJ order API; createOrderV2 needs the variant
   * id (vid), not the product pid. Throws (CJ userError) on bad fields/stock -
   * the caller marks the order errored and never pays.
   */
  async createOrder(input: {
    orderNumber: string;
    address: { name: string; phone: string; address1: string; address2?: string; city: string; province: string; zip: string; countryCode: string };
    products: { vid: string; quantity: number }[];
    fromCountryCode: string;
    logisticName?: string;
    remark?: string;
  }): Promise<{ orderId: string; orderNum: string }> {
    const a = input.address;
    const data = (await this.post('/shopping/order/createOrderV2', {
      orderNumber: input.orderNumber,
      shippingCountryCode: a.countryCode,
      shippingCountry: a.countryCode,
      shippingProvince: a.province,
      shippingCity: a.city,
      shippingZip: a.zip,
      shippingCustomerName: a.name,
      shippingPhone: a.phone,
      shippingAddress: [a.address1, a.address2].filter(Boolean).join(', '),
      fromCountryCode: input.fromCountryCode,
      ...(input.logisticName ? { logisticName: input.logisticName } : {}),
      remark: input.remark ?? '',
      payType: 2, // pay from wallet balance (settled later via payBalance)
      products: input.products.map((p) => ({ vid: p.vid, quantity: p.quantity }))
    })) as Record<string, unknown> | string | null;
    if (typeof data === 'string') return { orderId: data, orderNum: input.orderNumber };
    const d = (data ?? {}) as Record<string, unknown>;
    const orderId = String(d.orderId ?? d.id ?? '');
    if (!orderId) throw new Error('CJ createOrder returned no orderId');
    return { orderId, orderNum: String(d.orderNum ?? input.orderNumber) };
  }

  /** Pay a created CJ order from the wallet balance - THE money leg. */
  async payBalance(orderId: string): Promise<void> {
    await this.post('/shopping/pay/payBalance', { orderId });
  }

  /** Order status + tracking number (poll until trackNumber appears). */
  async getOrderDetail(orderId: string): Promise<{ orderId: string; orderNum: string; trackNumber: string; trackUrl: string; logisticName: string; status: string } | null> {
    const d = (await this.get('/shopping/order/getOrderDetail', { orderId })) as Record<string, unknown> | null;
    if (!d) return null;
    return {
      orderId: String(d.orderId ?? orderId),
      orderNum: String(d.orderNum ?? ''),
      trackNumber: String(d.trackNumber ?? ''),
      trackUrl: String(d.trackingUrl ?? d.trackUrl ?? d.logisticTrackUrl ?? ''),
      logisticName: String(d.logisticName ?? ''),
      status: String(d.orderStatus ?? d.status ?? '')
    };
  }

  /** Read-only: list recent CJ orders. Used to verify the order API + field names without creating/paying. */
  async getOrderList(pageSize = 5): Promise<unknown> {
    return this.get('/shopping/order/list', { pageNum: '1', pageSize: String(pageSize) });
  }
}
