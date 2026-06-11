import type { CjClient, CjSearchItem } from '../cj';
import type { TenantStore } from '../tenant-store';
import type { Gates, TenantConfig } from '../types';
import { retailPriceGbp } from '../pricing';

export const CACHE_TTL_DAYS = 30; // PS retention promise: cached supplier data lives 30 days

export interface GhostCard {
  pid: string;
  title: string;
  image: string;
  price: number; // GBP retail under the tenant's pricing rule
  state: 'ghost' | 'imported';
  url: string | null; // real PDP when already imported
}

export function normalizeKeyword(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function relevanceMatch(keyword: string, title: string, mode: Gates['relevance']): boolean {
  if (mode === 'loose') return true; // trust CJ's own match
  const t = title.toLowerCase();
  const tokens = keyword.split(' ').filter(Boolean);
  if (!tokens.length) return false;
  return mode === 'strict' ? tokens.every((tok) => t.includes(tok)) : tokens.some((tok) => t.includes(tok));
}

export function passesGates(item: CjSearchItem, gates: Gates, keyword: string): boolean {
  return (
    item.listedNum >= gates.popularityFloor &&
    item.sellPriceUsd >= gates.priceMin &&
    item.sellPriceUsd <= gates.priceMax &&
    relevanceMatch(keyword, item.nameEn, gates.relevance)
  );
}

/**
 * Storefront search backfill: serve CJ candidates for a keyword the store
 * couldn't fully answer. Cached per keyword (30d), gated, priced, deduped
 * against already-imported products. Logs the demand signal.
 */
export async function searchBackfill(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  query: string,
  storeHits: number,
  limit: number
): Promise<GhostCard[]> {
  const kw = normalizeKeyword(query);
  if (!kw) return [];

  let items: CjSearchItem[];
  const cached = await store.getSearchCache(`kw:${kw}`);
  if (cached) {
    items = JSON.parse(cached);
  } else {
    items = await cj.search(kw);
    await store.putSearchCache(`kw:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
  }

  const gated = items.filter((i) => passesGates(i, cfg.gates, kw));
  const links = await store.getLinks(gated.map((i) => i.pid));

  const cards: GhostCard[] = [];
  for (const item of gated) {
    if (cards.length >= limit) break;
    const link = links.get(item.pid);
    if (link?.state === 'imported' && link.handle) {
      cards.push({
        pid: item.pid,
        title: item.nameEn,
        image: item.image,
        price: retailPriceGbp(item.sellPriceUsd, cfg.pricing),
        state: 'imported',
        url: `/products/${link.handle}`
      });
    } else {
      // ghost / archived / failed: offer as ghost — fresh demand can revive it
      cards.push({
        pid: item.pid,
        title: item.nameEn,
        image: item.image,
        price: retailPriceGbp(item.sellPriceUsd, cfg.pricing),
        state: 'ghost',
        url: null
      });
    }
  }

  await store.logSearch(kw, storeHits, cards.length);
  return cards;
}
