import type { AdminGraphql } from '../shopify-admin';
import { chooseOrigin, type CjClient, type CjDetail } from '../cj';
import type { Curation } from '../llm';
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { retailPriceGbp } from '../pricing';
import { getPrimaryLocationId, setSupplierMetafields, MAX_TRACKED_QTY } from './inventory';

export const IMPORT_TAG = 'cj-import';
/** W-ADDON: hidden basket-fillers — buyable, but never browsable/searchable. */
export const ADDON_TAG = 'cj-addon';
const ADDON_CATEGORY = 'addons';
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
    price: retailPriceGbp(v.sellPriceUsd, cfg.pricing, detail.freightUsd)
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

/** W1: the warehouse is the primary detail source — zero CJ calls when stocked. */
export async function getDetailPreferWarehouse(store: TenantStore, cj: CjClient, pid: string): Promise<CjDetail | null> {
  const row = await store.getWarehouseProduct(pid);
  if (row) {
    try { return JSON.parse(row.detail) as CjDetail; } catch { /* corrupt row — fall through */ }
  }
  return getCachedDetail(store, cj, pid);
}

/**
 * The single CJ call left near the request path: a live stock confirmation
 * before the (background) import, so we never list something CJ can't fulfil.
 * Stock-unknown (endpoint failure) proceeds — the W2 daily sync corrects it.
 */
