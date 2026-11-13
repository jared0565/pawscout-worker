# Self-updating AI model menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-curated 12-model list in Settings > AI models with a menu built from the live OpenRouter feed. The menu shows the newest model per family, grouped by an owner-controlled provider list, and lets the owner pick a reasoning effort for the Image and Text slots. Saves are gated by a live test and a price confirmation, and a daily watch flags retiring models and efforts a model no longer offers.

**Architecture:** New modules, each pure or close to it:
- `models-feed`: reads and caches the OpenRouter feed;
- `model-menu`: builds the menu;
- `model-probe`: runs the live test;
- `model-save`: checks a save;
- `model-watch`: the daily retirement and effort watch.

They are wired into:
- the existing `/api/models` and `/api/llm` routes;
- a new `/api/models/menu` route;
- one daily shop stage;
- the console's AI models card.

The reasoning effort rides on the OpenRouter tier that `resolveChain` builds, and `LlmClient` sends it with an effort-sized `max_tokens`. `src/models-catalog.ts` and `visionModelRejected` are deleted at the end. There is no D1 migration: everything new lives inside the existing `tenant_config.llm` JSON.

**Tech Stack:** TypeScript Cloudflare Worker, Hono, D1, vitest with `@cloudflare/vitest-plugin` (`cloudflare:test` for D1 route tests), inline console JS in template literals.

**Spec:** `docs/superpowers/specs/2026-11-13-self-updating-model-menu-design.md`

## Global Constraints

- **Writing rules:**
  - No em or en dashes anywhere: code, comments, console copy, email copy, commit messages.
  - Never pass `--no-verify`. Before every commit, run `aramid check --staged`. If a tool reports "gate budget expired", re-run once, without a push running at the same time.
  - Push after every commit. The branch is `feat/self-updating-model-menu`.
- **Before editing a shared file**, run `python -P -m graphite impact <file>` and read the call sites it names. The shared files are `src/index.ts`, `src/tenant-store.ts`, `src/types.ts`, `src/validate.ts`, `src/llm.ts`, `src/llm-resolve.ts`, `src/jobs.ts`, `src/console/routes.ts` and `src/console/page.ts`.
- **What must not change:**
  - Nothing may write `llm.models` except a `POST /api/llm` save.
  - `resolveSearchChain`, `SEARCH_MODEL`, `DEFAULT_MODEL` and the OpenAI tier's `reasoning_effort: 'medium'` stay unchanged.
  - With no effort stored, every request body is byte-for-byte what it is today.
- **The console script lives in template literals:**
  - double-escape backslashes;
  - never use `window.confirm`/`alert`, which are blocked in the admin iframe;
  - after any console edit, run `npx vitest run tests/console.test.ts` and `npm run lint`.
- **Values fixed by the spec:**
  - The feed cache key is `openrouter:models:v2`, with a TTL of 1 day.
  - The default providers are `anthropic, openai, google, x-ai, deepseek, qwen, moonshotai, z-ai, minimax, mistralai`.
  - Staleness is 6 months, which is `183 * 86400` seconds. At most 6 families show per provider.
  - The probe times out after 60 s. Its pass cache lasts 7 days at `modelprobe:<slug>:<text|vision>:<effort|default>`.
  - Saves are held above a price ratio of 3 (`> 3`, not `>= 3`).
  - The retirement window is 30 days.
  - `SYSTEM_DEFAULT_MODEL = 'google/gemini-3.1-pro-preview'`.
  - Provider ids match `^[a-z0-9-]+$`, with 1 to 20 of them. Pins and hides are capped at 30 each, and every pin or hide must be an OpenRouter slug of at most 100 characters.
  - The effort levels, in display order, are `max, xhigh, high, medium, low, minimal, none`.
  - The effort token budget is `min(ceil(max(n, 3000) * 100 / answerPct), 64000)`, with `answerPct` of max 5, xhigh 5, high 20, medium 50, low 80, minimal 90 and none 100. With no effort set, the budget is `max(n, 3000)`. Use integer arithmetic, so 3750 never becomes 3751.
  - The probe's task size is 4800 tokens, matching the largest production task (`src/blog/draft.ts`).
- **Copy fixed by the spec:**
  - "Cannot verify new models right now; try again shortly."
  - "No OpenRouter key is configured, so new models cannot be tested."
  - "Image and Fallback must be vision-capable models"
  - "Fallback is the same as the text model, so there is no second model to switch to."
  - "Model list unavailable right now"
  - "Testing the new model..."
  - "Save anyway"
  - "Model default"
  - "Off" (the label for `none`)
  - "Higher effort means more thinking, billed as output tokens."
- **Test data:** tests use the checked-in fixture `tests/fixtures/openrouter-models-2026-11-13.json`.
  - It holds 331 rows trimmed from the 2026-11-13 feed: only the fields the reducer reads, `supported_parameters` cut down to `response_format`/`structured_outputs`, and `reasoning` cut down to `mandatory`, `supported_efforts` and `default_effort`.
  - The fixed "now" for menu tests is `Date.parse('2026-11-13T12:00:00Z')`.
- **Commands:** run a single file with `npx vitest run <path>`. The full gate is `npm test`, `npm run typecheck` and `npm run lint`.

## Review Focus

1. **Saving only the curation threshold** (Catalog "Save AI") must succeed even when a stored model is off the menu or the feed is down. It must also not fetch the feed or run a probe. Pinned in Task 7 (`unchanged slots never load the feed or probe`) and Task 9 (route).
2. **A select saved blank by accident**, because the menu fetch failed or Save was clicked before the options loaded. The saved slug must stay selected as "(current)". If a blank still reaches the server, it is treated as a change to `SYSTEM_DEFAULT_MODEL` (about 10x Luna) and held, never stored silently. Pinned in Task 7 (cleared-slot tests) and Task 10 (rejected-fetch test).
3. **An effort the fallback cannot run, or one a model stops listing.** The single request carries one effort, and a 400 stops the chain with no fallback tier. Such an effort must be refused at save time, and must raise a watch alert if it becomes unsupported later. Pinned in Task 7 (fallback intersection tests) and Task 8 (effort watch).
4. **A model moved into another slot** (the text model reused as fallback) counts as changed for that slot only. It is tested in that slot's mode, and the untouched slot gets no probe. Pinned in Task 7.
5. **OpenRouter never answers.** The save must come back with a plain reason instead of hanging the console. Pinned in Task 6 (timeout test).

Feed shape drift (Task 3) and a free or delisted current model (Task 7, `ratio: null`, never `Infinity`/`NaN`) also have their own tests.

---

### Task 1: System default model constant

**Files:**
- Modify: `src/llm.ts` (next to `SEARCH_MODEL`, line ~71)
- Modify: `src/llm-resolve.ts:1-23`
- Modify: `src/types.ts:111-115` (the `ModelsConfig` comments)
- Test: `tests/llm-resolve.test.ts`

**Interfaces:**
- Produces: `export const SYSTEM_DEFAULT_MODEL = 'google/gemini-3.1-pro-preview'` in `src/llm.ts`. `src/llm-resolve.ts` no longer imports `src/models-catalog.ts`.

- [ ] **Step 1: Update the test.** In `tests/llm-resolve.test.ts`, replace the `CURATED_MODELS` import and `HEAD` with `SYSTEM_DEFAULT_MODEL` from `../src/llm`, and add:

```ts
it('the blank-slot default is pinned to the old menu head', () => {
  expect(SYSTEM_DEFAULT_MODEL).toBe('google/gemini-3.1-pro-preview');
  expect(resolveChain(base({}), 'image')[0]).toEqual({ provider: 'openrouter', models: [SYSTEM_DEFAULT_MODEL] });
});
```

