# Self-updating AI model menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-curated 12-model list in Settings > AI models with a menu built from the live OpenRouter feed (newest model per family, grouped by an owner-controlled provider list), gated by a live test and a price confirmation on save, with a daily retirement watch.

**Architecture:** Four new pure-ish modules (`models-feed`, `model-menu`, `model-probe`, `model-save`) plus `model-watch`, wired into the existing `/api/models` and `/api/llm` routes, a new `/api/models/menu` route, one daily shop stage, and the console's AI models card. `src/models-catalog.ts` and `visionModelRejected` are deleted at the end. No D1 migration: owner menu settings ride inside the existing `tenant_config.llm` JSON.

**Tech Stack:** TypeScript Cloudflare Worker, Hono, D1, vitest with `@cloudflare/vitest-plugin` (`cloudflare:test` for D1 route tests), inline console JS in template literals.

**Spec:** `docs/superpowers/specs/2026-11-13-self-updating-model-menu-design.md`

## Global Constraints

- No em or en dashes anywhere: code, comments, console copy, email copy, commit messages.
- Never pass `--no-verify`. Before every commit run `aramid check --staged` (re-run once if a tool reports "gate budget expired"). Push after every commit. Branch: `feat/self-updating-model-menu`.
- Before editing a shared file (`src/index.ts`, `src/tenant-store.ts`, `src/types.ts`, `src/validate.ts`, `src/llm.ts`, `src/llm-resolve.ts`, `src/jobs.ts`, `src/console/routes.ts`, `src/console/page.ts`) run `python -P -m graphite impact <file>` and read the call sites it names.
- Nothing may write `llm.models` except a `POST /api/llm` save. `resolveChain` behaviour is unchanged except its blank-slot default. `SEARCH_MODEL` and `DEFAULT_MODEL` are unchanged.
- Console script lives in template literals: double-escape backslashes, never use `window.confirm`/`alert` (blocked in the admin iframe), and after any console edit run `npx vitest run tests/console.test.ts` and `npm run lint`.
- Values fixed by the spec:
  - feed cache key `openrouter:models:v2`, TTL 1 day;
  - default providers `anthropic, openai, google, x-ai, deepseek, qwen, moonshotai, z-ai, minimax, mistralai`;
  - staleness 6 months = `183 * 86400` seconds;
  - at most 6 families per provider;
  - probe timeout 60 s;
  - probe pass cache 7 days at `modelprobe:<slug>:text|vision`;
  - price confirm above ratio 3 (`> 3`, not `>= 3`);
  - retirement window 30 days;
  - `SYSTEM_DEFAULT_MODEL = 'google/gemini-3.1-pro-preview'`;
  - providers match `^[a-z0-9-]+$`, 1 to 20 of them;
  - pins and hides at most 30 each, each an OpenRouter slug of at most 100 characters.
- Copy fixed by the spec:
  - "Cannot verify new models right now; try again shortly."
  - "No OpenRouter key is configured, so new models cannot be tested."
  - "Image and Fallback must be vision-capable models"
  - "Fallback is the same as the text model, so there is no second model to switch to."
  - "Model list unavailable right now"
  - "Testing the new model..."
  - "Save anyway"
- Tests use the checked-in fixture `tests/fixtures/openrouter-models-2026-11-13.json`: 331 rows trimmed from the 2026-11-13 feed, keeping only the fields the reducer reads, with `supported_parameters` cut down to `response_format`/`structured_outputs`. Fixed "now" for menu tests: `Date.parse('2026-11-13T12:00:00Z')`.
- Run a single file with `npx vitest run <path>`. The full gate is `npm test`, `npm run typecheck` and `npm run lint`.

## Review Focus

1. **Saving only the curation threshold** (Catalog "Save AI") while a stored model is off the menu or the feed is down must succeed, and must not fetch the feed or run a probe. Pinned in Task 6 (`unchanged slots never load the feed`) and Task 8 (route).
2. **A model moved into another slot** (the text model reused as fallback) counts as changed for that slot only, is tested in that slot's mode (vision for fallback), and the untouched slot gets no probe. Pinned in Task 6.
3. **OpenRouter never answers.** The save comes back with a plain reason instead of hanging the console. Pinned in Task 5 (timeout test).
4. **The feed's shape drifts:** malformed rows, non-numeric prices, a corrupt cache entry, or a 200 with zero usable rows. The menu degrades and never throws, and an empty result is not cached. Pinned in Task 2.
5. **A free (zero-price) or delisted current model** means the price ratio cannot be computed. The save is held with `ratio: null` (never `Infinity`/`NaN`), and the console names the new prices instead of a ratio. Pinned in Task 6 and Task 9.

---

### Task 1: System default model constant

**Files:**
- Modify: `src/llm.ts` (next to `SEARCH_MODEL`, line ~71)
- Modify: `src/llm-resolve.ts:1-23`
- Modify: `src/types.ts:111-115` (the `ModelsConfig` comments)
- Test: `tests/llm-resolve.test.ts`

**Interfaces:**
- Produces: `export const SYSTEM_DEFAULT_MODEL = 'google/gemini-3.1-pro-preview'` in `src/llm.ts`. `src/llm-resolve.ts` no longer imports `src/models-catalog.ts`.

- [ ] **Step 1: Update the test.** In `tests/llm-resolve.test.ts` replace the `CURATED_MODELS` import and `HEAD` with `SYSTEM_DEFAULT_MODEL` from `../src/llm`, and add:

```ts
it('the blank-slot default is pinned to the old menu head', () => {
  expect(SYSTEM_DEFAULT_MODEL).toBe('google/gemini-3.1-pro-preview');
  expect(resolveChain(base({}), 'image')[0]).toEqual({ provider: 'openrouter', models: [SYSTEM_DEFAULT_MODEL] });
});
```

