import { defaultFetch } from './safe-fetch';
import type { TenantStore } from './tenant-store';
import type { CjDetail } from './cj';
import type { LlmConfig, TenantConfig } from './types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_MODEL_PRICE = { promptPerM: 0.75, completionPerM: 4.50 };
export type LlmRole = 'image' | 'text';
export type ChainTier =
  | { provider: 'openrouter'; models: string[] }
  | { provider: 'openai'; model: string };
const KEYWORD_META_TTL_DAYS = 30;

export interface LlmUsage { provider: 'openrouter' | 'openai'; model: string; promptTokens: number; completionTokens: number; costUsd: number }
export type LlmJson<T> = { ok: true; value: T; usage: LlmUsage } | { ok: false; error: string };

function tryJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Extract a JSON value from raw model output, tolerant of the ways models break
 * `response_format: json_object` in practice: markdown fences, and (the failure
 * we actually hit in prod) a prose preamble/postamble wrapping the JSON, which
 * reasoning/preview models emit intermittently. Returns `undefined` when no JSON
 * can be recovered. (JSON.parse never returns undefined, so it's a safe sentinel.)
 */
export function extractJson(raw: string): unknown {
  const stripped = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const direct = tryJsonParse(stripped);
  if (direct !== undefined) return direct;
  // Repair: pull the outermost {...} or [...] out of surrounding prose, earliest first.
  const candidates = [stripped.match(/\{[\s\S]*\}/), stripped.match(/\[[\s\S]*\]/)]
    .filter((m): m is RegExpMatchArray => m !== null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const m of candidates) {
    const p = tryJsonParse(m[0]);
    if (p !== undefined) return p;
  }
  return undefined;
}

type SendOutcome<T> =
  | { kind: 'ok'; value: T; usage: LlmUsage }
  | { kind: 'retry'; error: string }   // transient: retry SAME tier once
  | { kind: 'advance'; error: string } // hard model/account failure: next tier
  | { kind: 'stop'; error: string };   // request-shape bug: degrade, no advance

/**
 * Provider-aware LLM client (W3). Walks a tier chain (OpenRouter → OpenAI-direct).
 * Strict-JSON prompts, validated on parse. NEVER throws into a job — every failure
 * degrades to "no LLM", because the system must function on mechanical gates alone.
 */
export class LlmClient {
  constructor(
    private readonly keys: { openrouter?: string; openai?: string },
    private readonly fetchImpl: typeof fetch = defaultFetch
  ) {}

  get available(): boolean { return !!(this.keys.openrouter || this.keys.openai); }

  /** Walk a resolved tier chain; degrade to {ok:false} when exhausted. Never throws. */
  async jsonChain<T>(opts: {
    chain: ChainTier[]; system: string; user: string;
    images?: string[]; maxTokens?: number; validate: (v: unknown) => T | null;
  }): Promise<LlmJson<T>> {
    let lastError = 'no usable LLM tier';
    for (const tier of opts.chain) {
      const key = tier.provider === 'openai' ? this.keys.openai : this.keys.openrouter;
      if (!key) continue; // provider not configured → skip
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await this.send<T>(tier, key, opts);
        if (out.kind === 'ok') {
          if (tier.provider === 'openai') {
            console.warn(`llm.tier3.activated model=${out.usage.model} — both OpenRouter slots failed`);
          }
          return { ok: true, value: out.value, usage: out.usage };
        }
        lastError = out.error;
        if (out.kind === 'stop') return { ok: false, error: out.error };
        if (out.kind === 'retry' && attempt === 0) continue; // one same-tier retry
        break; // advance to next tier
      }
    }
    return { ok: false, error: lastError };
  }

  /** @deprecated transitional — single-OpenRouter-tier wrapper, removed in Task 5. */
  async json<T>(opts: { model: string; system: string; user: string; images?: string[]; maxTokens?: number; validate: (v: unknown) => T | null }): Promise<LlmJson<T>> {
    return this.jsonChain({ chain: [{ provider: 'openrouter', models: [opts.model] }], system: opts.system, user: opts.user, images: opts.images, maxTokens: opts.maxTokens, validate: opts.validate });
  }

  private async send<T>(tier: ChainTier, key: string, opts: {
    system: string; user: string; images?: string[]; maxTokens?: number; validate: (v: unknown) => T | null;
  }): Promise<SendOutcome<T>> {
    const userContent = opts.images?.length
      ? [{ type: 'text', text: opts.user }, ...opts.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
      : opts.user;
    const messages = [{ role: 'system', content: opts.system }, { role: 'user', content: userContent }];
    const isOpenai = tier.provider === 'openai';
    const url = isOpenai ? OPENAI_URL : OPENROUTER_URL;
    const body = isOpenai
      ? { model: tier.model, max_completion_tokens: Math.max(opts.maxTokens ?? 1024, 3000), reasoning_effort: 'medium', response_format: { type: 'json_object' }, messages }
      : { models: tier.models, max_tokens: opts.maxTokens ?? 1024, response_format: { type: 'json_object' }, usage: { include: true }, messages };
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (!isOpenai) { headers['HTTP-Referer'] = 'https://pawscout.activepaw.co.uk'; headers['X-Title'] = 'PawScout'; }

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) { return { kind: 'retry', error: (e as Error).message }; } // network throw → retry then advance

    if (!resp.ok) {
      const errBody = (await resp.json().catch(() => null)) as { error?: { type?: string; code?: string; message?: string } } | null;
      const code = errBody?.error?.code; const type = errBody?.error?.type;
      const msg = errBody?.error?.message ?? `HTTP ${resp.status}`;
      if (resp.status === 400 && type === 'invalid_request_error') return { kind: 'stop', error: msg };
      if (resp.status === 429 && code === 'insufficient_quota') return { kind: 'advance', error: msg };
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) return { kind: 'advance', error: msg };
      return { kind: 'retry', error: msg }; // 5xx/503/429 rate_limit
    }

    const data = (await resp.json().catch(() => null)) as any;
    if (data?.error?.message) return { kind: 'advance', error: data.error.message }; // OpenRouter 200-with-error
    const parsed = extractJson(data?.choices?.[0]?.message?.content ?? '');
    if (parsed === undefined) return { kind: 'retry', error: 'LLM returned non-JSON' };
    const value = opts.validate(parsed);
    if (value === null) return { kind: 'retry', error: 'LLM JSON failed validation' };

    const promptTokens = data?.usage?.prompt_tokens ?? 0;
    const completionTokens = data?.usage?.completion_tokens ?? 0;
    const costUsd = isOpenai
      ? promptTokens / 1e6 * DEFAULT_MODEL_PRICE.promptPerM + completionTokens / 1e6 * DEFAULT_MODEL_PRICE.completionPerM
      : (data?.usage?.cost ?? 0);
    return { kind: 'ok', value, usage: { provider: tier.provider, model: data?.model ?? (isOpenai ? tier.model : tier.models[0]), promptTokens, completionTokens, costUsd } };
  }
}

