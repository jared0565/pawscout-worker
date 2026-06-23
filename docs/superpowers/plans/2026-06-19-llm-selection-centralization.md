# LLM Selection Centralization - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard the single source of truth for LLM selection - Image / Text / Fallback models in one block - with every call resolving through a role chain and a system-owned `gpt-5.4-mini` OpenAI-direct floor.

**Architecture:** A pure `resolveChain(cfg, role)` turns the tenant's `cfg.llm.models` into ordered tiers (OpenRouter `models:[primary, fallback]` → OpenAI-direct `gpt-5.4-mini`). A provider-aware `LlmClient.jsonChain()` walks those tiers, branching request shape and cost by provider, degrading to no-LLM when exhausted. All 8 business call sites (incl. the inbox's parallel model subsystem) route through it; legacy slug fields are dropped and derived once, read-side.

**Tech Stack:** Cloudflare Worker (Hono) + D1, TypeScript, vitest + @cloudflare/vitest-pool-workers, OpenRouter + OpenAI Chat Completions.

## Global Constraints

- **No model-slug literal in business logic.** The only permitted slug references are `CURATED_MODELS[0].slug` (the menu head, `src/models-catalog.ts`) and `DEFAULT_MODEL` (the one deliberate constant).
- `DEFAULT_MODEL = 'gpt-5.4-mini'` (bare slug, OpenAI-direct). `DEFAULT_MODEL_PRICE = { promptPerM: 0.75, completionPerM: 4.50 }` (USD per 1M tokens).
- **OpenAI tier request shape:** `POST https://api.openai.com/v1/chat/completions`; `Authorization: Bearer <OPENAI_API_KEY>`; body `{ model: 'gpt-5.4-mini', max_completion_tokens: max(requested, 3000), reasoning_effort: 'medium', response_format: {type:'json_object'}, messages }`; **no** `max_tokens`, **no** `usage:{include:true}`, **no** `HTTP-Referer`/`X-Title`, **never** send `temperature`.
- **OpenRouter tier request shape (unchanged):** `models: [primary, fallback]` (deduped, blanks dropped - never empty), `max_tokens`, `usage:{include:true}`, existing headers.
- **Blank handling:** role primary blank → `CURATED_MODELS[0].slug`; fallback blank → omitted. OpenRouter `models[]` is never empty.
- **Tier-advance taxonomy:** advance on HTTP 401/403/404 and 429-`insufficient_quota`; same-tier retry once then advance on 5xx/503/429-`rate_limit_exceeded`/network-throw; **stop (degrade, do not advance)** on HTTP 400 `invalid_request_error`; on a 200 parse/validation failure retry the same tier once, then advance once, and on the final (OpenAI) tier stop.
- **Cost:** OpenRouter cost from `data.usage.cost`; OpenAI cost computed from token counts × `DEFAULT_MODEL_PRICE`.
- **Observability:** emit one structured `console.warn('llm.tier3.activated …')` whenever the OpenAI tier serves a call (both OpenRouter slots failed → ops incident).
- **Never throw into a job.** Every exhausted chain returns `{ok:false}`; callers fall back to mechanical gates / keep current image.
- **Retained behavioral knobs:** `cfg.llm.enabled` and `cfg.llm.scoreThreshold` stay first-class; only model-slug fields are removed from `LlmConfig`.
- **Image + Fallback** selections must be vision-capable and in the curated catalog; Text in the catalog. Validation rejects non-catalog and non-vision picks.
- **Tests:** run **focused** test files (`npx vitest run tests/<file>.ts`) - the full suite crashes on this Windows box (vitest-pool-workers parallel-storage contention). `npx tsc --noEmit` must be clean. After editing `src/console/page.ts`, ALWAYS run `tests/console.test.ts`, and double-escape backslashes (`\\n`) in browser-JS strings.

---

### Task 1: Config types, constants, and `Env`

**Files:**
- Modify: `src/types.ts` (LlmConfig ~73-80; DEFAULT_LLM:132; Env:3-29)
- Modify: `src/llm.ts` (add `DEFAULT_MODEL`, `DEFAULT_MODEL_PRICE`, `LlmRole`, `ChainTier` near top)
- Test: `tests/llm-config.test.ts` (new)

**Interfaces:**
- Produces: `interface ModelsConfig { image?: string; text?: string; fallback?: string }`; `interface LlmConfig { enabled: boolean; scoreThreshold: number; models: ModelsConfig }`; `const DEFAULT_LLM: LlmConfig = { enabled: true, scoreThreshold: 60, models: {} }`; `Env.OPENAI_API_KEY?: string`; `export const DEFAULT_MODEL = 'gpt-5.4-mini'`; `export const DEFAULT_MODEL_PRICE = { promptPerM: 0.75, completionPerM: 4.50 }`; `export type LlmRole = 'image' | 'text'`.

