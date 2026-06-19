# Selectable LLM Models (pricing + vision filter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every LLM-model setting in the PawScout console into a dropdown of ~9 curated models with live pricing, and guarantee a text-only model can never be selected for the image (vision) task.

**Architecture:** A worker constant (`CURATED_MODELS`) defines the shortlist. A new `GET /api/models` endpoint enriches it with live OpenRouter pricing + vision flags (cached 24h in `search_cache`), never erroring. The console renders five `<select>`s from that endpoint; the image-model select is built only from vision-capable models. A new optional `llm.visionModel` config field is added, validated for shape in `validateLlmPayload` and for vision-capability in the `/api/llm` save route (which has DB access to the cached catalog). `pickHeroImage` resolves `visionModel ?? curationModel ?? model`.

**Tech Stack:** Cloudflare Worker (Hono), TypeScript, D1 (`search_cache` table via `TenantStore.getSearchCache`/`putSearchCache`), OpenRouter `/api/v1/models`, vitest + `@cloudflare/vitest-pool-workers`. Console UI is a single template literal in `src/console/page.ts`.

## Global Constraints

- **Source spec (verbatim authority):** `docs/superpowers/specs/2026-06-19-selectable-llm-models-design.md`. Where this plan and the spec disagree, the spec governs — escalate.
- **Curated list is exactly these 9 slugs**, vision flags as written, `google/gemini-3.1-pro-preview` MUST always appear, Opus/Sonnet excluded:
  `anthropic/claude-haiku-4.5`(v), `google/gemini-2.5-flash-lite`(v), `google/gemini-2.5-flash`(v), `google/gemini-3.1-pro-preview`(v), `openai/gpt-5-mini`(v), `mistralai/mistral-medium-3.5`(v), `moonshotai/kimi-k2.6`(v), `deepseek/deepseek-v4-flash`(text), `qwen/qwen3.7-max`(text).