// --- W3.2 admission curation ---

export type PetClass = 'cat' | 'dog' | 'both' | 'small-pet' | 'other';

export interface Curation {
  relevanceScore: number;       // 0-100
  category: string | null;      // a collectionMap key, or null
  title: string;                // rewritten, <= 70 chars
  descriptionHtml: string;      // clean HTML
  petClass: PetClass;           // target animal — for species-aware filtering
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Score + rewrite a candidate at warehouse-admission time (background only).
 * Returns null on any LLM failure — the caller falls back to mechanical gates.
 */
export async function curateProduct(
  llm: LlmClient,
  store: TenantStore,
  cfg: TenantConfig,
  detail: CjDetail,
  context: string // the demand keyword or category that surfaced this candidate
): Promise<Curation | null> {
  if (!llm.available || !cfg.llm.enabled) return null;
  const categories = Object.keys(cfg.collectionMap);
  const model = cfg.llm.curationModel ?? cfg.llm.model;

  const result = await llm.json<Curation>({
    model,
    maxTokens: 1200,
    system:
      'You curate products for Active Paw, a UK online pet-care store (dogs and cats: grooming, toys, feeding, walking, health, daily care). ' +
      'You receive a raw supplier listing and the search CONTEXT that surfaced it. Respond with ONLY a JSON object: ' +
      '{"relevanceScore": <0-100 integer — how strongly this is a quality, on-niche PET product matching the context. ' +
      'Products for children or general household score under 30. ' +
      'CRITICAL species rule: if the context targets one animal (e.g. "cat ...") but the product is clearly FOR a different animal (e.g. a dog harness, a dog chew), score it under 20 even if its description merely mentions the other animal in passing. A "cat toy" search must NOT accept dog products.>, ' +
      `"category": <one of ${JSON.stringify(categories)} or null>, ` +
      '"title": <rewritten product title, natural English, max 70 chars, no ALL CAPS, no year prefixes, no keyword stuffing>, ' +
      '"descriptionHtml": <clean simple HTML description, max 200 words, factual, UK English, no medical claims, no supplier names>, ' +
      '"petClass": <the product\'s actual target animal — one of "cat", "dog", "both" (genuinely suitable for either), "small-pet" (rabbit/hamster/bird/fish), or "other" (not animal-specific, e.g. a generic bowl)>}',
    user: JSON.stringify({
      context,
      supplierTitle: detail.nameEn,
      supplierCategory: detail.categoryName,
      priceUsd: detail.variants[0]?.sellPriceUsd,
      variantNames: detail.variants.slice(0, 8).map((v) => v.name),
      descriptionExcerpt: clip(detail.descriptionHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 1200)
    }),
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return null;
      const score = Number(o.relevanceScore);
      if (!Number.isFinite(score) || score < 0 || score > 100) return null;
      if (typeof o.title !== 'string' || !o.title.trim()) return null;
      if (typeof o.descriptionHtml !== 'string' || !o.descriptionHtml.trim()) return null;
      const category = typeof o.category === 'string' && categories.includes(o.category) ? o.category : null;
      const PET_CLASSES = ['cat', 'dog', 'both', 'small-pet', 'other'];
      const petClass = (typeof o.petClass === 'string' && PET_CLASSES.includes(o.petClass) ? o.petClass : 'other') as Curation['petClass'];
      return {
        relevanceScore: Math.round(score),
        category,
        title: clip(o.title.trim(), 80),
        descriptionHtml: clip(o.descriptionHtml, 8000),
        petClass
      };
    }
  });

