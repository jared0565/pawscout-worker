// src/debrand.ts
//
// Strip manufacturer / competitor supplier brand names from customer-facing
// product titles and copy. The store RESELLS third-party-branded stock (e.g.
// PawHut, made by Aosom) under its own vendor ("Active Paw"), but the imported
// TITLES still carried the maker's brand. That brand then surfaced in blog
// articles, "Shop this guide" cards, OG tags, product pages and site search -
// effectively advertising a competitor and inviting shoppers to buy the same
// item elsewhere. We present our inventory under neutral, descriptive names.
//
// Applied at three layers:
//   1. import time  (src/proxy/import.ts) - incoming products land de-branded;
//   2. blog fact pack (src/blog/ground.ts) - the writer never even sees a brand;
//   3. a catalog sweep (src/jobs.ts debrandCatalog) - de-brands existing titles
//      AND already-published article bodies, self-healing on the nightly cron.
//
// CRITICAL: article bodies are HTML whose product links carry the brand in the
// LOWERCASE handle (href="/products/pawhut-..."). Title stripping is
// case-insensitive (a plain title has no URL to damage), but TEXT/HTML stripping
// is case-SENSITIVE so a lowercase handle inside an href is never touched - only
// the proper-case visible brand word ("PawHut ...") is removed. Handles, and
// therefore links, never change.

/** Manufacturer / supplier brands to strip from customer-facing titles + copy.
 *  Whole-word matches only. Add brands here as the catalog reveals them. */
export const BRAND_TOKENS = ['PawHut'];

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a regex matching a whole-word brand token plus any trailing spaces, so
 *  "PawHut Stainless" collapses cleanly to "Stainless" (not " Stainless"). */
function brandRegex(brand: string, flags: string): RegExp {
  return new RegExp(`\\b${escapeRegex(brand)}\\b\\s*`, flags);
}

/**
 * De-brand a PRODUCT TITLE (plain text, no URLs). Case-INSENSITIVE so any
 * casing of the brand is removed. Never returns an empty string - if stripping
 * would empty the title, the original is kept (a brand-only title is better than
 * a blank one, and signals a title worth a human's attention).
 */
export function debrandTitle(title: string, brands: string[] = BRAND_TOKENS): string {
  if (!title) return title;
  let out = title;
  for (const b of brands) out = out.replace(brandRegex(b, 'gi'), '');
  out = out.replace(/\s{2,}/g, ' ').replace(/^[\s,\-:]+/, '').trim();
  return out || title;
}

/**
 * De-brand a block of customer-facing TEXT or HTML (e.g. an article body).
 * Case-SENSITIVE: only the proper-case visible brand word is removed, so a
 * lowercase brand inside a URL/handle (href="/products/pawhut-...") is left
 * intact and links never break. Idempotent.
 */
export function debrandText(text: string, brands: string[] = BRAND_TOKENS): string {
  if (!text) return text;
  let out = text;
  for (const b of brands) out = out.replace(brandRegex(b, 'g'), '');
  return out;
}