- [ ] **Step 2: Run it.** `npx vitest run tests/llm-resolve.test.ts`. Expected: FAIL, because `SYSTEM_DEFAULT_MODEL` is not exported.
- [ ] **Step 3: Implement.**
  - Add the constant to `src/llm.ts`, with a comment saying it is the blank-slot default and was the curated menu head on 2026-11-13.
  - In `resolveChain`, use the constant instead of `CURATED_MODELS[0].slug`, and drop the `models-catalog` import.
  - Rewrite the doc comment at `src/llm-resolve.ts:7-11` so it names `DEFAULT_MODEL` without claiming any model ID.
  - Update the `ModelsConfig` comments to say "blank → SYSTEM_DEFAULT_MODEL".
- [ ] **Step 4: Run it.** `npx vitest run tests/llm-resolve.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/llm.ts src/llm-resolve.ts src/types.ts tests/llm-resolve.test.ts`, then `git commit -m "refactor(llm): SYSTEM_DEFAULT_MODEL replaces the curated menu head as the blank-slot default"`.

### Task 2: Reasoning effort in the call path

**Files:**
- Modify: `src/types.ts` (`ModelsConfig`, plus the new effort type)
- Modify: `src/llm.ts:99-102` (`ChainTier`), `:210-212` (OpenRouter body)
- Modify: `src/llm-resolve.ts` (`resolveChain` only)
- Modify: `src/validate.ts:142-158` (`validateLlmPayload`)
- Test: `tests/llm-resolve.test.ts`, `tests/llm-effort.test.ts` (new), `tests/validate.test.ts`

**Interfaces:**
- Produces:

```ts
// src/types.ts
export const EFFORT_LEVELS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const;
export type ReasoningEffort = typeof EFFORT_LEVELS[number];
export interface ModelsConfig { image?: string; text?: string; fallback?: string; imageEffort?: ReasoningEffort; textEffort?: ReasoningEffort }
// src/llm.ts
export type ChainTier = { provider: 'openrouter'; models: string[]; effort?: ReasoningEffort } | { provider: 'openai'; model: string };
export const EFFORT_TOKEN_CEILING = 64000;
export function effortMaxTokens(n: number, effort?: ReasoningEffort): number;
```

- [ ] **Step 1: Write the failing tests.**

```ts
// llm-effort.test.ts
it('no effort keeps the old floor', () => { expect(effortMaxTokens(1200)).toBe(3000); expect(effortMaxTokens(4800)).toBe(4800); });
it('sizes the cap by the share left for the answer', () => {
  const at = (e: ReasoningEffort) => effortMaxTokens(1200, e);
  expect([at('none'), at('minimal'), at('low'), at('medium'), at('high'), at('xhigh'), at('max')])
    .toEqual([3000, 3334, 3750, 6000, 15000, 60000, 60000]);
  expect(effortMaxTokens(4800, 'high')).toBe(24000);
  expect(effortMaxTokens(4800, 'max')).toBe(EFFORT_TOKEN_CEILING);
});
it('sends reasoning.effort and the sized cap only when an effort is set', async () => {
  /* LlmClient({ openrouter: 'k' }, recordingFetch).jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b'], effort: 'high' }], maxTokens: 1200, ... })
     -> body.reasoning toEqual { effort: 'high' }, body.max_tokens 15000.
     Same call without effort -> 'reasoning' in body === false, body.max_tokens 3000.
     An openai tier body still has reasoning_effort 'medium' and no 'reasoning' key. */
});
// llm-resolve.test.ts
it('each role carries only its own effort', () => {
  const cfg = base({ text: 'a/b', image: 'c/d', textEffort: 'high', imageEffort: 'low' });
  expect(resolveChain(cfg, 'text')[0]).toEqual({ provider: 'openrouter', models: ['a/b'], effort: 'high' });
  expect(resolveChain(cfg, 'image')[0]).toEqual({ provider: 'openrouter', models: ['c/d'], effort: 'low' });
  expect(resolveChain(base({ text: 'a/b' }), 'text')[0]).toEqual({ provider: 'openrouter', models: ['a/b'] }); // no effort key at all
  expect(resolveSearchChain(cfg)[0]).not.toHaveProperty('effort');
});
// validate.test.ts
it('accepts efforts and drops a blank one', () => { /* models { imageEffort: 'high', textEffort: '' } -> value.models { imageEffort: 'high' } */ });
it('rejects an unknown effort', () => {
  expect(validateLlmPayload({ enabled: true, scoreThreshold: 50, models: { textEffort: 'extreme' } }))
    .toEqual({ ok: false, error: 'textEffort must be one of max, xhigh, high, medium, low, minimal, none' });
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/llm-effort.test.ts tests/llm-resolve.test.ts tests/validate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `effortMaxTokens` uses an `answerPct` record with integer arithmetic: `Math.min(Math.ceil(Math.max(n, REASONING_HEADROOM) * 100 / pct), EFFORT_TOKEN_CEILING)`. An undefined effort returns `Math.max(n, REASONING_HEADROOM)`.
  - The OpenRouter body uses `max_tokens: effortMaxTokens(opts.maxTokens ?? 1024, tier.effort)` and sets `body.reasoning = { effort }` only when `tier.effort` is set.
  - `resolveChain` adds `effort` only when the role's effort is set: use `...(effort ? { effort } : {})`, so every existing `toEqual` stays green.
  - `validateLlmPayload` copies `imageEffort`/`textEffort` when they are in `EFFORT_LEVELS`, skips `''` or undefined, and rejects anything else.
- [ ] **Step 4: Run them.** `npx vitest run tests/llm-effort.test.ts tests/llm-resolve.test.ts tests/validate.test.ts tests/llm.test.ts`. Expected: PASS. `tests/llm.test.ts` covers today's request bodies and must stay green unchanged.
- [ ] **Step 5: Commit.** `git add src/types.ts src/llm.ts src/llm-resolve.ts src/validate.ts tests/llm-effort.test.ts tests/llm-resolve.test.ts tests/validate.test.ts`, then `git commit -m "feat(llm): per-slot reasoning effort with an effort-sized token cap"`.

### Task 3: Feed reader

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
  efforts: string[]; defaultEffort: string | null; // reasoning.supported_efforts / default_effort ([] / null when absent)
}
export const FEED_CACHE_KEY = 'openrouter:models:v2';
export function reduceFeed(payload: unknown): FeedModel[];
export async function loadFeed(store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>, fetchImpl?: typeof fetch): Promise<FeedModel[] | null>;
export function feedCost(m: FeedModel): number | null; // promptPriceM + completionPriceM, null if either is null
```

- [ ] **Step 1: Write the failing tests.** Import the fixture with `import feedJson from './fixtures/openrouter-models-2026-11-13.json'`. Use the `fakeStore()` pattern from the old `tests/models-catalog.test.ts:67-73`.

