# Self-updating AI model menu - Design

**Date:** 2026-11-13
**Repo:** `pawscout-worker` (catalog builder, console Settings card, save route, one daily stage). No theme change, no D1 migration.
**Builds on:** `2026-06-19-selectable-llm-models-design.md` (the curated dropdown this replaces) and `2026-06-19-llm-selection-centralization-design.md` (the three-slot `llm.models` block and `resolveChain`).

---

## 1. Intent

The Settings > AI models card offers a hand-curated list of 12 OpenRouter models (`CURATED_MODELS` in `src/models-catalog.ts`), last curated 2026-08-02. The live OpenRouter feed is read daily, but only to add prices and the vision flag to those 12; it never adds a model. So every new release needs a code change and a deploy before the owner can even see it.

The owner wants the menu to **always surface the latest releases**, especially the frontier models from Anthropic, OpenAI, Google (Gemini) and xAI (Grok), plus the emerging providers whose models are comparable to them. They chose (2026-11-13) to define "comparable" by **a list of providers they control**, not by an external quality leaderboard, and chose **"newest model in each family, grouped by provider"** as the way the menu is built.

### 1.1 What the menu looks like today vs the feed (read 2026-11-13 from `https://openrouter.ai/api/v1/models`)

| Provider | On our menu | Newest in the feed |
|---|---|---|
| Anthropic | Claude Sonnet 4.6, Claude Haiku 4.5 | Claude Fable 5.2 (11-09), Haiku 5.5 (10-07), Sonnet 5.5 (09-28), Opus 5.5 (09-22) |
| OpenAI | GPT-5.2, GPT-5.6 Luna, GPT-5 mini | GPT-6.1 Terra (10-26), GPT-6.1 Sol (09-29), GPT-6 Luna (09-22) |
| Google | Gemini 3.1 Pro preview, 3.5 Flash, 3.5 Flash Lite, 2.5 Flash, 3.1 Flash Lite | Gemini 4 Hydrogen (11-12), 4 Carbon (11-10), 4 Argon (10-13), 3.8 Flash (09-02) |
| xAI | Grok 4.3 | Grok 4.7 (09-21) |

Other facts found the same day:
- `openai/gpt-5-mini` (on the menu) carries `expiration_date: 2026-12-11` in the feed. The store does not use it.
- The store has `openai/gpt-5.6-luna` in all three slots (image, text, fallback), so OpenRouter has no second model to fail over to; an outage drops straight to the OpenAI-direct floor (`DEFAULT_MODEL = gpt-5.4-mini`).
- The comment in `src/llm-resolve.ts:9-11` says the floor is gpt-5.6-luna; the code (`src/llm.ts:58`) has been `gpt-5.4-mini` since the 2026-08-11 revert. The Settings card label ("Last resort: GPT-5.4 mini") is correct.

## 2. Goals, non-goals, anti-goals

**Goals**
1. A new model from a listed provider appears on the menu within a day of OpenRouter listing it, with no code change.
2. An older model in the same family drops off the menu when its successor appears (Sonnet 5.5 replaces Sonnet 4.6).
3. The owner controls which providers count (add, remove), and can pin a specific model onto the menu or hide one from it.
4. A model can only be saved into a slot after it has passed a small live call through our own OpenRouter key, in the same JSON request shape production uses.
5. The owner is warned, in the console and by email, when a model in use is about to be retired or has been delisted.
6. Premium models are visible on the menu, but a save that makes a slot more than 3x as expensive asks for confirmation first (5.6.1).

**Non-goals**
- An external quality ranking or leaderboard (the owner chose option (a)).
- Changing what each slot does, or the provider chain (`resolveChain`: OpenRouter primary+fallback, then OpenAI direct).
- Cost caps or budgets (the AI spend card already reports spend). The price check in 5.6.1 is a confirmation, not a cap: the owner can always save.
- Hiding models by price.
- Making the research model (`SEARCH_MODEL`) or the OpenAI floor (`DEFAULT_MODEL`) owner-selectable.