  if (!result.ok) {
    console.warn(`curation failed for ${detail.pid}: ${result.error}`);
    return null;
  }
  await store.logLlmUsage('curation', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  return result.value;
}

// --- Hero-image QA (vision): pick the best default image for a listing ---

const MAX_HERO_IMAGES = 8; // cap vision cost; CJ rarely puts the set shot past #8

/** Result of a hero-image decision. `ok:false` = couldn't decide (don't cache).
 * `index` = 0-based image to promote to hero (null = current first is fine).
 * `drop` = 0-based indices of images that DON'T belong to this listing (a
 * different animal than the title names, an unrelated product, or a duplicate)
 * and should be removed so they never surface in Shopify. The hero is never in
 * `drop`; `drop` is `[]` when nothing should be removed. */
export interface HeroPick { ok: boolean; index: number | null; drop?: number[] }

/**
 * Vision pass: given a product TITLE and its images (in current order, index 0
 * first), return the 0-based index of the image that best represents the whole
 * product — so the caller can promote it to the featured slot. Catches the
 * "title says SET but the default image is one comb" class of mismatch.
 *
 * Returns a HeroPick: `ok:false` means we couldn't decide (no LLM or a failure)
 * and the caller should NOT cache the result — retry later. `ok:true` means the
 * model (or the trivial <2-image case) gave a definitive answer: `index` is the
 * 0-based image to promote, or null when the current first image is already best.
 * Never throws.
 */
export async function pickHeroImage(
  llm: LlmClient,
  store: TenantStore,
  cfg: TenantConfig,
  title: string,
  imageUrls: string[]
): Promise<HeroPick> {
  if (!llm.available || !cfg.llm.enabled) return { ok: false, index: null, drop: [] };
  const urls = imageUrls.slice(0, MAX_HERO_IMAGES);
  if (urls.length < 2) return { ok: true, index: null, drop: [] }; // nothing to choose/vet — definitively fine
  const model = cfg.llm.visionModel ?? cfg.llm.curationModel ?? cfg.llm.model;

  const result = await llm.json<{ index: number; drop: number[]; reason: string }>({
    model,
    maxTokens: 200,
    images: urls,
    system:
      'You curate the image gallery for a pet-product listing. ' +
      'You are given the product TITLE and its images in order (image index 0 is shown first). Do two things:\n' +
      '1) HERO: pick the single image that best represents the WHOLE product as the title describes it. ' +
      'For a "set"/"kit"/"bundle"/"with X & Y" title, prefer the image showing ALL the included items together, NOT one component alone. ' +
      'STRONGLY prefer a clean, well-lit photo of the product ITSELF with NO overlaid marketing/banner text baked into the image, NO watermarks, and NO cartoon or illustrated mascots — ' +
      'over packaging-only, a size chart, any text/infographic/promotional graphic, a lifestyle-only scene, or an extreme close-up of one detail. ' +
      'A photo with large overlaid promo text or a cartoon mascot looks unprofessional; choose it as hero ONLY if no cleaner plain product photo exists in the set.\n' +
      '2) DROP: list the indices of images that DO NOT BELONG to this listing — an image showing a DIFFERENT animal than the title names (e.g. the title says "dog" but the image shows a cat), an unrelated product, or a near-duplicate. ' +
      'Be CONSERVATIVE: only drop an image you are confident is incongruent with the title; when unsure, KEEP it (do not drop). The hero must NOT be in drop. ' +
      'If the title names an animal, the hero MUST feature that animal when any image does.\n' +
      'Respond with ONLY JSON: {"index": <0-based hero index>, "drop": [<0-based indices to remove>], "reason": <short phrase, max 12 words>}.',
    user: JSON.stringify({ title, imageCount: urls.length, note: 'Images follow in order; the first image is index 0.' }),
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return null;
      const idx = Number(o.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= urls.length) return null;
      const drop = Array.isArray(o.drop)
        ? [...new Set(o.drop.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < urls.length && n !== idx))]
        : [];
      return { index: idx, drop, reason: typeof o.reason === 'string' ? clip(o.reason, 120) : '' };
    }
  });

  if (!result.ok) {
    console.warn(`hero-image pick failed for "${title}": ${result.error}`);
    return { ok: false, index: null, drop: [] };
  }
  await store.logLlmUsage('hero-image', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  return { ok: true, index: result.value.index > 0 ? result.value.index : null, drop: result.value.drop };
}