- [ ] **Step 2: Run it.** `npx vitest run tests/llm-resolve.test.ts`. Expected: FAIL, `SYSTEM_DEFAULT_MODEL` is not exported.
- [ ] **Step 3: Implement.** Add the constant to `src/llm.ts` with a comment saying it is the blank-slot default and was the curated menu head on 2026-11-13. In `resolveChain` use it in place of `CURATED_MODELS[0].slug` and drop the `models-catalog` import. Rewrite the doc comment at `src/llm-resolve.ts:7-11` so it names `DEFAULT_MODEL` without claiming any model ID. Update the `ModelsConfig` comments to say "blank → SYSTEM_DEFAULT_MODEL".
- [ ] **Step 4: Run it.** `npx vitest run tests/llm-resolve.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/llm.ts src/llm-resolve.ts src/types.ts tests/llm-resolve.test.ts`, then `git commit -m "refactor(llm): SYSTEM_DEFAULT_MODEL replaces the curated menu head as the blank-slot default"`.

### Task 2: Feed reader

**Files:**
- Create: `src/models-feed.ts`
- Test: `tests/models-feed.test.ts` (the fixture is already committed)

**Interfaces:**
- Produces:

```ts
export interface FeedModel {
  id: string; canonicalSlug: string | null; name: string; created: number; // unix seconds
  expiresOn: string | null;            // expiration_date, 'YYYY-MM-DD'
  inputs: string[]; outputs: string[]; // architecture.input_modalities / output_modalities
  promptPriceM: number | null; completionPriceM: number | null; // $ per million, unrounded
  json: boolean;                       // supported_parameters has response_format or structured_outputs
}
export const FEED_CACHE_KEY = 'openrouter:models:v2';
export function reduceFeed(payload: unknown): FeedModel[];
export async function loadFeed(store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>, fetchImpl?: typeof fetch): Promise<FeedModel[] | null>;
export function feedCost(m: FeedModel): number | null; // promptPriceM + completionPriceM, null if either is null
```

- [ ] **Step 1: Write the failing tests.** Import the fixture with `import feedJson from './fixtures/openrouter-models-2026-11-13.json'`. Use the `fakeStore()` from the old `tests/models-catalog.test.ts:67-73`.

```ts
it('reduces every fixture row', () => { expect(reduceFeed(feedJson)).toHaveLength(331); });
it('maps prices to $/M and keeps the canonical slug', () => {
  const f = reduceFeed(feedJson);
  const opus = f.find((m) => m.id === 'anthropic/claude-opus-5.5')!;
  expect([opus.promptPriceM, opus.completionPriceM, opus.json]).toEqual([4, 20, true]);
  expect(opus.outputs).toEqual(['text']);
  expect(f.find((m) => m.id === 'openai/gpt-5.6-luna')!.canonicalSlug).toBe('openai/gpt-5.6-luna-20260709');
  expect(f.find((m) => m.id === 'openai/gpt-5-mini')!.expiresOn).toBe('2026-12-11');
  expect(feedCost(opus)).toBe(24);
});
it('skips malformed rows and never throws', () => {
  expect(reduceFeed(null)).toEqual([]);
  expect(reduceFeed({ data: [null, 5, 'x', { name: 'no id' }] })).toEqual([]);
  const [m] = reduceFeed({ data: [{ id: 'a/b', created: 1, pricing: { prompt: 'abc', completion: '0.000001' } }] });
  expect(m.promptPriceM).toBeNull(); expect(m.completionPriceM).toBe(1); expect(m.inputs).toEqual([]);
});
it('loadFeed caches under the v2 key; a second call does not fetch', async () => { /* calls === 1, getSearchCache(FEED_CACHE_KEY) not null */ });
it('ignores an old-shape entry under the v1 key', async () => { /* store holds 'openrouter:models' -> fetch still happens */ });
it('refetches when the cached JSON is corrupt', async () => { /* put '{not json' under FEED_CACHE_KEY -> fetch happens, result length 331 */ });
it('returns null on a throw, a 500, or a 200 with zero usable rows, and caches none of them', async () => { /* three fetchImpls; each -> null; cache still empty */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/models-feed.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement `src/models-feed.ts`.**
  - `reduceFeed` skips any row without a string `id` or a finite `created`.
  - A price that does not parse to a finite number becomes `null`; a negative price is kept, because the menu filter drops it.
  - `loadFeed` reads the cache first; corrupt JSON or a non-array counts as a miss. It then fetches `https://openrouter.ai/api/v1/models` through `defaultFetch`, caches only a non-empty result for 1 day, returns `null` for an empty one, and catches everything.
- [ ] **Step 4: Run them.** `npx vitest run tests/models-feed.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/models-feed.ts tests/models-feed.test.ts`, then `git commit -m "feat(models): OpenRouter feed reader with a v2 cache key"`.

### Task 3: Menu builder

**Files:**
- Create: `src/model-menu.ts`
- Test: `tests/model-menu.test.ts`

**Interfaces:**
- Consumes: `FeedModel` (Task 2); `ModelMenuConfig` (Task 4 defines it in `src/types.ts`, so this task adds the type first: `export interface ModelMenuConfig { providers: string[]; pins: string[]; hides: string[] }`).
- Produces:

```ts
export const DEFAULT_MENU_PROVIDERS: string[]; // the 10 ids, in spec order
export const MENU_STALE_SECONDS = 183 * 86400;
export const MENU_MAX_PER_PROVIDER = 6;
export interface MenuEntry {
  slug: string; name: string; provider: string; vision: boolean;
  promptPriceM: number | null; completionPriceM: number | null; // rounded to 3 decimals
  created: number | null; retiresOn: string | null; pinned: boolean; available: boolean;
}
export interface MenuGroup { provider: string; entries: MenuEntry[] }
export function effectiveMenu(menu?: ModelMenuConfig): ModelMenuConfig; // undefined -> defaults, pins [], hides []
export function isMenuCandidate(m: FeedModel, ids: Set<string>): boolean; // spec 5.2 step 2 only
export function familyKey(slug: string): string;
export function buildMenu(feed: FeedModel[], menu: ModelMenuConfig | undefined, nowSec: number): MenuGroup[];
```

- [ ] **Step 1: Write the failing tests.** `const NOW = Date.parse('2026-11-13T12:00:00Z') / 1000`, `const feed = reduceFeed(feedJson)`, and `const slugs = (g: MenuGroup[], p: string) => g.find((x) => x.provider === p)?.entries.map((e) => e.slug) ?? []`.

