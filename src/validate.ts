import type { Gates, TenantConfig } from './types';

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const RELEVANCE = new Set<Gates['relevance']>(['loose', 'title', 'strict']);
// Shopify-style handle / tag slug: lowercase alphanumerics and single hyphens, no leading/trailing hyphen.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
export const MAX_COLLECTIONS = 50;
export const MAX_TARGET = 200;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate the /api/gates body. Returns a *clean* object (unknown fields
 * stripped) so nothing un-vetted reaches tenant_config. `target` is optional —
 * absent means "leave the stored value alone".
 */
export function validateGatesPayload(body: unknown): Validation<{ gates: Gates; target?: number }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (!finite(b.popularityFloor) || b.popularityFloor < 0) {
    return { ok: false, error: 'popularityFloor must be a number >= 0' };
  }
  if (!finite(b.priceMin) || b.priceMin < 0) {
    return { ok: false, error: 'priceMin must be a number >= 0' };
  }
  if (!finite(b.priceMax) || b.priceMax < b.priceMin) {
    return { ok: false, error: 'priceMax must be a number >= priceMin' };
  }
  if (typeof b.relevance !== 'string' || !RELEVANCE.has(b.relevance as Gates['relevance'])) {
    return { ok: false, error: 'relevance must be one of: loose, title, strict' };
  }
  let target: number | undefined;
  if (b.target !== undefined) {
    if (!finite(b.target) || !Number.isInteger(b.target) || b.target < 1 || b.target > MAX_TARGET) {
      return { ok: false, error: `target must be an integer between 1 and ${MAX_TARGET}` };
    }
    target = b.target;
  }
  return {
    ok: true,
    value: {
      gates: {
        popularityFloor: b.popularityFloor,
        priceMin: b.priceMin,
        priceMax: b.priceMax,
        relevance: b.relevance as Gates['relevance']
      },
      target
    }
  };
}

/**
 * Validate the /api/collections body: a map of slug → { handle, tag } where
 * every key, handle, and tag is a safe slug. Returns a clean copy.
 */
export function validateCollectionMap(body: unknown): Validation<TenantConfig['collectionMap']> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length > MAX_COLLECTIONS) {
    return { ok: false, error: `At most ${MAX_COLLECTIONS} collections allowed` };
  }
  const clean: TenantConfig['collectionMap'] = {};
  for (const [key, raw] of entries) {
    if (!SLUG.test(key)) return { ok: false, error: `Invalid collection key: ${JSON.stringify(key)}` };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `Entry ${JSON.stringify(key)} must be an object with handle and tag` };
    }
    const { handle, tag } = raw as Record<string, unknown>;
    if (typeof handle !== 'string' || !SLUG.test(handle)) {
      return { ok: false, error: `Entry ${JSON.stringify(key)}: handle must be a lowercase slug (a-z, 0-9, hyphens)` };
    }
    if (typeof tag !== 'string' || !SLUG.test(tag)) {
      return { ok: false, error: `Entry ${JSON.stringify(key)}: tag must be a lowercase slug (a-z, 0-9, hyphens)` };
    }
    clean[key] = { handle, tag };
  }
  return { ok: true, value: clean };
}
