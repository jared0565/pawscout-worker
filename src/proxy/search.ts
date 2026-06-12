import type { CjClient, CjSearchItem } from '../cj';
import type { TenantStore, WarehouseRow } from '../tenant-store';
import type { Gates, TenantConfig } from '../types';
import { retailPriceGbp } from '../pricing';
import { getKeywordMeta } from '../llm';

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
  if (mode === 'loose') return true; // trust the source's own match
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

function warehousePasses(row: WarehouseRow, cfg: TenantConfig, keyword: string): boolean {
  return (
    row.listed_num >= cfg.gates.popularityFloor &&
    row.price_usd >= cfg.gates.priceMin &&
    row.price_usd <= cfg.gates.priceMax &&
    row.stock >= cfg.floors.stockFloor &&
    relevanceMatch(keyword, row.title, cfg.gates.relevance)
  );
}

function firstImage(row: WarehouseRow): string {
  try {
    const detail = JSON.parse(row.detail) as { images?: string[] };
    return detail.images?.[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Storefront search backfill — WAREHOUSE FIRST (W1).
 *
 * 1. Match against the PS-local warehouse: zero CJ calls, gates re-applied at
 *    read time (config may have changed since admission), ranked by how many
 *    keyword tokens hit, then popularity.
 * 2. Only when the warehouse can't fill the grid, fall back to one live CJ
 *    search (30-day cached) — and the logged shortfall steers the nightly
 *    replenishment toward this keyword.
 */
export async function searchBackfill(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  query: string,
  storeHits: number,
  limit: number,
  opts: { liveFallback?: boolean } = {}
): Promise<GhostCard[]> {
  const kw = normalizeKeyword(query);
  if (!kw) return [];

  // W3: classified keywords carry cached synonyms (e.g. "puppy chew" → "dog
  // toy"), widening warehouse matching. Strict mode ignores them — expansion
  // must never loosen an explicitly strict gate.
  const meta = await getKeywordMeta(store, kw);
  const expanded = cfg.gates.relevance !== 'strict' && meta?.synonyms.length
    ? `${kw} ${meta.synonyms.join(' ')}`
    : kw;
  const tokens = [...new Set(expanded.split(' ').filter(Boolean))];

  const cards: GhostCard[] = [];
  const seen = new Set<string>();

  // --- 1) warehouse ---
  const rows = await store.searchWarehouse(tokens, limit * 3);
  const ranked = rows
    .filter((r) => warehousePasses(r, cfg, expanded))
    .map((r) => ({ r, hits: tokens.filter((t) => r.search_text.includes(t)).length }))
    .sort((a, b) => b.hits - a.hits || b.r.listed_num - a.r.listed_num);

  const whLinks = await store.getLinks(ranked.map((x) => x.r.cj_pid));
  for (const { r } of ranked) {
    if (cards.length >= limit) break;
    const link = whLinks.get(r.cj_pid);
    const imported = link?.state === 'imported' && link.handle;
    cards.push({
      pid: r.cj_pid,
      title: r.title,
      image: firstImage(r),
      price: retailPriceGbp(r.price_usd, cfg.pricing),
      state: imported ? 'imported' : 'ghost',
      url: imported ? `/products/${link!.handle}` : null
    });
    seen.add(r.cj_pid);
  }

  // --- 2) live CJ fallback (cached per keyword for 30 days) ---
  if (cards.length < limit && (opts.liveFallback ?? true)) {
    let items: CjSearchItem[];
    const cached = await store.getSearchCache(`kw:${kw}`);
    if (cached) {
      items = JSON.parse(cached);
    } else {
      items = await cj.search(kw);
      await store.putSearchCache(`kw:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
    }
    const gated = items.filter((i) => !seen.has(i.pid) && passesGates(i, cfg.gates, kw));
    const links = await store.getLinks(gated.map((i) => i.pid));
    for (const item of gated) {
      if (cards.length >= limit) break;
      const link = links.get(item.pid);
      const imported = link?.state === 'imported' && link.handle;
      cards.push({
        pid: item.pid,
        title: item.nameEn,
        image: item.image,
        price: retailPriceGbp(item.sellPriceUsd, cfg.pricing),
        state: imported ? 'imported' : 'ghost', // archived/failed re-offer as ghost: demand revives
        url: imported ? `/products/${link!.handle}` : null
      });
      seen.add(item.pid);
    }
  }

  await store.logSearch(kw, storeHits, cards.length);
  return cards;
}