```ts
it('Anthropic is exactly the four newest families, newest first', () => {
  expect(slugs(buildMenu(feed, undefined, NOW), 'anthropic')).toEqual([
    'anthropic/claude-fable-5.2', 'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5']);
});
it('caps a provider at 6 families', () => {
  const g = buildMenu(feed, undefined, NOW);
  expect(slugs(g, 'openai')).toEqual(['openai/gpt-6.1-terra-pro', 'openai/gpt-6.1-terra', 'openai/gpt-6.1-sol-pro',
    'openai/gpt-6.1-sol', 'openai/gpt-6-luna-pro', 'openai/gpt-6-luna']);   // gpt-6-astra cut by the cap
  expect(slugs(g, 'qwen')).toHaveLength(6); expect(slugs(g, 'qwen')).not.toContain('qwen/qwen3.7-plus');
});
it('drops variants, aliases, routers and non-text outputs', () => {
  const all = buildMenu(feed, undefined, NOW).flatMap((g) => g.entries.map((e) => e.slug));
  for (const s of ['anthropic/claude-sonnet-4.6', 'anthropic/claude-fable-5.2:batch', 'openrouter/auto', '~anthropic/claude-sonnet-latest',
    'google/lyria-3-pro-preview', 'google/gemini-nano-banana-2.1', 'google/gemini-omni-1.2-flash', 'deepseek/deepseek-v4.1-flash-1017',
    'z-ai/glm-5.3-flashx-legal', 'google/gemini-3.1-pro-preview-customtools']) expect(all).not.toContain(s);
  expect(all).toContain('qwen/qwen3.8-omni-flash');                    // omni name, text output: kept
  expect(slugs(buildMenu(feed, undefined, NOW), 'mistralai')).toEqual(['mistralai/mistral-large-4-0']);
});
it('the dated-snapshot rule drops only snapshots whose undated alias is listed', () => {
  const ids = new Set(feed.map((m) => m.id)); const by = (id: string) => feed.find((m) => m.id === id)!;
  expect(isMenuCandidate(by('deepseek/deepseek-v4.1-flash-1017'), ids)).toBe(false);
  expect(isMenuCandidate(by('mistralai/mistral-small-2603'), ids)).toBe(true);   // later dropped as stale, not here
});
it('family key strips versions and -preview', () => {
  expect(familyKey('anthropic/claude-sonnet-4.6')).toBe(familyKey('anthropic/claude-sonnet-5.5'));
  expect(familyKey('google/gemini-3.1-pro-preview')).toBe('google/gemini-pro');
  expect(familyKey('openai/gpt-6.1-terra')).not.toBe(familyKey('openai/gpt-6.1-terra-pro'));
});
it('a provider with only stale families keeps its single newest', () => {
  expect(slugs(buildMenu(feed, { providers: ['meta-llama'], pins: [], hides: [] }, NOW), 'meta-llama')).toEqual(['meta-llama/llama-4-maverick']);
});
it('groups follow the provider list order', () => {
  expect(buildMenu(feed, { providers: ['x-ai', 'anthropic'], pins: [], hides: [] }, NOW).map((g) => g.provider)).toEqual(['x-ai', 'anthropic']);
});
it('hides remove, pins add (pin wins), a missing pin is unavailable', () => {
  const g = buildMenu(feed, { providers: ['anthropic'], hides: ['anthropic/claude-opus-5.5', 'openai/gpt-5.6-luna'],
    pins: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.6-luna', 'openai/gone-1'] }, NOW);
  expect(slugs(g, 'anthropic')).not.toContain('anthropic/claude-opus-5.5');
  expect(g.find((x) => x.provider === 'anthropic')!.entries.find((e) => e.slug === 'anthropic/claude-sonnet-4.6')!.pinned).toBe(true);
  const oa = g.find((x) => x.provider === 'openai')!.entries;            // unlisted provider: its own group, after the listed ones
  expect(oa.map((e) => [e.slug, e.available])).toEqual([['openai/gpt-5.6-luna', true], ['openai/gone-1', false]]);
});
it('entries carry vision, prices and retirement', () => { /* gpt-5-mini pinned -> retiresOn '2026-12-11'; z-ai/glm-5.3 vision false */ });
it('an empty feed yields only pins, all unavailable', () => {
  expect(buildMenu([], { providers: ['anthropic'], pins: ['a/b'], hides: [] }, NOW)).toEqual([{ provider: 'a', entries: [expect.objectContaining({ slug: 'a/b', available: false })] }]);
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-menu.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement `src/model-menu.ts`** using these exact rules, already checked against the fixture:

```ts
const VARIANT = /(?:^|-)(?:legal|code|coder|customtools|multi-agent|exp)(?:-|$)|guard/; // tested on the name after '/'
const DATED = /^(.*)-(\d{4}|\d{6}|\d{8})$/;
// familyKey: provider + '/' + name.replace(/-preview/g, '').replace(/v?\d+(?:\.\d+)*/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
```

  - The candidate filter applies, in order:
    - the provider is listed;
    - the id has no `:`;
    - outputs are exactly `['text']`;
    - both prices are non-null and at least 0;
    - `json` is true;
    - the dated-snapshot rule;
    - `VARIANT`.
  - Keep the newest per family by `created`.
  - Drop families older than `nowSec - MENU_STALE_SECONDS`; if that empties a provider, keep its single newest.
  - Sort by `created` descending, then `slug` ascending, and cut at 6.
  - Then remove hides and add pins:
    - a pin already present just gets `pinned: true`;
    - a pin found in the feed is added to its provider's group, re-sorted;
    - a pin missing from the feed is added last in its group with `available: false`, `name` = slug, null prices and `vision: false`.
  - Groups for unlisted providers come after the listed ones, in pin order. Empty groups are omitted.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-menu.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/model-menu.ts src/types.ts tests/model-menu.test.ts`, then `git commit -m "feat(models): newest-per-family menu builder"`.

### Task 4: Owner menu settings (storage, validation, merge saves)

**Files:**
- Modify: `src/types.ts` (`LlmConfig` gains `menu?: ModelMenuConfig`)
- Modify: `src/validate.ts` (new `validateModelMenuPayload`)
- Modify: `src/tenant-store.ts:427-437` (`getConfig` keeps `menu`)
- Modify: `src/console/routes.ts:35-40` (`saveLlm` preserves `menu`; new `saveModelMenu`)
- Test: `tests/validate.test.ts` (append), `tests/model-menu-config.test.ts` (new, `cloudflare:test` D1)

