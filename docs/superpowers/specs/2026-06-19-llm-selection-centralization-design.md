# LLM Selection Centralization — Design

**Date:** 2026-06-19
**Status:** Draft for review
**Scope:** In-house (single-tenant, Active Paw). Multi-tenant / SaaS provisioning is an explicit deferred follow-on (see §11).

## Goal

Make the PawScout dashboard the single source of truth for which LLM the worker uses. A merchant picks an **Image** model, a **Text** model, and a **Fallback** model in one place at the top of the dashboard; every LLM call resolves its model from those selections. A system-owned, cross-provider **default** (`gpt-5.4-mini` on the OpenAI API direct) is the unbreakable last resort. **No model slug appears in business logic** — the only slug literals that remain are the selectable menu (`models-catalog.ts`) and the one deliberate default constant.

## Why (the failure model that shaped this)

LLM calls fail in two ways:
- **Correlated / global** — OpenRouter down, key revoked, account out of credits. *Every* OpenRouter-routed model fails identically; no OpenRouter model can rescue it. Defended by (a) a default on a **different provider** (OpenAI direct) and (b) the existing **no-LLM degradation** (mechanical gates / keep current image) as the true floor.
- **Independent / model-specific** — a slug is delisted/typo'd, one model is briefly down, or a model returns junk (the prose-wrapped-JSON we hit with `gemini-3.1-pro-preview`). Defended by a fallback model and, for the JSON case, the existing `extractJson` + same-tier retry.

The third tier earns its place **only because it is system-guaranteed and on a different provider** — a user can't break it with a typo, and it survives an OpenRouter outage.

---

## 1. Two roles, and the full call-site map

Every model-bearing call funnels through `LlmClient.json()` (`src/llm.ts:53`). There are exactly **8** API call sites (verified exhaustive by a transport-bounded census). Each maps to one of two roles:

| Call site | File | Role |
|---|---|---|
| `pickHeroImage` (the **only** vision call) | `src/llm.ts:241` | **image** |
| `curateProduct` | `src/llm.ts:156` | text |
| `rewriteDescription` | `src/llm.ts:298` | text |
| `classifyKeyword` | `src/llm.ts:353` | text |
| `cleanToPetTerms` | `src/semantic/library.ts:81` | text |
| `classifyEmail` | `src/inbox/classify.ts:24` | text |
| `draftReply` | `src/inbox/draft.ts:35` | text |
| `proposeInvoice` | `src/inbox/propose-invoice.ts:34` | text |

Plus one **record-keeping** resolution (not an API call): `sweep.ts:286` resolves the reply model to stamp the draft row — must be updated to record the resolved text model.

**`image` = vision only (`pickHeroImage`). `text` = everything else.**

## 2. Config shape

Introduce a dedicated model registry; retain the behavioral knobs.

```ts
// NEW — the single source of truth for model selection
interface ModelsConfig {
  image?: string;     // OpenRouter slug; blank → omitted from the OpenRouter request
  text?: string;      // OpenRouter slug; blank → omitted
  fallback?: string;  // OpenRouter slug; blank → omitted
}

// RETAINED behavioral knobs — these are NOT model slugs and must survive.
interface LlmConfig {
  enabled: boolean;        // degradation gate, read by every business fn
  scoreThreshold: number;  // admission relevance floor
  // REMOVED: model, curationModel, visionModel, digestModel (slug fields)
}
```

- **`DEFAULT_MODEL`** — the one deliberate constant: `{ provider: 'openai', slug: 'gpt-5.4-mini' }`. Plus its pinned price (see §6): `DEFAULT_MODEL_PRICE = { promptPerM: 0.75, completionPerM: 4.50 }` (USD/1M tokens). Not user-editable, not in the catalog.
- `digestModel` is **dead config** (declared + validated + persisted, zero consumers) — removed from `LlmConfig` and `validateLlmPayload`'s optional-model loop.

## 3. Resolution chain & tier policy

Per role, the chain is **two hops**, then graceful degradation:

