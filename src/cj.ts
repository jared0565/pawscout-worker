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

/** CJ error responses carry the real reason in the body — keep it. */
async function httpError(resp: Response): Promise<Error> {
  let body = '';
  try { body = (await resp.text()).slice(0, 300); } catch { /* body unavailable */ }
  return new Error(`CJ HTTP ${resp.status}${body ? ` — ${body}` : ''}`);
}

// CJ allows roughly one auth refresh per 300s and tokens live ~15 days —
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
  // country/warehouse. A single origin must be able to fulfil — take the max.
  if (Array.isArray(v.inventories)) {
    const totals = (v.inventories as Record<string, unknown>[])
      .map((r) => Number(r.totalInventory ?? r.totalInventoryNum ?? 0))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (totals.length) return Math.max(...totals);
  }
  return undefined;
}

/** CJ price fields can be numbers, strings, or ranges like "5.99 -- 12.99" — take the first number. */
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
      const data = (await resp.json()) as { result?: boolean; message?: string; code?: number; data?: unknown };
      if (!data.result) {
        // Keep CJ's numeric code — messages like "Interface not found" are
        // useless without it when debugging endpoint deprecations.
        throw new Error(`${data.message || 'CJ request failed'}${data.code != null ? ` (CJ code ${data.code}, ${path})` : ''}`);
      }
      return data.data;
    }
  }

  async search(keyword: string, pageSize = 40): Promise<CjSearchItem[]> {
    const data = (await this.get('/product/list', {
      productNameEn: keyword,
      pageNum: '1',
      pageSize: String(pageSize)
    })) as { list?: Record<string, unknown>[] } | null;
    return (data?.list ?? []).map((p) => ({
      pid: String(p.pid ?? ''),
      nameEn: String(p.productNameEn ?? ''),
      image: String(p.productImage ?? ''),
      sellPriceUsd: parseCjPrice(p.sellPrice),
      listedNum: Number(p.listedNum ?? 0),
      categoryName: String(p.categoryName ?? '')
    })).filter((p) => p.pid && p.nameEn);
  }

  async detail(pid: string): Promise<CjDetail | null> {
    // enable_inventory embeds per-variant inventories in the SAME response —
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
      name: String(v.variantNameEn ?? v.variantName ?? 'Default'),
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
      stock: known.length ? Math.max(...known) : 0
    };
  }

  /**
   * Per-variant stock totals from CJ's inventory endpoint.
   * NB: CJ RENAMED this endpoint (the old /product/stock/queryByPid now
   * answers "Interface not found"). The new shape returns per-warehouse rows
   * (areaEn/countryCode/totalInventoryNum) which may or may not carry a vid —
   * vid rows sum per variant; vid-less rows fold into a product-level '*'
   * entry (callers take max(values) for product stock; per-vid lookups
   * simply miss '*' and fall back).
   */
  async stockByPid(pid: string): Promise<Map<string, number>> {
    const data = await this.get('/product/stock/getInventoryByPid', { pid });
    const map = new Map<string, number>();
    let productLevel = 0;
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
}
