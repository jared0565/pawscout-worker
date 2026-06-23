# Selectable LLM Models (with pricing + vision filter) - Design

**Date:** 2026-06-19
**Repo:** `pawscout-worker` (console UI, config, validation, a new catalog endpoint). No theme changes.

---

## 1. Goal

Every LLM-model setting in the PawScout console becomes a **dropdown** the merchant selects from a curated shortlist of ~9 models, **with live pricing shown** per option. A capability **filter** guarantees a **text-only model can never be selected for the image (vision) task** (hero-image QA).

## 2. Current state (what exists today)

Model settings live in `TenantConfig`:

| Config key | Drives | Modality | Console field today |
|---|---|---|---|
| `llm.model` | keyword classify + fallback for all tasks | text | `#llmmodel` (free-text input) |
| `llm.curationModel` *(optional, falls back to `model`)* | product curation, descriptions | text **and** hero-image QA | none |
| `inbox.classifyModel` | email triage | text | `#inbox-classify-model` (free-text) |
| `inbox.replyModel` | reply + invoice drafts | text | `#inbox-reply-model` (free-text) |
| `llm.digestModel` *(optional)* | - **validated/stored but UNUSED** by any LLM call | - | none |

The **only** vision call is hero-image QA - `pickHeroImage` in `src/llm.ts` (~line 212), which sends image URLs and currently resolves `cfg.llm.curationModel ?? cfg.llm.model`. So a text-only model in `curationModel`/`model` would silently break image QA. PS calls OpenRouter via `LlmClient` (`src/llm.ts`), so every usable model is an OpenRouter slug.

## 3. The model fields → dropdowns

Five settings become `<select>` dropdowns (each option shows pricing + a vision marker - see §6):

| Setting | Config key | Dropdown contents |
|---|---|---|
| Base / default model | `llm.model` | all curated models |
| Curation model | `llm.curationModel` | all curated models |
| **Image (vision) model** *(NEW field)* | `llm.visionModel` | **vision-capable curated models only** |
| Inbox classify model | `inbox.classifyModel` | all curated models |
| Inbox reply model | `inbox.replyModel` | all curated models |

`digestModel` gets **no UI** (dead config - out of scope, §11). The currently-saved slug for any field is **always preserved** as a selected option even if it is not in the curated list, so converting free-text → dropdown never silently changes a tenant's config.

## 4. Model catalog

### 4.1 Curated list (a worker constant - easily editable)

`src/models-catalog.ts` exports `CURATED_MODELS: { slug: string; label: string; vision: boolean }[]`. The `vision` flag is a **static hint** (used as the fallback / when the live lookup misses); it is corrected from live data when available. Selection is **ACCURACY-first (price secondary)** per the merchant, validated against the live OpenRouter catalog + an adversarial ranking workflow (2026-06-19). Claude **Opus** is excluded (cost); Claude **Sonnet 4.6** is included as the claim-safety accuracy ceiling; `gemini-3.1-pro-preview` is merchant-mandated. Ordered premium → workhorse; 9 of 10 are vision-capable:

```ts
export const CURATED_MODELS = [
  { slug: 'google/gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro (preview)', vision: true  }, // REQUIRED; top multimodal
  { slug: 'openai/gpt-5.2',                 label: 'GPT-5.2',                  vision: true  }, // frontier text, lowest hallucination
  { slug: 'anthropic/claude-sonnet-4.6',    label: 'Claude Sonnet 4.6',        vision: true  }, // claim-safety ceiling (pet-health copy)
  { slug: 'x-ai/grok-4.3',                  label: 'Grok 4.3',                 vision: true  }, // frontier mid-tier workhorse
  { slug: 'google/gemini-3.5-flash',        label: 'Gemini 3.5 Flash',         vision: true  }, // fast, native structured output
  { slug: 'openai/gpt-5-mini',              label: 'GPT-5 mini',               vision: true  }, // reliable JSON classify
  { slug: 'google/gemini-2.5-flash',        label: 'Gemini 2.5 Flash',         vision: true  }, // cheap vision+text workhorse
  { slug: 'google/gemini-3.1-flash-lite',   label: 'Gemini 3.1 Flash Lite',    vision: true  }, // low-hallucination cheap curation
  { slug: 'anthropic/claude-haiku-4.5',     label: 'Claude Haiku 4.5',         vision: true  }, // cheap reply default
  { slug: 'deepseek/deepseek-v4-pro',       label: 'DeepSeek V4 Pro',          vision: false }, // ultra-cheap text triage floor
] as const;
```

> **Implementation note:** these exact slugs MUST be validated against the live OpenRouter catalog during implementation (slugs drift). Any slug the live catalog confirms keeps its live pricing + vision; any it lacks still surfaces using the static hint with pricing shown as `n/a`. This is what guarantees `gemini-3.1-pro-preview` always appears even if OpenRouter hasn't listed the preview yet.