```
HOP 1 — OpenRouter, ONE request with models:[primary, fallback] (blanks/dupes removed):
          image: models:[models.image, models.fallback]
          text : models:[models.text,  models.fallback]
        OpenRouter natively fails over primary→fallback on hard errors and
        returns the served model in response.model.
HOP 2 — OpenAI DIRECT: DEFAULT_MODEL (gpt-5.4-mini) at api.openai.com.
FLOOR — no-LLM: curation→mechanical gates; hero-pick→keep current image (already exists).
```

Collapsing tiers 1+2 into OpenRouter's native `models:[]` array (one HTTP round-trip) is what keeps the cross-tier cost bounded — there is no longer a separate hand-rolled tier per model.

**Tier-advance policy (failure taxonomy):**

| Outcome | Action |
|---|---|
| Transport throw / HTTP 5xx / 503 overloaded / 429 `rate_limit_exceeded` | **Same-hop retry once**, then advance to next hop |
| HTTP 401 / 403 / 404 / 429 `insufficient_quota` (hard, non-retryable) | **Advance to next hop** immediately |
| HTTP 400 `invalid_request_error` (request-shape bug — identical on every hop) | **Stop, degrade** (do not advance; every hop returns the same 400) |
| 200 but parse/validation fails (e.g. prose-JSON) | **Same-hop retry once** (existing `extractJson` path); if still bad, **advance once** (a different provider may emit valid JSON — our actual gemini case); if HOP 2 also fails validation, **stop, degrade** |
| 200 but empty content + `finish_reason:"length"` (reasoning starved output) | Treat as parse failure on HOP 1; on HOP 2 it is mitigated by §4 (reasoning_effort + raised cap) |

Worst case per item: ~2 OpenRouter attempts + ~2 OpenAI attempts = 4 paid calls before degrading — not the 6× of three independent hand-rolled tiers.

## 4. Provider-aware `LlmClient`

`json()` (and a new internal chain walker) become provider-aware. The constructor takes **both** keys.

```ts
new LlmClient({ openrouterKey, openaiKey }, fetchImpl?)
```

Each hop carries `{ provider: 'openrouter' | 'openai', model }`. Request building branches on `provider`:

| Aspect | OpenRouter (hops 1+2 primary/fallback) | OpenAI direct (default) |
|---|---|---|
| URL | `https://openrouter.ai/api/v1/chat/completions` | `https://api.openai.com/v1/chat/completions` |
| Auth | `Bearer <openrouterKey>` + `HTTP-Referer`/`X-Title` | `Bearer <openaiKey>` (drop Referer/X-Title) |
| Model field | `models: [primary, fallback]` (array) | `model: "gpt-5.4-mini"` (single) |
| Token cap | `max_tokens` | **`max_completion_tokens`** |
| `usage:{include:true}` | present (OpenRouter cost) | **removed** (OpenAI rejects it) |
| `reasoning_effort` | n/a | **`'medium'`** (uniform), with cap floored (see below) |
| `temperature` | omitted (unchanged) | omitted — GPT-5 reasoning models 400 on any non-default |
| `response_format` | `{type:'json_object'}` | `{type:'json_object'}` (identical) |
| Images | `image_url` content parts | **identical** — `image_url` parts, remote URL works |
| Cost | `data.usage.cost` | **computed** from tokens × `DEFAULT_MODEL_PRICE` |

**Reasoning-token guard (critical):** `gpt-5.4-mini` is a reasoning model; `max_completion_tokens` bounds reasoning **plus** visible output. The small caps (`pickHeroImage` 200, `classifyKeyword` 300) would be consumed by reasoning, yielding empty content. For the OpenAI hop: set `reasoning_effort: 'medium'` (the chosen quality/latency point for a rarely-fired floor) and floor the cap at **`max_completion_tokens = max(requested, 3000)`** — generous headroom so medium's deeper reasoning cannot starve the visible output. (Validated live at `'low'`+1500 with `finish_reason:"stop"`; the build-time A/B re-confirms `'stop'` holds at `'medium'`+3000 on real curation/hero prompts and can dial a role to `'high'` via config if output ever weakens during an outage.)