**Interfaces:**
- Consumes: `ModelMenuConfig` (Task 3).
- Produces:
  - `validateModelMenuPayload(body: unknown): Validation<ModelMenuConfig>`;
  - `saveModelMenu(db: D1Database, shop: string, menu: ModelMenuConfig): Promise<void>`;
  - `saveLlm(db, shop, llm: LlmConfig)`, which now always keeps the stored `cfg.llm.menu`, whatever `llm.menu` holds.

- [ ] **Step 1: Write the failing tests.**

```ts
// validate.test.ts
it('accepts a menu and dedupes providers', () => {
  expect(validateModelMenuPayload({ providers: ['anthropic', 'anthropic', 'x-ai'], pins: ['a/b'], hides: [] }))
    .toEqual({ ok: true, value: { providers: ['anthropic', 'x-ai'], pins: ['a/b'], hides: [] } });
});
it('missing pins/hides default to []', () => { /* { providers: ['openai'] } -> pins [], hides [] */ });
it('rejects bad menus', () => {
  for (const b of [{ providers: [] }, { providers: ['Bad Id'] }, { providers: Array.from({ length: 21 }, (_, i) => `p${i}`) },
    { providers: ['a'], pins: Array.from({ length: 31 }, (_, i) => `a/m${i}`) }, { providers: ['a'], hides: ['not a slug'] }])
    expect(validateModelMenuPayload(b).ok).toBe(false);
});
it('refuses a floating alias pin with a specific message', () => {
  const v = validateModelMenuPayload({ providers: ['anthropic'], pins: ['~anthropic/claude-sonnet-latest'] });
  expect(v).toEqual({ ok: false, error: 'Floating "-latest" aliases cannot be pinned; pin a specific model instead.' });
});
// model-menu-config.test.ts (seed like tests/fulfil-settings-route.test.ts:44-56)
it('getConfig round-trips llm.menu', async () => { /* seedConfig with llm.menu -> getConfig().llm.menu equal */ });
it('getConfig drops a malformed stored menu instead of throwing', async () => { /* raw UPDATE llm = '{"menu":{"providers":"x"}}' -> menu undefined */ });
it('saveLlm keeps the stored menu', async () => { /* saveModelMenu then saveLlm({enabled,scoreThreshold,models}) -> menu still there */ });
it('saveModelMenu keeps models, enabled and scoreThreshold', async () => { /* saveLlm first, then saveModelMenu -> those unchanged */ });
it('a gates save keeps the menu', async () => { /* saveGates -> menu still there */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/validate.test.ts tests/model-menu-config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The `getConfig` llm parser adds `menu` only when `validateModelMenuPayload(raw.menu).ok`.
  - `saveLlm` writes `{ ...llm, menu: cfg.llm.menu }`.
  - `saveModelMenu` writes `{ ...cfg, llm: { ...cfg.llm, menu } }`.
  - In `validateModelMenuPayload`, check for a `~` pin before the slug shape, reuse `MODEL_SLUG`, and keep slugs to at most 100 characters.
- [ ] **Step 4: Run them.** `npx vitest run tests/validate.test.ts tests/model-menu-config.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/types.ts src/validate.ts src/tenant-store.ts src/console/routes.ts tests/validate.test.ts tests/model-menu-config.test.ts`, then `git commit -m "feat(models): llm.menu settings stored with merge-safe saves"`.

### Task 5: Live test (probe)

**Files:**
- Create: `src/model-probe.ts`
- Test: `tests/model-probe.test.ts`

**Interfaces:**
- Consumes: `LlmClient.jsonChain`, `REASONING_HEADROOM` (`src/llm.ts`), `TenantStore.logLlmUsage(task, model, promptTokens, completionTokens, costUsd)`.
- Produces:

```ts
export type ProbeMode = 'text' | 'vision';
export type ProbeResult = { ok: true } | { ok: false; reason: string };
export const PROBE_TIMEOUT_MS = 60_000;
export const PROBE_CACHE_DAYS = 7;
export const PROBE_IMAGE_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItjWNOawAi+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgsbomGHIoj2rgAAAABJRU5ErkJggg=='; // 64x64 orange PNG, verified to decode
export function probeCacheKey(slug: string, mode: ProbeMode): string; // `modelprobe:${slug}:${mode}`
export async function probeModel(llm: LlmClient, store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache' | 'logLlmUsage'>,
  model: { id: string; canonicalSlug: string | null }, mode: ProbeMode, timeoutMs?: number): Promise<ProbeResult>;
