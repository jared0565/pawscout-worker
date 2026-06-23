import type { AdminGraphql } from '../shopify-admin';
import { chooseOrigin, type CjClient, type CjDetail } from '../cj';
import type { Curation, HeroPick } from '../llm';
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { retailPriceGbp, landedCostGbp } from '../pricing';
import { AFFILIATE_ELIGIBLE_TAG, productAffiliateEligible } from '../affiliate';
import { isLikelyPetProduct, signaledCategory } from './search';
import { getPrimaryLocationId, setSupplierMetafields, MAX_TRACKED_QTY } from './inventory';

export const IMPORT_TAG = 'cj-import';
/** W-ADDON: hidden basket-fillers - buyable, but never browsable/searchable. */
export const ADDON_TAG = 'cj-addon';
export const ADDON_CATEGORY = 'addons';
const MAX_IMAGES = 8;
// Curated-hero cache lifetime. Keyed by `hero:<pid>` in search_cache; lets the
// search grid reuse the vision-vetted hero so cards self-heal after one preview.
const HERO_CACHE_TTL_DAYS = 30;

export interface PreviewVariant { name: string; price: number }
export interface PreviewProduct {
  pid: string;
  title: string;
  images: string[];
  descriptionText: string; // plain text - CJ HTML is never sent to the storefront
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

/** W1: the warehouse is the primary detail source - zero CJ calls when stocked. */
export async function getDetailPreferWarehouse(store: TenantStore, cj: CjClient, pid: string): Promise<CjDetail | null> {
  const row = await store.getWarehouseProduct(pid);
  if (row) {
    try { return JSON.parse(row.detail) as CjDetail; } catch { /* corrupt row - fall through */ }
  }
  return getCachedDetail(store, cj, pid);
}

/** Indices to KEEP from a gallery given a vision verdict, hero first, dropping
 * incongruent images. Empty = no image is congruent with the title. */
export function vetOrder(images: string[], vet: HeroPick): number[] {
  const drop = new Set((vet.drop ?? []).filter((i) => i >= 0 && i < images.length));
  let keep = images.map((_, i) => i).filter((i) => !drop.has(i));
  if (vet.index !== null && vet.index >= 0 && vet.index < images.length && keep.includes(vet.index)) {
    keep = [vet.index, ...keep.filter((i) => i !== vet.index)];
  }
  return keep;
}

/**
 * Curate a detail's images via the vision pass, CACHED by image-set signature in
 * `hero:<pid>` so it's at most one vision call per product per media state. Used
 * by both the supplier preview (`/proxy/product`) and the background import, and
 * the cached hero feeds the search-grid cards (so a "cat on a dog listing" self-
 * heals after the first preview). Returns the (possibly reordered/filtered)
 * detail and whether ANY image is congruent with the title (`false` = the import
 * path should reject the listing). Best-effort: any failure leaves images as-is.
 */
export async function curateDetailImages(
  store: TenantStore,
  detail: CjDetail,
  pickHero?: (title: string, imageUrls: string[]) => Promise<HeroPick>
): Promise<{ detail: CjDetail; congruent: boolean }> {
  if (detail.images.length < 2) return { detail, congruent: true };
  const sig = mediaSignature(detail.images.slice(0, MAX_IMAGES));
  const key = `hero:${detail.pid}`;
  const cached = await store.getSearchCache(key);
  if (cached) {
    try {
      const c = JSON.parse(cached) as { sig?: string; images?: string[] };
      if (c.sig === sig && Array.isArray(c.images) && c.images.length) return { detail: { ...detail, images: c.images }, congruent: true };
    } catch { /* corrupt cache - re-curate */ }
  }
  if (!pickHero) return { detail, congruent: true }; // no LLM - leave raw, don't cache
  let vet: HeroPick;
  try { vet = await pickHero(detail.nameEn, detail.images); } catch (e) { console.warn(`image vet failed for ${detail.pid}: ${(e as Error).message}`); return { detail, congruent: true }; }
  if (!vet.ok) return { detail, congruent: true }; // undecided (LLM down) - retry later, don't cache
  const keep = vetOrder(detail.images, vet);
  if (keep.length === 0) return { detail, congruent: false }; // nothing matches the title
  const images = keep.map((i) => detail.images[i]).slice(0, MAX_IMAGES);
  await store.putSearchCache(key, JSON.stringify({ sig, images }), HERO_CACHE_TTL_DAYS);
  return { detail: { ...detail, images }, congruent: true };
}

/**
 * The single CJ call left near the request path: a live stock confirmation
 * before the (background) import, so we never list something CJ can't fulfil.
 * Stock-unknown (endpoint failure) proceeds - the W2 daily sync corrects it.
 */
export async function confirmAndImport(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  detail: CjDetail,
  category?: string | null,
  curate?: (detail: CjDetail, context: string) => Promise<Curation | null>,
  pickHero?: (title: string, imageUrls: string[]) => Promise<HeroPick>
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
  // Mechanical pet-relevance floor: if the LLM didn't admit this (no llmScore -
  // curation absent or failed), reject clearly non-pet items the mechanical
  // gates would otherwise pass (the kitchen/garden/human-tool class).
  if (detail.llmScore === undefined && !isLikelyPetProduct(`${detail.nameEn} ${detail.categoryName ?? ''}`)) {
    console.warn(`import blocked (not pet-relevant) for ${detail.pid}: ${detail.nameEn}`);
    await store.putLink({ cjPid: detail.pid, state: 'failed', category: category ?? null });
    return;
  }
  // Image QA (vision): CJ's first image is often a single component or a
  // packaging shot, and CJ galleries can include images of a DIFFERENT animal
  // than the title (a cat photo on a "dog" listing). Promote the best on-title
  // image to the front AND drop incongruent images so they never enter Shopify.
  // Cached + shared with the supplier preview; never blocks on an LLM failure.
  if (pickHero && detail.images.length > 1) {
    const { detail: curated, congruent } = await curateDetailImages(store, detail, pickHero);
    if (!congruent) { // no image matches the title - don't list a mislabelled product
      console.warn(`import rejected (no congruent image) for ${detail.pid}: ${detail.nameEn}`);
      await store.putLink({ cjPid: detail.pid, state: 'failed', category: category ?? null });
      return;
    }
    detail = curated;
  }
  // Freight-aware floor + origin badge: capture once at import time (ghost
  // clicks arrive without it; warehouse promotions already carry it).
  if (detail.freightUsd === undefined) {
    detail = { ...detail, origin: detail.origin ?? chooseOrigin(detail, cfg.floors.stockFloor) };
    const vid = detail.variants[0]?.vid;
    if (vid && vid !== 'default') {
      try {
        const f = await cj.freightEstimate(vid, detail.origin);
        if (f) detail = { ...detail, freightUsd: f.priceUsd };
      } catch (e) {
        // Unknown freight degrades to the product-cost-only floor - never block the sale path.
        console.warn(`freight estimate failed for ${detail.pid}: ${(e as Error).message}`);
      }
    }
  }
  let live: number | null = null;
  try {
    const m = await cj.stockByPid(detail.pid);
    live = m.size ? Math.max(...m.values()) : 0;
  } catch {
    live = null; // unknown - don't block the sale path on a flaky stock endpoint
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

    // W2: tracked inventory with policy DENY - Shopify itself blocks orders
    // beyond last-known CJ stock. Unknown stock (or no location) imports
    // untracked rather than tracked-at-zero, which would be unbuyable.
    const productStock = detail.stock ?? 0;
    const locationId = productStock > 0 ? await getPrimaryLocationId(admin) : null;

    const input = {
      title: detail.nameEn,
      descriptionHtml: detail.descriptionHtml,
      status: 'ACTIVE',
      tags: [IMPORT_TAG, `cj-pid-${detail.pid}`, ...(isAddon ? [ADDON_TAG] : []), ...(detail.petClass ? [`cj-species-${detail.petClass}`] : []), ...(browseCat && cfg.collectionMap[browseCat] ? [cfg.collectionMap[browseCat].tag] : []), ...(!isAddon && productAffiliateEligible(variants, cfg.pricing, detail.freightUsd) ? [AFFILIATE_ELIGIBLE_TAG] : [])],
      files: detail.images.slice(0, MAX_IMAGES).map((src) => ({ originalSource: src, contentType: 'IMAGE' })),
      productOptions: [{ name: optionName, values: multi ? variants.map((v) => ({ name: v.name })) : [{ name: 'Default Title' }] }],
      variants: variants.map((v) => ({
        optionValues: [{ optionName, name: multi ? v.name : 'Default Title' }],
        price: retailPriceGbp(v.sellPriceUsd, cfg.pricing, detail.freightUsd).toFixed(2),
        sku: v.sku || undefined,
        // Honest landed COGS → Shopify "Cost per item" at import (admin-only).
        inventoryItem: { cost: landedCostGbp(v.sellPriceUsd, cfg.pricing, detail.freightUsd).toFixed(2), ...(locationId ? { tracked: true } : {}) },
        ...(locationId
          ? {
              inventoryPolicy: 'DENY',
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

    // Supplier metafields (the theme's PDP renders these) - best-effort.
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
export async function setProductTags(admin: AdminGraphql, productId: string, tags: string[], add: boolean): Promise<void> {
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

const PRODUCT_MEDIA = `query pawscoutMedia($id: ID!) {
  product(id: $id) {
    title
    featuredMedia { ... on MediaImage { id } }
    metafield(namespace: "pawscout", key: "hero_sig") { value }
    media(first: 12) { nodes { ... on MediaImage { id image { url } } } }
  }
}`;

const REORDER_MEDIA = `mutation pawscoutReorder($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) {
    mediaUserErrors { field message }
    userErrors { field message }
  }
}`;

const SET_HERO_SIG = `mutation pawscoutHeroSig($mf: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $mf) { userErrors { field message } }
}`;

const DELETE_MEDIA = `mutation pawscoutDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message }
    userErrors { field message }
  }
}`;

// Bump when the vision logic changes meaning (e.g. v1 only reordered the hero;
// v2 also DROPS incongruent images) so every product is re-checked once under
// the new rules instead of being skipped by a stale cached signature.
const VET_VERSION = 'v2';

/**
 * Order-independent fingerprint of a product's media set, prefixed with the
 * vetting-logic version. Reordering (which the sweep itself does) leaves the
 * hash unchanged; adding/removing an image, or bumping VET_VERSION, changes it.
 * Stored in the pawscout.hero_sig metafield so the sweep can skip a product it
 * has already vision-checked at this exact media state under this logic - the
 * spend saver. A VET_VERSION bump invalidates all cached signatures once.
 */
export function mediaSignature(mediaIds: string[]): string {
  const s = [...mediaIds].sort().join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${VET_VERSION}:${(h >>> 0).toString(16)}`;
}

/**
 * Maintenance sweep (vision): re-pick the hero image for already-imported
 * products and promote it to the featured slot when CJ's first image isn't the
 * best representation of the title (e.g. a "set" whose default shot is one
 * component). Best-effort per product; one bad product never aborts the run.
 * `pickHero` is injected (same closure the import path uses) for testability.
 *
 * Batched (offset/limit) so each call finishes well inside a request's time
 * budget - the console loops with `next` for progress; the cron drains it.
 */
export async function reconcileHeroImages(
  store: TenantStore,
  admin: AdminGraphql,
  cfg: TenantConfig,
  pickHero: (title: string, imageUrls: string[]) => Promise<HeroPick>,
  opts: { offset?: number; limit?: number } = {}
): Promise<{ scanned: number; fixed: number; total: number; next: number | null }> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit ?? 8;
  const all = (await store.listImportedLinks(500)).filter((l) => l.shopify_product_id);
  const total = all.length;
  const links = all.slice(offset, offset + limit);
  let scanned = 0;
  let fixed = 0;
  for (const link of links) {
    scanned++;
    try {
      const data = await admin(PRODUCT_MEDIA, { id: link.shopify_product_id }) as {
        product?: {
          title?: string;
          featuredMedia?: { id?: string } | null;
          metafield?: { value?: string } | null;
          media?: { nodes?: { id?: string; image?: { url?: string } }[] };
        };
      };
      const p = data.product;
      const nodes = (p?.media?.nodes ?? []).filter(
        (n): n is { id: string; image: { url: string } } => !!n?.id && !!n?.image?.url
      );
      if (nodes.length < 2) continue;
      const sig = mediaSignature(nodes.map((n) => n.id));
      if (p?.metafield?.value === sig) continue; // already vision-checked at this media state - no LLM call
      const hero = await pickHero(p?.title ?? '', nodes.map((n) => n.image.url));
      if (!hero.ok) continue; // couldn't decide (LLM down/failed) - don't cache, retry next run

      // 1) Delete incongruent media (wrong animal vs title, etc.) so it never
      // shows in the store. Never empties the gallery; the hero is never dropped.
      const dropIds = [...new Set((hero.drop ?? []).filter((i) => i >= 0 && i < nodes.length).map((i) => nodes[i].id))];
      if (dropIds.length && dropIds.length < nodes.length) {
        const d = await admin(DELETE_MEDIA, { productId: link.shopify_product_id, mediaIds: dropIds }) as {
          productDeleteMedia?: { mediaUserErrors?: { message: string }[]; userErrors?: { message: string }[] };
        };
        const derrs = [...(d.productDeleteMedia?.mediaUserErrors ?? []), ...(d.productDeleteMedia?.userErrors ?? [])];
        if (derrs.length) throw new Error(derrs.map((e) => e.message).join('; '));
        fixed++;
      }
      // 2) Promote the hero (by media id - valid even after deletions).
      if (hero.index !== null && hero.index < nodes.length && !dropIds.includes(nodes[hero.index].id) && p?.featuredMedia?.id !== nodes[hero.index].id) {
        const r = await admin(REORDER_MEDIA, { id: link.shopify_product_id, moves: [{ id: nodes[hero.index].id, newPosition: '0' }] }) as {
          productReorderMedia?: { mediaUserErrors?: { message: string }[]; userErrors?: { message: string }[] };
        };
        const errs = [...(r.productReorderMedia?.mediaUserErrors ?? []), ...(r.productReorderMedia?.userErrors ?? [])];
        if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
        if (!dropIds.length) fixed++;
      }
      // Record the check against the KEPT media set so the next run (which sees
      // the reduced gallery) skips it - no re-vision after a clean pass.
      const keptSig = mediaSignature(nodes.map((n) => n.id).filter((id) => !dropIds.includes(id)));
      await admin(SET_HERO_SIG, { mf: [{ ownerId: link.shopify_product_id, namespace: 'pawscout', key: 'hero_sig', type: 'single_line_text_field', value: keptSig }] });
    } catch (e) {
      console.warn(`hero-image reconcile failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return { scanned, fixed, total, next: offset + limit < total ? offset + limit : null };
}

const PRODUCT_DESC = `query pawscoutDesc($id: ID!) { product(id: $id) { title descriptionHtml } }`;

const UPDATE_DESC = `mutation pawscoutDescSet($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

/**
 * True when a description still carries raw supplier copy that must not ship:
 * hotlinked CJ images, CJ editor artifacts, supplier shipping/refund policy, or
 * CJ boilerplate headings. Clean (LLM-rewritten) descriptions match none of these.
 */
export function needsDescriptionRewrite(html: string): boolean {
  return /cjdropshipping|data-src=|data-uploadossfail|cj-description|working days|business days|returns? and refunds?|\brefunds?\b|packing list|applicable object|keywords:/i.test(html);
}

/**
 * Maintenance sweep: rewrite legacy/raw product descriptions into clean,
 * claim-safe copy. Only products whose current description still smells of raw
 * CJ text are touched (so already-clean listings cost no LLM calls). `rewrite`
 * is injected for testability. One product's failure never aborts the run.
 *
 * Batched (offset/limit) so each call finishes inside a request's time budget -
 * the console loops with `next` for progress; the cron drains it.
 */
export async function reconcileDescriptions(
  store: TenantStore,
  admin: AdminGraphql,
  cfg: TenantConfig,
  rewrite: (title: string, rawHtml: string) => Promise<string | null>,
  opts: { offset?: number; limit?: number } = {}
): Promise<{ scanned: number; rewritten: number; total: number; next: number | null }> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit ?? 8;
  const all = (await store.listImportedLinks(500)).filter((l) => l.shopify_product_id);
  const total = all.length;
  const links = all.slice(offset, offset + limit);
  let scanned = 0;
  let rewritten = 0;
  for (const link of links) {
    scanned++;
    try {
      const data = await admin(PRODUCT_DESC, { id: link.shopify_product_id }) as {
        product?: { title?: string; descriptionHtml?: string };
      };
      const html = data.product?.descriptionHtml ?? '';
      if (!needsDescriptionRewrite(html)) continue;
      const clean = await rewrite(data.product?.title ?? '', html);
      if (!clean) continue;
      const r = await admin(UPDATE_DESC, { input: { id: link.shopify_product_id, descriptionHtml: clean } }) as {
        productUpdate?: { userErrors?: { message: string }[] };
      };
      const errs = r.productUpdate?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
      rewritten++;
    } catch (e) {
      console.warn(`description reconcile failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return { scanned, rewritten, total, next: offset + limit < total ? offset + limit : null };
}

const PRODUCT_TITLE = `query pawscoutTitle($id: ID!) { product(id: $id) { title } }`;

/**
 * Category re-audit (LLM-free): files an imported product under the SINGLE
 * collection its title unambiguously signals (`signaledCategory`) when that
 * differs from where it sits - and ALSO assigns an ORPHAN (a product in no
 * mapped collection) the same way, so an import that arrived without a
 * collection tag doesn't stay invisible in nav. Conservative: a product with
 * mixed or no signal is left exactly where it is (an orphan with no signal
 * stays orphaned), so this never fights a reasonable LLM placement. Add-ons are
 * never filed. Batched; one product's failure never aborts the run.
 */
export async function reconcileCategories(
  store: TenantStore,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: { offset?: number; limit?: number } = {}
): Promise<{ scanned: number; moved: number; total: number; next: number | null }> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit ?? 25;
  const all = (await store.listImportedLinks(500)).filter((l) => l.shopify_product_id);
  const total = all.length;
  const links = all.slice(offset, offset + limit);
  let scanned = 0;
  let moved = 0;
  for (const link of links) {
    scanned++;
    try {
      const current = link.category;
      if (current === ADDON_CATEGORY) continue; // hidden add-on lane - never auto-file into a browse collection
      // The collection it currently sits in, IF that's a real mapped collection.
      // Orphans (no category) and products in an unmapped/removed lane have none.
      const mappedCurrent = current && cfg.collectionMap[current] ? current : null;
      const data = await admin(PRODUCT_TITLE, { id: link.shopify_product_id }) as { product?: { title?: string } };
      const signaled = signaledCategory(data.product?.title ?? '');
      if (!signaled || !cfg.collectionMap[signaled] || signaled === mappedCurrent) continue; // no clear target, or already correct
      // Move: drop the old collection tag first. Assign (orphan): nothing to drop.
      if (mappedCurrent) await setProductTags(admin, link.shopify_product_id!, [cfg.collectionMap[mappedCurrent].tag], false);
      await setProductTags(admin, link.shopify_product_id!, [cfg.collectionMap[signaled].tag], true);
      await store.putLink({ cjPid: link.cj_pid, state: 'imported', category: signaled });
      moved++;
    } catch (e) {
      console.warn(`category reconcile failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return { scanned, moved, total, next: offset + limit < total ? offset + limit : null };
}