**Availability (must be provider-aware):**
- `llm.available` → `true` if **either** key is present.
- The chain walker skips HOP 1 when `openrouterKey` is absent, and skips HOP 2 when `openaiKey` is absent. (In-house: both set.)
- The per-call `!this.apiKey` early-return in `json()` (`llm.ts:61`) is replaced by this per-hop key check — otherwise a missing OpenRouter key short-circuits before the OpenAI default is tried.

**Served-model logging:** `usage.model` records `response.model` (the model OpenRouter actually used) for OpenRouter hops, and `gpt-5.4-mini` for the OpenAI hop — not the requested primary.

## 5. Inbox subsystem absorption

The inbox carries its **own** persisted model selectors — this must be fully absorbed or the goal is unmet.

- **Re-route** `classifyEmail`, `draftReply`, `proposeInvoice`, and the `sweep.ts` record-keeping site to resolve via the **text** role chain (no more `cfg.inbox.classifyModel/replyModel`).
- **Remove** `classifyModel` and `replyModel` from `InboxConfig` and `DEFAULT_INBOX` (`src/inbox/types.ts:33,36`). Keep them only as **read-side migration sources** (§7), never as live config.
- **Fix `validateInboxPayload`** (`src/validate.ts:241`): stop emitting `replyModel: replyModel ?? DEFAULT_INBOX.replyModel` and stop accepting `classifyModel`. An inbox save must persist **no** model slug.

## 6. Observability & cost

- **Compute tier-3 cost:** `costUsd = prompt_tokens/1e6 × 0.75 + completion_tokens/1e6 × 4.50`, so `logLlmUsage` and the console "$X (30 days)" line are not blind during the very outage that triggers the OpenAI hop.
- **Tier-3 activation signal:** whenever HOP 2 (OpenAI direct) serves a call, emit a distinct log/metric — it means *both* OpenRouter slots failed, i.e. OpenRouter is degraded. This is an operational incident, not a silent success.
- **No hard spend ceiling** in this iteration (single-tenant) — explicitly documented as accepted; a per-window owner alert is the mitigation. A real ceiling is deferred (§11).

## 7. Read-side migration

`getConfig`'s `{...DEFAULT, ...JSON.parse(row.x || '{}')}` merge has no "absent" state. Fix with a **null sentinel**:

- Store the `models` column as **SQL NULL** until the first explicit save (not `'{}'`).
- In `getConfig`, when `row.models` is NULL, **derive** (preserving today's effective behavior) and do **not** persist until the merchant saves:
  - `image    = visionModel ?? curationModel ?? model`  ← preserves the current `pickHeroImage` chain; a blank-`visionModel` tenant keeps using its base model on OpenRouter, **not** silently moving to OpenAI.
  - `text     = curationModel ?? model`
  - `fallback = model`  ← the legacy base; guarantees the OpenRouter `models:[]` fallback slot is non-empty (deduped against the primary).
- Legacy slug fields (`llm.model/curationModel/visionModel/digestModel`, `inbox.classifyModel/replyModel`) are read **only** here, then ignored. `enabled` and `scoreThreshold` are **not** touched.

## 8. Dashboard UI — one block, one place

- A single **"AI models"** block directly **below the Connected field**, the **only** place LLM selection appears:
  - **Image model** (select; vision-capable options only)
  - **Text model** (select; all catalog options)
  - **Fallback model** (select; vision-capable options only — see §10 coupling note)
  - read-only line: *"Last resort: GPT‑5.4 mini · OpenAI direct"*
- **Removed entirely:** `#llmmodel`, `#llmcuration`, `#llmvision` in the LLM panel; `#inbox-reply-model`, `#inbox-classify-model` in the inbox panel; and the two **browser-JS hardcoded fallbacks** at `page.ts:1390,1391`.

## 9. Validation

- The existing `/api/llm` endpoint is repurposed to accept `{ models: {image, text, fallback}, enabled, scoreThreshold }`; `/api/inbox` no longer accepts any model field. Validation of the three selections:
  - Each must be **in the curated catalog** (allowlist), not merely slug-shaped — so a typo'd/delisted primary is rejected loudly at save instead of silently cascading to fallback and masquerading as resilience.
  - **Image** and **Fallback** must be vision-capable (reuse `visionModelRejected`, `src/index.ts:56`).
  - All three optional (blank → omitted from the request; chain falls through).
- The default (`gpt-5.4-mini`) is system-set, never validated against the catalog (it isn't in it by design).

## 10. Error handling summary

- The system **never throws into a job** — every exhausted chain degrades to no-LLM (mechanical gates / keep current image), exactly as today.
- Failure taxonomy per §3; provider-specific status handling per §4.

## Testing

- **Resolver:** chain order; blanks dropped; dedupe primary==fallback; image/text role mapping.
- **Provider routing (mocked fetch):** OpenRouter hop sends `models:[]` + `max_tokens` + `usage:{include:true}`; OpenAI hop sends single `model` + `max_completion_tokens` + `reasoning_effort:'medium'` + no `usage` field + correct URL/key/headers.
- **Tier walk:** hops 1+2 forced to fail → OpenAI hop serves; 400 invalid_request → stop (no advance); 429 insufficient_quota → advance; 429 rate_limit → retry then advance; parse-fail on OpenRouter → advance once → validation-fail on OpenAI → degrade.
- **Reasoning guard:** small-cap OpenAI call floors `max_completion_tokens` at 3000 and sets `reasoning_effort:'medium'`; assert `finish_reason !== 'length'` / non-empty content.
- **Effort A/B (build-time):** low vs medium on real catalog products (titles + image sets) — measure format adherence, agreement with the primary model, tokens, latency; confirm medium does not truncate at the 3000 floor.
- **Cost:** OpenAI hop logs non-zero `costUsd` from pinned price; tier-3 activation emits its signal.
- **Migration:** NULL `models` + populated legacy `llm` → derived `{image,text,fallback}` with `image == previously-effective slug` and `fallback` non-empty; `'{}'` models treated as explicitly-empty; `enabled`/`scoreThreshold` preserved.
- **Inbox absorption:** an inbox save persists **no** model slug; `classifyEmail`/`draftReply`/`proposeInvoice` resolve via the text chain.
- **Validation:** non-catalog slug rejected; text-only model rejected for image/fallback; blanks accepted.
- **Console:** one "AI models" block renders; the five old selectors and two browser-JS fallbacks are gone.

## Deferred / future work (§11)

- **Multi-tenant / SaaS LLM provisioning** (its own spec): managed vs BYOK keys; per-tenant credential references (the resolver returning `{provider, model, keyRef}`); per-tenant usage metering, quotas, and a hard per-window **cost ceiling**; tier-3 as a platform-funded reliability guarantee. None built now.
- **Structured Outputs** (`response_format: json_schema`) on OpenAI to retire most of `extractJson` — optional later optimization.

## Secret

`OPENAI_API_KEY` is added as a Cloudflare Worker secret (`wrangler secret put OPENAI_API_KEY`). The value is never handled in code review or logs.

## Open decisions for review

1. **Shared fallback is vision-constrained.** One fallback serves both roles, so it must be vision-capable — this removes the only text-only catalog model (`deepseek/deepseek-v4-pro`) from the text fallback slot. Cost impact is marginal (vision models bill on text tokens when no image is sent). Accept + document the coupling (recommended), or split into `fallbackImage`/`fallbackText`?
2. **Inbox model fields:** drop `classifyModel`/`replyModel` from `InboxConfig` outright after migration (recommended), or retain as permanently-ignored deprecated fields?
3. **Config home for `enabled`/`scoreThreshold`:** keep a slim `cfg.llm` (recommended, minimal churn to degradation gates), or move them into `cfg.models`?