- **`/api/models` must NEVER error** — on any fetch/parse failure return the curated list with `promptPriceM`/`completionPriceM = null` and the static `vision` flag.
- **Never silently change a tenant's saved model:** a currently-saved slug not in the curated list is preserved as a selected `<option>`.
- **Vision = `architecture.input_modalities` includes `"image"`** (live), else the static `vision` hint.
- **Prices are $/million tokens** (`Number(pricing.prompt) * 1e6`), `null` when unknown.
- **`src/console/page.ts` is one giant template literal** — a raw `\n`/`` ` ``/`${` inside the embedded browser JS breaks the whole inline script. Write `\\n`, escape backticks, and **ALWAYS run `tests/console.test.ts` (the JS-parse guard) after editing it** (see `[[console-page-template-literal-gotcha]]`).
- **`digestModel` gets no UI** (dead config — out of scope).
- All `/api/*` routes are gated by `shopOf(c)`; `/api/models` follows the same gate.
- Run focused vitest batches, not the whole suite at once (documented Windows parallel-storage contention). `npx tsc --noEmit` must stay clean.

---

## File Structure

- **Create** `src/models-catalog.ts` — `CURATED_MODELS` constant, `CatalogModel` type, `buildLiveMap()`, `getModelCatalog()`. One responsibility: define and assemble the model catalog.
- **Modify** `src/types.ts` — add `visionModel?: string` to `LlmConfig`.
- **Modify** `src/validate.ts` — `validateLlmPayload` accepts `visionModel` (shape/length only).
- **Modify** `src/llm.ts:212` — `pickHeroImage` model resolution.
- **Modify** `src/index.ts` — add `GET /api/models`; add server-side vision rejection in `POST /api/llm`.
- **Modify** `src/console/page.ts` — five `<select>`s + browser JS that fetches `/api/models` and populates them.
- **Create** `tests/models-catalog.test.ts` — catalog mapping + fetch-failure fallback.
- **Modify** `tests/validate.test.ts` (or create if absent) — `visionModel` shape validation.
- **Modify** `tests/llm.test.ts` (or the file covering `pickHeroImage`) — model resolution order.
- **Existing** `tests/console.test.ts` — JS-parse guard, must stay green.

---

## Task 1: Curated catalog constant + types

**Files:**
- Create: `src/models-catalog.ts`
- Test: `tests/models-catalog.test.ts`

**Interfaces:**
- Produces: `CURATED_MODELS: readonly { slug: string; label: string; vision: boolean }[]`; `type CatalogModel = { slug: string; name: string; vision: boolean; promptPriceM: number | null; completionPriceM: number | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/models-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { CURATED_MODELS } from '../src/models-catalog';

describe('CURATED_MODELS', () => {
  it('has exactly 9 models incl. gemini-3.1-pro-preview, excludes opus/sonnet', () => {
    const slugs = CURATED_MODELS.map((m) => m.slug);
    expect(slugs).toHaveLength(9);
    expect(slugs).toContain('google/gemini-3.1-pro-preview');
    expect(slugs.some((s) => s.includes('opus') || s.includes('sonnet'))).toBe(false);
  });
  it('marks the two text-only models vision:false', () => {
    const bySlug = Object.fromEntries(CURATED_MODELS.map((m) => [m.slug, m.vision]));
    expect(bySlug['deepseek/deepseek-v4-flash']).toBe(false);
    expect(bySlug['qwen/qwen3.7-max']).toBe(false);
    expect(bySlug['anthropic/claude-haiku-4.5']).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/models-catalog.test.ts`
Expected: FAIL — cannot resolve `../src/models-catalog`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/models-catalog.ts
export type CatalogModel = {
  slug: string;
  name: string;
  vision: boolean;
  promptPriceM: number | null;
  completionPriceM: number | null;
};

export const CURATED_MODELS = [
  { slug: 'anthropic/claude-haiku-4.5',     label: 'Claude Haiku 4.5',         vision: true  },
  { slug: 'google/gemini-2.5-flash-lite',   label: 'Gemini 2.5 Flash Lite',    vision: true  },
  { slug: 'google/gemini-2.5-flash',        label: 'Gemini 2.5 Flash',         vision: true  },
  { slug: 'google/gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro (preview)', vision: true  },
  { slug: 'openai/gpt-5-mini',              label: 'GPT-5 mini',               vision: true  },
  { slug: 'mistralai/mistral-medium-3.5',   label: 'Mistral Medium 3.5',       vision: true  },
  { slug: 'moonshotai/kimi-k2.6',           label: 'Kimi K2.6',                vision: true  },
  { slug: 'deepseek/deepseek-v4-flash',     label: 'DeepSeek V4 Flash',        vision: false },
  { slug: 'qwen/qwen3.7-max',               label: 'Qwen3.7 Max',              vision: false },
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/models-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models-catalog.ts tests/models-catalog.test.ts
git commit -m "feat(llm): curated model catalog constant"
```

---

## Task 2: Live-catalog assembly (`buildLiveMap` + `getModelCatalog`)

**Files:**
- Modify: `src/models-catalog.ts`
- Test: `tests/models-catalog.test.ts`

**Interfaces:**
- Consumes: `TenantStore.getSearchCache(key): Promise<string|null>`, `TenantStore.putSearchCache(key, payload, ttlDays): Promise<void>`.
- Produces: `buildLiveMap(data: unknown): Map<string, { name: string; vision: boolean; promptPrice: number; completionPrice: number }>`; `getModelCatalog(store: TenantStore, fetchImpl?: typeof fetch): Promise<CatalogModel[]>`; `MODELS_CACHE_KEY = 'openrouter:models'`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/models-catalog.test.ts
import { buildLiveMap, getModelCatalog, MODELS_CACHE_KEY } from '../src/models-catalog';

const OR_RESPONSE = {
  data: [
    { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5',
      architecture: { input_modalities: ['text', 'image'] },
      pricing: { prompt: '0.000001', completion: '0.000005' } },
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash',
      architecture: { input_modalities: ['text'] },
      pricing: { prompt: '0.0000002', completion: '0.0000004' } },
  ],
};

function fakeStore() {
  const mem = new Map<string, string>();
  return {
    getSearchCache: async (k: string) => mem.get(k) ?? null,
    putSearchCache: async (k: string, p: string) => { mem.set(k, p); },
  } as any;
}

describe('buildLiveMap', () => {
  it('maps modalities to vision and prices to per-token numbers', () => {
    const m = buildLiveMap(OR_RESPONSE);
    expect(m.get('anthropic/claude-haiku-4.5')!.vision).toBe(true);
    expect(m.get('deepseek/deepseek-v4-flash')!.vision).toBe(false);
    expect(m.get('anthropic/claude-haiku-4.5')!.promptPrice).toBeCloseTo(0.000001);
  });
});

describe('getModelCatalog', () => {
  it('enriches curated models with live price ($/M) + vision; unknown slug → null price, static vision', async () => {
    const store = fakeStore();
    const fetchImpl = (async () => new Response(JSON.stringify(OR_RESPONSE), { status: 200 })) as any;
    const out = await getModelCatalog(store, fetchImpl);
    expect(out).toHaveLength(9);
    const haiku = out.find((m) => m.slug === 'anthropic/claude-haiku-4.5')!;
    expect(haiku.promptPriceM).toBeCloseTo(1.0);     // 0.000001 * 1e6
    expect(haiku.completionPriceM).toBeCloseTo(5.0);
    expect(haiku.vision).toBe(true);
    const gemini = out.find((m) => m.slug === 'google/gemini-3.1-pro-preview')!;
    expect(gemini.promptPriceM).toBeNull();          // not in mock → null
    expect(gemini.vision).toBe(true);                // static hint preserved
  });

  it('never throws on fetch failure → curated fallback with null prices', async () => {
    const store = fakeStore();
    const fetchImpl = (async () => { throw new Error('network'); }) as any;
    const out = await getModelCatalog(store, fetchImpl);
    expect(out).toHaveLength(9);
    expect(out.every((m) => m.promptPriceM === null)).toBe(true);
    expect(out.find((m) => m.slug === 'qwen/qwen3.7-max')!.vision).toBe(false);
  });

  it('uses cache on the second call (no second fetch)', async () => {
    const store = fakeStore();
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify(OR_RESPONSE), { status: 200 }); }) as any;
    await getModelCatalog(store, fetchImpl);
    await getModelCatalog(store, fetchImpl);
    expect(calls).toBe(1);
    expect(await store.getSearchCache(MODELS_CACHE_KEY)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/models-catalog.test.ts`
Expected: FAIL — `buildLiveMap`/`getModelCatalog`/`MODELS_CACHE_KEY` not exported.

- [ ] **Step 3: Implement**

```ts
// append to src/models-catalog.ts
import type { TenantStore } from './tenant-store';

export const MODELS_CACHE_KEY = 'openrouter:models';
const CACHE_TTL_DAYS = 1;

type LiveModel = { name: string; vision: boolean; promptPrice: number; completionPrice: number };

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/models-catalog.test.ts` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/models-catalog.ts tests/models-catalog.test.ts
git commit -m "feat(llm): live OpenRouter catalog assembly with 24h cache"
```

---

## Task 3: `visionModel` config field + shape validation

**Files:**
- Modify: `src/types.ts` (LlmConfig)
- Modify: `src/validate.ts` (`validateLlmPayload`)
- Test: `tests/validate.test.ts`

**Interfaces:**
- Consumes: existing `LlmConfig`, `MODEL_SLUG` regex in `validate.ts`.
- Produces: `LlmConfig.visionModel?: string`; `validateLlmPayload` echoes `visionModel` when present and valid.

- [ ] **Step 1: Write the failing test**

```ts
// tests/validate.test.ts (add cases; create file with imports if absent)
import { describe, it, expect } from 'vitest';
import { validateLlmPayload } from '../src/validate';

const base = { enabled: true, model: 'anthropic/claude-haiku-4.5', scoreThreshold: 50 };

describe('validateLlmPayload visionModel', () => {
  it('accepts a valid visionModel slug', () => {
    const v = validateLlmPayload({ ...base, visionModel: 'google/gemini-2.5-flash' });
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.visionModel).toBe('google/gemini-2.5-flash');
  });
  it('omits visionModel when empty string', () => {
    const v = validateLlmPayload({ ...base, visionModel: '' });
    expect(v.ok && 'visionModel' in v.value).toBe(false);
  });
  it('rejects a malformed visionModel', () => {
    const v = validateLlmPayload({ ...base, visionModel: 'not a slug!!' });
    expect(v.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/validate.test.ts` → FAIL (visionModel not echoed / not rejected).

- [ ] **Step 3: Implement**

In `src/types.ts`, add to `LlmConfig` (next to `curationModel`):
```ts
  visionModel?: string;
```

In `src/validate.ts` `validateLlmPayload`, extend the optional-model loop and the returned value:
```ts
  for (const k of ['curationModel', 'digestModel', 'visionModel'] as const) {
    if (b[k] !== undefined && b[k] !== '' && (typeof b[k] !== 'string' || (b[k] as string).length > 100 || !MODEL_SLUG.test(b[k] as string))) {
      return { ok: false, error: `${k} must be an OpenRouter model slug` };
    }
  }
  return {
    ok: true,
    value: {
      enabled: b.enabled,
      model: b.model,
      scoreThreshold: b.scoreThreshold as number,
      ...(b.curationModel ? { curationModel: b.curationModel as string } : {}),
      ...(b.digestModel ? { digestModel: b.digestModel as string } : {}),
      ...(b.visionModel ? { visionModel: b.visionModel as string } : {})
    }
  };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/validate.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/validate.ts tests/validate.test.ts
git commit -m "feat(llm): visionModel config field + shape validation"
```

---

## Task 4: `pickHeroImage` resolves visionModel first

**Files:**
- Modify: `src/llm.ts:212`
- Test: `tests/llm.test.ts` (the file covering `pickHeroImage`; create a focused one if absent)

**Interfaces:**
- Consumes: `LlmConfig.visionModel` (Task 3).
- Produces: vision call uses `cfg.llm.visionModel ?? cfg.llm.curationModel ?? cfg.llm.model`.

- [ ] **Step 1: Write the failing test** — assert the model passed to the LLM call. Stub `LlmClient.json` to capture `args.model`:

```ts
// tests/llm.test.ts (focused)
import { describe, it, expect } from 'vitest';
import { pickHeroImage } from '../src/llm';

function stubLlm(capture: { model?: string }) {
  return {
    available: true,
    json: async (args: any) => { capture.model = args.model; return { ok: true, value: { index: 0, drop: [], reason: 'x' } }; },
  } as any;
}
const cfg = (llm: any) => ({ llm: { enabled: true, ...llm } } as any);
const store = {} as any;

describe('pickHeroImage model resolution', () => {
  it('prefers visionModel over curationModel and model', async () => {
    const cap: { model?: string } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({ model: 'm/base', curationModel: 'm/cur', visionModel: 'm/vis' }), 'Dog bed', ['a', 'b']);
    expect(cap.model).toBe('m/vis');
  });
  it('falls back to curationModel when visionModel unset', async () => {
    const cap: { model?: string } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({ model: 'm/base', curationModel: 'm/cur' }), 'Dog bed', ['a', 'b']);
    expect(cap.model).toBe('m/cur');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/llm.test.ts` → FAIL on the first case (`m/cur` returned, not `m/vis`).

- [ ] **Step 3: Implement** — change `src/llm.ts:212`:
```ts
  const model = cfg.llm.visionModel ?? cfg.llm.curationModel ?? cfg.llm.model;
```
(Only `pickHeroImage`'s resolution — leave the two non-vision call sites at lines ~127 and ~265 unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/llm.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts tests/llm.test.ts
git commit -m "feat(llm): pickHeroImage prefers visionModel"
```

---

## Task 5: `GET /api/models` endpoint + server-side vision rejection in `POST /api/llm`

**Files:**
- Modify: `src/index.ts`
- Test: `tests/api-models.test.ts` (or extend an existing index/integration test)

**Interfaces:**
- Consumes: `getModelCatalog` (Task 2), `shopOf` (existing), `validateLlmPayload` (Task 3), `TenantStore`.
- Produces: `GET /api/models` → `{ ok: true, models: CatalogModel[] }`; `POST /api/llm` rejects a text-only `visionModel` with `{ ok:false, error:'Selected image model is text-only and cannot process images' }`.

- [ ] **Step 1: Write the failing test** — focused on the rejection helper. To keep the test pure (no session-token mint), extract the check into a small exported helper and test it directly:

```ts
// tests/api-models.test.ts
import { describe, it, expect } from 'vitest';
import { visionModelRejected } from '../src/index';
import type { CatalogModel } from '../src/models-catalog';

const cat: CatalogModel[] = [
  { slug: 'm/vis', name: 'V', vision: true,  promptPriceM: 1, completionPriceM: 2 },
  { slug: 'm/txt', name: 'T', vision: false, promptPriceM: 1, completionPriceM: 2 },
];

describe('visionModelRejected', () => {
  it('rejects a catalog model marked vision:false', () => {
    expect(visionModelRejected('m/txt', cat)).toBe(true);
  });
  it('allows a vision model', () => {
    expect(visionModelRejected('m/vis', cat)).toBe(false);
  });
  it('allows an unknown slug or unset (defense-in-depth, UI already constrained)', () => {
    expect(visionModelRejected('m/unknown', cat)).toBe(false);
    expect(visionModelRejected(undefined, cat)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/api-models.test.ts` → FAIL (`visionModelRejected` not exported).

- [ ] **Step 3: Implement** in `src/index.ts`:

Add the import near the other imports:
```ts
import { getModelCatalog, type CatalogModel } from './models-catalog';
```

Add the exported helper (top-level):
```ts
export function visionModelRejected(slug: string | undefined, catalog: CatalogModel[]): boolean {
  if (!slug) return false;
  const m = catalog.find((c) => c.slug === slug);
  return m ? m.vision === false : false; // unknown slug → allow (UI already constrained)
}
```

Add the endpoint (next to the other `/api/*` routes):
```ts
app.get('/api/models', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  return c.json({ ok: true, models: await getModelCatalog(store) });
});
```

Wire the rejection into `POST /api/llm` (after `validateLlmPayload` passes, before `saveLlm`):
```ts
  const v = validateLlmPayload(body);
  if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
  if (v.value.visionModel) {
    const store = new TenantStore(c.env.DB, s);
    const catalog = await getModelCatalog(store);
    if (visionModelRejected(v.value.visionModel, catalog)) {
      return c.json({ ok: false, error: 'Selected image model is text-only and cannot process images' }, 400);
    }
  }
  await saveLlm(c.env.DB, s, v.value);
```
(Confirm `TenantStore` is already imported in `index.ts`; it is used by other routes.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/api-models.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/api-models.test.ts
git commit -m "feat(llm): GET /api/models + server-side vision rejection"
```

---

## Task 6: Console UI — five dropdowns populated from `/api/models`

**Files:**
- Modify: `src/console/page.ts`
- Test: `tests/console.test.ts` (existing JS-parse guard must stay green)

**Interfaces:**
- Consumes: `GET /api/models` (Task 5), existing console fetch helper + auth token plumbing already used by other `/api/*` calls.
- Produces: five `<select>` elements — `#llmmodel`, `#llm-curation-model`, `#llm-vision-model` (NEW), `#inbox-classify-model`, `#inbox-reply-model` — populated on load; image-model select limited to vision models.

> **CRITICAL:** every newline inside embedded browser-JS strings is `\\n`, backticks are escaped, and `${...}` not meant for the outer literal is escaped. Run `tests/console.test.ts` after every edit.

- [ ] **Step 1: Replace the four free-text model inputs with `<select>`s and add the image-model select.** Locate the current `#llmmodel`, `#inbox-classify-model`, `#inbox-reply-model` inputs (and add `#llm-curation-model`, `#llm-vision-model`). Each becomes:
```html
<select id="llmmodel"></select>
```
Place `#llm-vision-model` beside `#llm-curation-model` with a label "Image (vision) model".

- [ ] **Step 2: Add the populate function in the embedded browser JS** (remember `\\n`):
```js
async function loadModelOptions(){
  var r = await api('/api/models', null, 'GET');           // reuse existing api() helper; pass GET
  var models = (r && r.models) || [];
  function opt(m){
    var price = (m.promptPriceM==null) ? 'price n/a'
      : ('$'+m.promptPriceM+'/M in \\u00b7 $'+m.completionPriceM+'/M out');
    return '<option value="'+m.slug+'">'+m.name+' \\u2014 '+price+(m.vision?' \\u00b7 \\ud83d\\udc41':'')+'</option>';
  }
  var all = models.map(opt).join('');
  var visionOnly = models.filter(function(m){return m.vision;}).map(opt).join('');
  ['llmmodel','llm-curation-model','inbox-classify-model','inbox-reply-model'].forEach(function(id){
    var el = document.getElementById(id); if(el){ el.innerHTML = all; }
  });
  var vel = document.getElementById('llm-vision-model'); if(vel){ vel.innerHTML = visionOnly; }
  preserveSaved(models);   // see Step 3
}
```

- [ ] **Step 3: Preserve a saved slug not in the curated list** — after populating, for each select read its saved value from the loaded config; if the value is not among the options, prepend `<option value="SAVED" selected>SAVED (current)</option>`. Then set each select's value to the saved config value. Implement `preserveSaved(models)` to read the same config object the console already loads for the LLM card and call `setSelected(id, savedSlug, models)` per field.

- [ ] **Step 4: Call `loadModelOptions()` where the LLM/inbox settings card initializes**, and ensure Save reads `.value` from the selects (the save payload already sends `model`/`curationModel`/`classifyModel`/`replyModel`; add `visionModel` from `#llm-vision-model`).

- [ ] **Step 5: Run the JS-parse guard + tsc**

Run: `npx vitest run tests/console.test.ts` → PASS (no syntax error in the inline script).
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/console/page.ts
git commit -m "feat(llm): console model dropdowns with pricing + vision filter"
```

---

## Task 7: Whole-feature verification

**Files:** none (verification only)

- [ ] **Step 1:** Run the focused batch: `npx vitest run tests/models-catalog.test.ts tests/validate.test.ts tests/llm.test.ts tests/api-models.test.ts tests/console.test.ts` → all PASS.
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** Manual sanity (optional, post-deploy): open the console, confirm five dropdowns populate with prices, the image-model dropdown shows only vision models (👁), and saving a text-only model in the image field is rejected by the server (force via devtools).
- [ ] **Step 4:** Do NOT deploy in this plan — deployment is a separate merchant-go step (the worker carries other undeployed commits; cutover is coordinated).

---

## Self-Review (completed at authoring)

- **Spec coverage:** §3 five fields → Tasks 3/6; §4 catalog+endpoint → Tasks 1/2/5; §5 schema+pickHeroImage → Tasks 3/4; §6 two-layer vision filter → Task 6 (UI) + Task 5 (server); §9 tests → each task's tests. `digestModel` UI correctly omitted (§11).
- **Placeholder scan:** none — every code step carries real code.
- **Type consistency:** `CatalogModel` shape identical across Tasks 1/2/5; `promptPriceM`/`completionPriceM` are `number|null` everywhere; `visionModel?: string` consistent in types/validate/llm.
- **Open risk flagged for implementer:** the console `api()` helper's exact signature (does it accept a GET method arg?) must be confirmed in Task 6 Step 2 against `src/console/page.ts`; if it is POST-only, add a tiny GET branch rather than forcing POST.
