import { defaultFetch } from './safe-fetch';
import type { TenantStore } from './tenant-store';
import type { CjDetail } from './cj';
import type { LlmConfig, TenantConfig } from './types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const KEYWORD_META_TTL_DAYS = 30;

export interface LlmUsage { model: string; promptTokens: number; completionTokens: number; costUsd: number }
export type LlmJson<T> = { ok: true; value: T; usage: LlmUsage } | { ok: false; error: string };

/**
 * Thin OpenRouter client (W3). Strict-JSON prompts, validated on parse.
 * NEVER throws into a job — every failure degrades to "no LLM", because the
 * system must function on mechanical gates alone.
 */
export class LlmClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = defaultFetch
  ) {}

  get available(): boolean {
    return !!this.apiKey;
  }

  async json<T>(opts: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
    validate: (v: unknown) => T | null;
  }): Promise<LlmJson<T>> {
    if (!this.apiKey) return { ok: false, error: 'OPENROUTER_API_KEY not set' };
    try {
      const resp = await this.fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://pawscout.activepaw.co.uk',
          'X-Title': 'PawScout'
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 1024,
          response_format: { type: 'json_object' },
          usage: { include: true }, // OpenRouter returns per-call cost
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user }
          ]
        })
      });
      if (!resp.ok) return { ok: false, error: `OpenRouter HTTP ${resp.status}` };
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        error?: { message?: string };
      };
      if (data.error?.message) return { ok: false, error: data.error.message };
      const raw = data.choices?.[0]?.message?.content ?? '';
      // Models occasionally wrap JSON in fences despite json_object mode.
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, error: 'LLM returned non-JSON' };
      }
      const value = opts.validate(parsed);
      if (value === null) return { ok: false, error: 'LLM JSON failed validation' };
      return {
        ok: true,
        value,
        usage: {
          model: opts.model,
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          costUsd: data.usage?.cost ?? 0
        }
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

// --- W3.2 admission curation ---

export interface Curation {
  relevanceScore: number;       // 0-100
  category: string | null;      // a collectionMap key, or null
  title: string;                // rewritten, <= 70 chars
  descriptionHtml: string;      // clean HTML
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
      'You receive a raw supplier listing. Respond with ONLY a JSON object: ' +
      '{"relevanceScore": <0-100 integer — how strongly this is a quality, on-niche PET product matching the context; products for children or general household score under 30>, ' +
      `"category": <one of ${JSON.stringify(categories)} or null>, ` +
      '"title": <rewritten product title, natural English, max 70 chars, no ALL CAPS, no year prefixes, no keyword stuffing>, ' +
      '"descriptionHtml": <clean simple HTML description, max 200 words, factual, UK English, no medical claims, no supplier names>}',
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
      return {
        relevanceScore: Math.round(score),
        category,
        title: clip(o.title.trim(), 80),
        descriptionHtml: clip(o.descriptionHtml, 8000)
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