### 4.2 Endpoint: `GET /api/models` (console-gated, like other `/api/*`)

1. Read cache key `openrouter:models` from D1 (`getSearchCache`). If present and fresh, use it.
2. Else `fetch('https://openrouter.ai/api/v1/models')`, build a `Map<slug, { name, vision, promptPrice, completionPrice }>` where `vision = architecture.input_modalities?.includes('image')`, `promptPrice = Number(pricing.prompt)`, `completionPrice = Number(pricing.completion)` (per-token USD). Cache the *built map* for **24h** (`putSearchCache(..., 1 day)`).
3. For each `CURATED_MODELS` entry, emit `{ slug, name: live?.name ?? label, vision: live?.vision ?? staticVision, promptPriceM: live ? promptPrice*1e6 : null, completionPriceM: live ? completionPrice*1e6 : null }` (prices converted to **$/million tokens**, `null` when unknown).
4. Return `{ ok: true, models: [...] }`. On any fetch/parse failure, return the curated list with `promptPriceM/completionPriceM = null` and the static `vision` flag - **never error** (dropdowns must always populate).

## 5. Config schema change

`LlmConfig` gains `visionModel?: string` (`src/types.ts`). `DEFAULT_LLM` leaves it unset (falls back). Hero-image QA changes its model resolution to:

```ts
const model = cfg.llm.visionModel ?? cfg.llm.curationModel ?? cfg.llm.model;
```

in `pickHeroImage` (`src/llm.ts`) - the **only** edit to a vision call. `validateLlm` (`src/validate.ts`) accepts `visionModel` as an optional model string (shape/length check only, like `curationModel`). The vision-*capability* check (§6) is NOT in the pure `validateLlm` - it needs the cached catalog, so it runs in the config-save route which has `c.env.DB`.

## 6. Vision filter - enforced in two layers

**UI (primary).** The Image-model `<select>` is built only from curated models where `vision === true`. The other four selects use all curated models. Each option label:
```
{name} - ${promptPriceM}/M in · ${completionPriceM}/M out{ · 👁}
```
e.g. `Claude Haiku 4.5 - $1.00/M in · $5.00/M out · 👁`. When price is `null`: show `price n/a`. The `· 👁` suffix appears for vision models.

**Server (defense-in-depth).** In the config-save route (which has `c.env.DB` → the cached catalog map), if `visionModel` is set, look it up; if found AND `vision === false`, **reject**: `{ ok:false, error:'Selected image model is text-only and cannot process images' }`. If the model is absent from the catalog OR the catalog is unavailable, **allow** (the UI already constrained it) and `console.warn`. This blocks a text-only image model even if the UI is bypassed, without hard-failing on catalog gaps.

## 7. Data flow

```
Console load → GET /api/models → {models:[{slug,name,vision,promptPriceM,completionPriceM}]}
  → build ALL-options + VISION-options
  → render 5 selects (saved slug preserved as selected, even if not curated)
Merchant picks → Save config → validateLlm (rejects text-only visionModel) → stored
Hero-image QA → cfg.llm.visionModel ?? curationModel ?? model
```

## 8. Error handling / resilience

- OpenRouter unreachable → `/api/models` returns curated list, prices `null`, static vision flags. UI works; vision filter still correct (static flags).
- A saved model not in the curated list → preserved as a selected `<option>` (no silent change).
- Catalog cache is per-shop-agnostic (model list is global); 24h TTL bounds staleness and OpenRouter calls.

## 9. Testing

Worker unit tests (`tests/`):
1. `/api/models` maps a **mocked** OpenRouter response: a vision model (`input_modalities:['text','image']`) → `vision:true`; a text model → `vision:false`; prices converted to $/M; a curated slug absent from the mock → surfaces with `null` price + static vision.
2. Fetch failure → endpoint returns curated fallback, no throw.
3. `validateLlm` **rejects** a `visionModel` that the cached catalog marks `vision:false`; **allows** one marked `vision:true`; **allows** an unknown slug.
4. `pickHeroImage` resolves `visionModel` ahead of `curationModel`/`model` (assert the model passed to the LLM call).

Console template stays covered by the existing `tests/console.test.ts` JS-parse guard.

## 10. UX

Native `<select>` (≤9 options; type-ahead works), no custom combobox. The five selects sit in their existing console locations (base/curation near the LLM/curation card; image model added beside curation; classify/reply in the inbox-settings card).

## 11. Out of scope (YAGNI)

- `digestModel` UI (dead config - not wired to any call).
- Full 300-model OpenRouter catalog / search box (curated 9 instead).
- Custom combobox / free-text model entry (would bypass the vision filter).
- Per-model cost estimation or usage-based ranking.
