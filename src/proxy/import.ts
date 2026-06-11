import type { AdminGraphql } from '../shopify-admin';
import type { CjClient, CjDetail } from '../cj';
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { retailPriceGbp } from '../pricing';

export const IMPORT_TAG = 'cj-import';
const MAX_IMAGES = 8;

export interface PreviewVariant { name: string; price: number }
export interface PreviewProduct {
  pid: string;
  title: string;
  images: string[];
  descriptionText: string; // plain text — CJ HTML is never sent to the storefront
  priceFrom: number;
  variants: PreviewVariant[];
  state: string;
  url: string | null;
}

/** CJ descriptions are untrusted HTML; the preview renders text only. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/** Map a CJ product onto a configured collection: keyword match, else more-to-love, else none. */
export function resolveCategory(cfg: TenantConfig, detail: { categoryName: string; nameEn: string }): string | null {
  const hay = `${detail.categoryName} ${detail.nameEn}`.toLowerCase();
  for (const key of Object.keys(cfg.collectionMap)) {
    const words = key.split('-').filter((w) => w !== 'pet' && w.length > 2);
    if (words.length && words.every((w) => hay.includes(w))) return key;
  }
  return cfg.collectionMap['more-to-love'] ? 'more-to-love' : null;
}

export function buildPreview(detail: CjDetail, cfg: TenantConfig, state: string, handle: string | null): PreviewProduct {
  const variants = dedupeVariantNames(detail.variants).map((v) => ({
    name: v.name,
    price: retailPriceGbp(v.sellPriceUsd, cfg.pricing)
  }));
  return {
    pid: detail.pid,
    title: detail.nameEn,
    images: detail.images.slice(0, MAX_IMAGES),
    descriptionText: stripHtml(detail.descriptionHtml),
    priceFrom: Math.min(...variants.map((v) => v.price)),
    variants,
    state,
    url: handle ? `/products/${handle}` : null
  };
}

function dedupeVariantNames<T extends { name: string }>(variants: T[]): T[] {
  const seen = new Map<string, number>();
  return variants.map((v) => {
    const n = seen.get(v.name) ?? 0;
    seen.set(v.name, n + 1);
    return n === 0 ? v : { ...v, name: `${v.name} (${n + 1})` };
  });
}

/** Detail lookups share the 30-day search cache (key `pid:<pid>`). */
export async function getCachedDetail(store: TenantStore, cj: CjClient, pid: string): Promise<CjDetail | null> {
  const cached = await store.getSearchCache(`pid:${pid}`);
  if (cached) return JSON.parse(cached) as CjDetail;
  const detail = await cj.detail(pid);
  if (detail) await store.putSearchCache(`pid:${pid}`, JSON.stringify(detail), 30);
  return detail;
}

const PRODUCT_SET = `mutation pawscoutImport($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product { id handle }
    userErrors { field message }
  }
}`;

const PRODUCT_STATUS = `mutation pawscoutStatus($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

const PUBLICATIONS = `query pawscoutPublications { publications(first: 20) { nodes { id name } } }`;

const PUBLISH = `mutation pawscoutPublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;

function firstUserError(data: Record<string, unknown>, op: string): string | null {
  const errs = (data[op] as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  return errs.length ? errs.map((e) => e.message).join('; ') : null;
}

/**
 * Create (or re-activate) the Shopify product for a CJ item and record the link.
 * Called in the background on PDP click and from the refill cron.
 */
export async function importProduct(
  store: TenantStore,
  admin: AdminGraphql,
  cfg: TenantConfig,
  detail: CjDetail,
  category?: string | null
): Promise<void> {
  const cat = category !== undefined ? category : resolveCategory(cfg, detail);
  try {
    const existing = await store.getLink(detail.pid);
    if (existing?.state === 'imported') return;

    // Revival: a previously culled product gets un-archived, not duplicated.
    if (existing?.shopify_product_id) {
      const data = await admin(PRODUCT_STATUS, { input: { id: existing.shopify_product_id, status: 'ACTIVE' } });
      const err = firstUserError(data, 'productUpdate');
      if (err) throw new Error(err);
      await store.putLink({ cjPid: detail.pid, state: 'imported' });
      return;
    }

    const variants = dedupeVariantNames(detail.variants);
    const multi = variants.length > 1;
    const optionName = multi ? 'Style' : 'Title';
    const input = {
      title: detail.nameEn,
      descriptionHtml: detail.descriptionHtml,
      status: 'ACTIVE',
      tags: [IMPORT_TAG, `cj-pid-${detail.pid}`, ...(cat && cfg.collectionMap[cat] ? [cfg.collectionMap[cat].tag] : [])],
      files: detail.images.slice(0, MAX_IMAGES).map((src) => ({ originalSource: src, contentType: 'IMAGE' })),
      productOptions: [{ name: optionName, values: multi ? variants.map((v) => ({ name: v.name })) : [{ name: 'Default Title' }] }],
      variants: variants.map((v) => ({
        optionValues: [{ optionName, name: multi ? v.name : 'Default Title' }],
        price: retailPriceGbp(v.sellPriceUsd, cfg.pricing).toFixed(2),
        sku: v.sku || undefined
      }))
    };

    const data = await admin(PRODUCT_SET, { input });
    const err = firstUserError(data, 'productSet');
    if (err) throw new Error(err);
    const product = (data.productSet as { product?: { id: string; handle: string } }).product;
    if (!product?.id) throw new Error('productSet returned no product');

    // Publish to the Online Store channel (best-effort: an unpublished import
    // still exists in admin and the link records success).
    try {
      const pubs = (await admin(PUBLICATIONS)) as { publications?: { nodes?: { id: string; name: string }[] } };
      const online = pubs.publications?.nodes?.find((p) => p.name === 'Online Store');
      if (online) {
        const pubData = await admin(PUBLISH, { id: product.id, input: [{ publicationId: online.id }] });
        const pubErr = firstUserError(pubData, 'publishablePublish');
        if (pubErr) console.warn(`publish failed for ${detail.pid}: ${pubErr}`);
      }
    } catch (e) {
      console.warn(`publish failed for ${detail.pid}: ${(e as Error).message}`);
    }

    await store.putLink({
      cjPid: detail.pid,
      state: 'imported',
      shopifyProductId: product.id,
      handle: product.handle,
      category: cat
    });
  } catch (e) {
    console.warn(`import failed for ${detail.pid}: ${(e as Error).message}`);
    await store.putLink({ cjPid: detail.pid, state: 'failed', category: cat });
  }
}
