import type { TenantStore } from './tenant-store';

export type CatalogModel = {
  slug: string;
  name: string;
  vision: boolean;
  promptPriceM: number | null;
  completionPriceM: number | null;
};

// Curated shortlist shown in every console model dropdown. `vision` is a static
// hint used as a fallback / when the live OpenRouter lookup misses; it is
// corrected from live data when available. Selection is ACCURACY-first (price
// secondary), validated against the live OpenRouter catalog and an adversarial
// ranking workflow (2026-06-19). Claude OPUS is excluded (cost); Claude Sonnet
// 4.6 IS included as the claim-safety accuracy ceiling. gemini-3.1-pro-preview
// is merchant-mandated and must always appear even if OpenRouter has not listed
// the preview yet (it then surfaces with the static hint + price n/a). Ordered
// premium → workhorse; 9 of 10 are vision-capable for the image (vision) field.
export const CURATED_MODELS = [
  { slug: 'google/gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro (preview)', vision: true  },
  { slug: 'openai/gpt-5.2',                 label: 'GPT-5.2',                  vision: true  },
  { slug: 'anthropic/claude-sonnet-4.6',    label: 'Claude Sonnet 4.6',        vision: true  },
  { slug: 'x-ai/grok-4.3',                  label: 'Grok 4.3',                 vision: true  },
  { slug: 'google/gemini-3.5-flash',        label: 'Gemini 3.5 Flash',         vision: true  },
  { slug: 'openai/gpt-5-mini',              label: 'GPT-5 mini',               vision: true  },
  { slug: 'google/gemini-2.5-flash',        label: 'Gemini 2.5 Flash',         vision: true  },
  { slug: 'google/gemini-3.1-flash-lite',   label: 'Gemini 3.1 Flash Lite',    vision: true  },
  { slug: 'anthropic/claude-haiku-4.5',     label: 'Claude Haiku 4.5',         vision: true  },
  { slug: 'deepseek/deepseek-v4-pro',       label: 'DeepSeek V4 Pro',          vision: false },
] as const;

export const MODELS_CACHE_KEY = 'openrouter:models';
const CACHE_TTL_DAYS = 1;

type LiveModel = { name: string; vision: boolean; promptPrice: number; completionPrice: number };

// Build a slug → live-attributes map from the OpenRouter /api/v1/models payload.
// vision = the model's input_modalities include "image"; prices stay per-token USD.
export function buildLiveMap(data: unknown): Map<string, LiveModel> {
  const map = new Map<string, LiveModel>();
  const rows = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(rows)) return map;
  for (const r of rows) {
    const m = r as Record<string, any>;
    if (typeof m.id !== 'string') continue;
    const mods = m.architecture?.input_modalities;
    map.set(m.id, {
      name: typeof m.name === 'string' ? m.name : m.id,
      vision: Array.isArray(mods) && mods.includes('image'),
      promptPrice: Number(m.pricing?.prompt) || 0,
      completionPrice: Number(m.pricing?.completion) || 0,
    });
  }
  return map;
}

// Read the cached live map; on a miss, fetch OpenRouter and cache it (24h).
// Returns null on any failure so callers fall back to static curated data.
async function loadLiveMap(store: TenantStore, fetchImpl: typeof fetch): Promise<Map<string, LiveModel> | null> {
  try {
    const cached = await store.getSearchCache(MODELS_CACHE_KEY);
    if (cached) return new Map(JSON.parse(cached) as [string, LiveModel][]);
    const res = await fetchImpl('https://openrouter.ai/api/v1/models');
    if (!res.ok) return null;
    const map = buildLiveMap(await res.json());
    if (map.size) await store.putSearchCache(MODELS_CACHE_KEY, JSON.stringify([...map]), CACHE_TTL_DAYS);
    return map;
  } catch {
    return null;
  }
}

// Assemble the curated list enriched with live pricing ($/million tokens) and
// the corrected vision flag. Never throws: on any catalog failure every model
// surfaces with null prices and its static vision hint.
export async function getModelCatalog(store: TenantStore, fetchImpl: typeof fetch = fetch): Promise<CatalogModel[]> {
  const live = await loadLiveMap(store, fetchImpl);
  return CURATED_MODELS.map((m) => {
    const l = live?.get(m.slug);
    return {
      slug: m.slug,
      name: l?.name ?? m.label,
      vision: l?.vision ?? m.vision,
      promptPriceM: l ? Math.round(l.promptPrice * 1e6 * 100) / 100 : null,
      completionPriceM: l ? Math.round(l.completionPrice * 1e6 * 100) / 100 : null,
    };
  });
}