// --- Description rewrite: clean a raw/legacy supplier description ---

/**
 * Rewrite a product description into clean, claim-safe UK-English HTML. Used to
 * repair legacy listings that still carry raw CJ copy — supplier shipping/refund
 * text, hotlinked images, and medical claims. Returns null on any failure, or if
 * the output still smells of a hotlink/supplier marker (defensive). Never throws.
 */
export async function rewriteDescription(
  llm: LlmClient,
  store: TenantStore,
  cfg: TenantConfig,
  title: string,
  rawHtml: string
): Promise<string | null> {
  if (!llm.available || !cfg.llm.enabled) return null;
  const model = cfg.llm.curationModel ?? cfg.llm.model;
  const currentText = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!currentText) return null;

  const result = await llm.json<{ descriptionHtml: string }>({
    model,
    maxTokens: 700,
    system:
      'You rewrite a pet-product description for a UK online pet store. Respond with ONLY JSON: ' +
      '{"descriptionHtml": <clean HTML string>}. Rules: simple factual HTML using only <p>, <ul>, <li>, <strong>; ' +
      'UK English; max ~150 words; keep accurate specs (material, size, contents, colours) when present; ' +
      'NO medical or disease claims — never say a product prevents, treats or cures disease; phrase care benefits softly ' +
      '("helps maintain", "supports"); NO supplier or brand names; NO shipping times, returns or refund policy; ' +
      'NO <img> tags, NO external links or URLs; no ALL CAPS, no keyword stuffing. ' +
      'For oral/dental products, add one short line to introduce gradually and consult a vet about existing concerns.',
    user: JSON.stringify({ title, currentText }),
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return null;
      const d = typeof o.descriptionHtml === 'string' ? o.descriptionHtml.trim() : '';
      if (!d) return null;
      if (/cjdropshipping|<img|https?:\/\//i.test(d)) return null; // defensive: no hotlinks/supplier leak
      return { descriptionHtml: clip(d, 6000) };
    }
  });

  if (!result.ok) {
    console.warn(`description rewrite failed for "${title}": ${result.error}`);
    return null;
  }
  await store.logLlmUsage('description', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  return result.value.descriptionHtml;
}

// --- W3.3 keyword classification (cached; runs via waitUntil, never hot path) ---

export interface KeywordMeta { category: string | null; synonyms: string[] }

export function keywordMetaKey(kw: string): string {
  return `kw-meta:${kw}`;
}

export async function getKeywordMeta(store: TenantStore, kw: string): Promise<KeywordMeta | null> {
  const cached = await store.getSearchCache(keywordMetaKey(kw));
  if (!cached) return null;
  try { return JSON.parse(cached) as KeywordMeta; } catch { return null; }
}

/** Classify a new search keyword once; subsequent searches use the cached meta. */
export async function classifyKeyword(
  llm: LlmClient,
  store: TenantStore,
  cfg: TenantConfig,
  kw: string
): Promise<void> {
  if (!llm.available || !cfg.llm.enabled) return;
  if (await store.getSearchCache(keywordMetaKey(kw))) return; // already classified
  const categories = Object.keys(cfg.collectionMap);

  const result = await llm.json<KeywordMeta>({
    model: cfg.llm.model,
    maxTokens: 300,
    system:
      'You classify pet-store search queries. Respond with ONLY a JSON object: ' +
      `{"category": <one of ${JSON.stringify(categories)} or null>, ` +
      '"synonyms": <array of up to 4 short alternative keyword phrases a pet-product catalog might use for the same intent>}',
    user: kw,
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return null;
      const category = typeof o.category === 'string' && categories.includes(o.category) ? o.category : null;
      const synonyms = Array.isArray(o.synonyms)
        ? o.synonyms.filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 4).map((s) => s.toLowerCase().trim())
        : [];
      return { category, synonyms };
    }
  });

  if (!result.ok) {
    console.warn(`keyword classification failed for "${kw}": ${result.error}`);
    return;
  }
  await store.logLlmUsage('keyword', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  await store.putSearchCache(keywordMetaKey(kw), JSON.stringify(result.value), KEYWORD_META_TTL_DAYS);
}
