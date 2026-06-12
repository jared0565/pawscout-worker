import type { Vault } from './vault';
import type { TenantStore } from './tenant-store';
import { defaultFetch } from './safe-fetch';

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
const CJ_AUTH_URL = `${CJ_BASE}/authentication/getAccessToken`;

// CJ allows roughly one auth refresh per 300s and tokens live ~15 days —
// never authenticate per request; cache the token and refresh early.
const REFRESH_COOLDOWN_MS = 300_000;
const EXPIRY_SAFETY_MS = 3_600_000;

export type ValidateResult = { ok: true } | { ok: false; error: string };

export async function validateCjKey(apiKey: string, fetchImpl: typeof fetch = defaultFetch): Promise<ValidateResult> {
  try {
    const resp = await fetchImpl(CJ_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    if (!resp.ok) return { ok: false, error: `CJ auth HTTP ${resp.status}` };
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey })
  });
  if (!resp.ok) throw new Error(`CJ auth HTTP ${resp.status}`);
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

export interface CjVariant { vid: string; name: string; sellPriceUsd: number; sku: string }

export interface CjDetail {
  pid: string;
  nameEn: string;
  images: string[];
  descriptionHtml: string;
  variants: CjVariant[];
  listedNum: number;
  categoryName: string;
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
        headers: { 'CJ-Access-Token': await this.token() }
      });
      if (resp.status === 429 && attempt < 2) {
        await this.pause(1200 * (attempt + 1));
        continue;
      }
      if (!resp.ok) throw new Error(`CJ HTTP ${resp.status}`);
      const data = (await resp.json()) as { result?: boolean; message?: string; data?: unknown };
      if (!data.result) throw new Error(data.message || 'CJ request failed');
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
    const p = (await this.get('/product/query', { pid })) as Record<string, unknown> | null;
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
      sku: String(v.variantSku ?? '')
    })).filter((v) => v.vid && v.sellPriceUsd > 0);
    return {
      pid: String(p.pid),
      nameEn: String(p.productNameEn ?? ''),
      images,
      descriptionHtml: String(p.description ?? ''),
      variants: variants.length ? variants : [{ vid: 'default', name: 'Default', sellPriceUsd: parseCjPrice(p.sellPrice), sku: String(p.productSku ?? '') }],
      listedNum: Number(p.listedNum ?? 0),
      categoryName: String(p.categoryName ?? '')
    };
  }
}
