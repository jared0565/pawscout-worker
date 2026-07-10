// src/blog/select.ts
//
// Picks the "Shop this guide" product set + the article's hero image from a
// grounded fact pack and the drafted body. Pure + deterministic + testable: no
// I/O, no LLM. The editorial intent (docs/blog-rss-pinterest-traffic-prd-audit.md)
// is that the block shows products the article ACTUALLY discusses - so the
// products the body links come first (the writer chose them as relevant), then
// we top up from the funnel collection so the block is always full. The hero is
// the first pick that has an image; a human can swap it on review.

import type { FactPack, GroundedProduct } from './types';

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
  heroImageUrl?: string;         // chosen hero (prefers a >=1200 source)
  heroSourceHandle?: string;     // which product the hero came from
  heroAlt?: string;              // that product's title (image alt)
  heroIsHighRes?: boolean;       // true when the hero source is >= 1200x1200
}

// Shopify never upscales, so only a >=1200 SQUARE source yields a genuine
// 1200x1200 og:image (the 1.91:1 wide card also needs both dims >= this).
const MIN_HERO_PX = 1200;

export type HeroFields = Pick<ShopBlockSelection, 'heroImageUrl' | 'heroSourceHandle' | 'heroAlt' | 'heroIsHighRes'>;

/**
 * Hero for a chosen handle set. CONGRUENCE OUTRANKS RESOLUTION (2026-07-10
 * live defect: a 1600px water bowl in slot 2 beat the 1100px elevated bed the
 * article was actually about, so a dog-beds post shipped a water-bowl hero).
 * The >=1200-square preference (a true 1200x1200 og:image) may only choose
 * AMONG the first `linkedCount` handles - the writer's own body-linked picks,
 * which are all congruent with the article. From the top-up region the hero is
 * strictly the first product with an image; a smaller social card is a better
 * failure than a wrong-subject hero, and heroIsHighRes surfaces the trade-off
 * to the owner. Shared by the deterministic selection and the combo
 * merchandiser (the hero must always follow the FINAL handle set).
 */
export function pickHeroFields(
  byHandle: Map<string, GroundedProduct>, handles: string[], linkedCount = handles.length
): HeroFields {
  const products = (hs: string[]) => hs.map((h) => byHandle.get(h)).filter((p): p is GroundedProduct => !!p);
  const isHighRes = (p: GroundedProduct) => (p.imageWidth ?? 0) >= MIN_HERO_PX && (p.imageHeight ?? 0) >= MIN_HERO_PX;
  const linked = products(handles.slice(0, Math.max(0, linkedCount)));
  const rest = products(handles.slice(Math.max(0, linkedCount)));
  const hero =
    linked.find((p) => p.imageUrl && isHighRes(p)) ??
    linked.find((p) => p.imageUrl) ??
    rest.find((p) => p.imageUrl);
  return {
    heroImageUrl: hero?.imageUrl,
    heroSourceHandle: hero?.handle,
    heroAlt: hero?.title,
    heroIsHighRes: !!hero && isHighRes(hero)
  };
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

  return { handles, ...pickHeroFields(byHandle, handles, Math.min(linked.length, handles.length)) };
}