- [ ] **Step 1: Write the failing test**
```ts
// tests/llm-config.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_LLM } from '../src/types';
import { DEFAULT_MODEL, DEFAULT_MODEL_PRICE } from '../src/llm';

describe('llm config shape', () => {
  it('DEFAULT_LLM has slim behavioral knobs + empty models, no slug fields', () => {
    expect(DEFAULT_LLM).toEqual({ enabled: true, scoreThreshold: 60, models: {} });
    expect('model' in DEFAULT_LLM).toBe(false);
    expect('curationModel' in DEFAULT_LLM).toBe(false);
  });
  it('the deliberate OpenAI floor constant + price are pinned', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.4-mini');
    expect(DEFAULT_MODEL_PRICE).toEqual({ promptPerM: 0.75, completionPerM: 4.50 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm-config.test.ts`
Expected: FAIL - `DEFAULT_MODEL` not exported; `DEFAULT_LLM` still has `model`.

- [ ] **Step 3: Implement**
In `src/types.ts` replace the `LlmConfig` interface and `DEFAULT_LLM`:
```ts
export interface ModelsConfig {
  image?: string;    // OpenRouter slug; blank → CURATED_MODELS[0] (menu head)
  text?: string;     // OpenRouter slug; blank → CURATED_MODELS[0]
  fallback?: string; // OpenRouter slug; blank → omitted from the models[] array
}

/**
 * LLM behavioral config. Model SELECTION lives in `models` (one dashboard block);
 * `enabled`/`scoreThreshold` are the behavioral knobs. Disabled (or no key) =
 * mechanical gates only - the system never depends on the LLM to function.
 */
export interface LlmConfig {
  enabled: boolean;
  scoreThreshold: number; // 0-100: minimum relevance score to admit
  models: ModelsConfig;
}
```
Update `DEFAULT_LLM` (line 132):
```ts
export const DEFAULT_LLM: LlmConfig = { enabled: true, scoreThreshold: 60, models: {} };
```
Add `OPENAI_API_KEY?: string;` to `Env` (after `OPENROUTER_API_KEY?`):
```ts
  // OpenAI direct (LLM-centralization last-resort floor, gpt-5.4-mini) - optional:
  // absent = OpenAI tier skipped (OpenRouter tiers + mechanical degradation remain).
  OPENAI_API_KEY?: string;
```
In `src/llm.ts` near the top (after `OPENROUTER_URL`):
```ts
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_MODEL_PRICE = { promptPerM: 0.75, completionPerM: 4.50 };
export type LlmRole = 'image' | 'text';
export type ChainTier =
  | { provider: 'openrouter'; models: string[] }
  | { provider: 'openai'; model: string };
```

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/llm-config.test.ts`
Expected: PASS. (Type errors in other files from the `LlmConfig` reshape are expected and resolved by later tasks - do NOT run `tsc` yet.)

- [ ] **Step 5: Commit**
```bash
git add src/types.ts src/llm.ts tests/llm-config.test.ts
git commit -m "feat(llm): reshape LlmConfig to models block + add OpenAI floor constants"
```

---

### Task 2: `resolveChain` model resolver

**Files:**
- Create: `src/llm-resolve.ts`
- Test: `tests/llm-resolve.test.ts` (new)

**Interfaces:**
- Consumes: `LlmRole`, `ChainTier` (Task 1); `CURATED_MODELS` (`src/models-catalog.ts`); `DEFAULT_MODEL` (Task 1); `TenantConfig` (`src/types.ts`).
- Produces: `export function resolveChain(cfg: TenantConfig, role: LlmRole): ChainTier[]`.

- [ ] **Step 1: Write the failing test**
```ts
// tests/llm-resolve.test.ts
import { describe, it, expect } from 'vitest';
import { resolveChain } from '../src/llm-resolve';
import { CURATED_MODELS } from '../src/models-catalog';
import { DEFAULT_LLM } from '../src/types';
import type { TenantConfig } from '../src/types';

const HEAD = CURATED_MODELS[0].slug;
const base = (models: any): TenantConfig => ({ ...({} as TenantConfig), llm: { ...DEFAULT_LLM, models } });