```

- [ ] **Step 1: Write the failing tests.** `new LlmClient({ openrouter: 'k' }, fakeFetch)`, where `fakeFetch` records each request body and returns an OpenRouter-shaped reply `{ model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }`. The store fake adds `logLlmUsage` that records its arguments.

```ts
it('passes, sends the production shape, and logs model-probe', async () => {
  const r = await probeModel(llm, store, { id: 'x/m', canonicalSlug: null }, 'text');
  expect(r).toEqual({ ok: true });
  expect(bodies[0]).toMatchObject({ models: ['x/m'], max_tokens: 3000, response_format: { type: 'json_object' } });
  expect(logged).toEqual([['model-probe', 'x/m', 10, 5, 0.0001]]);
});
it('vision mode attaches the probe image', async () => { /* bodies[0].messages[1].content[1].image_url.url === PROBE_IMAGE_DATA_URI */ });
it('a cached pass skips the call; the cache is per mode', async () => { /* text twice -> 1 fetch; then vision -> 2 fetches */ });
it('accepts the canonical slug as the answering model', async () => { /* reply model 'x/m-20261001', canonicalSlug 'x/m-20261001' -> ok */ });
it('fails when another model answered', async () => { /* reply model 'y/z' -> reason contains 'different model (y/z)' */ });
it('explains an empty reply as a token budget problem', async () => { /* content '' -> reason contains 'larger token budget' */ });
it('fails when the JSON is not the test answer', async () => { /* content '{"ok":false}' -> reason 'did not return the expected test answer' */ });
it('surfaces an OpenRouter refusal in plain words', async () => {
  /* 404 { error: { message: 'Project does not have access to model' } } -> reason === 'OpenRouter refused the call: Project does not have access to model' */
});
it('times out instead of hanging', async () => {
  const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
  const r = await probeModel(new LlmClient({ openrouter: 'k' }, hang), store, { id: 'x/m', canonicalSlug: null }, 'text', 50);
  expect(r.ok).toBe(false); expect((r as { reason: string }).reason).toMatch(/did not answer within/);
});
it('never caches a failure', async () => { /* 404 reply (no same-tier retry) then passing reply -> 2 fetches in all, second ok */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-probe.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement `probeModel`.**
  - Return early on a cache hit.
  - Call `llm.jsonChain` with:
    - `chain: [{ provider: 'openrouter', models: [model.id] }]`;
    - `maxTokens: REASONING_HEADROOM`;
    - `system`: return exactly the JSON object `{"ok": true}` and nothing else;
    - `images: [PROBE_IMAGE_DATA_URI]` in vision mode;
    - `validate: (v) => (v && typeof v === 'object' && (v as { ok?: unknown }).ok === true ? true : null)`.
  - Race it against a `setTimeout` of `timeoutMs`.
  - Map the error strings:
    - `LLM returned non-JSON` gives "did not return JSON (an empty reply usually means the model needs a larger token budget)";
    - `LLM JSON failed validation` gives "did not return the expected test answer";
    - any other error gives `OpenRouter refused the call: ${error}`;
    - a timeout gives `did not answer within ${Math.round(timeoutMs / 1000)} seconds`.
  - On success:
    - check that `usage.model` equals `model.id` or `model.canonicalSlug`;
    - log usage as `model-probe`;
    - cache the pass for `PROBE_CACHE_DAYS`.
  - A failure's tokens are not logged, because `jsonChain` returns no usage on failure. That is existing behaviour for every task; say so in a code comment.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-probe.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/model-probe.ts tests/model-probe.test.ts`, then `git commit -m "feat(models): live test in the production request shape"`.

### Task 6: Save check (changed slots, vision rule, price confirmation, live tests)

**Files:**
- Create: `src/model-save.ts`
- Test: `tests/model-save.test.ts`

**Interfaces:**
- Consumes: `FeedModel`, `feedCost` (Task 2); `ProbeMode`, `ProbeResult` (Task 5); `SYSTEM_DEFAULT_MODEL` (Task 1); `ModelsConfig`.
- Produces:

```ts
export type SlotName = 'image' | 'text' | 'fallback';
export const COST_CONFIRM_RATIO = 3;
export interface HeldSlot { slot: SlotName; slug: string; name: string; ratio: number | null; promptPriceM: number | null; completionPriceM: number | null }
export type ProbeFn = (model: FeedModel, mode: ProbeMode) => Promise<ProbeResult>;
export type SaveCheck = { ok: true } | { ok: false; status: 400; error: string } | { ok: false; status: 409; held: HeldSlot[] };
export async function checkModelSave(input: {
  stored: ModelsConfig; requested: ModelsConfig; loadFeed: () => Promise<FeedModel[] | null>;
  confirmCost: boolean; probe: ProbeFn | null;
}): Promise<SaveCheck>;
```

- [ ] **Step 1: Write the failing tests.** `const feed = reduceFeed(feedJson)`; `probe` is a `vi.fn` that resolves `{ ok: true }` unless a test overrides it; `LUNA = 'openai/gpt-5.6-luna'`.

```ts
it('unchanged slots never load the feed or probe', async () => {
  const loadFeed = vi.fn(async () => null);
  expect(await checkModelSave({ stored: { image: LUNA, text: LUNA, fallback: LUNA }, requested: { image: LUNA, text: LUNA, fallback: LUNA }, loadFeed, confirmCost: false, probe })).toEqual({ ok: true });
  expect(loadFeed).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
});
it('clearing a slot needs no check', async () => { /* stored fallback LUNA, requested fallback undefined -> ok, no probe */ });
it('feed down refuses only a change', async () => { /* changed text, loadFeed -> null -> 400 'Cannot verify new models right now; try again shortly.' */ });
it('refuses a slug OpenRouter does not list', async () => { /* text 'openai/nope' -> 400 'text model openai/nope is not offered by OpenRouter' */ });
it('refuses a floating alias even though the feed lists it', async () => { /* text '~anthropic/claude-sonnet-latest' -> 400 */ });
it('refuses a text-only model for image', async () => { /* image 'z-ai/glm-5.3' -> 400 'Image and Fallback must be vision-capable models' */ });
it('holds Luna -> Opus at about 17x and does not probe', async () => {
  const r = await checkModelSave({ stored: { text: LUNA }, requested: { text: 'anthropic/claude-opus-5.5' }, loadFeed: async () => feed, confirmCost: false, probe });
  expect(r).toMatchObject({ ok: false, status: 409, held: [{ slot: 'text', slug: 'anthropic/claude-opus-5.5', promptPriceM: 4, completionPriceM: 20 }] });
  expect((r as { held: HeldSlot[] }).held[0].ratio).toBeCloseTo(17.14, 1); expect(probe).not.toHaveBeenCalled();
});
it('confirmCost lets the held change through to its live test', async () => { /* same + confirmCost true -> ok; probe called once with mode 'text' */ });
it('a cheaper model is not held', async () => { /* LUNA -> 'anthropic/claude-haiku-5.5' -> ok, probe called */ });
it('exactly 3x is not held', async () => { /* synthetic feed: base cost 2, new cost 6 -> ok */ });
it('a blank slot compares with SYSTEM_DEFAULT_MODEL', async () => {
  /* stored text blank: Opus (24 vs 14 = 1.71x) -> ok; Fable 5.2 (48 vs 14 = 3.43x) -> 409 */
});
it('a delisted or free current model holds with ratio null', async () => {
  /* stored 'openai/gone' -> held ratio null; synthetic base with prices 0/0 -> held ratio null; no Infinity or NaN anywhere */
});
it('no OpenRouter key refuses a change', async () => { /* probe null, cheap change -> 400 'No OpenRouter key is configured, so new models cannot be tested.' */ });
it('a failed live test refuses the slot with the reason', async () => { /* probe -> { ok:false, reason:'r' } -> 400 'text model failed its live test: r' */ });
it('a model moved into fallback is tested in vision mode, and only there', async () => {
  /* stored { text: LUNA }, requested { text: LUNA, fallback: LUNA } -> ok; probe calls == [[luna, 'vision']] */
});
it('the same slug in image and fallback is probed once', async () => { /* both changed to haiku-5.5 -> one probe call */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-save.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement `checkModelSave`.** Steps, in order:
  1. Find the changed slots: `requested[s]` is non-empty and differs from `stored[s]`. If there are none, return ok.
  2. Load the feed once. If it is `null`, return a 400.
  3. Per changed slot, refuse a slug that is not in the feed, a `~` slug, or a model without `image` input in the image or fallback slot. Return the first refusal, in slot order image, text, fallback.
  4. Run the price check. The baseline is `stored[s] || SYSTEM_DEFAULT_MODEL`.
     - The ratio is `null` when the baseline is missing from the feed, its cost is null, or its cost is at most 0.
     - Hold the slot when the ratio is null or above 3.
     - If anything is held and `confirmCost` is false, return a 409 with every held slot.
  5. If `probe` is null, return the no-key 400.
  6. Probe each distinct (slug, mode) pair in parallel with `Promise.all`. The text slot uses `text`; image and fallback use `vision`.
  7. Return the first failure in slot order as a 400 that names the slot.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-save.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/model-save.ts tests/model-save.test.ts`, then `git commit -m "feat(models): save check with price confirmation and live tests"`.

### Task 7: Retirement watch and daily stage

**Files:**
- Create: `src/model-watch.ts`
- Modify: `src/jobs.ts` (`DAILY_SHOP_STAGES`: a new entry right after `order-webhooks`)
- Test: `tests/model-watch.test.ts`

**Interfaces:**
- Consumes: `FeedModel` (Task 2); `SlotName` (Task 6); `AlertResult` (`src/owner-alert.ts`); `SEARCH_MODEL`.
- Produces:

```ts
export type WatchState = 'ok' | 'retiring' | 'delisted';
export interface SlotStatus { slug: string; state: WatchState; retiresOn: string | null }
export const RETIRE_WARN_DAYS = 30;
export const WATCH_ALERT_KEY = 'modelwatch:alerted';
export const WATCH_ALERT_TTL_DAYS = 90;
export function modelState(slug: string, feed: FeedModel[], nowMs: number): { state: WatchState; retiresOn: string | null };
export function selectedStatus(models: ModelsConfig, feed: FeedModel[], nowMs: number): Partial<Record<SlotName, SlotStatus>>;
export async function runModelWatch(store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>, models: ModelsConfig,
  searchModel: string, feed: FeedModel[], nowMs: number, send: (subject: string, text: string) => Promise<AlertResult>): Promise<number>; // send calls made this run
```

- [ ] **Step 1: Write the failing tests.** `NOW = Date.parse('2026-11-13T12:00:00Z')`.

```ts
it('gpt-5-mini is retiring on 2026-12-11; Luna is ok; an unknown slug is delisted', () => {
  expect(modelState('openai/gpt-5-mini', feed, NOW)).toEqual({ state: 'retiring', retiresOn: '2026-12-11' });
  expect(modelState('openai/gpt-5.6-luna', feed, NOW).state).toBe('ok');
  expect(modelState('openai/gone', feed, NOW)).toEqual({ state: 'delisted', retiresOn: null });
  expect(modelState('openai/gpt-5-mini', feed, Date.parse('2026-11-01T00:00:00Z')).state).toBe('ok'); // 40 days out
});
it('selectedStatus covers set slots only', () => { /* { text: gpt-5-mini } -> { text: { slug, state:'retiring', retiresOn:'2026-12-11' } } */ });
it('alerts once per (slug, state)', async () => { /* run twice with gpt-5-mini as text -> 1 then 0; subject contains 'openai/gpt-5-mini' */ });
it('a cleared issue that returns alerts again', async () => { /* run(mini) -> 1; run(luna) -> 0; run(mini) -> 1 */ });
it('a failed send is retried next run', async () => { /* send -> 'failed', then 'sent': runs return 1, 1, then 0 */ });
it('one email per slug, naming every slot it fills', async () => { /* image+fallback both 'openai/gone' -> 1 email; text names both slots */ });
it('the search model alert says a code change is needed', async () => { /* searchModel 'anthropic/gone' -> text contains 'code change' */ });
it('the daily chain runs model-watch without needing CJ', () => {
  const s = DAILY_SHOP_STAGES.find((x) => x.name === 'model-watch');
  expect(s?.needsCj).toBe(false);
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-watch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `modelState`: the state is "retiring" when `expiresOn` is at most 30 days from `nowMs`.
  - `runModelWatch`:
    - builds the current issues as `slug|state` for the set slots plus `searchModel` (non-ok only), with each slug's slots grouped;
    - reads the remembered set (a JSON array, where corrupt counts as empty) and sends one email per issue not remembered;
    - remembers an issue unless `send` returned `'failed'`;
    - writes back (remembered ∩ current) ∪ the newly remembered issues.
  - Email copy, plain and with no dashes:
    - subject `PawScout: AI model ${slug} is ${delisted ? 'no longer offered by OpenRouter' : `retiring on ${retiresOn}`}`;
    - the body names the slots and says "Open Settings > AI models and pick a replacement.", or for the search model "This is PawScout's built-in research model, so replacing it needs a code change.".
  - The stage is `{ name: 'model-watch', maxMs: 1 * MIN_MS, needsCj: false, run }`.
    - `run` calls `loadFeed(ctx.store)`;
    - it returns quietly on `null`;
    - otherwise it calls `runModelWatch(ctx.store, ctx.cfg.llm.models, SEARCH_MODEL, feed, Date.now(), (s, t) => alertOwner(ctx.env, ctx.cfg, s, t))`.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-watch.test.ts tests/jobs.test.ts`. Expected: PASS. `tests/jobs.test.ts` covers the existing stage chain and must stay green with the new stage.
- [ ] **Step 5: Commit.** `git add src/model-watch.ts src/jobs.ts tests/model-watch.test.ts`, then `git commit -m "feat(models): daily model-watch alerts on retiring or delisted models"`.

### Task 8: Routes, and removal of the curated catalog

**Files:**
- Modify: `src/index.ts:252-259` (delete `visionModelRejected`), `src/index.ts:1279-1302` (`/api/llm`, `/api/models`), plus a new `POST /api/models/menu` beside them
- Delete: `src/models-catalog.ts`, `tests/models-catalog.test.ts`, `tests/api-models.test.ts`
- Test: `tests/model-routes.test.ts` (new; harness copied from `tests/fulfil-settings-route.test.ts:35-64`)

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces:
  - `export function modelsPayload(feed: FeedModel[] | null, llm: LlmConfig, nowMs: number)` in `src/index.ts`, which builds the GET body below. It is pure, so the no-feed case is unit-tested without a network call, the same way `visionModelRejected` used to be exported and tested from `src/index.ts`.
- Produces (HTTP):
  - `GET /api/models` returns `{ ok: true, feedAvailable: boolean, groups: MenuGroup[], menu: ModelMenuConfig, selectedStatus: Partial<Record<SlotName, SlotStatus>> }`.
    - `menu` is `effectiveMenu(cfg.llm.menu)`.
    - When the feed is unavailable, `groups` is `buildMenu([], …)`, so it holds only the pins, and `selectedStatus` is `{}`.
  - `POST /api/llm`:
    - the body is today's plus optional `confirmCost: boolean` and `dryRun: boolean`;
    - it answers `200 { ok: true }`, `200 { ok: true, dryRun: true }` (nothing stored), `400 { ok: false, error }` or `409 { ok: false, held: HeldSlot[] }`.
  - `POST /api/models/menu`:
    - the body is `ModelMenuConfig`;
    - it answers `200 { ok: true, menu }` or `400 { ok: false, error }`.

- [ ] **Step 1: Write the failing tests.**
  - Seed the tenant with `llm.models = { image: LUNA, text: LUNA, fallback: LUNA }`.
  - Seed the feed cache with `store.putSearchCache(FEED_CACHE_KEY, JSON.stringify(reduceFeed(feedJson)), 1)`.
  - Seed probe passes with `store.putSearchCache(probeCacheKey(slug, mode), '1', 7)` for each slug a test saves, so no test reaches the network.
  - Pass `{ ...env, SHOPIFY_API_SECRET: SECRET, OPENROUTER_API_KEY: 'test-key' }`.

```ts
it('GET /api/models returns grouped menu, effective settings and slot status', async () => {
  /* feedAvailable true; groups[0].provider 'anthropic'; groups[0].entries[0].slug 'anthropic/claude-fable-5.2';
     menu.providers has 10 entries; selectedStatus.text.state 'ok' */
});
it('modelsPayload with no feed returns pins only and feedAvailable false', () => {
  const p = modelsPayload(null, { ...DEFAULT_LLM, models: { text: LUNA }, menu: { providers: ['anthropic'], pins: ['a/b'], hides: [] } }, Date.now());
  expect(p).toMatchObject({ ok: true, feedAvailable: false, selectedStatus: {}, groups: [{ provider: 'a', entries: [{ slug: 'a/b', available: false }] }] });
});
it('saving only the threshold succeeds with Luna off the menu', async () => {
  /* POST { enabled:true, scoreThreshold:55, models: all LUNA } -> 200; stored threshold 55; models unchanged */
});
it('an expensive change is held and stores nothing', async () => { /* text -> opus -> 409 held[0].slug opus; stored text still LUNA */ });
it('confirmCost saves it', async () => { /* + confirmCost true (probe pass seeded) -> 200; stored text opus */ });
it('dryRun runs the checks and stores nothing', async () => { /* + confirmCost + dryRun -> 200 { ok:true, dryRun:true }; stored text LUNA */ });
it('a menu save keeps the models, and a models save keeps the menu', async () => {
  /* POST /api/models/menu { providers:['x-ai'] } -> 200; then threshold save -> stored llm.menu.providers ['x-ai'], models unchanged */
});
it('a floating alias pin is refused', async () => { /* POST /api/models/menu pins ['~anthropic/claude-sonnet-latest'] -> 400 */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Wire the routes as specified.
  - In `/api/llm`:
    - read `cfg` (400 `Not configured` if absent);
    - pass `loadFeed: () => loadFeed(store)`;
    - build `probe` only when `c.env.OPENROUTER_API_KEY` is set, using `new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY })`;
    - read `confirmCost`/`dryRun` as `=== true`;
    - on success, call `saveLlm` unless `dryRun`.
  - Delete `visionModelRejected` and the `models-catalog` import, then delete the three files.
  - Run `python -P -m graphite build .`, then `python -P -m graphite search "CURATED_MODELS"`. It must report no `src/` or `tests/` match.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-routes.test.ts`, then `npm run typecheck`. Expected: PASS and no type errors.