```ts
it('reduces every fixture row', () => { expect(reduceFeed(feedJson)).toHaveLength(331); });
it('maps prices to $/M, keeps the canonical slug and the efforts', () => {
  const f = reduceFeed(feedJson); const by = (id: string) => f.find((m) => m.id === id)!;
  const opus = by('anthropic/claude-opus-5.5');
  expect([opus.promptPriceM, opus.completionPriceM, opus.json]).toEqual([4, 20, true]);
  expect(opus.outputs).toEqual(['text']);
  expect(by('openai/gpt-5.6-luna').canonicalSlug).toBe('openai/gpt-5.6-luna-20260709');
  expect(by('openai/gpt-5-mini').expiresOn).toBe('2026-12-11');
  expect(feedCost(opus)).toBe(24);
  expect([by('anthropic/claude-fable-5.2').efforts, by('anthropic/claude-fable-5.2').defaultEffort])
    .toEqual([['max', 'xhigh', 'high', 'medium', 'low'], 'high']);
  expect(by('qwen/qwen3.8-flash').efforts).toEqual([]);
});
it('skips malformed rows and never throws', () => {
  expect(reduceFeed(null)).toEqual([]);
  expect(reduceFeed({ data: [null, 5, 'x', { name: 'no id' }] })).toEqual([]);
  const [m] = reduceFeed({ data: [{ id: 'a/b', created: 1, pricing: { prompt: 'abc', completion: '0.000001' } }] });
  expect(m.promptPriceM).toBeNull(); expect(m.completionPriceM).toBe(1); expect(m.inputs).toEqual([]); expect(m.efforts).toEqual([]);
});
it('loadFeed caches under the v2 key; a second call does not fetch', async () => { /* calls === 1; getSearchCache(FEED_CACHE_KEY) not null */ });
it('ignores an old-shape entry under the v1 key', async () => { /* store holds 'openrouter:models' -> fetch still happens */ });
it('refetches when the cached JSON is corrupt', async () => { /* put '{not json' under FEED_CACHE_KEY -> fetch happens, result length 331 */ });
it('returns null on a throw, a 500, or a 200 with zero usable rows, and caches none of them', async () => { /* three fetchImpls; each -> null; cache still empty */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/models-feed.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `src/models-feed.ts`.**
  - `reduceFeed` skips any row without a string `id` or a finite `created`.
  - A price that does not parse to a finite number becomes `null`. A negative price is kept, because the menu filter drops it.
  - `efforts` keeps only strings that appear in `EFFORT_LEVELS`.
  - `loadFeed` reads the cache first; corrupt JSON or a non-array counts as a miss. It then fetches `https://openrouter.ai/api/v1/models` through `defaultFetch`.
  - It caches only a non-empty result, for 1 day, and returns `null` for an empty one. It catches everything.
- [ ] **Step 4: Run them.** `npx vitest run tests/models-feed.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/models-feed.ts tests/models-feed.test.ts`, then `git commit -m "feat(models): OpenRouter feed reader with a v2 cache key"`.

### Task 4: Menu builder

**Files:**
- Create: `src/model-menu.ts`
- Modify: `src/types.ts` (add `ModelMenuConfig`)
- Test: `tests/model-menu.test.ts`

**Interfaces:**
- Consumes: `FeedModel` (Task 3).
- Produces:

```ts
// src/types.ts
export interface ModelMenuConfig { providers: string[]; pins: string[]; hides: string[] }
// src/model-menu.ts
export const DEFAULT_MENU_PROVIDERS: string[]; // the 10 ids, in spec order
export const MENU_STALE_SECONDS = 183 * 86400;
export const MENU_MAX_PER_PROVIDER = 6;
export interface MenuEntry {
  slug: string; name: string; provider: string; vision: boolean;
  promptPriceM: number | null; completionPriceM: number | null; // rounded to 3 decimals
  created: number | null; retiresOn: string | null; pinned: boolean; available: boolean;
  efforts: string[]; defaultEffort: string | null;
}
export interface MenuGroup { provider: string; entries: MenuEntry[] }
export function effectiveMenu(menu?: ModelMenuConfig): ModelMenuConfig; // undefined -> defaults, pins [], hides []
export function isMenuCandidate(m: FeedModel, ids: Set<string>): boolean; // spec 5.2 step 2 only
export function familyKey(slug: string): string;
export function buildMenu(feed: FeedModel[], menu: ModelMenuConfig | undefined, nowSec: number): MenuGroup[];
```