describe('resolveChain', () => {
  it('text: primary+fallback → openrouter array then openai floor', () => {
    const c = resolveChain(base({ text: 'a/b', fallback: 'c/d' }), 'text');
    expect(c).toEqual([{ provider: 'openrouter', models: ['a/b', 'c/d'] }, { provider: 'openai', model: 'gpt-5.4-mini' }]);
  });
  it('blank primary → catalog head; never an empty array', () => {
    const c = resolveChain(base({}), 'text');
    expect(c[0]).toEqual({ provider: 'openrouter', models: [HEAD] });
  });
  it('image uses models.image; dedupes primary==fallback', () => {
    const c = resolveChain(base({ image: 'x/y', fallback: 'x/y' }), 'image');
    expect(c[0]).toEqual({ provider: 'openrouter', models: ['x/y'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm-resolve.test.ts`
Expected: FAIL - `src/llm-resolve.ts` does not exist.

- [ ] **Step 3: Implement**
```ts
// src/llm-resolve.ts
import type { TenantConfig } from './types';
import { DEFAULT_MODEL, type LlmRole, type ChainTier } from './llm';
import { CURATED_MODELS } from './models-catalog';

/**
 * Turn a tenant's model selection into an ordered tier chain:
 *   1. OpenRouter, models:[primary, fallback] (native failover; blanks dropped,
 *      deduped, never empty - a blank primary falls back to the menu head).
 *   2. OpenAI-direct gpt-5.4-mini (the system floor).
 * The chain is provider-aware; LlmClient.jsonChain walks it and skips a tier
 * whose provider key is absent. Pure - no env, no I/O.
 */
export function resolveChain(cfg: TenantConfig, role: LlmRole): ChainTier[] {
  const m = cfg.llm.models ?? {};
  const primary = (role === 'image' ? m.image : m.text) || CURATED_MODELS[0].slug;
  const models = [...new Set([primary, m.fallback].filter((s): s is string => !!s))];
  return [
    { provider: 'openrouter', models },
    { provider: 'openai', model: DEFAULT_MODEL },
  ];
}
```

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/llm-resolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add src/llm-resolve.ts tests/llm-resolve.test.ts
git commit -m "feat(llm): resolveChain - role selection to provider tier chain"
```

---

### Task 3: Provider-aware `LlmClient` (`jsonChain`, tier walk, cost, activation log)

**Files:**
- Modify: `src/llm.ts` (`LlmClient` class 43-123)
- Modify (constructor sites): `src/jobs.ts:532`; `src/index.ts:212,304,330,578,606,618`; `src/inbox/sweep.ts:42,67,128,265`
- Test: `tests/llm-client.test.ts` (new)

**Interfaces:**
- Consumes: `ChainTier`, `DEFAULT_MODEL_PRICE`, `OPENAI_URL` (Tasks 1).
- Produces: `new LlmClient(keys: { openrouter?: string; openai?: string }, fetchImpl?)`; `get available(): boolean` (true if either key); `jsonChain<T>(opts: { chain: ChainTier[]; system: string; user: string; images?: string[]; maxTokens?: number; validate: (v: unknown) => T | null }): Promise<LlmJson<T>>` where `LlmUsage` gains `provider: 'openrouter' | 'openai'`. Existing `json()` is removed (all callers migrate in Task 5; this task keeps the file compiling by having `jsonChain` be the only public call path and updating no business callers yet - see Step 3 note).

- [ ] **Step 1: Write the failing test**
```ts
// tests/llm-client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LlmClient } from '../src/llm';

const ok = (model: string, content: string, cost = 0.001) => ({
  ok: true, status: 200,
  json: async () => ({ model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost } }),
});

describe('LlmClient.jsonChain', () => {
  it('OpenRouter tier sends models[] + max_tokens + usage:{include}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('a/b', '{"v":1}'));
    const llm = new LlmClient({ openrouter: 'k' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b', 'c/d'] }, { provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as any).body);
    expect(body.models).toEqual(['a/b', 'c/d']);
    expect(body.max_tokens).toBeDefined();
    expect(body.usage).toEqual({ include: true });
  });

  it('advances to OpenAI floor on OpenRouter 404; OpenAI body uses max_completion_tokens + reasoning_effort medium, no usage', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: { message: 'no model', code: 'model_not_found' } }) })
      .mockResolvedValueOnce(ok('gpt-5.4-mini', '{"v":2}'));
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b'] }, { provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', maxTokens: 200, validate: (v: any) => v });
    expect(r.ok && r.value).toEqual({ v: 2 });
    const oaiReq = JSON.parse((fetchImpl.mock.calls[1][1] as any).body);
    expect(oaiReq.max_completion_tokens).toBe(3000); // floored
    expect(oaiReq.reasoning_effort).toBe('medium');
    expect(oaiReq.max_tokens).toBeUndefined();
    expect(oaiReq.usage).toBeUndefined();
    expect((fetchImpl.mock.calls[1][0] as string)).toBe('https://api.openai.com/v1/chat/completions');
    if (r.ok) { expect(r.usage.provider).toBe('openai'); expect(r.usage.costUsd).toBeCloseTo(10/1e6*0.75 + 5/1e6*4.50); }
  });

  it('HTTP 400 invalid_request stops - does NOT advance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error', message: 'bad' } }) });
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b'] }, { provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // stopped, no advance
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm-client.test.ts`
Expected: FAIL - `jsonChain` / new constructor not present.

- [ ] **Step 3: Implement**
Replace the `LlmClient` class in `src/llm.ts`. Keep `extractJson` and `LlmUsage`/`LlmJson` (extend `LlmUsage` with `provider`).
```ts
export interface LlmUsage { provider: 'openrouter' | 'openai'; model: string; promptTokens: number; completionTokens: number; costUsd: number }
export type LlmJson<T> = { ok: true; value: T; usage: LlmUsage } | { ok: false; error: string };

type SendOutcome<T> =
  | { kind: 'ok'; value: T; usage: LlmUsage }
  | { kind: 'retry'; error: string }   // transient: retry SAME tier once
  | { kind: 'advance'; error: string } // hard model/account failure: next tier
  | { kind: 'stop'; error: string };   // request-shape bug: degrade, no advance

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
            console.warn(`llm.tier3.activated model=${out.usage.model} - both OpenRouter slots failed`);
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
```
> **NOTE on the parse/validation "advance once" rule:** the per-tier loop above retries once on `retry`, then breaks to the next tier - so a 200-garbage on OpenRouter retries once then advances to OpenAI, and a 200-garbage on the (final) OpenAI tier retries once then exhausts the chain → `{ok:false}`. This satisfies the taxonomy without extra state.

Update **all 10 construction sites** from `new LlmClient(<key>[, fetchImpl])` to the object form, e.g.:
```ts
// src/jobs.ts:532, src/index.ts:212/304/330/578/606/618
const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY });
// src/inbox/sweep.ts:42/67/128/265 (these pass a fetchImpl second arg - keep it)
const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
```
> Business callers still reference the old `json()` until Task 5. To keep the file compiling now, leave the 8 `json()` call sites untouched **but** they will not type-check against the removed `json()` - therefore Task 3 and Task 5 ship together is acceptable, OR add a thin temporary `json()` shim that wraps a single OpenRouter tier. **Chosen:** add the shim so Task 3 compiles standalone:
```ts
  /** @deprecated transitional - single-OpenRouter-tier wrapper, removed in Task 5. */
  async json<T>(opts: { model: string; system: string; user: string; images?: string[]; maxTokens?: number; validate: (v: unknown) => T | null }): Promise<LlmJson<T>> {
    return this.jsonChain({ chain: [{ provider: 'openrouter', models: [opts.model] }], system: opts.system, user: opts.user, images: opts.images, maxTokens: opts.maxTokens, validate: opts.validate });
  }
```

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/llm-client.test.ts tests/llm.test.ts`
Expected: PASS. (`tests/llm.test.ts` exercises the existing curation/hero paths through the `json()` shim.)

- [ ] **Step 5: Commit**
```bash
git add src/llm.ts src/jobs.ts src/index.ts src/inbox/sweep.ts tests/llm-client.test.ts
git commit -m "feat(llm): provider-aware LlmClient.jsonChain (OpenRouter+OpenAI tier walk, cost, activation log)"
```

---

### Task 4: Read-side migration in `getConfig`

**Files:**
- Modify: `src/tenant-store.ts` (`getConfig` 108-127)
- Create: `src/llm-migrate.ts` (pure derive helper)
- Test: `tests/llm-migrate.test.ts` (new)

**Interfaces:**
- Produces: `export function deriveModels(legacy: Record<string, unknown>): ModelsConfig` - maps `visionModel ?? curationModel ?? model → image`, `curationModel ?? model → text`, `model → fallback`; returns `{}` when no legacy slugs present.
- `getConfig` returns `llm: { enabled, scoreThreshold, models }`, with `models = parsedLlm.models ?? deriveModels(parsedLlm)` and legacy slug keys stripped.

- [ ] **Step 1: Write the failing test**
```ts
// tests/llm-migrate.test.ts
import { describe, it, expect } from 'vitest';
import { deriveModels } from '../src/llm-migrate';

describe('deriveModels (legacy → models)', () => {
  it('preserves the current pickHeroImage chain for blank visionModel', () => {
    expect(deriveModels({ model: 'base/x', curationModel: 'cur/y' }))
      .toEqual({ image: 'cur/y', text: 'cur/y', fallback: 'base/x' });
  });
  it('uses visionModel for image when present', () => {
    expect(deriveModels({ model: 'base/x', visionModel: 'vis/z' }))
      .toEqual({ image: 'vis/z', text: 'base/x', fallback: 'base/x' });
  });
  it('no legacy slugs → empty models', () => {
    expect(deriveModels({ enabled: true, scoreThreshold: 60 })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm-migrate.test.ts`
Expected: FAIL - `src/llm-migrate.ts` missing.

- [ ] **Step 3: Implement**
```ts
// src/llm-migrate.ts
import type { ModelsConfig } from './types';

const slug = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Derive the models block from a legacy llm blob, preserving today's effective
 *  resolution: image = visionModel ?? curationModel ?? model; text = curationModel
 *  ?? model; fallback = model. Empty when the blob carries no slug fields. */
export function deriveModels(legacy: Record<string, unknown>): ModelsConfig {
  const model = slug(legacy.model);
  const curation = slug(legacy.curationModel);
  const vision = slug(legacy.visionModel);
  const out: ModelsConfig = {};
  const image = vision ?? curation ?? model;
  const text = curation ?? model;
  if (image) out.image = image;
  if (text) out.text = text;
  if (model) out.fallback = model;
  return out;
}
```
In `src/tenant-store.ts` `getConfig`, replace the `llm:` line (120):
```ts
      llm: (() => {
        const raw = { ...JSON.parse(row.llm || '{}') } as Record<string, unknown>;
        const models = (raw.models && typeof raw.models === 'object') ? raw.models : deriveModels(raw);
        return { enabled: DEFAULT_LLM.enabled, scoreThreshold: DEFAULT_LLM.scoreThreshold, ...{ enabled: raw.enabled, scoreThreshold: raw.scoreThreshold }, models } as TenantConfig['llm'];
      })(),
```
> Use a clean merge - keep `raw.enabled`/`raw.scoreThreshold` only when present:
```ts
      llm: (() => {
        const raw = JSON.parse(row.llm || '{}') as Record<string, unknown>;
        const models = (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models))
          ? (raw.models as TenantConfig['llm']['models'])
          : deriveModels(raw);
        return {
          enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_LLM.enabled,
          scoreThreshold: typeof raw.scoreThreshold === 'number' ? raw.scoreThreshold : DEFAULT_LLM.scoreThreshold,
          models,
        };
      })(),
```
Add `import { deriveModels } from './llm-migrate';` at the top of `tenant-store.ts`.

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/llm-migrate.test.ts tests/tenant-store.test.ts`
Expected: PASS (derive tests; existing tenant-store tests still green - adjust any that asserted the old `llm.model` shape to assert `llm.models`).

- [ ] **Step 5: Commit**
```bash
git add src/llm-migrate.ts src/tenant-store.ts tests/llm-migrate.test.ts
git commit -m "feat(llm): read-side migration - derive models block from legacy llm fields"
```

---

### Task 5: Route all 8 call sites through the role chain

**Files:**
- Modify: `src/llm.ts` (`curateProduct` 154/156, `pickHeroImage` 239/241, `rewriteDescription` 294/298, `classifyKeyword` 354) - replace `model` resolution + `llm.json(...)` with `resolveChain` + `llm.jsonChain(...)`; remove the deprecated `json()` shim
- Modify: `src/semantic/library.ts:81-82`; `src/inbox/classify.ts:21-24`; `src/inbox/draft.ts:32-35`; `src/inbox/propose-invoice.ts:32-34`; `src/inbox/sweep.ts:286`
- Test: `tests/llm.test.ts` (extend), `tests/inbox-classify.test.ts` / existing inbox tests

**Interfaces:**
- Consumes: `resolveChain` (Task 2), `jsonChain` (Task 3). Each call site needs a `TenantConfig` in scope - all already receive `cfg`.

- [ ] **Step 1: Write the failing test**
```ts
// tests/llm.test.ts - add
it('curateProduct routes through the text chain (no cfg.llm.model)', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'cur/y', choices: [{ message: { content: JSON.stringify({ relevanceScore: 80, category: null, title: 'T', descriptionHtml: '<p>d</p>', petClass: 'dog' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }) });
  const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
  const cfg: any = { collectionMap: {}, llm: { enabled: true, scoreThreshold: 60, models: { text: 'cur/y' } } };
  const r = await curateProduct(llm, fakeStore(), cfg, fakeDetail(), 'dog chew');
  expect(r?.relevanceScore).toBe(80);
  expect(JSON.parse((fetchImpl.mock.calls[0][1] as any).body).models).toEqual(['cur/y']);
});
```
(Reuse the existing `tests/llm.test.ts` fixtures `fakeStore`/`fakeDetail`; if absent, add minimal stubs.)

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm.test.ts`
Expected: FAIL - `curateProduct` still calls `llm.json({ model: cfg.llm.curationModel ?? cfg.llm.model })` (now a type error / wrong body).

- [ ] **Step 3: Implement**
In `src/llm.ts`, add `import { resolveChain } from './llm-resolve';` (or co-locate). For each fn replace the model line + `llm.json({ model, ... })`:

`curateProduct` (lines 154 + 156):
```ts
  const chain = resolveChain(cfg, 'text');
  const result = await llm.jsonChain<Curation>({ chain, maxTokens: 1200, system: /* unchanged */, user: /* unchanged */, validate: /* unchanged */ });
```
`pickHeroImage` (239 + 241): `const chain = resolveChain(cfg, 'image');` then `llm.jsonChain<{index;drop;reason}>({ chain, maxTokens: 200, images: urls, system, user, validate })`.
`rewriteDescription` (294 + 298): `resolveChain(cfg, 'text')` + `jsonChain({ chain, maxTokens: 700, ... })`.
`classifyKeyword` (354): `resolveChain(cfg, 'text')` + `jsonChain({ chain, maxTokens: 300, ... })`.
`src/semantic/library.ts:81-82`: replace `model: cfg.llm.curationModel ?? cfg.llm.model` with `chain: resolveChain(cfg, 'text')` and call `jsonChain`.
`src/inbox/classify.ts:21`: replace `const model = cfg.inbox.classifyModel || cfg.llm.model;` → `const chain = resolveChain(cfg, 'text');`, call `llm.jsonChain({ chain, ... })`.
`src/inbox/draft.ts:32` and `src/inbox/propose-invoice.ts:32`: replace `cfg.inbox.replyModel || cfg.llm.model` similarly with `resolveChain(cfg, 'text')` + `jsonChain`.
`src/inbox/sweep.ts:286` (record-keeping, not an API call): replace `model: cfg.inbox.replyModel || cfg.llm.model` with `model: (resolveChain(cfg, 'text')[0] as { models: string[] }).models[0]` (the served-primary slug for the draft row).
Finally **remove the deprecated `json()` shim** from `LlmClient` (added in Task 3).

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/llm.test.ts tests/inbox-classify.test.ts tests/inbox-draft.test.ts`
Expected: PASS. Then `npx tsc --noEmit` - expect remaining errors ONLY in `validate.ts` / inbox types / console (Tasks 6-8).

- [ ] **Step 5: Commit**
```bash
git add src/llm.ts src/semantic/library.ts src/inbox/classify.ts src/inbox/draft.ts src/inbox/propose-invoice.ts src/inbox/sweep.ts tests/llm.test.ts
git commit -m "feat(llm): route all 8 call sites (incl. inbox) through resolveChain"
```

---

### Task 6: Drop inbox model fields

**Files:**
- Modify: `src/inbox/types.ts` (`InboxConfig` 16/21; `DEFAULT_INBOX` 33/36)
- Modify: `src/validate.ts` (`validateInboxPayload` 209-215, 222-228, 241, 247)
- Test: `tests/inbox-validate.test.ts` (extend), `tests/inbox-config.test.ts` (update)

**Interfaces:**
- Produces: `InboxConfig` without `classifyModel`/`replyModel`; `validateInboxPayload` neither accepts nor emits them.

- [ ] **Step 1: Write the failing test**
```ts
// tests/inbox-validate.test.ts - add
it('inbox save persists no model slug', () => {
  const r = validateInboxPayload({ enabled: true, autosend: false, intentThreshold: 70, autoConfidenceThreshold: 80, labels: [], replyModel: 'anthropic/claude-haiku-4.5', classifyModel: 'google/gemini-2.5-flash-lite' });
  expect(r.ok).toBe(true);
  if (r.ok) { expect('replyModel' in r.value).toBe(false); expect('classifyModel' in r.value).toBe(false); }
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/inbox-validate.test.ts`
Expected: FAIL - `r.value.replyModel` still present (`?? DEFAULT_INBOX.replyModel`).

- [ ] **Step 3: Implement**
In `src/inbox/types.ts`: delete `classifyModel?` (line 16) and `replyModel` (line 21) from `InboxConfig`; delete lines 33 (`classifyModel: …`) and 36 (`replyModel: …`) from `DEFAULT_INBOX`.
In `src/validate.ts` `validateInboxPayload`: delete the `classifyModel` block (209-215), the `replyModel` block (222-228), and remove `replyModel: replyModel ?? DEFAULT_INBOX.replyModel,` (241) and `...(classifyModel ? { classifyModel } : {})` (247) from the returned value.

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/inbox-validate.test.ts tests/inbox-config.test.ts`
Expected: PASS (update `inbox-config.test.ts` line that asserted `classifyModel === 'google/gemini-2.5-flash-lite'` - delete that assertion).

- [ ] **Step 5: Commit**
```bash
git add src/inbox/types.ts src/validate.ts tests/inbox-validate.test.ts tests/inbox-config.test.ts
git commit -m "feat(inbox): drop classifyModel/replyModel - inbox uses the text role"
```

---

### Task 7: `validateLlmPayload` reshape + catalog/vision gate on `/api/llm`

**Files:**
- Modify: `src/validate.ts` (`validateLlmPayload` 128-156)
- Modify: `src/index.ts` (the POST `/api/llm` handler around 91-126 - extend the existing `visionModelRejected` gate to image+fallback and add a catalog-allowlist check)
- Test: `tests/validate-vision.test.ts` (update), `tests/llm-validate.test.ts` (new)

**Interfaces:**
- Produces: `validateLlmPayload` accepts `{ enabled, scoreThreshold, models: { image?, text?, fallback? } }`; each model (when non-blank) is slug-shaped; returns `LlmConfig`. Catalog allowlist + vision constraint enforced in the route (catalog-aware).

- [ ] **Step 1: Write the failing test**
```ts
// tests/llm-validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateLlmPayload } from '../src/validate';
describe('validateLlmPayload (models block)', () => {
  it('accepts the new shape and drops blanks', () => {
    const r = validateLlmPayload({ enabled: true, scoreThreshold: 60, models: { text: 'a/b', image: '', fallback: 'c/d' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ enabled: true, scoreThreshold: 60, models: { text: 'a/b', fallback: 'c/d' } });
  });
  it('rejects a malformed slug', () => {
    expect(validateLlmPayload({ enabled: true, scoreThreshold: 60, models: { text: 'not a slug' } }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/llm-validate.test.ts`
Expected: FAIL - validator still requires top-level `model`.

- [ ] **Step 3: Implement**
Replace `validateLlmPayload` body (128-156):
```ts
export function validateLlmPayload(body: unknown): Validation<LlmConfig> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (!finite(b.scoreThreshold) || (b.scoreThreshold as number) < 0 || (b.scoreThreshold as number) > 100) {
    return { ok: false, error: 'scoreThreshold must be a number between 0 and 100' };
  }
  const rawModels = (b.models && typeof b.models === 'object' && !Array.isArray(b.models)) ? b.models as Record<string, unknown> : {};
  const models: { image?: string; text?: string; fallback?: string } = {};
  for (const k of ['image', 'text', 'fallback'] as const) {
    const v = rawModels[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || v.length > 100 || !MODEL_SLUG.test(v)) return { ok: false, error: `${k} model must be an OpenRouter slug` };
    models[k] = v;
  }
  return { ok: true, value: { enabled: b.enabled, scoreThreshold: b.scoreThreshold as number, models } };
}
```
In `src/index.ts` POST `/api/llm` handler, after validation, replace the single `visionModelRejected(v.value.visionModel, …)` check with a catalog allowlist + vision gate over the three selections:
```ts
  const catalog = await getModelCatalog(store);
  const inCatalog = (s?: string) => !s || catalog.some((m) => m.slug === s);
  const { image, text, fallback } = v.value.models;
  for (const [label, slug] of [['image', image], ['text', text], ['fallback', fallback]] as const) {
    if (slug && !inCatalog(slug)) return c.json({ ok: false, error: `${label} model is not in the catalog` }, 400);
  }
  if (visionModelRejected(image, catalog) || visionModelRejected(fallback, catalog)) {
    return c.json({ ok: false, error: 'Image and Fallback must be vision-capable models' }, 400);
  }
```

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/llm-validate.test.ts tests/validate-vision.test.ts`
Expected: PASS (rewrite `validate-vision.test.ts` to set `models.image`/`models.fallback` instead of `visionModel`).

- [ ] **Step 5: Commit**
```bash
git add src/validate.ts src/index.ts tests/llm-validate.test.ts tests/validate-vision.test.ts
git commit -m "feat(llm): validate models block + catalog/vision gate on /api/llm"
```

---

### Task 8: Console - one "AI models" block, remove all other selectors

**Files:**
- Modify: `src/console/page.ts` (LLM panel HTML 240-264; inbox model HTML 427-436; `populateForms` 556-559; `saveLlm` client 664-677; inbox populate 1358-1359; inbox save 1390-1391)
- Test: `tests/console.test.ts` (MUST run after editing)

**Interfaces:**
- Produces: one "AI models" block with `#mdl-image`, `#mdl-text`, `#mdl-fallback` selects + a read-only last-resort line, placed directly under the Connected/status area; `saveLlm()` POSTs `{ enabled, scoreThreshold, models: { image, text, fallback } }`. The five old selectors and both inbox model selectors are removed.

- [ ] **Step 1: Write the failing test**
```ts
// tests/console.test.ts - add
it('renders one AI-models block and no legacy/inbox model selectors', () => {
  const html = consolePage('test-key');
  expect(html).toContain('id="mdl-image"');
  expect(html).toContain('id="mdl-text"');
  expect(html).toContain('id="mdl-fallback"');
  expect(html).toContain('Last resort: GPT-5.4 mini');
  expect(html).not.toContain('id="llmcuration"');
  expect(html).not.toContain('id="llmvision"');
  expect(html).not.toContain('id="inbox-reply-model"');
  expect(html).not.toContain('id="inbox-classify-model"');
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run tests/console.test.ts`
Expected: FAIL - `mdl-image` absent; `llmcuration` present.

- [ ] **Step 3: Implement**
Replace the AI-curation model HTML (240-264) with a single block (keep Min score + Enabled in this section):
```html
    <div class="row">
      <div class="grow"><label for="mdl-image">Image (vision) model</label><select id="mdl-image"></select></div>
      <div class="grow"><label for="mdl-text">Text model</label><select id="mdl-text"></select></div>
      <div class="grow"><label for="mdl-fallback">Fallback model</label><select id="mdl-fallback"></select></div>
    </div>
    <div class="row" style="margin-top:10px">
      <div class="grow" style="flex:0 1 140px"><label for="llmthresh">Min score</label><input id="llmthresh" type="number" value="60" min="0" max="100" step="5"></div>
      <div class="grow" style="flex:0 1 120px"><label for="llmon">Enabled</label><select id="llmon"><option value="true" selected>On</option><option value="false">Off</option></select></div>
      <button onclick="saveLlm()">Save AI</button>
    </div>
    <p class="sub muted" style="margin:8px 0 0">Last resort: GPT-5.4 mini · OpenAI direct (system-managed, used only if OpenRouter fails).</p>
```
Delete the inbox model HTML (427-436 - the `inbox-reply-model` / `inbox-classify-model` row).
`populateForms` (556-559): replace the three `setModelSelect('llmmodel'…)`/`llmcuration`/`llmvision` lines with:
```js
  var mm=(l.models||{});
  setModelSelect('mdl-image', mm.image, {vision:true, blank:'- '+esc(/* head label */'top model')});
  setModelSelect('mdl-text', mm.text, {blank:'- top model'});
  setModelSelect('mdl-fallback', mm.fallback, {vision:true, blank:'- none'});
```
`saveLlm()` client (664-677): replace the body with:
```js
    var r=await api('/llm',{
      enabled:el('llmon').value==='true',
      scoreThreshold:Number(el('llmthresh').value),
      models:{ image:(el('mdl-image')&&el('mdl-image').value)||'', text:(el('mdl-text')&&el('mdl-text').value)||'', fallback:(el('mdl-fallback')&&el('mdl-fallback').value)||'' }
    });
```
Inbox populate (1358-1359): delete both `setModelSelect('inbox-…-model', …)` lines.
Inbox save (1370-1391): delete `var rm=…`, `var cm=…`, and the `replyModel:…`/`classifyModel:…` payload lines (1390-1391).

- [ ] **Step 4: Run the tests**
Run: `npx vitest run tests/console.test.ts`
Expected: PASS. Then `npx tsc --noEmit` - expect CLEAN across the repo now.

- [ ] **Step 5: Commit**
```bash
git add src/console/page.ts tests/console.test.ts
git commit -m "feat(console): single AI-models block (image/text/fallback); remove all other selectors"
```

---

### Task 9: Whole-feature verification

**Files:** none (verification + spec deferred-list tick)

- [ ] **Step 1: Type-check clean**
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Focused test batches** (never the whole suite - Windows pool contention)
Run each: `npx vitest run tests/llm-config.test.ts tests/llm-resolve.test.ts tests/llm-client.test.ts tests/llm-migrate.test.ts`
Then: `npx vitest run tests/llm.test.ts tests/llm-validate.test.ts tests/validate-vision.test.ts`
Then: `npx vitest run tests/inbox-validate.test.ts tests/inbox-config.test.ts tests/console.test.ts`
Expected: all PASS.

- [ ] **Step 3: Grep for residual hardcoded slugs in business logic**
Run: `git grep -nE "(anthropic|google|openai|x-ai|deepseek)/" -- src ':!src/models-catalog.ts'`
Expected: only `DEFAULT_MODEL = 'gpt-5.4-mini'` (and the `OPENAI_URL`) - no other functional slug literal.

- [ ] **Step 4: Build-time effort A/B (manual, optional, behind your go)**
Re-stand the token-gated diagnostic (or a focused script) to run `low` vs `medium` on 3 real catalog products (titles + image sets); record format adherence, agreement with the primary model, tokens, latency; confirm `finish_reason !== 'length'` at the 3000 cap. Document results in the spec.

- [ ] **Step 5: Commit (docs)**
```bash
git add docs/superpowers/specs/2026-06-19-llm-selection-centralization-design.md
git commit -m "docs(spec): record A/B results + mark feature implemented"
```

> **Deploy (separate, needs explicit go):** `npx wrangler deploy`. After deploy, the daily cron's `reconcileHeroImages`/`reconcileDescriptions` will exercise the new chain on real products - watch `wrangler tail` for `llm.tier3.activated` (should be silent unless OpenRouter is degraded).