- [ ] **Step 5: Commit.** `git add -A src/index.ts src/models-catalog.ts tests/models-catalog.test.ts tests/api-models.test.ts tests/model-routes.test.ts`, then `git commit -m "feat(models): menu, save-check and menu-settings routes; remove the curated catalog"`.

### Task 9: Console AI models card

**Files:**
- Modify: `src/console/views/settings.ts:20-32`
- Modify: `src/console/page.ts:229-264` (option building), `:299-303` (select fill), `:476-491` (`saveLlm`)
- Test: `tests/console.test.ts` (append)

**Interfaces:**
- Consumes: the Task 8 HTTP shapes.
- Produces (page script functions, all at top level of the inline script so tests can extract them):
  - `modelOptionsHtml(groups, vision)` returns `string`;
  - `providerLabel(id)` returns `string`;
  - `heldMessage(h, slotLabel)` returns `string`;
  - `saveLlm(confirm)`, where `confirm` is `true` only from the "Save anyway" button.

- [ ] **Step 1: Write the failing tests.** Extract the functions with the brace-matching helper used at `tests/console.test.ts:165-184`, then drive them:

```ts
it('modelOptionsHtml groups by provider, filters vision, flags retirement and unavailable pins', async () => {
  const groups = [{ provider: 'anthropic', entries: [
    { slug: 'anthropic/a', name: 'A <b>', vision: true, promptPriceM: 4, completionPriceM: 20, retiresOn: '2026-12-11', pinned: false, available: true },
    { slug: 'anthropic/t', name: 'T', vision: false, promptPriceM: 1, completionPriceM: 2, retiresOn: null, pinned: false, available: true },
    { slug: 'anthropic/p', name: 'anthropic/p', vision: false, promptPriceM: null, completionPriceM: null, retiresOn: null, pinned: true, available: false }] }];
  const all = modelOptionsHtml(groups, false), vis = modelOptionsHtml(groups, true);
  expect(all).toContain('<optgroup label="Anthropic">');
  expect(all).toContain('A &lt;b&gt; - $4/M in · $20/M out · 👁 · retires 2026-12-11');
  expect(all).toMatch(/<option value="anthropic\/p" disabled>[^<]*unavailable/);
  expect(vis).not.toContain('anthropic/t');
});
it('heldMessage gives a ratio, or the prices when the ratio is unknown', async () => {
  expect(heldMessage({ name: 'Claude Opus 5.5', ratio: 17.14, promptPriceM: 4, completionPriceM: 20 }, 'text'))
    .toBe('Claude Opus 5.5 costs about 17x your current text model ($4/M in, $20/M out). Save anyway?');
  expect(heldMessage({ name: 'X', ratio: null, promptPriceM: 4, completionPriceM: 20 }, 'image'))
    .toBe('X costs $4/M in, $20/M out, and the current image model has no known price to compare. Save anyway?');
});
it('the AI models card carries the menu controls and the fixed copy', async () => {
  const html = await consolePage('test-key').text();
  for (const s of ['id="llm-menu"', 'id="mdl-provider-add"', 'id="mdl-pin"', 'id="llm-fallback-hint"', 'id="llm-models-warn"',
    "'/models/menu'", 'confirmCost', 'Save anyway', 'Testing the new model...', 'Model list unavailable right now',
    'Fallback is the same as the text model, so there is no second model to switch to.', 'Last resort: GPT-5.4 mini']) expect(html).toContain(s);
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/console.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Replace `ensureModelOptions` with `loadModelMenu()`. It caches the GET promise, and `invalidateModelMenu()` clears it after a menu save.
  - `setModelSelect` builds its options from `modelOptionsHtml` and keeps `setSelectValue`'s "(current)" behaviour. The blank labels are `- system default` for image and text and `- none` for fallback.
  - `providerLabel` maps:
    - `anthropic` to Anthropic;
    - `openai` to OpenAI;
    - `google` to Google;
    - `x-ai` to xAI;
    - `deepseek` to DeepSeek;
    - `qwen` to Qwen;
    - `moonshotai` to Moonshot (Kimi);
    - `z-ai` to Z.ai;
    - `minimax` to MiniMax;
    - `mistralai` to Mistral;
    - anything else to its raw id.
  - Under the selects, add:
    - `#llm-fallback-hint`, filled on select change and after load, when fallback equals text;
    - `#llm-models-warn`, one line per `selectedStatus` slot that is retiring or delisted.
  - Add `#llm-menu`, a `<details>` titled "Menu: providers, pins and hidden models", containing:
    - the provider chips, each with a remove button, plus `#mdl-provider-add` and an Add button;
    - `#mdl-pin` with a Pin button;
    - the menu entries per provider, each with a Hide button;
    - the hidden and pinned lists, with Unhide and Unpin buttons.
    Every change POSTs the full block to `'/models/menu'`, then invalidates the menu and refills the selects.
  - `saveLlm(confirm)`:
    - shows "Testing the new model..." while in flight;
    - sends `confirmCost: confirm === true`;
    - on a 409, writes the `heldMessage` lines plus a "Save anyway" button (calling `saveLlm(true)`) into `#llm-models-msg`, and the plain text into `#llmmsg`;
    - otherwise keeps today's Saved/Failed messages.
  - When `feedAvailable` is false, show "Model list unavailable right now" in `#llm-models-warn`.
  - Format prices as `'$'+n` with no trailing zeros.