- [ ] **Step 1: Write the failing tests.** Set up three helpers:
  - `const NOW = Date.parse('2026-11-13T12:00:00Z') / 1000`;
  - `const feed = reduceFeed(feedJson)`;
  - `const slugs = (g: MenuGroup[], p: string) => g.find((x) => x.provider === p)?.entries.map((e) => e.slug) ?? []`.

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
it('entries carry vision, prices, retirement and efforts', () => {
  /* pin openai/gpt-5-mini -> retiresOn '2026-12-11'; z-ai/glm-5.3 vision false;
     mistralai/mistral-large-4-0 efforts ['high', 'none'] and defaultEffort 'high' */
});
it('an empty feed yields only pins, all unavailable', () => {
  expect(buildMenu([], { providers: ['anthropic'], pins: ['a/b'], hides: [] }, NOW))
    .toEqual([{ provider: 'a', entries: [expect.objectContaining({ slug: 'a/b', available: false, efforts: [] })] }]);
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-menu.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `src/model-menu.ts`** with these exact rules, which were checked against the fixture:

```ts
const VARIANT = /(?:^|-)(?:legal|code|coder|customtools|multi-agent|exp)(?:-|$)|guard/; // tested on the name after '/'
const DATED = /^(.*)-(\d{4}|\d{6}|\d{8})$/;
// familyKey: provider + '/' + name.replace(/-preview/g, '').replace(/v?\d+(?:\.\d+)*/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
```

  - **Candidate filter.** A model passes only if all of these hold, checked in order:
    - its provider is listed;
    - its id has no `:`;
    - its outputs are exactly `['text']`;
    - both prices are non-null and at least 0;
    - `json` is true;
    - it is not dropped by the dated-snapshot rule;
    - its name does not match `VARIANT`.
  - **Family and staleness.** Keep the newest model per family by `created`. Drop families older than `nowSec - MENU_STALE_SECONDS`; if that empties a provider, keep its single newest family.
  - **Ordering.** Sort by `created` descending, then `slug` ascending, and cut each provider at 6.
  - **Hides and pins.** Remove hides, then add pins:
    - a pin already in the menu just gets `pinned: true`;
    - a pin that is in the feed is added to its provider's group, which is then re-sorted;
    - a pin missing from the feed is added last in its group, with `available: false`, `name` set to the slug, null prices, `vision: false` and `efforts: []`.
  - **Groups.** Groups for unlisted providers come after the listed ones, in pin order. Empty groups are omitted.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-menu.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/model-menu.ts src/types.ts tests/model-menu.test.ts`, then `git commit -m "feat(models): newest-per-family menu builder"`.

### Task 5: Owner menu settings (storage, validation, merge saves)

**Files:**
- Modify: `src/types.ts` (`LlmConfig` gains `menu?: ModelMenuConfig`)
- Modify: `src/validate.ts` (new `validateModelMenuPayload`)
- Modify: `src/tenant-store.ts:427-437` (`getConfig` keeps `menu`)
- Modify: `src/console/routes.ts:35-40` (`saveLlm` preserves `menu`; new `saveModelMenu`)
- Test: `tests/validate.test.ts` (append), `tests/model-menu-config.test.ts` (new, `cloudflare:test` D1)

**Interfaces:**
- Consumes: `ModelMenuConfig` (Task 4).
- Produces:
  - `validateModelMenuPayload(body: unknown): Validation<ModelMenuConfig>`.
  - `saveModelMenu(db: D1Database, shop: string, menu: ModelMenuConfig): Promise<void>`.
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
it('saveModelMenu keeps models (with efforts), enabled and scoreThreshold', async () => { /* saveLlm with textEffort 'high' first, then saveModelMenu -> unchanged */ });
it('a gates save keeps the menu', async () => { /* saveGates -> menu still there */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/validate.test.ts tests/model-menu-config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The `getConfig` llm parser adds `menu` only when `validateModelMenuPayload(raw.menu).ok`.
  - `saveLlm` writes `{ ...llm, menu: cfg.llm.menu }`.
  - `saveModelMenu` writes `{ ...cfg, llm: { ...cfg.llm, menu } }`.
  - `validateModelMenuPayload` checks for a `~` pin before checking the slug shape, reuses `MODEL_SLUG`, and limits each slug to 100 characters.
- [ ] **Step 4: Run them.** `npx vitest run tests/validate.test.ts tests/model-menu-config.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/types.ts src/validate.ts src/tenant-store.ts src/console/routes.ts tests/validate.test.ts tests/model-menu-config.test.ts`, then `git commit -m "feat(models): llm.menu settings stored with merge-safe saves"`.

### Task 6: Live test (probe)

**Files:**
- Create: `src/model-probe.ts`
- Test: `tests/model-probe.test.ts`

**Interfaces:**
- Consumes:
  - `LlmClient.jsonChain` and `ChainTier` with `effort` (Task 2);
  - `ReasoningEffort`;
  - `TenantStore.logLlmUsage(task, model, promptTokens, completionTokens, costUsd)`.
- Produces:

```ts
export type ProbeMode = 'text' | 'vision';
export type ProbeResult = { ok: true } | { ok: false; reason: string };
export const PROBE_TIMEOUT_MS = 60_000;
export const PROBE_CACHE_DAYS = 7;
export const PROBE_MAX_TOKENS = 4800; // the largest production task (src/blog/draft.ts), so max_tokens matches its worst case
// Inline on purpose (spec section 9): no outside host has to be reachable. Production sends https image links instead.
export const PROBE_IMAGE_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItjWNOawAi+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgsbomGHIoj2rgAAAABJRU5ErkJggg=='; // 64x64 orange PNG, verified to decode
export function probeCacheKey(slug: string, mode: ProbeMode, effort?: ReasoningEffort): string; // `modelprobe:${slug}:${mode}:${effort ?? 'default'}`
export async function probeModel(llm: LlmClient, store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache' | 'logLlmUsage'>,
  model: { id: string; canonicalSlug: string | null }, mode: ProbeMode, effort?: ReasoningEffort, timeoutMs?: number): Promise<ProbeResult>;
```

- [ ] **Step 1: Write the failing tests.** Build the client as `new LlmClient({ openrouter: 'k' }, fakeFetch)`.
  - `fakeFetch` records each request body and returns an OpenRouter-shaped reply: `{ model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } }`.
  - The store fake adds `logLlmUsage`, which records its arguments.

```ts
it('passes, sends the production shape, and logs model-probe', async () => {
  const r = await probeModel(llm, store, { id: 'x/m', canonicalSlug: null }, 'text');
  expect(r).toEqual({ ok: true });
  expect(bodies[0]).toMatchObject({ models: ['x/m'], max_tokens: 4800, response_format: { type: 'json_object' } });
  expect('reasoning' in bodies[0]).toBe(false);
  expect(logged).toEqual([['model-probe', 'x/m', 10, 5, 0.0001]]);
});
it('runs at the requested effort with the sized cap', async () => {
  await probeModel(llm, store, { id: 'x/m', canonicalSlug: null }, 'text', 'high');
  expect(bodies[0]).toMatchObject({ reasoning: { effort: 'high' }, max_tokens: 24000 });
});
it('vision mode attaches the probe image', async () => { /* bodies[0].messages[1].content[1].image_url.url === PROBE_IMAGE_DATA_URI */ });
it('a cached pass skips the call; the cache is per mode and per effort', async () => {
  /* text twice -> 1 fetch; vision -> 2; text at 'high' -> 3 */
});
it('accepts the canonical slug as the answering model', async () => { /* reply model 'x/m-20261001', canonicalSlug 'x/m-20261001' -> ok */ });
it('fails when another model answered', async () => { /* reply model 'y/z' -> reason contains 'different model (y/z)' */ });
it('explains an empty reply as a token budget problem', async () => { /* content '' -> reason contains 'larger token budget' */ });
it('fails when the JSON is not the test answer', async () => { /* content '{"ok":false}' -> reason 'did not return the expected test answer' */ });
it('surfaces an OpenRouter refusal in plain words', async () => {
  /* 404 { error: { message: 'Project does not have access to model' } } -> reason === 'OpenRouter refused the call: Project does not have access to model' */
});
it('times out instead of hanging', async () => {
  const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
  const r = await probeModel(new LlmClient({ openrouter: 'k' }, hang), store, { id: 'x/m', canonicalSlug: null }, 'text', undefined, 50);
  expect(r.ok).toBe(false); expect((r as { reason: string }).reason).toMatch(/did not answer within/);
});
it('never caches a failure', async () => { /* 404 reply (no same-tier retry) then passing reply -> 2 fetches in all, second ok */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-probe.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `probeModel`.**
  - Return early on a cache hit.
  - Otherwise call `llm.jsonChain` with:
    - `chain: [{ provider: 'openrouter', models: [model.id], ...(effort ? { effort } : {}) }]`;
    - `maxTokens: PROBE_MAX_TOKENS`;
    - a `system` prompt saying to return exactly the JSON object `{"ok": true}` and nothing else;
    - `images: [PROBE_IMAGE_DATA_URI]` in vision mode;
    - `validate: (v) => (v && typeof v === 'object' && (v as { ok?: unknown }).ok === true ? true : null)`.
  - Race the call against a `setTimeout` of `timeoutMs`.
  - Map each failure to a plain reason:
    - `LLM returned non-JSON` → "did not return JSON (an empty reply usually means the model needs a larger token budget)";
    - `LLM JSON failed validation` → "did not return the expected test answer";
    - any other error → `OpenRouter refused the call: ${error}`;
    - a timeout → `did not answer within ${Math.round(timeoutMs / 1000)} seconds`.
  - On success:
    - check that `usage.model` equals `model.id` or `model.canonicalSlug`;
    - log usage as `model-probe`;
    - cache the pass for `PROBE_CACHE_DAYS`.
  - A failure's tokens are not logged, because `jsonChain` returns no usage on failure. Every task already behaves this way; say so in a code comment.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-probe.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/model-probe.ts tests/model-probe.test.ts`, then `git commit -m "feat(models): live test in the production request shape, per effort"`.

### Task 7: Save check (changed slots, vision rule, efforts, price confirmation, live tests)

**Files:**
- Create: `src/model-save.ts`
- Test: `tests/model-save.test.ts`

**Interfaces:**
- Consumes: `FeedModel` and `feedCost` (Task 3); `ProbeMode` and `ProbeResult` (Task 6); `SYSTEM_DEFAULT_MODEL` (Task 1); `ModelsConfig` and `ReasoningEffort` (Task 2).
- Produces:

```ts
export type SlotName = 'image' | 'text' | 'fallback';
export const COST_CONFIRM_RATIO = 3;
export interface HeldSlot { slot: SlotName; slug: string; name: string; ratio: number | null; promptPriceM: number | null; completionPriceM: number | null }
export type ProbeFn = (model: FeedModel, mode: ProbeMode, effort: ReasoningEffort | undefined) => Promise<ProbeResult>;
export type SaveCheck = { ok: true } | { ok: false; status: 400; error: string } | { ok: false; status: 409; held: HeldSlot[] };
export function allowedEfforts(model: FeedModel, fallback: FeedModel | null): string[]; // EFFORT_LEVELS order; intersection when fallback set
export async function checkModelSave(input: {
  stored: ModelsConfig; requested: ModelsConfig; loadFeed: () => Promise<FeedModel[] | null>;
  confirmCost: boolean; probe: ProbeFn | null;
}): Promise<SaveCheck>;
```

- [ ] **Step 1: Write the failing tests.** Fixtures and helpers:
  - `const feed = reduceFeed(feedJson)`;
  - `probe` is a `vi.fn` that resolves `{ ok: true }` unless a test overrides it, and its calls are read as `[model.id, mode, effort]`;
  - `LUNA = 'openai/gpt-5.6-luna'`, `FABLE = 'anthropic/claude-fable-5.2'`, `MISTRAL = 'mistralai/mistral-large-4-0'`.

```ts
it('unchanged slots never load the feed or probe', async () => {
  const loadFeed = vi.fn(async () => null);
  const same = { image: LUNA, text: LUNA, fallback: LUNA, textEffort: 'low' as const };
  expect(await checkModelSave({ stored: same, requested: same, loadFeed, confirmCost: false, probe })).toEqual({ ok: true });
  expect(loadFeed).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
});
it('an unchanged effort a model has since dropped still saves', async () => { /* stored+requested { text: MISTRAL, textEffort: 'medium' } -> ok */ });
it('clearing fallback needs no check', async () => { /* stored fallback LUNA, requested fallback undefined -> ok, no feed load, no probe */ });
it('clearing text is a change to SYSTEM_DEFAULT_MODEL and is held at about 10x', async () => {
  const r = await checkModelSave({ stored: { text: LUNA }, requested: {}, loadFeed: async () => feed, confirmCost: false, probe });
  expect(r).toMatchObject({ ok: false, status: 409, held: [{ slot: 'text', slug: 'google/gemini-3.1-pro-preview' }] });
  expect((r as { held: HeldSlot[] }).held[0].ratio).toBeCloseTo(10, 1); expect(probe).not.toHaveBeenCalled();
});
it('a confirmed clear of image runs the vision live test on SYSTEM_DEFAULT_MODEL', async () => {
  /* stored { image: LUNA }, requested {}, confirmCost true -> ok; probe calls == [['google/gemini-3.1-pro-preview', 'vision', undefined]] */
});
it('feed down refuses only a change', async () => { /* changed text, loadFeed -> null -> 400 'Cannot verify new models right now; try again shortly.' */ });
it('refuses a slug OpenRouter does not list', async () => { /* text 'openai/nope' -> 400 'text model openai/nope is not offered by OpenRouter' */ });
it('refuses a floating alias even though the feed lists it', async () => { /* text '~anthropic/claude-sonnet-latest' -> 400 */ });
it('refuses a text-only model for image', async () => { /* image 'z-ai/glm-5.3' -> 400 'Image and Fallback must be vision-capable models' */ });
it('holds Luna -> Opus at about 17x and does not probe', async () => {
  const r = await checkModelSave({ stored: { text: LUNA }, requested: { text: 'anthropic/claude-opus-5.5' }, loadFeed: async () => feed, confirmCost: false, probe });
  expect(r).toMatchObject({ ok: false, status: 409, held: [{ slot: 'text', slug: 'anthropic/claude-opus-5.5', promptPriceM: 4, completionPriceM: 20 }] });
  expect((r as { held: HeldSlot[] }).held[0].ratio).toBeCloseTo(17.14, 1); expect(probe).not.toHaveBeenCalled();
});
it('confirmCost lets the held change through to its live test', async () => { /* same + confirmCost true -> ok; probe calls [[opus, 'text', undefined]] */ });
it('a cheaper model is not held', async () => { /* LUNA -> 'anthropic/claude-haiku-5.5' -> ok, probe called */ });
it('exactly 3x is not held', async () => { /* synthetic feed: base cost 2, new cost 6 -> ok */ });
it('a blank slot compares with SYSTEM_DEFAULT_MODEL', async () => {
  /* stored text blank: Opus (24 vs 14 = 1.71x) -> ok; Fable 5.2 (48 vs 14 = 3.43x) -> 409 */
});
it('a delisted or free current model holds with ratio null', async () => {
  /* stored 'openai/gone' -> held ratio null; synthetic base with prices 0/0 -> held ratio null; no Infinity or NaN anywhere */
});
it('an effort-only change is live-tested at that effort and never price-held', async () => {
  /* stored { text: LUNA }, requested { text: LUNA, textEffort: 'high' } -> ok; probe calls == [[LUNA, 'text', 'high']] */
});
it('offered efforts are the model intersected with the fallback', () => {
  const by = (id: string) => feed.find((m) => m.id === id)!;
  expect(allowedEfforts(by(FABLE), by(MISTRAL))).toEqual(['high']);
  expect(allowedEfforts(by(FABLE), null)).toEqual(['max', 'xhigh', 'high', 'medium', 'low']);
  expect(allowedEfforts(by(LUNA), by('qwen/qwen3.8-flash'))).toEqual([]);   // fallback lists none: only the default
});
it('refuses an effort the model does not offer', async () => {
  /* requested { text: MISTRAL, textEffort: 'medium' } -> 400 'Text effort "medium" is not offered by mistralai/mistral-large-4-0.' */
});
it('refuses an effort the fallback does not offer', async () => {
  /* stored { fallback: MISTRAL }, requested { text: FABLE, textEffort: 'medium', fallback: MISTRAL }
     -> 400 'Text effort "medium" is not offered by the fallback model mistralai/mistral-large-4-0.' */
});
it('a changed effort also tests the fallback at that effort', async () => {
  /* stored { text: FABLE, fallback: MISTRAL }, requested + textEffort 'high'
     -> probe calls (any order) [[FABLE, 'text', 'high'], [MISTRAL, 'vision', 'high']] */
});
it('a new fallback is tested at both slot efforts, deduplicated', async () => {
  /* stored { text: LUNA, image: LUNA, textEffort: 'high', imageEffort: 'high' }, requested + fallback 'anthropic/claude-haiku-5.5'
     -> probe calls == [['anthropic/claude-haiku-5.5', 'vision', 'high']] */
});
it('no OpenRouter key refuses a change', async () => { /* probe null, cheap change -> 400 'No OpenRouter key is configured, so new models cannot be tested.' */ });
it('a failed live test refuses the slot with the reason', async () => { /* probe -> { ok:false, reason:'r' } -> 400 'text model failed its live test: r' */ });
it('a model moved into fallback is tested in vision mode, and only there', async () => {
  /* stored { text: LUNA }, requested { text: LUNA, fallback: LUNA } -> ok; probe calls == [[LUNA, 'vision', undefined]] */
});
it('the same slug in image and fallback is probed once', async () => { /* both changed to haiku-5.5 -> one probe call */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-save.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `checkModelSave`.** In order:
  1. **Find the changed slots.** Image or text is changed when its model (`requested[s] || ''` vs `stored[s] || ''`) or its effort (`requested[sEffort] ?? ''` vs `stored[sEffort] ?? ''`) differs. Fallback is changed when its model differs.
     - A changed slot's model is `requested[s]`. A cleared image or text slot runs `SYSTEM_DEFAULT_MODEL` and is checked like any other model.
     - A cleared fallback runs nothing and drops out of the set.
     - If nothing changed, return ok.
  2. **Load the feed once.** If it returns `null`, answer 400.
  3. **Check each changed slot, in slot order image, text, fallback.** Refuse a slug that is not in the feed, a `~` slug, or a model without `image` input in the image or fallback slot.
  4. **Check efforts.** For image and text, when the slot or the fallback changed and an effort is set, the effort must be in `allowedEfforts(slotModel, fallbackModel)`. Use the model message if the slot's own model lacks the effort, and the fallback message otherwise.
  5. **Check the price** for slots whose model changed (effort-only changes are skipped).
     - The baseline is `stored[s] || SYSTEM_DEFAULT_MODEL`.
     - The ratio is `null` when the baseline is missing from the feed, its cost is null, or its cost is at most 0.
     - Hold the slot when the ratio is null or above 3.
     - If anything is held and `confirmCost` is false, return 409 with every held slot.
  6. **Need a key.** If `probe` is null, return the no-key 400.
  7. **Build the probe set**, keyed by `slug|mode|effort`:
     - for a changed image or text slot, its model in its mode at its effort;
     - for a changed slot effort with a fallback set, the fallback in vision mode at that effort;
     - for a changed fallback, the fallback in vision mode at the image effort and at the text effort.
  8. **Run the set with `Promise.all`.** Return the first failure, in slot order, as a 400 that names the slot.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-save.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/model-save.ts tests/model-save.test.ts`, then `git commit -m "feat(models): save check with efforts, price confirmation and live tests"`.

### Task 8: Retirement and effort watch, daily stage

**Files:**
- Create: `src/model-watch.ts`
- Modify: `src/jobs.ts` (`DAILY_SHOP_STAGES`: a new entry right after `order-webhooks`)
- Test: `tests/model-watch.test.ts`

**Interfaces:**
- Consumes: `FeedModel` (Task 3); `SlotName` and `allowedEfforts` (Task 7); `AlertResult` (`src/owner-alert.ts`); `SEARCH_MODEL`.
- Produces:

```ts
export type WatchState = 'ok' | 'retiring' | 'delisted';
export interface SlotStatus {
  slug: string; state: WatchState; retiresOn: string | null;
  efforts: string[]; defaultEffort: string | null; // from the feed, for the console's effort select
  effortSupported: boolean;                        // image/text only: false when the stored effort is no longer allowed
}
export const RETIRE_WARN_DAYS = 30;
export const WATCH_ALERT_KEY = 'modelwatch:alerted';
export const WATCH_ALERT_TTL_DAYS = 90;
export function modelState(slug: string, feed: FeedModel[], nowMs: number): { state: WatchState; retiresOn: string | null };
export function selectedStatus(models: ModelsConfig, feed: FeedModel[], nowMs: number): Partial<Record<SlotName, SlotStatus>>;
export async function runModelWatch(store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>, models: ModelsConfig,
  searchModel: string, feed: FeedModel[], nowMs: number, send: (subject: string, text: string) => Promise<AlertResult>): Promise<number>; // send calls made this run
```

- [ ] **Step 1: Write the failing tests.** Use `NOW = Date.parse('2026-11-13T12:00:00Z')`.

```ts
it('gpt-5-mini is retiring on 2026-12-11; Luna is ok; an unknown slug is delisted', () => {
  expect(modelState('openai/gpt-5-mini', feed, NOW)).toEqual({ state: 'retiring', retiresOn: '2026-12-11' });
  expect(modelState('openai/gpt-5.6-luna', feed, NOW).state).toBe('ok');
  expect(modelState('openai/gone', feed, NOW)).toEqual({ state: 'delisted', retiresOn: null });
  expect(modelState('openai/gpt-5-mini', feed, Date.parse('2026-11-01T00:00:00Z')).state).toBe('ok'); // 40 days out
});
it('selectedStatus covers set slots only, with efforts', () => {
  /* { text: gpt-5-mini } -> { text: { slug, state:'retiring', retiresOn:'2026-12-11', efforts: [...feed's], effortSupported: true } } */
});
it('flags a stored effort the model no longer offers', () => {
  expect(selectedStatus({ text: 'mistralai/mistral-large-4-0', textEffort: 'medium' }, feed, NOW).text!.effortSupported).toBe(false);
});
it('alerts once per (slug, state)', async () => { /* run twice with gpt-5-mini as text -> 1 then 0; subject contains 'openai/gpt-5-mini' */ });
it('a cleared issue that returns alerts again', async () => { /* run(mini) -> 1; run(luna) -> 0; run(mini) -> 1 */ });
it('a failed send is retried next run', async () => { /* send -> 'failed', then 'sent': runs return 1, 1, then 0 */ });
it('one email per slug, naming every slot it fills', async () => { /* image+fallback both 'openai/gone' -> 1 email; text names both slots */ });
it('the search model alert says a code change is needed', async () => { /* searchModel 'anthropic/gone' -> text contains 'code change' */ });
it('an unsupported effort alerts once', async () => {
  /* { text: MISTRAL, textEffort: 'medium' } -> 1 email, subject 'PawScout: the text effort "medium" is no longer offered'; second run -> 0 */
});
it('the daily chain runs model-watch without needing CJ', () => {
  const s = DAILY_SHOP_STAGES.find((x) => x.name === 'model-watch');
  expect(s?.needsCj).toBe(false);
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-watch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `modelState` returns "retiring" when `expiresOn` is no more than 30 days after `nowMs`.
  - `selectedStatus` sets `effortSupported` to false only for an image or text slot with a stored effort missing from `allowedEfforts(slotModel, fallbackModel)`. Both models must be in the feed; otherwise it stays true, and the delisted state covers the slot.
  - `runModelWatch` builds the current issues:
    - `model|slug|state` for every non-ok slot and for `searchModel`, grouping each slug's slots together;
    - `effort|slot|effort|slug` for every unsupported effort.
  - It reads the remembered set, a JSON array (a corrupt one counts as empty), and sends one email per issue it has not remembered.
  - It remembers an issue unless `send` returned `'failed'`, and writes back (remembered ∩ current) ∪ the newly remembered.
  - Email copy, plain text with no dashes:
    - Model subject: `PawScout: AI model ${slug} is ${delisted ? 'no longer offered by OpenRouter' : `retiring on ${retiresOn}`}`. The body names the slots and says "Open Settings > AI models and pick a replacement.". For the search model it says instead "This is PawScout's built-in research model, so replacing it needs a code change.".
    - Effort subject: `PawScout: the ${slot} effort "${effort}" is no longer offered`. The body says "OpenRouter may reject these calls outright, with no fallback. Open Settings > AI models and pick another effort.".
  - The stage is `{ name: 'model-watch', maxMs: 1 * MIN_MS, needsCj: false, run }`.
    - `run` calls `loadFeed(ctx.store)` and returns quietly on `null`.
    - Otherwise it calls `runModelWatch(ctx.store, ctx.cfg.llm.models, SEARCH_MODEL, feed, Date.now(), (s, t) => alertOwner(ctx.env, ctx.cfg, s, t))`.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-watch.test.ts tests/jobs.test.ts`. Expected: PASS. `tests/jobs.test.ts` covers the existing stage chain and must stay green with the new stage.
- [ ] **Step 5: Commit.** `git add src/model-watch.ts src/jobs.ts tests/model-watch.test.ts`, then `git commit -m "feat(models): daily model-watch alerts on retiring models and dropped efforts"`.

### Task 9: Routes, and removal of the curated catalog

**Files:**
- Modify: `src/index.ts`:
  - delete `visionModelRejected` (`:252-259`);
  - update `/api/llm` and `/api/models` (`:1279-1302`);
  - add `POST /api/models/menu` beside them.
- Delete: `src/models-catalog.ts`, `tests/models-catalog.test.ts`, `tests/api-models.test.ts`
- Test: `tests/model-routes.test.ts` (new; copy the harness from `tests/fulfil-settings-route.test.ts:35-64`)

**Interfaces:**
- Consumes: Tasks 2 to 8.
- Produces:
  - `export function modelsPayload(feed: FeedModel[] | null, llm: LlmConfig, nowMs: number)` in `src/index.ts`, which builds the GET body below.
    - It is pure, so the no-feed case is unit-tested without a network call.
    - This mirrors how `visionModelRejected` used to be exported from `src/index.ts` and tested.
- Produces (HTTP):
  - **`GET /api/models`** returns `{ ok: true, feedAvailable: boolean, groups: MenuGroup[], menu: ModelMenuConfig, selectedStatus: Partial<Record<SlotName, SlotStatus>> }`.
    - `menu` is `effectiveMenu(cfg.llm.menu)`.
    - When the feed is unavailable, `groups` is `buildMenu([], …)`, which holds only pins, and `selectedStatus` is `{}`.
  - **`POST /api/llm`** accepts today's body, whose `models` may now carry efforts, plus optional `confirmCost: boolean` and `dryRun: boolean`. It answers:
    - `200 { ok: true }`;
    - `200 { ok: true, dryRun: true }`, with nothing stored;
    - `400 { ok: false, error }`;
    - `409 { ok: false, held: HeldSlot[] }`.
  - **`POST /api/models/menu`** takes `ModelMenuConfig` and answers `200 { ok: true, menu }` or `400 { ok: false, error }`.

- [ ] **Step 1: Write the failing tests.** Set up:
  - the tenant, seeded with `llm.models = { image: LUNA, text: LUNA, fallback: LUNA }`;
  - the feed cache, via `store.putSearchCache(FEED_CACHE_KEY, JSON.stringify(reduceFeed(feedJson)), 1)`;
  - one probe pass per tested save, via `store.putSearchCache(probeCacheKey(slug, mode, effort), '1', 7)`, so no test reaches the network;
  - the env `{ ...env, SHOPIFY_API_SECRET: SECRET, OPENROUTER_API_KEY: 'test-key' }`.

```ts
it('GET /api/models returns grouped menu, effective settings and slot status', async () => {
  /* feedAvailable true; groups[0].provider 'anthropic'; groups[0].entries[0].slug 'anthropic/claude-fable-5.2';
     menu.providers has 10 entries; selectedStatus.text.state 'ok'; selectedStatus.text.efforts contains 'medium' */
});
it('modelsPayload with no feed returns pins only and feedAvailable false', () => {
  const p = modelsPayload(null, { ...DEFAULT_LLM, models: { text: LUNA }, menu: { providers: ['anthropic'], pins: ['a/b'], hides: [] } }, Date.now());
  expect(p).toMatchObject({ ok: true, feedAvailable: false, selectedStatus: {}, groups: [{ provider: 'a', entries: [{ slug: 'a/b', available: false }] }] });
});
it('saving only the threshold succeeds with Luna off the menu', async () => {
  /* POST { enabled:true, scoreThreshold:55, models: all LUNA } -> 200; stored threshold 55; models unchanged */
});
it('an expensive change is held and stores nothing', async () => { /* text -> opus -> 409 held[0].slug opus; stored text still LUNA */ });
it('confirmCost saves it', async () => { /* + confirmCost true (probe pass seeded for opus/text/default) -> 200; stored text opus */ });
it('an effort change saves after its live test', async () => {
  /* models all LUNA + textEffort 'low' (seed probeCacheKey(LUNA,'text','low') and probeCacheKey(LUNA,'vision','low')) -> 200; stored textEffort 'low' */
});
it('dryRun runs the checks and stores nothing', async () => { /* opus + confirmCost + dryRun -> 200 { ok:true, dryRun:true }; stored text LUNA */ });
it('a menu save keeps the models, and a models save keeps the menu', async () => {
  /* POST /api/models/menu { providers:['x-ai'] } -> 200; then threshold save -> stored llm.menu.providers ['x-ai'], models unchanged */
});
it('a floating alias pin is refused', async () => { /* POST /api/models/menu pins ['~anthropic/claude-sonnet-latest'] -> 400 */ });
```

- [ ] **Step 2: Run them.** `npx vitest run tests/model-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Wire the routes as specified.
  - **`/api/llm`:**
    - read `cfg`, answering 400 `Not configured` if it is absent;
    - pass `loadFeed: () => loadFeed(store)`;
    - build `probe` only when `c.env.OPENROUTER_API_KEY` is set, as `(m, mode, effort) => probeModel(new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY }), store, m, mode, effort)`;
    - read `confirmCost` and `dryRun` as `=== true`;
    - on success, call `saveLlm` unless `dryRun` is set.
  - **Cleanup:** delete `visionModelRejected` and the `models-catalog` import, then delete the three files.
  - **Check:** run `python -P -m graphite build .`, then `python -P -m graphite search "CURATED_MODELS"`. It must report no `src/` or `tests/` match.
- [ ] **Step 4: Run them.** `npx vitest run tests/model-routes.test.ts`, then `npm run typecheck`. Expected: PASS, and no type errors.
- [ ] **Step 5: Commit.** `git add -A src/index.ts src/models-catalog.ts tests/models-catalog.test.ts tests/api-models.test.ts tests/model-routes.test.ts`, then `git commit -m "feat(models): menu, save-check and menu-settings routes; remove the curated catalog"`.

### Task 10: Console AI models card

**Files:**
- Modify: `src/console/views/settings.ts:20-32`
- Modify: `src/console/page.ts`:
  - `:229-264`, option building;
  - `:299-303`, filling the selects;
  - `:476-491`, `saveLlm`.
- Test: `tests/console.test.ts` (append)

**Interfaces:**
- Consumes: the Task 9 HTTP shapes.
- Produces: page script functions. All of them sit at the top level of the inline script, so tests can extract them.
  - `modelOptionsHtml(groups, vision)` returns a `string`.
  - `effortOptionsHtml(efforts, defaultEffort, fallbackEfforts)` returns a `string`. `fallbackEfforts` is `null` when no fallback is set.
  - `providerLabel(id)` returns a `string`.
  - `heldMessage(h, slotLabel)` returns a `string`.
  - `loadModelMenu()`.
  - `saveLlm(confirm)`. `confirm` is `true` only when it comes from the "Save anyway" button.

- [ ] **Step 1: Write the failing tests.** Extract the functions with the brace-matching helper used at `tests/console.test.ts:165-184`, then drive them:

```ts
it('modelOptionsHtml groups by provider, filters vision, flags retirement and unavailable pins', async () => {
  const groups = [{ provider: 'anthropic', entries: [
    { slug: 'anthropic/a', name: 'A <b>', vision: true, promptPriceM: 4, completionPriceM: 20, retiresOn: '2026-12-11', pinned: false, available: true, efforts: [], defaultEffort: null },
    { slug: 'anthropic/t', name: 'T', vision: false, promptPriceM: 1, completionPriceM: 2, retiresOn: null, pinned: false, available: true, efforts: [], defaultEffort: null },
    { slug: 'anthropic/p', name: 'anthropic/p', vision: false, promptPriceM: null, completionPriceM: null, retiresOn: null, pinned: true, available: false, efforts: [], defaultEffort: null }] }];
  const all = modelOptionsHtml(groups, false), vis = modelOptionsHtml(groups, true);
  expect(all).toContain('<optgroup label="Anthropic">');
  expect(all).toContain('A &lt;b&gt; - $4/M in · $20/M out · 👁 · retires 2026-12-11');
  expect(all).toMatch(/<option value="anthropic\/p" disabled>[^<]*unavailable/);
  expect(vis).not.toContain('anthropic/t');
});
it('effortOptionsHtml offers the model default, then the shared levels in order, with none as Off', async () => {
  expect(effortOptionsHtml(['max', 'xhigh', 'high', 'medium', 'low'], 'high', ['high', 'none']))
    .toBe('<option value="">Model default (high)</option><option value="high">high</option>');
  expect(effortOptionsHtml(['high', 'none'], 'high', null)).toContain('<option value="none">Off</option>');
  expect(effortOptionsHtml([], null, null)).toBe('<option value="">Model default</option>');
});
it('heldMessage gives a ratio, or the prices when the ratio is unknown', async () => {
  expect(heldMessage({ name: 'Claude Opus 5.5', ratio: 17.14, promptPriceM: 4, completionPriceM: 20 }, 'text'))
    .toBe('Claude Opus 5.5 costs about 17x your current text model ($4/M in, $20/M out). Save anyway?');
  expect(heldMessage({ name: 'X', ratio: null, promptPriceM: 4, completionPriceM: 20 }, 'image'))
    .toBe('X costs $4/M in, $20/M out, and the current image model has no known price to compare. Save anyway?');
});
it('loadModelMenu survives a failed fetch with an empty, unavailable menu', async () => {
  /* extract loadModelMenu; new Function('api', 'var modelMenuPromise=null;' + src + '\nreturn loadModelMenu;')(async () => { throw new Error('x'); })
     -> resolves (does not reject) to { groups: [], feedAvailable: false, selectedStatus: {} } */
});
it('the AI models card carries the menu and effort controls and the fixed copy', async () => {
  const html = await consolePage('test-key').text();
  for (const s of ['id="llm-menu"', 'id="mdl-provider-add"', 'id="mdl-pin"', 'id="llm-fallback-hint"', 'id="llm-models-warn"',
    'id="mdl-image-effort"', 'id="mdl-text-effort"', "'/models/menu'", 'confirmCost', 'Save anyway', 'Testing the new model...',
    'Model list unavailable right now', 'Higher effort means more thinking, billed as output tokens.',
    'Fallback is the same as the text model, so there is no second model to switch to.', 'Last resort: GPT-5.4 mini']) expect(html).toContain(s);
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/console.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - **Loading the menu.** Replace `ensureModelOptions` with `loadModelMenu()`.
    - It caches the GET promise, and `invalidateModelMenu()` clears it after a menu save.
    - It catches every failure and resolves to `{ groups: [], feedAvailable: false, selectedStatus: {} }`. That way `setModelSelect` still runs `setSelectValue`, and the saved slug stays selected as "(current)".
  - **Model selects.** `setModelSelect` fills from `modelOptionsHtml` and keeps the "(current)" behaviour of `setSelectValue`. The blank options read `- system default` for image and text and `- none` for fallback.
  - **Provider names.** `providerLabel` maps:
    - `anthropic` to Anthropic, `openai` to OpenAI and `google` to Google;
    - `x-ai` to xAI, `deepseek` to DeepSeek and `qwen` to Qwen;
    - `moonshotai` to Moonshot (Kimi), `z-ai` to Z.ai and `minimax` to MiniMax;
    - `mistralai` to Mistral;
    - anything else to its raw id.
  - **Effort selects.**
    - `#mdl-image-effort` sits beside the image select and `#mdl-text-effort` beside the text select, with the hint line under them.
    - Each is rebuilt by `effortOptionsHtml` whenever its model select or the fallback select changes. A model's efforts are looked up in the menu entries first, then in `selectedStatus` for an off-menu "(current)" model.
    - If the stored effort is no longer offered, it is still shown selected, marked "(not offered)", so a save without touching it keeps it, and the server accepts it unchanged.
  - **Under the selects:**
    - `#llm-fallback-hint` appears when fallback equals text. It is filled on select change and after load.
    - `#llm-models-warn` shows one line per `selectedStatus` slot that is retiring or delisted, or whose `effortSupported` is false.
    - When `feedAvailable` is false, it shows "Model list unavailable right now".
  - **The menu panel.** `#llm-menu` is a `<details>` titled "Menu: providers, pins and hidden models", containing:
    - the provider chips, each with a remove button, plus `#mdl-provider-add` and an Add button;
    - `#mdl-pin` with a Pin button;
    - each provider's menu entries, each with a Hide button;
    - the hidden and pinned lists, with Unhide and Unpin.

    Every change POSTs the full block to `'/models/menu'`, then invalidates the menu and refills the selects.
  - **`saveLlm(confirm)`:**
    - it sends `imageEffort`/`textEffort` from the effort selects, with `''` meaning default, and `confirmCost: confirm === true`;
    - it shows "Testing the new model..." while the request is in flight;
    - on a 409, it writes the `heldMessage` lines and a "Save anyway" button, which calls `saveLlm(true)`, into `#llm-models-msg`, and the plain text into `#llmmsg`;
    - otherwise it keeps today's Saved/Failed messages.
  - **Prices** are formatted as `'$'+n` with no trailing zeros.
- [ ] **Step 4: Run them.** `npx vitest run tests/console.test.ts`, then `npm run lint`. Expected: PASS, and lint is clean.
- [ ] **Step 5: Commit.** `git add src/console/views/settings.ts src/console/page.ts tests/console.test.ts`, then `git commit -m "feat(console): provider-grouped model menu, effort selects, menu settings and price confirmation"`.

### Task 11: Gate, staging, and production verification

**Files:** none, apart from the backlog memory note at the end.

- [ ] **Step 1: Run the full gate.** `npm test`, `npm run typecheck` and `npm run lint`, each redirected to a file, and read the exit codes directly. Expected: all three exit 0.
- [ ] **Step 2: Scan for dashes.** Run `git diff master --stat`, then search the added lines for the en dash and em dash characters (code points U+2013 and U+2014; write the regex with backslash-u escapes so the plan itself stays clean). Expected: 0 hits.
- [ ] **Step 3: Push and wait for CI.** Push, then run `gh run list --branch feat/self-updating-model-menu --limit 1`. Expected: CI succeeds for HEAD.
- [ ] **Step 4: Deploy to staging.** `npm run deploy -- --env staging`. Expected: the deploy succeeds and the smoke test passes. Staging cannot open the console, because it has no shop.
- [ ] **Step 5: Merge, then ask for production.** Merge to master with `--no-ff`, as with earlier branches, and push. Ask the owner for "deploy <sha> to production". Do not deploy without that exact sentence.
- [ ] **Step 6: Verify on production**, after the owner's go and the guarded deploy. Work through the admin iframe session (memory: call-session-authed-routes-via-iframe).
  - `GET /api/models` returns `feedAvailable: true`, Anthropic first, and the stored slots as `ok`.
  - `POST /api/llm` with text set to `anthropic/claude-opus-5.5` and `dryRun: true` returns 409 with a ratio of about 17.
  - `POST /api/llm` with text set to `anthropic/claude-haiku-5.5` and `dryRun: true` runs a real live test and returns `{ ok: true, dryRun: true }`.
  - `POST /api/llm` with Luna unchanged, `textEffort: 'low'` and `dryRun: true` runs a real live test with `reasoning.effort` set and returns `{ ok: true, dryRun: true }`.
  - A D1 read shows the stored `llm.models` unchanged, plus one `llm_usage` row with task `model-probe` for each live test.
- [ ] **Step 7: Update `pawscout-backlog.md`** with the deployed sha and what was verified.
