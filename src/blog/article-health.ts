// src/blog/article-health.ts
//
// The ARTICLE HEALTH pass: published guides must never link a 404 product and
// their "Shop this guide" metafield must never hold dead picks. The profit
// agent archives products continuously, so generation-time grounding rots;
// this pass reconciles every guide against the LIVE catalog (nightly stage +
// owner console button), mirroring the de-brand/link-scrub architecture.
//
// Heal policy (owner-approved 2026-07-19): a dead body link is relinked to a
// congruent LIVE product picked by the LLM inside a deterministic cage (the
// returned handle MUST be in the grounded candidate list, the anchor text is
// sanitised plain text, and the final body passes scrubExternalLinks). When
// the LLM is unavailable, declines, or there are no candidates, the fallback
// swaps the href to the guide's funnel collection: never a 404 either way.

import type { AdminGraphql } from '../shopify-admin';
import type { Env, TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import { defaultFetch } from '../safe-fetch';
import { groundCollection } from './ground';
import { scrubExternalLinks } from './sources';
import { sanitizeBlogHtml } from './draft';
import { htmlToText } from './quality';
import { enrichBlogPost } from './pipeline';

export interface ArticleHealthResult {
  articlesScanned: number;
  linksChecked: number;
  deadLinks: number;
  bodiesHealed: number;
  metafieldsRefreshed: number;
  errors: string[];
  samples: string[]; // before -> after examples for the console/log
}

export interface HealCandidate { title: string; handle: string; path: string }

/** Distinct product handles the body links, in order of first appearance. */
export function extractBodyProductHandles(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*['"]\/products\/([a-z0-9][a-z0-9-]*)['"]/gi)) {
    const h = m[1].toLowerCase();
    if (!seen.has(h)) { seen.add(h); out.push(h); }
  }
  return out;
}

// Validated against the pinned 2026-04 Admin schema (shopify-admin skill,
// 2026-07-19). onlineStoreUrl is the 404 truth: null when the product is
// archived, draft, or unpublished from the Online Store channel.
const PRODUCTS_BY_HANDLES = `query pawscoutProductsByHandles($q: String!) {
  products(first: 50, query: $q) { nodes { handle onlineStoreUrl status } }
}`;

/** handle -> live (reachable on the storefront). Handles absent from the shop
 *  resolve to false. Queried in chunks of 25 exact-handle OR terms. */
export async function resolveHandleLiveness(admin: AdminGraphql, handles: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  for (const h of handles) map.set(h, false);
  for (let i = 0; i < handles.length; i += 25) {
    const chunk = handles.slice(i, i + 25);
    const q = chunk.map((h) => `handle:${h}`).join(' OR ');
    const data = await admin(PRODUCTS_BY_HANDLES, { q }) as {
      products?: { nodes?: { handle?: string; onlineStoreUrl?: string | null }[] };
    };
    for (const n of data.products?.nodes ?? []) {
      if (n?.handle && map.has(n.handle.toLowerCase())) map.set(n.handle.toLowerCase(), !!n.onlineStoreUrl);
    }
  }
  return map;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The caged LLM pick: {handle, anchorText} from the candidate list, or
 *  {handle:null} ("none fits" is a valid answer, never forced). */
function validateHealPick(v: unknown, candidateHandles: Set<string>): { handle: string | null; anchorText: string } | null {
  const o = v as Record<string, unknown>;
  if (typeof o !== 'object' || o === null) return null;
  if (o.handle === null) return { handle: null, anchorText: '' };
  const handle = typeof o.handle === 'string' ? o.handle.trim().toLowerCase() : '';
  if (!handle || !candidateHandles.has(handle)) return null;
  const anchorText = typeof o.anchorText === 'string'
    ? htmlToText(sanitizeBlogHtml(o.anchorText)).slice(0, 120).trim()
    : '';
  if (!anchorText) return null;
  return { handle, anchorText };
}

/**
 * Heal every dead product anchor in a body. Pure over its inputs (LLM injected)
 * so it is directly testable. Returns the healed body (scrubbed + sanitised)
 * and human-readable samples; body === input when nothing needed healing.
 */
export async function healArticleBody(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: {
    body: string;
    articleTitle: string;
    deadHandles: string[];
    candidates: HealCandidate[];
    collectionPath: string | null; // fallback href; null -> unwrap (last resort)
  }
): Promise<{ body: string; samples: string[] }> {
  let body = opts.body;
  const samples: string[] = [];
  const candidateHandles = new Set(opts.candidates.map((c) => c.handle.toLowerCase()));
  const byHandle = new Map(opts.candidates.map((c) => [c.handle.toLowerCase(), c]));

  for (const dead of opts.deadHandles) {
    const anchorRe = new RegExp(`<a\\b[^>]*href\\s*=\\s*["']/products/${escapeRe(dead)}["'][^>]*>([\\s\\S]*?)</a>`, 'gi');
    const anchors = [...body.matchAll(anchorRe)];
    if (!anchors.length) continue;

    let replacement: ((inner: string) => string) | null = null;
    let target = '';

    if (opts.candidates.length && llm.available) {
      const chain = resolveChain(cfg, 'text');
      const r = await llm.jsonChain<{ handle: string | null; anchorText: string }>({
        chain, maxTokens: 300,
        system:
          'A pet-care article links a product that no longer exists. From CANDIDATES (real, live products), pick the ONE most congruent with the anchor context and write natural replacement anchor text naming it (plain text, max 90 chars, no dashes of the em/en kind). ' +
          'Respond with ONLY JSON: {"handle": <a candidate handle>, "anchorText": <the text>}. If no candidate genuinely fits the context, respond {"handle": null}.',
        user: JSON.stringify({
          articleTitle: opts.articleTitle,
          deadHandle: dead,
          anchorTexts: anchors.map((a) => htmlToText(a[1]).slice(0, 200)),
          candidates: opts.candidates.map((c) => ({ handle: c.handle, title: c.title }))
        }),
        validate: (v) => validateHealPick(v, candidateHandles)
      });
      if (r.ok) {
        await store.logLlmUsage('blog-health', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
        if (r.value.handle) {
          const c = byHandle.get(r.value.handle)!;
          const text = escapeHtml(r.value.anchorText);
          replacement = () => `<a href="${c.path}">${text}</a>`;
          target = c.path;
        }
      }
    }
    if (!replacement) {
      if (opts.collectionPath) {
        const path = opts.collectionPath;
        replacement = (inner) => `<a href="${path}">${inner}</a>`;
        target = path;
      } else {
        replacement = (inner) => inner; // no funnel to point at: unwrap, keep the words
        target = '(unlinked)';
      }
    }
    body = body.replace(anchorRe, (_whole, inner: string) => replacement!(inner));
    samples.push(`"${opts.articleTitle}": /products/${dead} -> ${target}`);
  }

  if (body !== opts.body) body = scrubExternalLinks(sanitizeBlogHtml(body));
  return { body, samples };
}

// Same read shape as the de-brand sweep, extended with tags (the funnel
// collection handle) and the shop-block metafield. Validated 2026-07-19.
const HEALTH_ARTICLES_QUERY = `query pawscoutHealthArticles {
  blogs(first: 20) {
    nodes {
      id handle
      articles(first: 100) {
        nodes { id title tags body metafield(namespace: "blog", key: "related_products") { value } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const ARTICLE_BODY_UPDATE = `mutation pawscoutHealthArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } }
}`;

/**
 * The full pass: detect dead product links in every article, heal bodies, and
 * refresh the shop-block metafield (via the existing enrich flow) when its
 * curated picks are dead. Never throws: per-article failures collect into
 * `errors` (de-brand philosophy). Cheap no-op on a healthy catalog.
 */
export async function runArticleHealth(
  env: Env, store: TenantStore, cfg: TenantConfig, admin: AdminGraphql,
  fetchImpl: typeof fetch = defaultFetch,
  enrich: typeof enrichBlogPost = enrichBlogPost // injectable for tests
): Promise<ArticleHealthResult> {
  const result: ArticleHealthResult = {
    articlesScanned: 0, linksChecked: 0, deadLinks: 0, bodiesHealed: 0, metafieldsRefreshed: 0, errors: [], samples: []
  };
  let data: {
    blogs?: { nodes?: { handle?: string; articles?: {
      nodes?: { id: string; title?: string; tags?: string[]; body?: string; metafield?: { value?: string } | null }[];
      pageInfo?: { hasNextPage?: boolean };
    } }[] };
  };
  try {
    data = await admin(HEALTH_ARTICLES_QUERY) as typeof data;
  } catch (e) {
    result.errors.push(`articles query: ${(e as Error).message}`);
    return result;
  }
  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);

  for (const blog of data.blogs?.nodes ?? []) {
    for (const a of blog.articles?.nodes ?? []) {
      result.articlesScanned++;
      try {
        const body = a.body ?? '';
        const bodyHandles = extractBodyProductHandles(body);
        let curated: string[] = [];
        if (a.metafield?.value) {
          try { curated = (JSON.parse(a.metafield.value) as string[]).filter((h) => typeof h === 'string'); } catch {}
        }
        result.linksChecked += bodyHandles.length;
        const all = [...new Set([...bodyHandles, ...curated.map((h) => h.toLowerCase())])];
        if (!all.length) continue;
        const live = await resolveHandleLiveness(admin, all);
        const deadBody = bodyHandles.filter((h) => !live.get(h));
        const deadCurated = curated.filter((h) => !live.get(h.toLowerCase()));
        result.deadLinks += deadBody.length;

        if (deadBody.length) {
          // Funnel: the first tag that grounds to a collection with live products.
          let pack = null;
          for (const tag of a.tags ?? []) {
            pack = await groundCollection(admin, tag).catch(() => null);
            if (pack && pack.products.some((p) => p.available)) break;
            pack = null;
          }
          const candidates: HealCandidate[] = (pack?.products ?? [])
            .filter((p) => p.available && !deadBody.includes(p.handle.toLowerCase()))
            .map((p) => ({ title: p.title, handle: p.handle, path: p.path }));
          const collectionPath = pack?.collectionPath ?? ((a.tags?.length) ? `/collections/${a.tags[0]}` : null);
          const healed = await healArticleBody(llm, store, cfg, {
            body, articleTitle: a.title ?? a.id, deadHandles: deadBody, candidates, collectionPath
          });
          if (healed.body !== body) {
            const r = await admin(ARTICLE_BODY_UPDATE, { id: a.id, article: { body: healed.body } }) as {
              articleUpdate?: { userErrors?: { message: string }[] };
            };
            const errs = r.articleUpdate?.userErrors ?? [];
            if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
            result.bodiesHealed++;
            for (const s of healed.samples) if (result.samples.length < 12) result.samples.push(s);
          }
        }

        if (deadCurated.length) {
          const er = await enrich(env, store, cfg, { articleId: a.id }, fetchImpl);
          if (er.ok) {
            result.metafieldsRefreshed++;
            if (result.samples.length < 12) result.samples.push(`"${a.title ?? a.id}": shop block refreshed (${deadCurated.length} dead pick(s))`);
          } else {
            result.errors.push(`shop block ${a.id}: ${er.error}`);
          }
        }
      } catch (e) {
        result.errors.push(`article ${a.id}: ${(e as Error).message}`);
      }
    }
    if (blog.articles?.pageInfo?.hasNextPage) {
      result.errors.push(`blog ${blog.handle ?? '?'}: >100 articles, tail not checked this run`);
    }
  }
  if (result.bodiesHealed || result.metafieldsRefreshed) {
    console.log(`article-health: healed ${result.bodiesHealed} body(ies), refreshed ${result.metafieldsRefreshed} shop block(s), ${result.deadLinks} dead link(s) found`);
  }
  return result;
}