- [ ] **Step 4: Run them.** `npx vitest run tests/console.test.ts`, then `npm run lint`. Expected: PASS, and lint is clean.
- [ ] **Step 5: Commit.** `git add src/console/views/settings.ts src/console/page.ts tests/console.test.ts`, then `git commit -m "feat(console): provider-grouped model menu, menu settings and price confirmation"`.

### Task 10: Gate, staging, and production verification

**Files:** none, apart from the backlog memory note at the end.

- [ ] **Step 1: Run the full gate.** `npm test`, `npm run typecheck` and `npm run lint`, each redirected to a file, and read the exit codes directly. Expected: all three exit 0.
- [ ] **Step 2: Scan for dashes.** Run `git diff master --stat`, then search the added lines for the en dash and em dash characters (code points U+2013 and U+2014; write the regex with backslash-u escapes so the plan itself stays clean). Expected: 0 hits.
- [ ] **Step 3: Push and wait for CI.** Push, then run `gh run list --branch feat/self-updating-model-menu --limit 1`. Expected: CI succeeds for HEAD.
- [ ] **Step 4: Deploy to staging.** `npm run deploy -- --env staging`. Expected: the deploy succeeds and the smoke test passes. Staging cannot open the console, because it has no shop.
- [ ] **Step 5: Merge to master and ask the owner for production.** Merge with `--no-ff`, as for the earlier branches, and push. Ask the owner for "deploy <sha> to production". Do not deploy without that exact sentence.
- [ ] **Step 6: Verify on production, after the owner's go and the guarded deploy.** Work through the admin iframe session (memory: call-session-authed-routes-via-iframe).
  - `GET /api/models` returns `feedAvailable: true`, Anthropic first, and the stored slots as `ok`.
  - `POST /api/llm` with text set to `anthropic/claude-opus-5.5` and `dryRun: true` returns 409 with a ratio of about 17.
  - `POST /api/llm` with text set to `anthropic/claude-haiku-5.5` and `dryRun: true` runs a real live test and returns `{ ok: true, dryRun: true }`.
  - A D1 read shows the stored `llm.models` unchanged and one `llm_usage` row with task `model-probe`.
- [ ] **Step 7: Update `pawscout-backlog.md`** with the deployed sha and what was verified.
