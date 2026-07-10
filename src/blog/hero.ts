// src/blog/hero.ts
//
// Blog hero image selection. The owner's rule: a photo of a PET using or with the
// product converts better in an article than a bare product shot. This is the
// OPPOSITE preference to the PDP pickHeroImage (which wants clean product-only
// images), so it is a separate, blog-tuned vision pass - it never touches the
// listing hero logic. Pure I/O + one vision call; never throws to the caller.

import type { AdminGraphql } from '../shopify-admin';
import { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import type { TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';

export interface ProductImage { url: string; width: number; height: number }

const PRODUCT_IMAGES = `query pawscoutBlogHeroImages($q: String!) {
  products(first: 1, query: $q) {
    nodes { images(first: 10) { nodes { url width height } } }
  }
}`;

/** All images (url + source dimensions) for a product, in gallery order. Empty on
 *  any miss - the caller then keeps whatever hero it already had. */
export async function getProductImages(admin: AdminGraphql, handle: string): Promise<ProductImage[]> {
  try {
    const data = await admin(PRODUCT_IMAGES, { q: `handle:${handle}` }) as {
      products?: { nodes?: { images?: { nodes?: { url?: string; width?: number; height?: number }[] } }[] };
    };
    const nodes = data.products?.nodes?.[0]?.images?.nodes ?? [];
    return nodes
      .filter((n): n is { url: string; width: number; height: number } => typeof n.url === 'string' && !!n.url)
      .map((n) => ({ url: n.url, width: n.width ?? 0, height: n.height ?? 0 }));
  } catch { return []; }
}

const MAX_HERO_IMAGES = 8; // cap vision cost

/**
 * Vision pass tuned for the BLOG hero: prefer a warm lifestyle photo showing a
 * real dog or cat USING or ALONGSIDE the product, over a bare product shot,
 * packaging, or anything with baked-in text. The model is given the ARTICLE
 * title too, and may REJECT the whole gallery (index -1) when nothing in it
 * fits the article's subject (2026-07-10 defect: a disconnected hero is worse
 * than the plain featured image). Returns the chosen image (with its source
 * dimensions so the caller can flag og resolution), or null when there is no
 * LLM / no decision / a rejection (caller falls back to the featured image).
 */
export async function pickBlogHeroImage(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  titles: { articleTitle: string; productTitle: string }, images: ProductImage[]
): Promise<ProductImage | null> {
  if (!llm.available || !cfg.llm.enabled) return null;
  const urls = images.slice(0, MAX_HERO_IMAGES);
  if (urls.length < 2) return urls[0] ?? null; // 0-1 images: nothing to choose between
  const chain = resolveChain(cfg, 'image');

  const result = await llm.jsonChain<{ index: number }>({
    chain, maxTokens: 160, images: urls.map((u) => u.url),
    system:
      'You choose the HERO image for a pet-care BLOG article. You are given the ARTICLE TITLE, the featured product\'s TITLE, and that product\'s images in order (index 0 is first). ' +
      'The hero MUST plainly belong with the article\'s subject: a reader seeing the image next to the article title must not be confused. ' +
      'STRONGLY PREFER a warm, natural LIFESTYLE photo that shows a real dog or cat USING or ALONGSIDE the product - a pet in the scene converts far better in an article than a bare product shot. ' +
      'Avoid, in decreasing order of dislike: images with overlaid marketing/banner text or watermarks, infographics or size charts, cartoon or illustrated mascots, packaging-only shots, extreme close-ups of one detail, and plain product-on-white photos. ' +
      'Pick a plain product photo ONLY if no image shows a real pet with the product. Never pick an image with text baked into it when a cleaner option exists. ' +
      'If NO image fits the article\'s subject (wrong product type, wrong animal, unrelated scenes), respond with index -1: rejecting is BETTER than a mismatched hero. ' +
      'Respond with ONLY JSON: {"index": <0-based index of the best hero image, or -1 to reject all>, "reason": <max 10 words>}.',
    user: JSON.stringify({ articleTitle: titles.articleTitle, productTitle: titles.productTitle, imageCount: urls.length, note: 'Images follow in order; the first is index 0.' }),
    validate: (v) => {
      const o = v as Record<string, unknown>;
      const idx = Number(o?.index);
      if (!Number.isInteger(idx) || idx < -1 || idx >= urls.length) return null;
      return { index: idx };
    }
  });
  if (!result.ok) { console.warn(`blog hero-image pick failed for "${titles.productTitle}": ${result.error}`); return null; }
  await store.logLlmUsage('blog-hero-image', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  if (result.value.index === -1) {
    console.warn(`blog hero gallery rejected for "${titles.productTitle}" (article "${titles.articleTitle}") - falling back to the featured image`);
    return null;
  }
  return urls[result.value.index] ?? null;
}
