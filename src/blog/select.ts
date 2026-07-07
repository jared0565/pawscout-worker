// src/blog/select.ts
//
// Picks the "Shop this guide" product set + the article's hero image from a
// grounded fact pack and the drafted body. Pure + deterministic + testable: no
// I/O, no LLM. The editorial intent (docs/blog-rss-pinterest-traffic-prd-audit.md)
// is that the block shows products the article ACTUALLY discusses - so the
// products the body links come first (the writer chose them as relevant), then
// we top up from the funnel collection so the block is always full. The hero is
// the first pick that has an image; a human can swap it on review.

import type { FactPack } from './types';

/** Every /products/<handle> the body links to, in first-seen order, deduped.
 *  Matches both absolute and root-relative hrefs (the drafter is told to use
 *  root-relative paths, but absolute ones must not slip through unmatched). */
export function extractProductHandles(bodyHtml: string): string[] {
  const re = /href\s*=\s*["'](?:https?:\/\/[^"']*)?\/products\/([a-z0-9][a-z0-9-]*)/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml)) !== null) {
    const h = m[1].toLowerCase();
    if (!seen.has(h)) { seen.add(h); out.push(h); }
  }
  return out;
}

export interface ShopBlockSelection {
  handles: string[];             // <= max, congruence-ordered
  heroImageUrl?: string;         // first pick that has an image
  heroSourceHandle?: string;     // which product the hero came from
  heroAlt?: string;              // that product's title (image alt)
}

/**
 * Choose up to `max` products for the shop block and the hero image.
 *
 * Ordering: products the body links (that are real + available in the pack)
 * first, then the remaining available pack products, deduped. Only available
 * products are ever included - the theme links live stock. The hero is the
 * first selected product that carries a featuredImage.
 */
export function selectShopBlock(pack: FactPack, bodyHtml: string, max = 4): ShopBlockSelection {
  const available = pack.products.filter((p) => p.available);
  const byHandle = new Map(available.map((p) => [p.handle, p]));

  const linked = extractProductHandles(bodyHtml).filter((h) => byHandle.has(h));
  const linkedSet = new Set(linked);
  const topUp = available.map((p) => p.handle).filter((h) => !linkedSet.has(h));

  const handles = [...linked, ...topUp].slice(0, max);

  let heroImageUrl: string | undefined;
  let heroSourceHandle: string | undefined;
  let heroAlt: string | undefined;
  for (const h of handles) {
    const p = byHandle.get(h);
    if (p?.imageUrl) { heroImageUrl = p.imageUrl; heroSourceHandle = p.handle; heroAlt = p.title; break; }
  }

  return { handles, heroImageUrl, heroSourceHandle, heroAlt };
}