**Anti-goals (a failure even if it technically works)**
- **The store's model changes without the owner choosing it.** Nothing in this design may rewrite `llm.models`. This is why OpenRouter's floating `~vendor/<family>-latest` aliases (e.g. `~anthropic/claude-sonnet-latest`, present in the feed) are excluded from the menu and from saving: they change the model underneath a saved setting with no live test.
- **A Settings save fails because of a field the owner did not touch.** Today `/api/llm` rejects any slug not in the catalog; once the menu moves, an unchanged saved slug would block every save.
- **A model the owner selected is offered but our key cannot call it.** (Lesson from 2026-08: `gpt-5.6-luna` was in OpenAI's docs but our project had no access, and it shipped for 9 days.)
- **A reasoning model passes the live test but is starved in production.** (Lesson: a reasoning model with too small a token budget returns empty content, reported as "non-JSON".) The live test uses the production token floor.

## 3. Constraints from the code

- **Every selectable model is an OpenRouter slug**, called with `{ models: [primary, fallback], max_tokens: max(n, REASONING_HEADROOM=3000), response_format: { type: 'json_object' }, usage: { include: true } }` (`src/llm.ts:212`). The live test must use this shape.
- **`resolveChain` falls back to `CURATED_MODELS[0].slug` when a slot is blank** (`src/llm-resolve.ts:17`). That position-0 dependency must become a fixed constant, or a reordered menu would silently change the system default.
- **`saveLlm` replaces the whole `llm` block** (`src/console/routes.ts:35`), and `validateLlmPayload` (`src/validate.ts:142`) rebuilds it from the request body. New owner preferences must not be wiped by an AI-models save, and vice versa.
- **The catalog has exactly two callers**, `GET /api/models` and `POST /api/llm` (graphite `callers getModelCatalog`, decision_grade). `visionModelRejected` is called only by `POST /api/llm`.
- **The feed cache is per shop** in `search_cache` (`openrouter:models`, 24h TTL) and currently stores only `{name, vision, promptPrice, completionPrice}`.
- **The daily job runs per-shop stages** (`DAILY_SHOP_STAGES` in `src/jobs.ts`, driven by `driveDailyChain`), and `alertOwner` (`src/owner-alert.ts`) sends a plain owner email that never throws.
- **No em or en dashes** in code, docs or customer text (standing rule).

## 4. Approaches considered

All three read the same OpenRouter feed and take the owner's provider list as input.

1. **Newest model in each family, grouped by provider (CHOSEN by the owner).** Strip version numbers from the slug to get a family (`claude-sonnet-5.5` and `claude-sonnet-4.6` are both `claude-sonnet`), keep the newest member, drop families with no release for 6 months. Simulated on the 2026-11-13 feed: Anthropic shows exactly Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5. Risk: a provider renames a line in a way that splits a family; the pin covers it.
2. **Everything released in the last N months.** Simpler rule, but lists every variant (pro and non-pro, every size: 40 entries at 4 months), and a quiet provider vanishes entirely (Mistral and DeepSeek were down to one entry each).
3. **Newest per price tier (premium, mid, budget).** Rejected on the simulation: Anthropic's mid tier picked the year-old Haiku 4.5 and Sonnet 5.5 disappeared under Fable 5.2; Mistral's premium tier was a 2024 model; Kimi K3 landed in "budget" on a $0.19 input price while its output is $16.

Also rejected: OpenRouter's `~<vendor>/<family>-latest` aliases (auto-switching, see anti-goals).

## 5. Design

### 5.1 Feed reader

- One fetch of `https://openrouter.ai/api/v1/models` (public, no key), through `defaultFetch`, cached in `search_cache` for 24h under a **new key** `openrouter:models:v2` so an old-shape cache entry is never misread.
- Cache only the reduced fields per model: `id`, `canonical_slug`, `name`, `created`, `expiration_date`, input modalities, output modalities, prompt and completion price, and whether `supported_parameters` contains `response_format` or `structured_outputs`.
- A fetch or parse failure returns `null`; callers degrade (5.6, 5.9). It never throws.

### 5.2 Menu builder (pure function, no I/O)

Input: the reduced feed, the owner's provider list, pins, hides, and "now". Output: an ordered list of menu entries grouped by provider. Steps, in order:

1. **Provider match.** Keep ids whose prefix before `/` is in the provider list. This also excludes the `~vendor/...-latest` aliases (their prefix starts with `~`) and routers like `openrouter/auto`.
2. **Variant filter.** Drop:
   - any id containing `:` (`:batch`, `:free`, `:thinking`, `:extended`, and any future suffix);
   - any model whose output modalities are not exactly text (drops image, music and video generators: `gemini-nano-banana`, `lyria`, `gemini-omni` on today's feed; keeps `qwen3.8-omni-flash`, which outputs text);
   - negative or missing prices;
   - models with neither `response_format` nor `structured_outputs` (every call is JSON mode);
   - a dated snapshot (`-NNNN`, `-NNNNNN` or `-NNNNNNNN` suffix) **only when its undated alias is also listed** (drops `deepseek-v4.1-flash-1017`, keeps `mistral-small-2603`, which is Mistral's real name for that model);
   - specialised variants by name: `-legal`, `-code`, `-coder`, `guard`, `-customtools`, `-multi-agent`, `-exp`.
3. **Family key.** The model name (after `/`) with version tokens removed (a number with optional dots, optionally preceded by `v`), and `-preview` removed so a general release supersedes its preview; repeated dashes collapsed. Provider is part of the key.
4. **Newest per family** by `created`.
5. **Staleness.** Drop a family whose newest member is older than **6 months**, except that a listed provider always keeps its single newest family (so a provider the owner added never shows an empty group).
6. **Cap.** At most **6 families per provider**, newest first.
7. **Hides** removed; **pins** added (a pinned slug appears in its provider group even if a filter dropped it; a pinned slug missing from the feed appears as "unavailable" and cannot be newly selected).
8. **Order.** Provider groups in the owner's list order; within a group, newest first.

Each entry carries: `slug`, `name`, `provider`, `vision` (input modalities include `image`), `promptPriceM`, `completionPriceM` ($ per million tokens, both always shown), `created`, `retiresOn` (from `expiration_date`), and `pinned`.

### 5.3 Owner settings: providers, pins, hides

- Stored in a new optional sub-block `llm.menu = { providers: string[], pins: string[], hides: string[] }` inside the existing `tenant_config.llm` JSON. No migration: a missing block means the defaults.
- **Default providers:** `anthropic, openai, google, x-ai, deepseek, qwen, moonshotai, z-ai, minimax, mistralai` (the four named by the owner plus the six emerging providers with current releases in the feed).
- Saved through **its own route** (`POST /api/models/menu`), which **merges** into the stored `llm` block (the `/api/fulfil` pattern), and `saveLlm` / `validateLlmPayload` carry `llm.menu` through unchanged, so neither save can wipe the other.
- Validation: provider ids `^[a-z0-9-]+$`, at most 20; pins and hides are OpenRouter slugs (existing `MODEL_SLUG` shape), at most 30 each. A pin starting with `~` (a floating alias) is refused, for the reason in section 2.
- UI: a "Menu" area under the three selects: the provider list as removable chips with an add box, a "Pin a model" box (slug), and a "Hide" action per menu entry.

### 5.4 The three selects

- Built from the menu, using `<optgroup>` per provider. Option text: `{name} - ${in}/M in · ${out}/M out` plus `· 👁` for vision and `· retires {date}` when `retiresOn` is set.
- The Image select (and the Fallback select, per the existing server rule) lists vision models only.
- A saved slug not on the menu is still preserved as a selected `"<slug> (current)"` option (existing `setSelectValue`, `src/console/page.ts:249`), so a menu change never changes a setting.
- A hint under the selects when Fallback equals Text: "Fallback is the same as the text model, so there is no second model to switch to."

### 5.5 Live test before save

When the owner saves a slug into a slot that **differs from what is stored**, the save route runs one live call per changed slug, unless that slug passed within the last 7 days (cached in `search_cache` as `modelprobe:<slug>`):

- Request: the production OpenRouter shape (`models: [slug]` alone, so OpenRouter cannot fail over to another model), `response_format: json_object`, `max_tokens: REASONING_HEADROOM`, a short instruction to return `{"ok": true}`. For the image and fallback slots, the message also carries one small image (builder's choice of a stable public image).
- Pass: HTTP ok, the response's `model` matches the requested slug or its `canonical_slug`, and the content parses (with the existing fence-tolerant JSON parser) to an object whose `ok` is `true`.
- Fail: the save is refused for that slot with the reason in plain words (for example "returned no text: may need a larger token budget", "our key cannot use this model", "did not return JSON"). Nothing is stored.
- The call is logged to `llm_usage` as function `model-probe` so it shows in AI spend.
- Changed slots are tested **in parallel**, each with a **60-second timeout** (a timeout is a fail: "did not answer within 60 seconds"). The console shows "Testing the new model..." while the save is in flight.
- The 7-day pass cache is keyed by slug **and mode**: `modelprobe:<slug>:text` and `modelprobe:<slug>:vision`, because a text pass says nothing about image input.
- No `OPENROUTER_API_KEY` in the environment: a changed slug is refused with "No OpenRouter key is configured, so new models cannot be tested." Unchanged slugs still save.

### 5.6 Save validation (replaces the "in the catalog" rule)

For each slot, in `POST /api/llm`:
- **Unchanged** from the stored value: accepted with no check (fixes the anti-goal in section 2).
- **Changed**: must be in the feed (not necessarily on the menu, since a pin may add it), must not be a `~` alias, must pass the vision rule for image and fallback (existing `visionModelRejected`, now fed from the feed), and must pass the live test (5.5).
- **Feed unreachable**: unchanged slugs are accepted; a changed slug is refused with "Cannot verify new models right now; try again shortly."

### 5.6.1 Price check before an expensive save (owner decision 2026-11-13, option a)

Premium models stay on the menu with their prices shown; nothing is hidden by price. Instead, a save that makes a slot much more expensive asks first.

- **Cost of a model** = `promptPriceM + completionPriceM` ($ per million input tokens plus $ per million output tokens, from the feed). On the 2026-11-13 feed: GPT-5.6 Luna (the store's current model) is $0.20 + $1.20 = 1.4; Opus 5.5 is $4 + $20 = 24 (about 17x); Fable 5.2 is $8 + $40 = 48 (about 34x).
- **When it asks:** for each changed slot, the new model's cost is compared with the cost of the model stored in that slot (or `SYSTEM_DEFAULT_MODEL` when the slot is blank). Above **3x**, the save is held. If the stored model's price is unknown (delisted), the save is held too, and the message gives the new model's prices instead of a ratio.
- **Enforced by the server**, not only the page: `POST /api/llm` answers a held save with the list of held slots (slot, slug, ratio, prices) and stores nothing. The page then shows an inline confirmation in the AI models card, for example "Claude Opus 5.5 costs about 17x your current text model ($4/M in, $20/M out). Save anyway?" with a "Save anyway" button, which re-sends the same save with `confirmCost: true`. This uses the console's existing inline two-click pattern (`src/console/page.ts:588`), because `window.confirm()` is blocked inside the admin iframe.
- **Order:** the price check runs before the live test (5.5), so a cancelled save spends nothing.
- A cheaper or similarly priced model (3x or less) saves with no extra step.

### 5.7 Retirement watch

- A new per-shop daily stage, `model-watch`, compares the three selected slugs (and the system `SEARCH_MODEL`) with the feed:
  - **delisted**: no longer in the feed;
  - **retiring**: `expiration_date` within 30 days.
- On a new state it sends one `alertOwner` email per (slug, state), de-duplicated with a `search_cache` marker so it does not repeat daily. For `SEARCH_MODEL` the email says a code change is needed, since it is system-fixed.
- `GET /api/models` also returns `selectedStatus` per slot, and the AI models card shows a warning line for any slot that is retiring or delisted.

### 5.8 System models

- New constant `SYSTEM_DEFAULT_MODEL` replaces `CURATED_MODELS[0].slug` in `resolveChain`. Its value is today's menu head, `google/gemini-3.1-pro-preview`, so behaviour is unchanged for any tenant with a blank slot.
- `SEARCH_MODEL` and `DEFAULT_MODEL` stay as they are (`src/llm.ts`); only the watch in 5.7 covers `SEARCH_MODEL`.
- `CURATED_MODELS` is removed once nothing reads it (tests that import it are updated).

### 5.9 Small fixes in the same change

- Correct the `src/llm-resolve.ts` comment to name `DEFAULT_MODEL` without claiming luna.
- If the feed is unreachable and nothing is cached, `GET /api/models` returns only the saved slugs (as "(current)" options) plus pins, with a message "Model list unavailable right now", instead of an empty menu.

## 6. Data flow

```
Daily or on cache miss: OpenRouter feed --reduce--> search_cache openrouter:models:v2 (24h)
Console load: GET /api/models --> buildMenu(feed, llm.menu, now) --> optgroups + selectedStatus
Owner edits providers/pins/hides: POST /api/models/menu --merge--> tenant_config.llm.menu
Owner saves a model: POST /api/llm --> unchanged? accept : (in feed, vision rule, price check > 3x held unless confirmCost, live test) --> saveLlm
Daily stage model-watch: selected slugs + SEARCH_MODEL vs feed --> alertOwner once per (slug, state)
Runtime calls: resolveChain (unchanged except the blank-slot default constant)
```

## 7. Testing

Unit tests over a **trimmed fixture copy of the 2026-11-13 feed** (checked in under `tests/fixtures/`), so the builder's behaviour is pinned to real data:
1. Menu builder: Anthropic yields exactly Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5; Sonnet 4.6 is absent; `:batch`, `~...-latest`, `lyria`, `nano-banana`, `gemini-omni` absent; `deepseek-v4.1-flash-1017` absent while `mistral-small-2603` present; a 2024 Mistral model absent; a provider with only stale families keeps its newest one; cap of 6; hides and pins applied; group order follows the provider list.
2. Live test: pass; HTTP error; empty content (starved reasoning); non-JSON; a different `model` in the response; the 7-day cache skips a second call; usage logged as `model-probe`.
3. Save validation: an unchanged slug not on the menu saves; a changed slug missing from the feed is refused; a `~` alias is refused; a text-only model in the image slot is refused; feed down refuses only changed slugs.
3a. Price check: Luna to Opus 5.5 is held with a ratio near 17 and stores nothing; the same save with `confirmCost: true` proceeds to the live test; a held save makes no live-test call; a change at 3x or less is not held; a stored model with no known price holds the save; a blank slot compares against `SYSTEM_DEFAULT_MODEL`.
4. Merge: an AI-models save keeps `llm.menu`; a menu save keeps `llm.models`, `enabled` and `scoreThreshold`.
5. Model watch: retiring within 30 days alerts once; a second day does not re-alert; delisted alerts; `SEARCH_MODEL` covered.
6. `resolveChain`: a blank slot resolves to `SYSTEM_DEFAULT_MODEL`.
7. Console: the existing `tests/console.test.ts` script-parse guard, plus the optgroup rendering and the "(current)" preservation.

## 8. Rollout

Feature branch, full suite, CI, staging deploy (staging has no store and no crons, so the live test is exercised by hand there through the console), then production only on the owner's explicit "deploy <sha> to production". No migration. The store's saved models are untouched by the deploy; the owner picks new ones when ready.

## 9. Decided, and left to the builder

**Decided by the owner (2026-11-13):** providers the owner controls (option a); newest per family grouped by provider (option 1); new models appear but the store never switches by itself; warnings when a selected model is retiring; research and last-resort models stay system-fixed; a live test before a model can be saved; premium models stay visible, and a save more than 3x as expensive as the slot's current model asks for confirmation (option a, 5.6.1).

**My calls (stated to the owner as proposals; correctable):** the default provider list in 5.3; 6-month staleness; 6 families per provider; 30-day retirement window; 7-day live-test cache; the variant filter list in 5.2; `-preview` merged into its family; `llm.menu` with its own merge route; `SYSTEM_DEFAULT_MODEL` keeping today's head; live tests in parallel with a 60-second timeout; the pass cache keyed by slug and mode; `~` aliases refused as pins; changed slugs refused when no OpenRouter key is configured; cost measured as input plus output price per million; an unknown current price holds the save; the price check enforced on the server and run before the live test.

**Left to the builder:** the exact family-key regex (must satisfy the fixture tests in section 7); the image used in the vision live test; the chip and pin UI details within the existing console style; how the reduced feed is shaped in the cache.