export async function confirmAndImport(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  detail: CjDetail,
  category?: string | null,
  curate?: (detail: CjDetail, context: string) => Promise<Curation | null>
): Promise<void> {
  // Ghost-click curation gate (added 2026-06-12 after a "pet food" search
  // imported a kitchen vacuum sealer): clicked ghosts must pass the SAME
  // LLM relevance gate as warehouse admissions. Already-curated details
  // (llmScore present) skip; a failed LLM degrades to mechanical gates.
  if (curate && detail.llmScore === undefined) {
    try {
      const curated = await curate(detail, category ?? detail.categoryName);
      if (curated) {
        if (curated.relevanceScore < cfg.llm.scoreThreshold) {
          console.warn(`import rejected by curation for ${detail.pid}: score ${curated.relevanceScore} < ${cfg.llm.scoreThreshold}`);
          await store.putLink({ cjPid: detail.pid, state: 'failed', category: category ?? null });
          return;
        }
        detail = {
          ...detail,
          nameEn: curated.title,
          descriptionHtml: curated.descriptionHtml,
          originalNameEn: detail.nameEn,
          llmScore: curated.relevanceScore,
          petClass: curated.petClass
        };
        if (curated.category) category = curated.category;
      }
    } catch (e) {
      console.warn(`import curation failed for ${detail.pid}: ${(e as Error).message}`);
    }
  }
  // Freight-aware floor + origin badge: capture once at import time (ghost
  // clicks arrive without it; warehouse promotions already carry it).
  if (detail.freightUsd === undefined) {
    detail = { ...detail, origin: detail.origin ?? chooseOrigin(detail, cfg.floors.stockFloor) };
    const vid = detail.variants[0]?.vid;
    if (vid && vid !== 'default') {
      try {
        const f = await cj.freightEstimate(vid, detail.origin);
        if (f) detail = { ...detail, freightUsd: f.priceUsd, freightDays: f.days };
      } catch (e) {
        // Unknown freight degrades to the product-cost-only floor — never block the sale path.
        console.warn(`freight estimate failed for ${detail.pid}: ${(e as Error).message}`);
      }
    }
  }
  let live: number | null = null;
  try {
    const m = await cj.stockByPid(detail.pid);
    live = m.size ? Math.max(...m.values()) : 0;
  } catch {
    live = null; // unknown — don't block the sale path on a flaky stock endpoint
  }
  if (live !== null) {
    await store.setWarehouseStock(detail.pid, live, live >= cfg.floors.stockFloor ? 'available' : 'low_stock');
    if (live < cfg.floors.stockFloor) {
      console.warn(`import blocked for ${detail.pid}: CJ stock ${live} < floor ${cfg.floors.stockFloor}`);
      await store.putLink({ cjPid: detail.pid, state: 'failed', category: category ?? null });
      return;
    }
  }
  await importProduct(store, admin, cfg, detail, category);
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

    // W-ADDON visibility: a suppressed add-on carries NO collection tag and is
    // hidden from search; a VISIBLE add-on (toggle off) joins a real resolved
    // collection so it appears in browsing & search like any product. Non-addon
    // imports use their given category unchanged.
    const isAddon = cat === ADDON_CATEGORY;
    const addonVisible = isAddon && !cfg.addons.suppressFromBrowse;
    const browseCat = isAddon ? (addonVisible ? resolveCategory(cfg, detail) : null) : cat;

    // W2: tracked inventory with policy DENY — Shopify itself blocks orders
    // beyond last-known CJ stock. Unknown stock (or no location) imports
    // untracked rather than tracked-at-zero, which would be unbuyable.
    const productStock = detail.stock ?? 0;
    const locationId = productStock > 0 ? await getPrimaryLocationId(admin) : null;

    const input = {
      title: detail.nameEn,
      descriptionHtml: detail.descriptionHtml,
      status: 'ACTIVE',
      tags: [IMPORT_TAG, `cj-pid-${detail.pid}`, ...(isAddon ? [ADDON_TAG] : []), ...(detail.petClass ? [`cj-pet-${detail.petClass}`] : []), ...(browseCat && cfg.collectionMap[browseCat] ? [cfg.collectionMap[browseCat].tag] : [])],
      files: detail.images.slice(0, MAX_IMAGES).map((src) => ({ originalSource: src, contentType: 'IMAGE' })),
      productOptions: [{ name: optionName, values: multi ? variants.map((v) => ({ name: v.name })) : [{ name: 'Default Title' }] }],
      variants: variants.map((v) => ({
        optionValues: [{ optionName, name: multi ? v.name : 'Default Title' }],
        price: retailPriceGbp(v.sellPriceUsd, cfg.pricing, detail.freightUsd).toFixed(2),
        sku: v.sku || undefined,
        ...(locationId
          ? {
              inventoryPolicy: 'DENY',
              inventoryItem: { tracked: true },
              inventoryQuantities: [{
                locationId,
                name: 'available',
                quantity: Math.min(v.stock ?? productStock, MAX_TRACKED_QTY)
              }]
            }
          : {})
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

    // W-ADDON: hide a suppressed add-on from storefront search + sitemap while
    // it stays buyable (surfaces only via the add-on widgets). A visible
    // add-on is explicitly un-hidden. Best-effort.
    if (isAddon) {
      try {
        await setSeoHidden(admin, product.id, cfg.addons.suppressFromBrowse);
      } catch (e) {
        console.warn(`seo.hidden failed for ${detail.pid}: ${(e as Error).message}`);
      }
    }

    // Supplier metafields (the theme's PDP renders these) — best-effort.
    try {
      // Import only happens at/above the stock floor (or stock-unknown), so
      // 'available' is correct here; the daily sync keeps it honest after.
      await setSupplierMetafields(admin, product.id, {
        status: 'available',
        qty: productStock,
        checkedAt: new Date().toISOString(),
        origin: detail.origin
      });
    } catch (e) {
      console.warn(`supplier metafields failed for ${detail.pid}: ${(e as Error).message}`);
    }
  } catch (e) {
    console.warn(`import failed for ${detail.pid}: ${(e as Error).message}`);
    await store.putLink({ cjPid: detail.pid, state: 'failed', category: cat });
  }
}


/** Set the seo.hidden metafield (1 = hidden from storefront search + sitemap). */
async function setSeoHidden(admin: AdminGraphql, productId: string, hidden: boolean): Promise<void> {
  const data = await admin(
    `mutation pawscoutHide($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields: [{ ownerId: productId, namespace: 'seo', key: 'hidden', type: 'number_integer', value: hidden ? '1' : '0' }] }
  );
  const errs = (data.metafieldsSet as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/** Add or remove storefront tags on an existing product. */
async function setProductTags(admin: AdminGraphql, productId: string, tags: string[], add: boolean): Promise<void> {
  if (!tags.length) return;
  const mut = add
    ? `mutation pawscoutTagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`
    : `mutation pawscoutTagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`;
  const data = await admin(mut, { id: productId, tags });
  const key = add ? 'tagsAdd' : 'tagsRemove';
  const errs = (data[key] as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/**
 * Align EXISTING add-on products to the current `addons.suppressFromBrowse`
 * flag (the toggle changing affects already-imported fillers, not just new
 * ones). Idempotent: sets seo.hidden and adds/removes the resolved collection
 * tag. Pool is capped (≤ poolSize), so this is cheap. Called nightly.
 */
export async function reconcileAddonVisibility(
  store: TenantStore,
  admin: AdminGraphql,
  cfg: TenantConfig
): Promise<number> {
  const suppress = cfg.addons.suppressFromBrowse;
  const links = (await store.listImportedLinks(500)).filter(
    (l) => l.category === ADDON_CATEGORY && l.shopify_product_id
  );
  let reconciled = 0;
  for (const link of links) {
    // Resolve the collection tag this filler would carry when visible.
    let browseTag: string | null = null;
    const wh = await store.getWarehouseProduct(link.cj_pid);
    if (wh) {
      try {
        const d = JSON.parse(wh.detail) as CjDetail;
        const bc = resolveCategory(cfg, d);
        browseTag = bc && cfg.collectionMap[bc] ? cfg.collectionMap[bc].tag : null;
      } catch { /* no detail → seo.hidden flip only */ }
    }
    try {
      await setSeoHidden(admin, link.shopify_product_id!, suppress);
      if (browseTag) await setProductTags(admin, link.shopify_product_id!, [browseTag], !suppress);
      reconciled++;
    } catch (e) {
      console.warn(`addon visibility reconcile failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return reconciled;
}
