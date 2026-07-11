# Blog Distribution Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the owner publishes a blog guide, the worker builds a validated creative pack (copy + hero image) and can post it to Pinterest / Facebook / Instagram through the Blotato API, with a per-post-per-channel ledger, per-channel auto toggles (all off), and a console Distribution card.

**Architecture:** New `src/syndicate/` module. The 15-minute cron detects drafted-to-published transitions via the existing `listPostsSynced`, enqueues ledger rows for enabled channels, builds the pack (one LLM copy call + a Blotato media mirror of the article's live hero image), fires channels whose `auto` switch is on, and confirms submissions by polling Blotato. Manual sends and config live on console-session routes. Spec: `docs/superpowers/specs/2026-07-11-blog-distribution-design.md`.

**Tech Stack:** Cloudflare Worker (Hono), D1 via `TenantStore`, `LlmClient.jsonChain` (text role), Blotato REST API (`backend.blotato.com/v2`), vitest.

## Global Constraints

- No em-dash or en-dash anywhere (code, comments, copy, docs). `sanitizeOutbound` additionally enforces it on generated copy at runtime.
- Console browser JS lives inside TS template literals: no backticks, no `${}`, string `+` concatenation, `esc()` on every dynamic value, `\\'` escaping in inline onclick args, event delegation via `data-` attributes. ALWAYS run `npx vitest run tests/console.test.ts` after editing `src/console/*`.
- All D1 access goes through `TenantStore` methods (tenant isolation: every SQL binds `this.shop`).
- Never publish or send anything customer-visible from a cron except through this plan's explicit auto toggles; campaign email sending stays owner-clicked (not in this phase).
- Secrets only via `wrangler secret put` (`BLOTATO_API_KEY`); never in code, vars, or logs.
- Production deploy (`wrangler deploy`, `d1 migrations apply --remote`) requires the owner's explicit "go".
- Before editing the SHARED files (`src/index.ts`, `src/types.ts`, `src/tenant-store.ts`, `src/blog/pipeline.ts`, `src/blog/article.ts`): run `python -m graphite context <file>` and `python -m graphite impact <file>` and read the flagged call sites.
- After every commit: `git push` (standing rule).
- vitest runs in workerd and wedges on rapid consecutive runs: space runs out, and after a wedge (ConnectEx 1225) wait 60-75 s before retrying.
- Copy gates are hard rules from the spec: no currency amounts, no supplier brand tokens, no fulfilment-origin claims (prompt-level), per-channel length caps.

---

### Task 1: Syndication config + migration + store methods

**Files:**
- Modify: `src/types.ts` (after the `ProfitConfig` block, ~line 260)
- Create: `migrations/0029_syndication.sql`
- Modify: `src/tenant-store.ts` (`getConfig` ~line 220, new methods after `setBlogPostAssets` ~line 2172)
- Test: `tests/syndicate.test.ts` (new)

**Interfaces:**
- Consumes: existing `tenant_config` table and `getConfig` merge pattern.
- Produces (later tasks rely on these exact names):
  - `SyndicateChannelConfig { enabled: boolean; auto: boolean; accountId?: string; boardId?: string; pageId?: string }`
  - `SyndicateConfig { channels: { pinterest; facebook; instagram }: SyndicateChannelConfig; digest: { mode: 'weekly' | 'per-post' } }`
  - `DEFAULT_SYNDICATE: SyndicateConfig`, `SYNDICATE_CHANNEL_KEYS: readonly ('pinterest'|'facebook'|'instagram')[]`, `mergeSyndicate(rawJson): SyndicateConfig` (all exported from `src/types.ts`)
  - `TenantConfig.syndicate?: SyndicateConfig` (always populated by `getConfig`)
  - `TenantStore.saveSyndicate(syn: SyndicateConfig): Promise<void>`
  - `TenantStore.upsertSyndicationPack(p: { postId: string; articleHandle: string | null; captionsJson: string; pinImageUrl?: string | null; squareImageUrl?: string | null }): Promise<void>`
  - `TenantStore.getSyndicationPack(postId: string): Promise<SyndicationPackRow | null>` where `SyndicationPackRow { post_id; article_handle; captions_json; pin_image_url; square_image_url; updated_at }`
  - `TenantStore.enqueueSyndication(postId: string, channel: string): Promise<boolean>` (INSERT OR IGNORE; true when a row was created)
  - `TenantStore.listSyndicationLedger(limit?): Promise<SyndicationLedgerRow[]>` where `SyndicationLedgerRow { post_id; channel; status; external_id; error; attempts; sent_at; updated_at }`
  - `TenantStore.markSyndication(postId, channel, patch: { status?: string; externalId?: string | null; error?: string | null; sentAt?: string | null; attempts?: number }): Promise<void>` (error is ALWAYS written, null clears; other fields only when provided)
  - `TenantStore.claimSyndicationAttempt(postId: string, channel: string, expectedAttempts: number): Promise<boolean>` (optimistic-concurrency fence: bumps attempts only when it still equals the expected value; false = another actor is mid-send. This is what makes a concurrent cron sweep + console click unable to double-post.)

- [ ] **Step 1: Write the failing test**

Create `tests/syndicate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeSyndicate, DEFAULT_SYNDICATE, SYNDICATE_CHANNEL_KEYS } from '../src/types';

describe('mergeSyndicate', () => {
  it('empty/corrupt blobs yield the full dormant default', () => {
    expect(mergeSyndicate('')).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate('{')).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate(null)).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate('{}').channels.pinterest).toEqual({ enabled: false, auto: false });
  });
  it('saved partial blob merges per channel without losing siblings', () => {
    const syn = mergeSyndicate(JSON.stringify({ channels: { pinterest: { enabled: true, accountId: 'a1', boardId: 'b1' } } }));
    expect(syn.channels.pinterest).toEqual({ enabled: true, auto: false, accountId: 'a1', boardId: 'b1' });
    expect(syn.channels.facebook).toEqual({ enabled: false, auto: false });
    expect(syn.digest.mode).toBe('weekly');
  });
  it('channel keys are the stable registry', () => {
    expect(SYNDICATE_CHANNEL_KEYS).toEqual(['pinterest', 'facebook', 'instagram']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: FAIL (`mergeSyndicate` is not exported).

- [ ] **Step 3: Add the config types to `src/types.ts`**

First run `python -m graphite context src/types.ts` and `python -m graphite impact src/types.ts` (shared file rule). Then add after the `DEFAULT_PROFIT` export:

```ts
/** Blog syndication (2026-07-11 design): per-channel distribution config.
 * Ships DORMANT: every channel disabled until the owner configures it in the
 * console, and `auto` is a separate per-channel switch (all false at first),
 * the same preview-to-full-auto ramp as the profitability agent. `digest` is
 * consumed by phase 3 (email digest cadence); stored now so the block shape
 * is stable. See docs/superpowers/specs/2026-07-11-blog-distribution-design.md. */
export interface SyndicateChannelConfig {
  enabled: boolean;   // configured + participating (ledger rows get created)
  auto: boolean;      // fire on publish without an owner click
  accountId?: string; // Blotato connected-account id
  boardId?: string;   // pinterest only
  pageId?: string;    // facebook only
}
export interface SyndicateConfig {
  channels: {
    pinterest: SyndicateChannelConfig;
    facebook: SyndicateChannelConfig;
    instagram: SyndicateChannelConfig;
  };
  digest: { mode: 'weekly' | 'per-post' };
}
export type SyndicateChannelKey = keyof SyndicateConfig['channels'];
export const SYNDICATE_CHANNEL_KEYS: readonly SyndicateChannelKey[] = ['pinterest', 'facebook', 'instagram'];
export const DEFAULT_SYNDICATE: SyndicateConfig = {
  channels: {
    pinterest: { enabled: false, auto: false },
    facebook: { enabled: false, auto: false },
    instagram: { enabled: false, auto: false }
  },
  digest: { mode: 'weekly' }
};
/** Two-level default merge for the stored tenant_config.syndicate blob (a
 * partial saved block must not erase sibling channels or the digest mode). */
export function mergeSyndicate(rawJson: string | null | undefined): SyndicateConfig {
  let raw: { channels?: Record<string, Partial<SyndicateChannelConfig>>; digest?: Partial<SyndicateConfig['digest']> } = {};
  try { raw = JSON.parse(rawJson || '{}') ?? {}; } catch { raw = {}; }
  const ch = (k: SyndicateChannelKey): SyndicateChannelConfig => ({ ...DEFAULT_SYNDICATE.channels[k], ...(raw.channels?.[k] ?? {}) });
  return {
    channels: { pinterest: ch('pinterest'), facebook: ch('facebook'), instagram: ch('instagram') },
    digest: { ...DEFAULT_SYNDICATE.digest, ...(raw.digest ?? {}) }
  };
}
```

And add to `TenantConfig` (after `profit?: ProfitConfig;`):

```ts
  // Blog syndication config. Always populated by getConfig ('{}' default +
  // mergeSyndicate); optional on hand-built cfgs. Read via mergeSyndicate guard.
  syndicate?: SyndicateConfig;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create `migrations/0029_syndication.sql`**

```sql
-- Blog distribution phase 1 (2026-07-11 design): per-post creative pack +
-- per-channel send ledger. UNIQUE(shop, post_id, channel) via the ledger PK is
-- THE idempotency guarantee - a re-run sweep can never double-post. Statuses:
-- queued (awaiting send) | sent (accepted by Blotato, pending confirmation) |
-- published (confirmed live) | failed | skipped. tenant_config gains the
-- 'syndicate' block (channel toggles), merged over DEFAULT_SYNDICATE on read.
CREATE TABLE syndication_packs (
  shop             TEXT NOT NULL,
  post_id          TEXT NOT NULL,           -- blog_post_drafts.id
  article_handle   TEXT,                    -- live article handle at pack time (URL building)
  captions_json    TEXT NOT NULL,           -- validated SyndicationCopy JSON
  pin_image_url    TEXT,                    -- Blotato-hosted mirror of the article hero
  square_image_url TEXT,                    -- phase 2 (composed creative), null in phase 1
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (shop, post_id)
);

CREATE TABLE syndication_ledger (
  shop        TEXT NOT NULL,
  post_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  external_id TEXT,                          -- Blotato postSubmissionId
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (shop, post_id, channel)
);

ALTER TABLE tenant_config ADD COLUMN syndicate TEXT NOT NULL DEFAULT '{}';
```

- [ ] **Step 6: Wire the store methods in `src/tenant-store.ts`**

First run `python -m graphite context src/tenant-store.ts` and `python -m graphite impact src/tenant-store.ts`. Then:

(a) Import the new symbols in the existing types import at line 1: add `DEFAULT_SYNDICATE` is NOT needed; add `mergeSyndicate` and `type SyndicateConfig`.

(b) In `getConfig` (line ~222): add `syndicate` to the SELECT column list and row type, and add to the returned object (after `profit:`):

```ts
      syndicate: mergeSyndicate(row.syndicate),
```

SELECT becomes: `SELECT collection_map, gates, pricing, floors, llm, addons, fulfil, inbox, semantic, target, profit, syndicate FROM tenant_config WHERE shop = ?1` and the `.first<...>()` type gains `syndicate: string`.

(c) After `saveProfit` add:

```ts
  /** Persist the blog syndication config block (channel toggles + digest mode). */
  async saveSyndicate(syn: SyndicateConfig): Promise<void> {
    await this.db
      .prepare(`UPDATE tenant_config SET syndicate = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, JSON.stringify(syn), new Date().toISOString())
      .run();
  }
```

(d) After `setBlogPostAssets` (~line 2172) add the pack + ledger methods:

```ts
  // --- Blog syndication (phase 1, 2026-07-11): creative packs + send ledger ---

  async upsertSyndicationPack(p: {
    postId: string; articleHandle: string | null; captionsJson: string;
    pinImageUrl?: string | null; squareImageUrl?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO syndication_packs (shop, post_id, article_handle, captions_json, pin_image_url, square_image_url, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                ON CONFLICT(shop, post_id) DO UPDATE SET article_handle = excluded.article_handle,
                  captions_json = excluded.captions_json, pin_image_url = excluded.pin_image_url,
                  square_image_url = excluded.square_image_url, updated_at = excluded.updated_at`)
      .bind(this.shop, p.postId, p.articleHandle, p.captionsJson, p.pinImageUrl ?? null, p.squareImageUrl ?? null, now)
      .run();
  }

  async getSyndicationPack(postId: string): Promise<{
    post_id: string; article_handle: string | null; captions_json: string;
    pin_image_url: string | null; square_image_url: string | null; updated_at: string;
  } | null> {
    return await this.db
      .prepare(`SELECT post_id, article_handle, captions_json, pin_image_url, square_image_url, updated_at
                FROM syndication_packs WHERE shop = ?1 AND post_id = ?2`)
      .bind(this.shop, postId)
      .first();
  }

  /** Idempotent enqueue: the (shop, post_id, channel) PK means a re-run can
   * never create a second row. Returns true when a NEW row was created. */
  async enqueueSyndication(postId: string, channel: string): Promise<boolean> {
    const now = new Date().toISOString();
    const r = await this.db
      .prepare(`INSERT OR IGNORE INTO syndication_ledger (shop, post_id, channel, status, attempts, created_at, updated_at)
                VALUES (?1, ?2, ?3, 'queued', 0, ?4, ?4)`)
      .bind(this.shop, postId, channel, now)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async listSyndicationLedger(limit = 300): Promise<{
    post_id: string; channel: string; status: string; external_id: string | null;
    error: string | null; attempts: number; sent_at: string | null; updated_at: string;
  }[]> {
    const rs = await this.db
      .prepare(`SELECT post_id, channel, status, external_id, error, attempts, sent_at, updated_at
                FROM syndication_ledger WHERE shop = ?1 ORDER BY updated_at DESC LIMIT ?2`)
      .bind(this.shop, limit)
      .all<{ post_id: string; channel: string; status: string; external_id: string | null; error: string | null; attempts: number; sent_at: string | null; updated_at: string }>();
    return rs.results ?? [];
  }

  /** Partial ledger update. `error` is ALWAYS written (pass null to clear);
   * status/externalId/sentAt/attempts only when provided. */
  async markSyndication(postId: string, channel: string, patch: {
    status?: string; externalId?: string | null; error?: string | null; sentAt?: string | null; attempts?: number;
  }): Promise<void> {
    await this.db
      .prepare(`UPDATE syndication_ledger SET
                  status = COALESCE(?4, status),
                  external_id = COALESCE(?5, external_id),
                  error = ?6,
                  sent_at = COALESCE(?7, sent_at),
                  attempts = COALESCE(?8, attempts),
                  updated_at = ?3
                WHERE shop = ?1 AND post_id = ?2 AND channel = ?9`)
      .bind(this.shop, postId, new Date().toISOString(), patch.status ?? null, patch.externalId ?? null,
            patch.error ?? null, patch.sentAt ?? null, patch.attempts ?? null, channel)
      .run();
  }

  /** Optimistic send fence: bump attempts only if it still equals the value
   * the caller read. Returns false when a concurrent actor (cron sweep vs a
   * console click) claimed the send first - the loser must NOT post. This is
   * the double-post guard for a public action; crash-safe (a crash after a
   * claim just burns one attempt number, it never strands a status). */
  async claimSyndicationAttempt(postId: string, channel: string, expectedAttempts: number): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE syndication_ledger SET attempts = attempts + 1, updated_at = ?3
                WHERE shop = ?1 AND post_id = ?2 AND channel = ?4 AND attempts = ?5`)
      .bind(this.shop, postId, new Date().toISOString(), channel, expectedAttempts)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
```

- [ ] **Step 7: Typecheck + full syndicate test run**

Run: `npx tsc --noEmit` then `npx vitest run tests/syndicate.test.ts`
Expected: both clean. (Store methods are exercised by typecheck + the live migration at deploy; engine tests in Task 5 fake the store, per house pattern.)

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/tenant-store.ts migrations/0029_syndication.sql tests/syndicate.test.ts
git commit -m "feat(syndicate): config block, pack + ledger tables, store methods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 2: Creative pack copy (LLM call + hard gates)

**Files:**
- Create: `src/syndicate/pack.ts`
- Test: `tests/syndicate.test.ts` (extend)

**Interfaces:**
- Consumes: `LlmClient.jsonChain({chain, system, user, maxTokens, validate})` from `src/llm.ts`, `resolveChain(cfg, 'text')` from `src/llm-resolve.ts`, `sanitizeOutbound` from `src/inbox/draft.ts`, `BRAND_TOKENS` from `src/debrand.ts`, `TenantStore.logLlmUsage`.
- Produces:
  - `SyndicationCopy { pinTitle: string; pinDesc: string; caption: string; teaser: string; altText: string }`
  - `COPY_CAPS: Record<keyof SyndicationCopy, number>` (pinTitle 100, pinDesc 500, caption 2200, teaser 300, altText 500)
  - `copyGateErrors(c: SyndicationCopy): string[]`
  - `validateCopy(v: unknown): SyndicationCopy | null` (sanitizes, then gates)
  - `buildCopy(llm: LlmClient, store: TenantStore, cfg: TenantConfig, input: { articleTitle: string; collectionHandle: string | null; productTitles: string[] }): Promise<SyndicationCopy | null>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/syndicate.test.ts`:

```ts
import { validateCopy, copyGateErrors, buildCopy, COPY_CAPS, type SyndicationCopy } from '../src/syndicate/pack';
import type { TenantStore } from '../src/tenant-store';
import type { TenantConfig } from '../src/types';
import type { LlmClient } from '../src/llm';

const GOOD_COPY = {
  pinTitle: 'How to keep your cat drinking enough water',
  pinDesc: 'Simple ways to get a reluctant cat drinking more, and what to look for in a fountain.',
  caption: 'Cats are famously bad at staying hydrated. Our new guide covers the why and the fixes.',
  teaser: 'Why cats under-drink, and what actually helps.',
  altText: 'A cat drinking from a pet water fountain'
};

const CFG = { llm: { enabled: true, scoreThreshold: 60, models: {} } } as unknown as TenantConfig;

describe('syndication copy gates', () => {
  it('accepts clean copy and sanitizes dashes', () => {
    const v = validateCopy({ ...GOOD_COPY, teaser: 'Why cats under-drink — and what helps.' });
    expect(v).not.toBeNull();
    expect(v!.teaser).not.toContain('—');
  });
  it('rejects prices in any field (pins outlive repricing)', () => {
    expect(validateCopy({ ...GOOD_COPY, caption: 'Fountains from £12.99 in stock now' })).toBeNull();
    expect(copyGateErrors({ ...GOOD_COPY, pinDesc: 'now only 9.99 GBP' } as SyndicationCopy).join(' ')).toContain('price');
  });
  it('rejects supplier brand tokens', () => {
    expect(validateCopy({ ...GOOD_COPY, caption: 'Our PawHut fountain guide' })).toBeNull();
  });
  it('rejects missing fields and over-cap lengths', () => {
    expect(validateCopy({ ...GOOD_COPY, altText: '' })).toBeNull();
    expect(validateCopy({ ...GOOD_COPY, pinTitle: 'x'.repeat(COPY_CAPS.pinTitle + 1) })).toBeNull();
    expect(validateCopy(null)).toBeNull();
    expect(validateCopy({})).toBeNull();
  });
});

describe('buildCopy', () => {
  const storeOf = (calls: unknown[][]) => ({
    logLlmUsage: async (...a: unknown[]) => { calls.push(a); }
  }) as unknown as TenantStore;

  it('returns validated copy and logs usage under blog-syndication-copy', async () => {
    const calls: unknown[][] = [];
    const llm = {
      jsonChain: async (opts: { validate: (v: unknown) => unknown }) =>
        ({ ok: true, value: opts.validate(GOOD_COPY), usage: { provider: 'openrouter', model: 'm', promptTokens: 10, completionTokens: 20, costUsd: 0.001 } })
    } as unknown as LlmClient;
    const out = await buildCopy(llm, storeOf(calls), CFG, { articleTitle: 'Cat hydration', collectionHandle: 'pet-health', productTitles: ['Pet Water Fountain 2L'] });
    expect(out).toEqual(expect.objectContaining({ pinTitle: GOOD_COPY.pinTitle }));
    expect(calls[0][0]).toBe('blog-syndication-copy');
  });
  it('degrades to null on chain failure without logging', async () => {
    const calls: unknown[][] = [];
    const llm = { jsonChain: async () => ({ ok: false, error: 'exhausted' }) } as unknown as LlmClient;
    expect(await buildCopy(llm, storeOf(calls), CFG, { articleTitle: 'T', collectionHandle: null, productTitles: [] })).toBeNull();
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: FAIL (cannot resolve `../src/syndicate/pack`).

- [ ] **Step 3: Implement `src/syndicate/pack.ts`**

```ts
// Creative pack copy (blog distribution phase 1, 2026-07-11): ONE small LLM
// call per published guide writes every channel's copy, validated by HARD code
// gates before anything can ship. The gates, not model confidence, are the
// safety layer: no currency amounts (pins live for months while the profit
// agent reprices every 15 minutes; the landing page shows the live price), no
// supplier brand tokens, per-platform length caps, and sanitizeOutbound (the
// em/en-dash rule) on every field. jsonChain re-asks the model when validate
// returns null, so a gate rejection self-corrects before degrading to null.
import type { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { sanitizeOutbound } from '../inbox/draft';
import { BRAND_TOKENS } from '../debrand';

export interface SyndicationCopy {
  pinTitle: string;  // Pinterest pin title
  pinDesc: string;   // Pinterest pin description
  caption: string;   // Facebook / Instagram caption
  teaser: string;    // email digest teaser (phase 3)
  altText: string;   // image alt text
}

/** Per-platform length caps (Pinterest title/alt from Blotato's target spec;
 * description 500 per Pinterest; caption 2200 per Instagram). */
export const COPY_CAPS: Record<keyof SyndicationCopy, number> = {
  pinTitle: 100, pinDesc: 500, caption: 2200, teaser: 300, altText: 500
};

/** Currency amounts are banned in syndicated copy. */
const PRICE_RE = /[£$€]\s?\d|\b\d+(?:\.\d{1,2})?\s?(?:gbp|usd|eur|pounds?|quid|dollars?)\b/i;

export function copyGateErrors(c: SyndicationCopy): string[] {
  const errs: string[] = [];
  for (const k of Object.keys(COPY_CAPS) as (keyof SyndicationCopy)[]) {
    const v = c[k];
    if (!v || !v.trim()) { errs.push(`${k} is empty`); continue; }
    if (v.length > COPY_CAPS[k]) errs.push(`${k} exceeds ${COPY_CAPS[k]} chars`);
    if (PRICE_RE.test(v)) errs.push(`${k} contains a price`);
    for (const b of BRAND_TOKENS) {
      if (new RegExp(`\\b${b}\\b`, 'i').test(v)) errs.push(`${k} names supplier brand ${b}`);
    }
  }
  return errs;
}

/** Shape-check + sanitize + gate. Passed as jsonChain's validate, so a gate
 * rejection makes the model retry rather than shipping bad copy. */
export function validateCopy(v: unknown): SyndicationCopy | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = {} as SyndicationCopy;
  for (const k of Object.keys(COPY_CAPS) as (keyof SyndicationCopy)[]) {
    if (typeof o[k] !== 'string') return null;
    out[k] = sanitizeOutbound((o[k] as string).trim());
  }
  return copyGateErrors(out).length ? null : out;
}

const COPY_SYSTEM =
  'You write social copy for Active Paw, a UK pet-care store, announcing a newly published buying guide. ' +
  'You are given the guide TITLE, its funnel collection, and the real product titles it features. ' +
  'HARD RULES: restate only what the title and products imply, never invent claims, benefits, statistics or endorsements; ' +
  'NEVER mention a price, discount, or currency amount; NEVER name a manufacturer or supplier brand; ' +
  'never mention shipping times, dispatch, or where products ship from; at most one emoji per field; no hashtags except at most two at the end of caption. ' +
  'Voice: warm, useful, direct, British English. ' +
  'Reply with JSON only: {"pinTitle": string (<=100 chars, the guide as a benefit), ' +
  '"pinDesc": string (<=500 chars, why the guide helps + gentle invitation to read), ' +
  '"caption": string (<=2200 chars but aim for 2-4 sentences, for Facebook/Instagram), ' +
  '"teaser": string (<=300 chars, one-line email teaser), ' +
  '"altText": string (<=500 chars, literal description of a photo of the featured product for accessibility)}';

/** One copy call per pack build. Degrades to null (caller records the error on
 * the ledger rows); never throws. */
export async function buildCopy(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  input: { articleTitle: string; collectionHandle: string | null; productTitles: string[] }
): Promise<SyndicationCopy | null> {
  const result = await llm.jsonChain({
    chain: resolveChain(cfg, 'text'),
    maxTokens: 900,
    system: COPY_SYSTEM,
    user: JSON.stringify({
      guideTitle: input.articleTitle,
      collection: input.collectionHandle ?? undefined,
      featuredProducts: input.productTitles.slice(0, 6)
    }),
    validate: validateCopy
  });
  if (!result.ok) {
    console.warn(`syndication copy failed for "${input.articleTitle}": ${result.error}`);
    return null;
  }
  await store.logLlmUsage('blog-syndication-copy', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  return result.value;
}
```

Note: check `resolveChain`'s import path with `python -m graphite query "callers resolveChain"` before writing the import; `src/llm.ts` imports it from `./llm-resolve`, so `../llm-resolve` is expected here.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/syndicate/pack.ts tests/syndicate.test.ts
git commit -m "feat(syndicate): copy build with hard gates (no prices, no brands, caps)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 3: Blotato client

**Files:**
- Create: `src/syndicate/blotato.ts`
- Modify: `src/types.ts` (Env: add `BLOTATO_API_KEY?: string`)
- Test: `tests/syndicate.test.ts` (extend)

**Interfaces:**
- Consumes: `defaultFetch` from `src/safe-fetch.ts`, `Env` from `src/types.ts`.
- Produces:
  - `class Blotato { constructor(apiKey: string, fetchImpl?: typeof fetch) }` with:
    - `mirrorMedia(url: string): Promise<string | null>` (POST `/v2/media` `{url}` -> hosted `url`)
    - `createPost(p: BlotatoPostInput): Promise<BlotatoSendResult>` (POST `/v2/posts` -> `{postSubmissionId}`)
    - `pollStatus(submissionId: string): Promise<BlotatoStatus | null>` (GET `/v2/posts/:id`)
    - `listAccounts(): Promise<BlotatoAccount[] | null>` (GET `/v2/users/me/accounts`, `{items:[...]}`)
    - `listSubaccounts(accountId: string): Promise<BlotatoAccount[] | null>` (facebook pageId source)
    - `listPinterestBoards(accountId: string): Promise<BlotatoAccount[] | null>` (GET `/v2/social/pinterest/boards?accountId=`)
  - `BlotatoPostInput { accountId: string; text: string; mediaUrls: string[]; platform: 'pinterest' | 'facebook' | 'instagram'; target: Record<string, unknown> }`
  - `BlotatoSendResult = { ok: true; submissionId: string } | { ok: false; error: string; permanent: boolean }`
  - `BlotatoStatus { status: 'in-progress' | 'published' | 'failed'; errorMessage?: string; publicUrl?: string }`
  - `BlotatoAccount { id: string; platform?: string; name?: string; username?: string }`
  - `blotatoFromEnv(env: Env, fetchImpl?: typeof fetch): Blotato | null` (null unless `BLOTATO_API_KEY`; the dormancy switch, mirroring `ebayFromEnv`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/syndicate.test.ts` (add `vi` to the vitest import at the top):

```ts
import { Blotato, blotatoFromEnv } from '../src/syndicate/blotato';
import type { Env } from '../src/types';

describe('Blotato client', () => {
  it('mirrorMedia returns the hosted url, null on failure', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ url: 'https://database.blotato.com/abc.jpg' }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    const b = new Blotato('k', f as unknown as typeof fetch);
    expect(await b.mirrorMedia('https://cdn.shopify.com/x.jpg')).toBe('https://database.blotato.com/abc.jpg');
    expect(await b.mirrorMedia('https://cdn.shopify.com/x.jpg')).toBeNull();
    const call = f.mock.calls[0];
    expect(call[0]).toBe('https://backend.blotato.com/v2/media');
    expect((call[1] as { headers: Record<string, string> }).headers['blotato-api-key']).toBe('k');
  });

  it('createPost returns the submission id; 4xx is permanent, 5xx/429 is not', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ postSubmissionId: 'sub-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ message: 'bad boardId' }) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ message: 'slow down' }) });
    const b = new Blotato('k', f as unknown as typeof fetch);
    const post = { accountId: 'a', text: 't', mediaUrls: [], platform: 'pinterest' as const, target: { targetType: 'pinterest' } };
    expect(await b.createPost(post)).toEqual({ ok: true, submissionId: 'sub-1' });
    expect(await b.createPost(post)).toEqual({ ok: false, error: 'bad boardId', permanent: true });
    expect(await b.createPost(post)).toEqual({ ok: false, error: 'slow down', permanent: false });
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body.post.content.platform).toBe('pinterest');
  });

  it('pollStatus maps the three states, null on transport error', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'published', publicUrl: 'https://pin.it/x' }) })
      .mockRejectedValueOnce(new Error('net'));
    const b = new Blotato('k', f as unknown as typeof fetch);
    expect(await b.pollStatus('sub-1')).toEqual({ status: 'published', errorMessage: undefined, publicUrl: 'https://pin.it/x' });
    expect(await b.pollStatus('sub-1')).toBeNull();
  });

  it('listAccounts/listPinterestBoards unwrap items[]', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [{ id: '98432', platform: 'pinterest', username: 'activepaw' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [{ id: 'board-1', name: 'Pet Care Guides' }] }) });
    const b = new Blotato('k', f as unknown as typeof fetch);
    expect((await b.listAccounts())![0].id).toBe('98432');
    expect((await b.listPinterestBoards('98432'))![0].id).toBe('board-1');
    expect(f.mock.calls[1][0]).toContain('/social/pinterest/boards?accountId=98432');
  });

  it('blotatoFromEnv is dormant without the secret', () => {
    expect(blotatoFromEnv({} as Env)).toBeNull();
    expect(blotatoFromEnv({ BLOTATO_API_KEY: 'k' } as Env)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: FAIL (cannot resolve `../src/syndicate/blotato`).

- [ ] **Step 3: Implement `src/syndicate/blotato.ts`**

```ts
// Thin Blotato REST client (blog distribution phase 1). Blotato is the social
// posting RAIL only: account OAuth lives in their dashboard, this client just
// mirrors media and submits posts with the vault-external worker secret
// BLOTATO_API_KEY. Deliberately swappable: everything upstream (pack, ledger,
// console) is rail-agnostic, per the spec's 90-day earn-it review exit path.
// API shapes verified against help.blotato.com 2026-07-11: POST /v2/media
// {url} -> {url}; POST /v2/posts -> 201 {postSubmissionId} (async);
// GET /v2/posts/:id -> {status: in-progress|published|failed, errorMessage?,
// publicUrl?}; account/board lists return {items: [...]}. Post creation is
// rate-limited 30/min (far above our few posts a week).
import { defaultFetch } from '../safe-fetch';
import type { Env } from '../types';

const BASE = 'https://backend.blotato.com/v2';

export interface BlotatoPostInput {
  accountId: string;
  text: string;
  mediaUrls: string[];
  platform: 'pinterest' | 'facebook' | 'instagram';
  target: Record<string, unknown>;
}
export type BlotatoSendResult = { ok: true; submissionId: string } | { ok: false; error: string; permanent: boolean };
export interface BlotatoStatus { status: 'in-progress' | 'published' | 'failed'; errorMessage?: string; publicUrl?: string }
export interface BlotatoAccount { id: string; platform?: string; name?: string; username?: string }

export class Blotato {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = defaultFetch) {}

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'blotato-api-key': this.apiKey };
  }

  /** Mirror a public image onto Blotato hosting (their media pipeline wants
   * media served from their domain). Null on any failure. */
  async mirrorMedia(url: string): Promise<string | null> {
    try {
      const r = await this.fetchImpl(`${BASE}/media`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ url }) });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { url?: string } | null;
      return j?.url ?? null;
    } catch { return null; }
  }

  /** Submit a post. Blotato queues it (async): a true result means ACCEPTED,
   * not live - pollStatus confirms. permanent=true (4xx except 429) tells the
   * sweep a retry with the same payload cannot succeed. */
  async createPost(p: BlotatoPostInput): Promise<BlotatoSendResult> {
    let r: Response;
    try {
      r = await this.fetchImpl(`${BASE}/posts`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ post: { accountId: p.accountId, content: { text: p.text, mediaUrls: p.mediaUrls, platform: p.platform }, target: p.target } })
      });
    } catch (e) { return { ok: false, error: (e as Error).message, permanent: false }; }
    const j = (await r.json().catch(() => null)) as { postSubmissionId?: string; message?: string; error?: string } | null;
    if (!r.ok) {
      return { ok: false, error: j?.message ?? j?.error ?? `HTTP ${r.status}`, permanent: r.status >= 400 && r.status < 500 && r.status !== 429 };
    }
    if (!j?.postSubmissionId) return { ok: false, error: 'no postSubmissionId in response', permanent: false };
    return { ok: true, submissionId: j.postSubmissionId };
  }

  async pollStatus(submissionId: string): Promise<BlotatoStatus | null> {
    try {
      const r = await this.fetchImpl(`${BASE}/posts/${encodeURIComponent(submissionId)}`, { headers: this.headers() });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { status?: string; errorMessage?: string; publicUrl?: string } | null;
      if (j?.status !== 'in-progress' && j?.status !== 'published' && j?.status !== 'failed') return null;
      return { status: j.status, errorMessage: j.errorMessage, publicUrl: j.publicUrl };
    } catch { return null; }
  }

  private async listItems(path: string): Promise<BlotatoAccount[] | null> {
    try {
      const r = await this.fetchImpl(`${BASE}${path}`, { headers: this.headers() });
      if (!r.ok) return null;
      const j = (await r.json().catch(() => null)) as { items?: BlotatoAccount[] } | null;
      return j?.items ?? null;
    } catch { return null; }
  }

  listAccounts(): Promise<BlotatoAccount[] | null> { return this.listItems('/users/me/accounts'); }
  listSubaccounts(accountId: string): Promise<BlotatoAccount[] | null> { return this.listItems(`/users/me/accounts/${encodeURIComponent(accountId)}/subaccounts`); }
  listPinterestBoards(accountId: string): Promise<BlotatoAccount[] | null> { return this.listItems(`/social/pinterest/boards?accountId=${encodeURIComponent(accountId)}`); }
}

/** Dormancy switch (mirrors ebayFromEnv): no BLOTATO_API_KEY secret = no rail,
 * queued rows wait and the console shows "not connected". */
export function blotatoFromEnv(env: Env, fetchImpl: typeof fetch = defaultFetch): Blotato | null {
  return env.BLOTATO_API_KEY ? new Blotato(env.BLOTATO_API_KEY, fetchImpl) : null;
}
```

- [ ] **Step 4: Add the Env field in `src/types.ts`**

After the `EBAY_CLIENT_SECRET?: string;` line:

```ts
  // Blotato social posting rail (blog distribution phase 1, 2026-07-11) - optional:
  // absent = syndication rail dormant (ledger rows queue; console shows not connected).
  // $29/mo vendor with a 90-day earn-it review; see the 2026-07-11 spec's exit path.
  BLOTATO_API_KEY?: string;
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/syndicate/blotato.ts src/types.ts tests/syndicate.test.ts
git commit -m "feat(syndicate): Blotato rail client (media mirror, post, poll, accounts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 4: Channel payload mapping + UTM helper

**Files:**
- Create: `src/syndicate/channels.ts`
- Modify: `src/blog/pipeline.ts` (export the existing `BLOG_HANDLE` const)
- Test: `tests/syndicate.test.ts` (extend)

**Interfaces:**
- Consumes: `SyndicationCopy` (Task 2), `BlotatoPostInput` (Task 3), `SyndicateChannelConfig`/`SyndicateChannelKey` (Task 1), `BLOG_HANDLE` from `src/blog/pipeline.ts`.
- Produces:
  - `utmUrl(articleHandle: string, channel: string): string` -> `https://activepaw.co.uk/blogs/guides/<handle>?utm_source=<channel>&utm_medium=social&utm_campaign=guide-<handle>`
  - `blotatoPostFor(channel: SyndicateChannelKey, ch: SyndicateChannelConfig, input: { copy: SyndicationCopy; articleHandle: string; imageUrl: string | null }): BlotatoPostInput | { error: string }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/syndicate.test.ts`:

```ts
import { utmUrl, blotatoPostFor } from '../src/syndicate/channels';
import type { SyndicateChannelConfig } from '../src/types';

describe('channel payloads', () => {
  const copy = GOOD_COPY as SyndicationCopy;
  const IMG = 'https://database.blotato.com/abc.jpg';

  it('utmUrl carries source, medium and the guide campaign', () => {
    expect(utmUrl('cat-hydration', 'pinterest'))
      .toBe('https://activepaw.co.uk/blogs/guides/cat-hydration?utm_source=pinterest&utm_medium=social&utm_campaign=guide-cat-hydration');
  });

  it('pinterest: pin with board, title, utm link, alt and image', () => {
    const ch: SyndicateChannelConfig = { enabled: true, auto: false, accountId: 'a1', boardId: 'b1' };
    const p = blotatoPostFor('pinterest', ch, { copy, articleHandle: 'cat-hydration', imageUrl: IMG });
    expect(p).toEqual({
      accountId: 'a1', text: copy.pinDesc, mediaUrls: [IMG], platform: 'pinterest',
      target: { targetType: 'pinterest', boardId: 'b1', title: copy.pinTitle, link: utmUrl('cat-hydration', 'pinterest'), altText: copy.altText }
    });
  });

  it('facebook: link post (OG card carries the image), pageId required', () => {
    const ch: SyndicateChannelConfig = { enabled: true, auto: false, accountId: 'a2', pageId: 'pg9' };
    const p = blotatoPostFor('facebook', ch, { copy, articleHandle: 'cat-hydration', imageUrl: IMG });
    expect(p).toEqual({
      accountId: 'a2', text: copy.caption, mediaUrls: [], platform: 'facebook',
      target: { targetType: 'facebook', pageId: 'pg9', link: utmUrl('cat-hydration', 'facebook') }
    });
    expect(blotatoPostFor('facebook', { enabled: true, auto: false, accountId: 'a2' }, { copy, articleHandle: 'h', imageUrl: IMG }))
      .toEqual({ error: 'facebook channel has no pageId' });
  });

  it('instagram: image post, url rides in the caption text', () => {
    const ch: SyndicateChannelConfig = { enabled: true, auto: false, accountId: 'a3' };
    const p = blotatoPostFor('instagram', ch, { copy, articleHandle: 'cat-hydration', imageUrl: IMG });
    if ('error' in p) throw new Error(p.error);
    expect(p.mediaUrls).toEqual([IMG]);
    expect(p.text).toContain(utmUrl('cat-hydration', 'instagram'));
    expect(p.target).toEqual({ targetType: 'instagram' });
  });

  it('hard errors: no accountId, and no image where an image is required', () => {
    expect(blotatoPostFor('pinterest', { enabled: true, auto: false, boardId: 'b' }, { copy, articleHandle: 'h', imageUrl: IMG }))
      .toEqual({ error: 'channel has no connected accountId' });
    expect(blotatoPostFor('pinterest', { enabled: true, auto: false, accountId: 'a', boardId: 'b' }, { copy, articleHandle: 'h', imageUrl: null }))
      .toEqual({ error: 'no image available for a pin' });
    expect(blotatoPostFor('instagram', { enabled: true, auto: false, accountId: 'a' }, { copy, articleHandle: 'h', imageUrl: null }))
      .toEqual({ error: 'no image available for an instagram post' });
  });
});
```

(Adjust the `GOOD_COPY as SyndicationCopy` cast: `GOOD_COPY` from Task 2 already matches the shape.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: FAIL (cannot resolve `../src/syndicate/channels`).

- [ ] **Step 3: Export `BLOG_HANDLE` from the pipeline**

Run `python -m graphite context src/blog/pipeline.ts` first (shared file). In `src/blog/pipeline.ts` line 82 change:

```ts
const BLOG_HANDLE = 'guides';              // the clean handle we want: /blogs/guides
```

to:

```ts
export const BLOG_HANDLE = 'guides';       // the clean handle we want: /blogs/guides (also imported by src/syndicate)
```

- [ ] **Step 4: Implement `src/syndicate/channels.ts`**

```ts
// Channel payload mapping (blog distribution phase 1): pure functions from a
// creative pack to a Blotato post per channel. Rail-agnostic callers (sweep,
// manual send route) only see BlotatoPostInput | {error}; a config gap (no
// account/board/image) is a HARD error surfaced on the ledger, never a silent
// skip. UTM discipline: every link carries source/medium/campaign so Shopify
// analytics can attribute sessions and sales per channel per guide (the data
// the 90-day Blotato review reads).
import type { SyndicationCopy } from './pack';
import type { BlotatoPostInput } from './blotato';
import type { SyndicateChannelConfig, SyndicateChannelKey } from '../types';
import { BLOG_HANDLE } from '../blog/pipeline';

export const STORE_URL = 'https://activepaw.co.uk';

export function utmUrl(articleHandle: string, channel: string): string {
  return `${STORE_URL}/blogs/${BLOG_HANDLE}/${articleHandle}`
    + `?utm_source=${encodeURIComponent(channel)}&utm_medium=social&utm_campaign=guide-${encodeURIComponent(articleHandle)}`;
}

export interface ChannelSendInput { copy: SyndicationCopy; articleHandle: string; imageUrl: string | null }

export function blotatoPostFor(
  channel: SyndicateChannelKey, ch: SyndicateChannelConfig, input: ChannelSendInput
): BlotatoPostInput | { error: string } {
  if (!ch.accountId) return { error: 'channel has no connected accountId' };
  const link = utmUrl(input.articleHandle, channel);
  if (channel === 'pinterest') {
    if (!ch.boardId) return { error: 'pinterest channel has no boardId' };
    if (!input.imageUrl) return { error: 'no image available for a pin' };
    return {
      accountId: ch.accountId, text: input.copy.pinDesc, mediaUrls: [input.imageUrl], platform: 'pinterest',
      target: { targetType: 'pinterest', boardId: ch.boardId, title: input.copy.pinTitle, link, altText: input.copy.altText }
    };
  }
  if (channel === 'facebook') {
    if (!ch.pageId) return { error: 'facebook channel has no pageId' };
    // Link post, no media: Facebook renders the article's OG card (built and
    // debugger-verified in the blog MVP), which converts better than a photo
    // post whose link hides in the text.
    return {
      accountId: ch.accountId, text: input.copy.caption, mediaUrls: [], platform: 'facebook',
      target: { targetType: 'facebook', pageId: ch.pageId, link }
    };
  }
  // instagram: feed posts carry no clickable link; the URL rides in the caption.
  if (!input.imageUrl) return { error: 'no image available for an instagram post' };
  return {
    accountId: ch.accountId, text: `${input.copy.caption}\n\nRead the guide: ${link}`, mediaUrls: [input.imageUrl], platform: 'instagram',
    target: { targetType: 'instagram' }
  };
}
```

- [ ] **Step 5: Run to verify pass, plus the blog suite (pipeline export change)**

Run: `npx vitest run tests/syndicate.test.ts` then (after a pause) `npx vitest run tests/blog.test.ts`
Expected: both PASS (the pipeline change is export-only).

- [ ] **Step 6: Commit**

```bash
git add src/syndicate/channels.ts src/blog/pipeline.ts tests/syndicate.test.ts
git commit -m "feat(syndicate): per-channel Blotato payloads + UTM discipline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 5: Live article info query

**Files:**
- Modify: `src/blog/article.ts` (after `getPublishedMap`, ~line 165)
- Test: `tests/syndicate.test.ts` (extend)

**Interfaces:**
- Consumes: `AdminGraphql` (a `(query, vars) => Promise<Record<string, unknown>>` function type from `src/shopify-admin.ts`).
- Produces:
  - `ArticleSyndicationInfo { id: string; handle: string; title: string; imageUrl: string | null; isPublished: boolean }`
  - `getArticlesForSyndication(admin: AdminGraphql, ids: string[]): Promise<Map<string, ArticleSyndicationInfo>>`

Why live-fetch instead of the D1 `hero_image_url`: the owner sometimes swaps a hero in Shopify admin after authoring (it happened 2026-07-10); the pin must carry the CURRENT article image and handle, so Shopify is the source of truth at pack time.

- [ ] **Step 1: Write the failing test**

Append to `tests/syndicate.test.ts`:

```ts
import { getArticlesForSyndication } from '../src/blog/article';
import type { AdminGraphql } from '../src/shopify-admin';

describe('getArticlesForSyndication', () => {
  it('maps id -> handle/title/image/published; missing nodes absent', async () => {
    const admin = (async (_q: string, vars?: Record<string, unknown>) => {
      expect((vars as { ids: string[] }).ids).toEqual(['gid://shopify/Article/1', 'gid://shopify/Article/2']);
      return { nodes: [
        { id: 'gid://shopify/Article/1', handle: 'cat-hydration', title: 'Cat hydration', image: { url: 'https://cdn.shopify.com/h.jpg' }, isPublished: true },
        null
      ] };
    }) as unknown as AdminGraphql;
    const m = await getArticlesForSyndication(admin, ['gid://shopify/Article/1', 'gid://shopify/Article/2']);
    expect(m.get('gid://shopify/Article/1')).toEqual({ id: 'gid://shopify/Article/1', handle: 'cat-hydration', title: 'Cat hydration', imageUrl: 'https://cdn.shopify.com/h.jpg', isPublished: true });
    expect(m.has('gid://shopify/Article/2')).toBe(false);
    expect(await getArticlesForSyndication(admin, [])).toEqual(new Map());
  });
});
```

Note: the empty-ids assertion must not hit the fake admin; `getArticlesForSyndication` returns early on `ids.length === 0`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: FAIL (no export `getArticlesForSyndication`).

- [ ] **Step 3: Implement in `src/blog/article.ts`**

Run `python -m graphite context src/blog/article.ts` first. Add after `getPublishedMap`:

```ts
const ARTICLES_FOR_SYNDICATION = `query pawscoutArticlesSyndication($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Article { id handle title isPublished image { url } } }
}`;

export interface ArticleSyndicationInfo { id: string; handle: string; title: string; imageUrl: string | null; isPublished: boolean }

/** Live handle + title + CURRENT featured image per article id, for the
 * syndication pack build. Shopify is the source of truth here (an owner-swapped
 * hero must be what gets pinned, not the stale D1 bookkeeping url). Missing or
 * deleted articles are simply absent. Throws on transport errors (caller
 * degrades). */
export async function getArticlesForSyndication(admin: AdminGraphql, ids: string[]): Promise<Map<string, ArticleSyndicationInfo>> {
  const map = new Map<string, ArticleSyndicationInfo>();
  if (!ids.length) return map;
  const data = await admin(ARTICLES_FOR_SYNDICATION, { ids }) as {
    nodes?: ({ id?: string; handle?: string; title?: string; isPublished?: boolean; image?: { url?: string } | null } | null)[];
  };
  for (const n of data.nodes ?? []) {
    if (!n?.id || !n.handle) continue;
    map.set(n.id, { id: n.id, handle: n.handle, title: n.title ?? '', imageUrl: n.image?.url ?? null, isPublished: n.isPublished === true });
  }
  return map;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/blog/article.ts tests/syndicate.test.ts
git commit -m "feat(blog): live article info query for the syndication pack build

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 6: Sweep engine (enqueue, pack, fire, confirm) + cron wiring

**Files:**
- Create: `src/syndicate/run.ts`
- Modify: `src/index.ts` (scheduled handler, ~line 1560)
- Test: `tests/syndicate.test.ts` (extend)

**Interfaces:**
- Consumes: everything above, plus `listPostsSynced` from `src/blog/pipeline.ts`, `adminForShop` from `src/inbox/invoice-routes.ts`, `LlmClient`, `listActiveShops` from `src/tenant-store.ts`.
- Produces:
  - `SYNDICATION_MAX_AUTO_ATTEMPTS = 3`
  - `anyChannelEnabled(syn: SyndicateConfig): boolean`
  - `ensurePack(env, store, cfg, blotato, post: { id: string; shopifyArticleId: string; title: string; collectionHandle: string | null; relatedHandlesJson: string | null }, opts?: { force?: boolean; fetchImpl?: typeof fetch }): Promise<{ pack: PackInfo } | { error: string }>` where `PackInfo { articleHandle: string | null; copy: SyndicationCopy; pinImageUrl: string | null }`
  - `sendChannel(store, syn, blotato: Blotato | null, postId: string, channel: SyndicateChannelKey, pack: PackInfo, attempts: number): Promise<{ ok: boolean; error?: string }>` (claims via `claimSyndicationAttempt` BEFORE posting; a lost claim aborts the send)
  - `runSyndicationForShop(env, store, cfg, deps?: SyndicationDeps): Promise<{ queued: number; posted: number; confirmed: number; failed: number }>` with `SyndicationDeps { listPosts?; articles?; blotato?; copy?; fire?; fetchImpl? }` (test injection; `fire: false` = enqueue + pack + confirm but never auto-send, used by the console list route so opening the console can never race the cron into a double post)
  - `runSyndicationSweep(env: Env): Promise<void>` (the cron entry)

Behavioral contract (the tests below pin it):
1. Fully dormant (zero D1/API work beyond one config read) when no channel is enabled.
2. Every published post gets exactly one ledger row per ENABLED channel (INSERT OR IGNORE; disabled channels get none).
3. Pack build: live article info -> mirror hero via Blotato -> `buildCopy`; failure writes the error on that post's queued rows and leaves them queued.
4. Auto-fire: only channels with `auto: true`, only rows `status='queued'`, only `attempts < 3`, and only after WINNING the attempts claim (the double-post fence); transient send failure stays `queued` with the error recorded (the claim already bumped attempts); permanent failure goes `failed`. Success -> `sent` + externalId + sentAt.
5. Confirm: rows `status='sent'` with an externalId poll Blotato; `published` -> `published`, `failed` -> `failed` + errorMessage, `in-progress`/null -> unchanged.
6. No Blotato configured: enqueue still happens (console shows the queue), nothing sends, no attempts burned.
7. `deps.fire === false`: queued rows on auto channels are NOT sent (everything else runs).

- [ ] **Step 1: Write the failing tests**

Append to `tests/syndicate.test.ts`. Build a tiny in-memory fake store (only the methods the engine touches) and fakes for posts/articles/blotato:

```ts
import { runSyndicationForShop, anyChannelEnabled, SYNDICATION_MAX_AUTO_ATTEMPTS } from '../src/syndicate/run';
import type { Env as WorkerEnv } from '../src/types';

function fakeSynStore() {
  const ledger = new Map<string, { post_id: string; channel: string; status: string; external_id: string | null; error: string | null; attempts: number; sent_at: string | null; updated_at: string }>();
  const packs = new Map<string, { post_id: string; article_handle: string | null; captions_json: string; pin_image_url: string | null; square_image_url: string | null; updated_at: string }>();
  const key = (p: string, c: string) => p + '|' + c;
  return {
    ledger, packs,
    logLlmUsage: async () => {},
    enqueueSyndication: async (p: string, c: string) => {
      if (ledger.has(key(p, c))) return false;
      ledger.set(key(p, c), { post_id: p, channel: c, status: 'queued', external_id: null, error: null, attempts: 0, sent_at: null, updated_at: 't' });
      return true;
    },
    listSyndicationLedger: async () => [...ledger.values()],
    markSyndication: async (p: string, c: string, patch: Record<string, unknown>) => {
      const row = ledger.get(key(p, c))!;
      if (patch.status !== undefined && patch.status !== null) row.status = patch.status as string;
      if (patch.externalId !== undefined && patch.externalId !== null) row.external_id = patch.externalId as string;
      row.error = (patch.error as string | null) ?? null;
      if (patch.sentAt !== undefined && patch.sentAt !== null) row.sent_at = patch.sentAt as string;
      if (patch.attempts !== undefined && patch.attempts !== null) row.attempts = patch.attempts as number;
    },
    claimSyndicationAttempt: async (p: string, c: string, expected: number) => {
      const row = ledger.get(key(p, c));
      if (!row || row.attempts !== expected) return false;
      row.attempts += 1;
      return true;
    },
    upsertSyndicationPack: async (p: { postId: string; articleHandle: string | null; captionsJson: string; pinImageUrl?: string | null }) => {
      packs.set(p.postId, { post_id: p.postId, article_handle: p.articleHandle, captions_json: p.captionsJson, pin_image_url: p.pinImageUrl ?? null, square_image_url: null, updated_at: 't' });
    },
    getSyndicationPack: async (p: string) => packs.get(p) ?? null
  };
}

const POST = { id: 'post-1', shopify_article_id: 'gid://shopify/Article/1', title: 'Cat hydration', status: 'published', collection_handle: 'pet-health', related_handles_json: '["fountain-2l"]', blog_handle: 'guides', brief_json: null, claim_flags_json: null, hero_image_url: null, hero_source_handle: null, created_at: 't' };
const ART = new Map([[POST.shopify_article_id, { id: POST.shopify_article_id, handle: 'cat-hydration', title: 'Cat hydration', imageUrl: 'https://cdn.shopify.com/h.jpg', isPublished: true }]]);

function synCfg(over: Record<string, Partial<SyndicateChannelConfig>>): TenantConfig {
  const syn = mergeSyndicate(JSON.stringify({ channels: over }));
  return { llm: { enabled: true, scoreThreshold: 60, models: {} }, syndicate: syn } as unknown as TenantConfig;
}

const okLlmEnv = {} as WorkerEnv; // engine receives llm via deps.blotato/copy fakes; env only feeds LlmClient keys

function fakeBlotato(sent: unknown[]) {
  return {
    mirrorMedia: async () => 'https://database.blotato.com/m.jpg',
    createPost: async (p: unknown) => { sent.push(p); return { ok: true as const, submissionId: 'sub-' + sent.length }; },
    pollStatus: async () => ({ status: 'published' as const })
  };
}

describe('runSyndicationForShop', () => {
  const deps = (store: ReturnType<typeof fakeSynStore>, blotato: unknown, copy = GOOD_COPY) => ({
    listPosts: async () => [POST],
    articles: async () => ART,
    blotato: blotato as never,
    copy: async () => copy as never
  });

  it('dormant when no channel is enabled', async () => {
    const store = fakeSynStore();
    const r = await runSyndicationForShop(okLlmEnv, store as never, synCfg({}), deps(store, null));
    expect(r).toEqual({ queued: 0, posted: 0, confirmed: 0, failed: 0 });
    expect(store.ledger.size).toBe(0);
  });

  it('enqueues one row per enabled channel, idempotently, manual channels stay queued', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, accountId: 'a', boardId: 'b' }, facebook: { enabled: true, accountId: 'a', pageId: 'p' } });
    const r1 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato([])));
    expect(r1.queued).toBe(2);
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('queued'); // auto off
    expect(store.ledger.has('post-1|instagram')).toBe(false);            // disabled channel: no row
    const r2 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato([])));
    expect(r2.queued).toBe(0); // idempotent
  });

  it('auto channel fires with the pack image + utm link and confirms to published', async () => {
    const store = fakeSynStore();
    const sent: { target: { link?: string }; mediaUrls: string[] }[] = [];
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const r1 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato(sent)));
    expect(r1.posted).toBe(1);
    expect(sent[0].mediaUrls).toEqual(['https://database.blotato.com/m.jpg']); // mirrored, not the Shopify url
    expect(sent[0].target.link).toContain('utm_source=pinterest');
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('sent');
    const r2 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato(sent)));
    expect(r2.confirmed).toBe(1);
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('published');
  });

  it('copy failure leaves rows queued with the error recorded', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const d = deps(store, fakeBlotato([]));
    (d as { copy: unknown }).copy = async () => null;
    const r = await runSyndicationForShop(okLlmEnv, store as never, cfg, d);
    expect(r.posted).toBe(0);
    const row = store.ledger.get('post-1|pinterest')!;
    expect(row.status).toBe('queued');
    expect(row.error).toContain('pack');
  });

  it('transient send failure bumps attempts and stops at the auto cap', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const failing = { ...fakeBlotato([]), createPost: async () => ({ ok: false as const, error: 'rate limited', permanent: false }) };
    for (let i = 0; i < SYNDICATION_MAX_AUTO_ATTEMPTS + 1; i++) {
      await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, failing));
    }
    const row = store.ledger.get('post-1|pinterest')!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(SYNDICATION_MAX_AUTO_ATTEMPTS); // capped, not 4
    expect(row.error).toContain('rate limited');
  });

  it('fire:false (console list route) enqueues and packs but never auto-sends', async () => {
    const store = fakeSynStore();
    const sent: unknown[] = [];
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const r = await runSyndicationForShop(okLlmEnv, store as never, cfg, { ...deps(store, fakeBlotato(sent)), fire: false });
    expect(r.queued).toBe(1);
    expect(r.posted).toBe(0);
    expect(sent.length).toBe(0);
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('queued');
  });

  it('a lost attempts claim aborts the send (double-post fence)', async () => {
    const store = fakeSynStore();
    const sent: unknown[] = [];
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const racingBlotato = {
      ...fakeBlotato(sent),
      // Simulate a concurrent actor winning between the sweep's ledger read and
      // its claim: bump attempts during the pack's media mirror.
      mirrorMedia: async () => { store.ledger.get('post-1|pinterest')!.attempts = 1; return 'https://database.blotato.com/m.jpg'; }
    };
    const r = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, racingBlotato));
    expect(r.posted).toBe(0);
    expect(sent.length).toBe(0); // the loser never posted
  });

  it('permanent send failure goes failed immediately; no blotato = queued untouched', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const perm = { ...fakeBlotato([]), createPost: async () => ({ ok: false as const, error: 'bad boardId', permanent: true }) };
    await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, perm));
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('failed');

    const store2 = fakeSynStore();
    const r = await runSyndicationForShop(okLlmEnv, store2 as never, cfg, deps(store2, null));
    expect(r.posted).toBe(0);
    expect(store2.ledger.get('post-1|pinterest')!.status).toBe('queued');
    expect(store2.ledger.get('post-1|pinterest')!.attempts).toBe(0);
  });
});

describe('anyChannelEnabled', () => {
  it('true only when at least one channel is enabled', () => {
    expect(anyChannelEnabled(mergeSyndicate('{}'))).toBe(false);
    expect(anyChannelEnabled(mergeSyndicate(JSON.stringify({ channels: { facebook: { enabled: true } } })))).toBe(true);
  });
});
```

Merge the imports at the top of the file as needed (`mergeSyndicate` and `SyndicateChannelConfig` are already imported from Task 1/4; add the new ones).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: FAIL (cannot resolve `../src/syndicate/run`).

- [ ] **Step 3: Implement `src/syndicate/run.ts`**

```ts
// The syndication sweep (blog distribution phase 1). Runs on the 15-minute
// cron: detect drafted-to-published transitions (reusing the same
// listPostsSynced the console list uses, so D1 status follows Shopify), ensure
// each published guide has a creative pack, enqueue one ledger row per ENABLED
// channel (the (shop, post_id, channel) PK makes this idempotent), fire the
// channels whose auto switch is on, and confirm accepted submissions by
// polling Blotato. Manual sends (console route) share ensurePack/sendChannel.
// HITL contract: every channel ships enabled=false auto=false; the owner
// clicks Send per channel in the console until a channel earns its auto flip.
import { LlmClient } from '../llm';
import { TenantStore, listActiveShops } from '../tenant-store';
import { adminForShop } from '../inbox/invoice-routes';
import { defaultFetch } from '../safe-fetch';
import type { Env, TenantConfig, SyndicateConfig, SyndicateChannelKey } from '../types';
import { SYNDICATE_CHANNEL_KEYS, mergeSyndicate } from '../types';
import { listPostsSynced } from '../blog/pipeline';
import { getArticlesForSyndication, type ArticleSyndicationInfo } from '../blog/article';
import type { AdminGraphql } from '../shopify-admin';
import { buildCopy, validateCopy, type SyndicationCopy } from './pack';
import { blotatoPostFor } from './channels';
import { Blotato, blotatoFromEnv } from './blotato';

export const SYNDICATION_MAX_AUTO_ATTEMPTS = 3;

export function anyChannelEnabled(syn: SyndicateConfig): boolean {
  return SYNDICATE_CHANNEL_KEYS.some((k) => syn.channels[k].enabled);
}

export interface PackInfo { articleHandle: string | null; copy: SyndicationCopy; pinImageUrl: string | null }

type PostRow = Awaited<ReturnType<TenantStore['listBlogPostDrafts']>>[number];

/** Test injection points (and the console list route's fire:false); production
 * cron callers pass nothing. */
export interface SyndicationDeps {
  listPosts?: (env: Env, store: TenantStore, fetchImpl?: typeof fetch) => Promise<PostRow[]>;
  articles?: (admin: AdminGraphql, ids: string[]) => Promise<Map<string, ArticleSyndicationInfo>>;
  blotato?: Blotato | null;
  copy?: typeof buildCopy;
  /** false = enqueue + pack + confirm but never auto-send. The console list
   * route uses this so opening the console cannot race the cron into a
   * double post; sends from the console are always the explicit send route. */
  fire?: boolean;
  fetchImpl?: typeof fetch;
}

function parsePack(row: { article_handle: string | null; captions_json: string; pin_image_url: string | null } | null): PackInfo | null {
  if (!row) return null;
  let raw: unknown;
  try { raw = JSON.parse(row.captions_json); } catch { return null; }
  const copy = validateCopy(raw);
  if (!copy) return null;
  return { articleHandle: row.article_handle, copy, pinImageUrl: row.pin_image_url };
}

/** Build (or reuse) the creative pack for one published post. Live Shopify
 * article info is the source of truth (handle + CURRENT hero, so an
 * owner-swapped image is what gets pinned). Degrades to {error}. */
export async function ensurePack(
  env: Env, store: TenantStore, cfg: TenantConfig, blotato: Blotato | null,
  post: { id: string; shopifyArticleId: string; title: string; collectionHandle: string | null; relatedHandlesJson: string | null },
  opts: { force?: boolean; fetchImpl?: typeof fetch; articles?: SyndicationDeps['articles']; copy?: typeof buildCopy } = {}
): Promise<{ pack: PackInfo } | { error: string }> {
  if (!opts.force) {
    const existing = parsePack(await store.getSyndicationPack(post.id));
    if (existing) return { pack: existing };
  }
  const admin = await adminForShop(env, store, opts.fetchImpl ?? defaultFetch).catch(() => null);
  if (!admin) return { error: 'pack build failed: Shopify connection unavailable' };
  let info: ArticleSyndicationInfo | undefined;
  try {
    info = (await (opts.articles ?? getArticlesForSyndication)(admin, [post.shopifyArticleId])).get(post.shopifyArticleId);
  } catch (e) { return { error: `pack build failed: ${(e as Error).message}` }; }
  if (!info) return { error: 'pack build failed: article no longer exists' };

  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, opts.fetchImpl ?? defaultFetch);
  let productTitles: string[] = [];
  try { productTitles = (JSON.parse(post.relatedHandlesJson ?? '[]') as string[]).map((h) => h.replace(/-/g, ' ')); } catch { /* bookkeeping only */ }
  const copy = await (opts.copy ?? buildCopy)(llm, store, cfg, {
    articleTitle: info.title || post.title, collectionHandle: post.collectionHandle, productTitles
  });
  if (!copy) return { error: 'pack build failed: copy agent produced nothing usable' };

  // Mirror the CURRENT article hero onto Blotato hosting. Best-effort: a
  // missing rail or failed mirror leaves pinImageUrl null (image-requiring
  // channels then error per-send, visibly).
  let pinImageUrl: string | null = null;
  if (info.imageUrl && blotato) pinImageUrl = await blotato.mirrorMedia(info.imageUrl);

  await store.upsertSyndicationPack({ postId: post.id, articleHandle: info.handle, captionsJson: JSON.stringify(copy), pinImageUrl });
  return { pack: { articleHandle: info.handle, copy, pinImageUrl } };
}

/** Send one queued channel row. Shared by the auto sweep and the manual
 * console route (the route bypasses the auto flag + attempt cap by calling
 * this directly). Posting is public and irreversible, so the FIRST act is an
 * optimistic claim on the attempts counter: a concurrent actor (cron tick vs
 * console click) makes the loser's claim fail, and the loser never posts. */
export async function sendChannel(
  store: TenantStore, syn: SyndicateConfig, blotato: Blotato | null,
  postId: string, channel: SyndicateChannelKey, pack: PackInfo, attempts: number
): Promise<{ ok: boolean; error?: string }> {
  if (!blotato) return { ok: false, error: 'Blotato is not connected (set BLOTATO_API_KEY)' };
  if (!(await store.claimSyndicationAttempt(postId, channel, attempts))) {
    return { ok: false, error: 'another send for this post and channel is already in flight' };
  }
  if (!pack.articleHandle) {
    await store.markSyndication(postId, channel, { status: 'failed', error: 'no article handle for the link' });
    return { ok: false, error: 'no article handle for the link' };
  }
  const payload = blotatoPostFor(channel, syn.channels[channel], { copy: pack.copy, articleHandle: pack.articleHandle, imageUrl: pack.pinImageUrl });
  if ('error' in payload) {
    await store.markSyndication(postId, channel, { status: 'failed', error: payload.error });
    return { ok: false, error: payload.error };
  }
  const r = await blotato.createPost(payload);
  if (!r.ok) {
    await store.markSyndication(postId, channel, { status: r.permanent ? 'failed' : 'queued', error: r.error });
    return { ok: false, error: r.error };
  }
  await store.markSyndication(postId, channel, {
    status: 'sent', externalId: r.submissionId, error: null, sentAt: new Date().toISOString()
  });
  return { ok: true };
}

/** One shop's sweep pass. See the file header for the five stages. */
export async function runSyndicationForShop(
  env: Env, store: TenantStore, cfg: TenantConfig, deps: SyndicationDeps = {}
): Promise<{ queued: number; posted: number; confirmed: number; failed: number }> {
  const zero = { queued: 0, posted: 0, confirmed: 0, failed: 0 };
  const syn = cfg.syndicate ?? mergeSyndicate('{}');
  if (!anyChannelEnabled(syn)) return zero;

  const posts = await (deps.listPosts ?? listPostsSynced)(env, store, deps.fetchImpl ?? defaultFetch);
  const published = posts.filter((p) => p.status === 'published' && p.shopify_article_id);
  if (!published.length) return zero;

  const out = { ...zero };
  const fire = deps.fire !== false;
  const blotato = deps.blotato !== undefined ? deps.blotato : blotatoFromEnv(env, deps.fetchImpl ?? defaultFetch);

  // 1) Enqueue: one row per published post per ENABLED channel.
  const before = await store.listSyndicationLedger();
  const have = new Set(before.map((r) => `${r.post_id}|${r.channel}`));
  for (const p of published) {
    for (const k of SYNDICATE_CHANNEL_KEYS) {
      if (!syn.channels[k].enabled || have.has(`${p.id}|${k}`)) continue;
      if (await store.enqueueSyndication(p.id, k)) out.queued++;
    }
  }

  const ledger = await store.listSyndicationLedger();
  const byPost = new Map<string, typeof ledger>();
  for (const r of ledger) {
    const arr = byPost.get(r.post_id) ?? [];
    arr.push(r); byPost.set(r.post_id, arr);
  }

  for (const p of published) {
    const rows = byPost.get(p.id) ?? [];
    const queuedRows = rows.filter((r) => r.status === 'queued');

    // 2) Pack: built lazily, only when this post still has queued work.
    let pack: PackInfo | null = null;
    if (queuedRows.length) {
      const ensured = await ensurePack(env, store, cfg, blotato, {
        id: p.id, shopifyArticleId: p.shopify_article_id as string, title: p.title,
        collectionHandle: p.collection_handle, relatedHandlesJson: p.related_handles_json
      }, { fetchImpl: deps.fetchImpl, articles: deps.articles, copy: deps.copy });
      if ('error' in ensured) {
        for (const r of queuedRows) await store.markSyndication(p.id, r.channel, { error: ensured.error });
      } else {
        pack = ensured.pack;
      }
    }

    // 3) Auto-fire queued rows on auto channels (attempt-capped; manual
    //    channels wait for the console click; fire:false skips this stage).
    if (pack && blotato && fire) {
      for (const r of queuedRows) {
        const k = r.channel as SyndicateChannelKey;
        if (!syn.channels[k]?.auto || r.attempts >= SYNDICATION_MAX_AUTO_ATTEMPTS) continue;
        const sent = await sendChannel(store, syn, blotato, p.id, k, pack, r.attempts);
        if (sent.ok) out.posted++; else out.failed++;
      }
    }

    // 4) Confirm accepted submissions.
    if (blotato) {
      for (const r of rows.filter((x) => x.status === 'sent' && x.external_id)) {
        const st = await blotato.pollStatus(r.external_id as string);
        if (!st || st.status === 'in-progress') continue;
        if (st.status === 'published') {
          await store.markSyndication(p.id, r.channel, { status: 'published', error: null });
          out.confirmed++;
        } else {
          await store.markSyndication(p.id, r.channel, { status: 'failed', error: st.errorMessage ?? 'Blotato reports the post failed' });
          out.failed++;
        }
      }
    }
  }
  return out;
}

/** 15-min cron lane. Fully dormant per shop until a channel is enabled: a
 * disabled shop costs one config read (same contract as runProfitAgentSweep). */
export async function runSyndicationSweep(env: Env): Promise<void> {
  for (const shop of await listActiveShops(env.DB)) {
    try {
      const store = new TenantStore(env.DB, shop);
      const cfg = await store.getConfig();
      if (!cfg?.syndicate || !anyChannelEnabled(cfg.syndicate)) continue;
      const r = await runSyndicationForShop(env, store, cfg);
      if (r.queued || r.posted || r.confirmed || r.failed) {
        console.log(`syndication ${shop}: ${r.queued} queued, ${r.posted} posted, ${r.confirmed} confirmed, ${r.failed} failed`);
      }
    } catch (e) { console.warn(`syndication sweep failed for ${shop}: ${(e as Error).message}`); }
  }
}
```

Note for the implementer: the tests inject `deps.copy`; keep that passthrough in `ensurePack` exactly as shown (`opts.copy ?? buildCopy`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/syndicate.test.ts`
Expected: PASS (all engine scenarios).

- [ ] **Step 5: Wire the cron in `src/index.ts`**

Run `python -m graphite context src/index.ts` and `python -m graphite impact src/index.ts` first. Add the import near the other job imports:

```ts
import { runSyndicationSweep } from './syndicate/run';
```

In the scheduled handler (~line 1560) extend the 15-minute `Promise.all`:

```ts
        : Promise.all([runOrderPipeline(env), runInboxClassifySweep(env), runMarketVisibilityReconcile(env), runProfitAgentSweep(env), runSyndicationSweep(env), resumeDailyMaintenance(env)]).then(() => undefined)
```

- [ ] **Step 6: Typecheck + spaced full test batch**

Run: `npx tsc --noEmit`, then `npx vitest run tests/syndicate.test.ts tests/blog.test.ts` (one batch; workerd wedge rule if a second batch is needed).
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/syndicate/run.ts src/index.ts tests/syndicate.test.ts
git commit -m "feat(syndicate): publish-triggered sweep with ledger, auto-fire and confirm

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 7: Console routes

**Files:**
- Modify: `src/index.ts` (after the `/api/blog/enrich` route, ~line 381)
- Test: engine behavior is covered by Task 6; routes follow the untested-thin-handler house pattern (`/api/blog/*` precedent). Console pins land in Task 8.

**Interfaces:**
- Consumes: `shopOf(c)` (existing session guard), `TenantStore`, `runSyndicationForShop`, `ensurePack`, `sendChannel`, `blotatoFromEnv`, `SYNDICATE_CHANNEL_KEYS`, `mergeSyndicate`, `listPostsSynced`.
- Produces routes (all console-session authed):
  - `POST /api/syndicate/list` -> `{ ok, blotatoConfigured, syndicate, posts, packs, ledger }`
  - `POST /api/syndicate/config` `{ channels?, digest? }` -> `{ ok, syndicate }`
  - `POST /api/syndicate/accounts` -> `{ ok, accounts, boards, pages }`
  - `POST /api/syndicate/send` `{ postId, channel }` -> `{ ok, error? }`
  - `POST /api/syndicate/regenerate` `{ postId }` -> `{ ok, error? }`

- [ ] **Step 1: Add the imports**

In `src/index.ts` extend the existing blog import line to include `listPostsSynced` (already imported) and add:

```ts
import { ensurePack, sendChannel, runSyndicationForShop } from './syndicate/run';
import { blotatoFromEnv } from './syndicate/blotato';
import { SYNDICATE_CHANNEL_KEYS, mergeSyndicate, type SyndicateChannelKey, type SyndicateChannelConfig } from './types';
```

(Types are already imported from `./types` on an existing line; merge rather than duplicate.)

- [ ] **Step 2: Add the routes after `/api/blog/enrich`**

```ts
// --- Blog syndication (distribution phase 1, 2026-07-11) ---
// List the distribution state: published posts + their creative packs + the
// per-channel ledger. Runs one fire:false sweep pass first (enqueue + pack +
// confirm, never auto-send) so opening the card reflects a just-published
// guide without waiting for the cron AND can never race the cron into a
// double post - console sends only ever happen via the explicit send route.
app.post('/api/syndicate/list', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Tenant not found' }, 400);
  try { await runSyndicationForShop(c.env, store, cfg, { fire: false }); } catch { /* list still renders */ }
  const posts = (await listPostsSynced(c.env, store)).filter((p) => p.status === 'published' && p.shopify_article_id).slice(0, 12);
  const packs: Record<string, { articleHandle: string | null; captions: unknown; pinImageUrl: string | null }> = {};
  for (const p of posts) {
    const row = await store.getSyndicationPack(p.id);
    if (row) {
      let captions: unknown = null;
      try { captions = JSON.parse(row.captions_json); } catch { /* render without */ }
      packs[p.id] = { articleHandle: row.article_handle, captions, pinImageUrl: row.pin_image_url };
    }
  }
  return c.json({
    ok: true,
    blotatoConfigured: blotatoFromEnv(c.env) !== null,
    syndicate: cfg.syndicate ?? mergeSyndicate('{}'),
    posts: posts.map((p) => ({ id: p.id, title: p.title, articleId: p.shopify_article_id, createdAt: p.created_at })),
    packs,
    ledger: await store.listSyndicationLedger()
  });
});
// Save channel toggles / ids / digest mode. Validated field-by-field; unknown
// channels and keys are dropped (the config is owner-facing, not free-form).
app.post('/api/syndicate/config', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { channels?: unknown; digest?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Tenant not found' }, 400);
  const syn = cfg.syndicate ?? mergeSyndicate('{}');
  const chIn = (body.channels && typeof body.channels === 'object' ? body.channels : {}) as Record<string, Partial<SyndicateChannelConfig>>;
  for (const k of SYNDICATE_CHANNEL_KEYS) {
    const inc = chIn[k];
    if (!inc || typeof inc !== 'object') continue;
    const cur = syn.channels[k];
    if (typeof inc.enabled === 'boolean') cur.enabled = inc.enabled;
    if (typeof inc.auto === 'boolean') cur.auto = inc.auto;
    for (const id of ['accountId', 'boardId', 'pageId'] as const) {
      if (typeof inc[id] === 'string') {
        const v = (inc[id] as string).trim().slice(0, 160);
        if (v) cur[id] = v; else delete cur[id];
      }
    }
  }
  const dg = (body.digest && typeof body.digest === 'object' ? body.digest : {}) as { mode?: unknown };
  if (dg.mode === 'weekly' || dg.mode === 'per-post') syn.digest.mode = dg.mode;
  await store.saveSyndicate(syn);
  return c.json({ ok: true, syndicate: syn });
});
// Connected Blotato accounts + Pinterest boards + Facebook pages, so the owner
// configures channels by picking, never by hand-copying ids.
app.post('/api/syndicate/accounts', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  const blotato = blotatoFromEnv(c.env);
  if (!blotato) return c.json({ ok: false, error: 'Blotato is not connected (set the BLOTATO_API_KEY secret first)' });
  const accounts = await blotato.listAccounts();
  if (!accounts) return c.json({ ok: false, error: 'Could not list Blotato accounts (check the key)' });
  const boards: Record<string, unknown[]> = {};
  const pages: Record<string, unknown[]> = {};
  for (const a of accounts) {
    const platform = (a.platform ?? '').toLowerCase();
    if (platform === 'pinterest') boards[a.id] = (await blotato.listPinterestBoards(a.id)) ?? [];
    if (platform === 'facebook') pages[a.id] = (await blotato.listSubaccounts(a.id)) ?? [];
  }
  return c.json({ ok: true, accounts, boards, pages });
});
// Manual send for one post x channel (also the retry button). Bypasses the
// auto flag and the attempt cap - an owner click IS the authorization.
app.post('/api/syndicate/send', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { postId?: unknown; channel?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  const postId = typeof body.postId === 'string' ? body.postId : '';
  const channel = SYNDICATE_CHANNEL_KEYS.find((k) => k === body.channel);
  if (!postId || !channel) return c.json({ ok: false, error: 'postId and a known channel are required' }, 400);
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Tenant not found' }, 400);
  const syn = cfg.syndicate ?? mergeSyndicate('{}');
  if (!syn.channels[channel].enabled) return c.json({ ok: false, error: 'That channel is not enabled' }, 400);
  const post = (await store.listBlogPostDrafts()).find((p) => p.id === postId);
  if (!post || !post.shopify_article_id) return c.json({ ok: false, error: 'Post not found' }, 404);
  const blotato = blotatoFromEnv(c.env);
  await store.enqueueSyndication(postId, channel); // idempotent (first manual send can precede any sweep)
  const ensured = await ensurePack(c.env, store, cfg, blotato, {
    id: post.id, shopifyArticleId: post.shopify_article_id, title: post.title,
    collectionHandle: post.collection_handle, relatedHandlesJson: post.related_handles_json
  });
  if ('error' in ensured) {
    await store.markSyndication(postId, channel, { error: ensured.error });
    return c.json({ ok: false, error: ensured.error });
  }
  const row = (await store.listSyndicationLedger()).find((r) => r.post_id === postId && r.channel === channel);
  const sent = await sendChannel(store, syn, blotato, postId, channel, ensured.pack, row?.attempts ?? 0);
  return c.json(sent.ok ? { ok: true } : { ok: false, error: sent.error });
});
// Rebuild one post's creative pack (fresh copy + fresh hero mirror).
app.post('/api/syndicate/regenerate', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { postId?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  const postId = typeof body.postId === 'string' ? body.postId : '';
  if (!postId) return c.json({ ok: false, error: 'postId required' }, 400);
  const store = new TenantStore(c.env.DB, s);
  const cfg = await store.getConfig();
  if (!cfg) return c.json({ ok: false, error: 'Tenant not found' }, 400);
  const post = (await store.listBlogPostDrafts()).find((p) => p.id === postId);
  if (!post || !post.shopify_article_id) return c.json({ ok: false, error: 'Post not found' }, 404);
  const ensured = await ensurePack(c.env, store, cfg, blotatoFromEnv(c.env), {
    id: post.id, shopifyArticleId: post.shopify_article_id, title: post.title,
    collectionHandle: post.collection_handle, relatedHandlesJson: post.related_handles_json
  }, { force: true });
  return c.json('error' in ensured ? { ok: false, error: ensured.error } : { ok: true });
});
```

- [ ] **Step 3: Typecheck + smoke the suite**

Run: `npx tsc --noEmit` then `npx vitest run tests/syndicate.test.ts`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(syndicate): console routes (list, config, accounts, send, regenerate)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 8: Console Distribution card (view + browser JS)

**Files:**
- Modify: `src/console/views/blog.ts`
- Modify: `src/console/blog-js.ts`
- Test: `tests/console.test.ts` (extend the existing pins)

**Interfaces:**
- Consumes: routes from Task 7; console globals `el()`, `esc()`, `setMsg()`, `api()`, `errText()`, `prtArm()`; existing `loadContent()` (called when the Content view opens).
- Produces: browser functions `sydLoad`, `sydSaveConfig`, `sydAccounts`, `sydSend` (armed), `sydRegen`; DOM ids `syd-channels`, `syd-list`, `syd-msg`; delegated `data-syd-send`, `data-syd-regen` attributes.

**Rules reminder (memory: console-page-template-literal-gotcha):** no backticks or `${}` inside the JS template literal, `+` concatenation, `esc()` on every dynamic value, run `tests/console.test.ts` after every edit.

- [ ] **Step 1: Write the failing console pins**

In `tests/console.test.ts`, find the existing blog-view pin block (search for `blg-list`) and add alongside:

```ts
  it('blog view carries the Distribution card and its JS wiring', () => {
    expect(page).toContain('id="syd-channels"');
    expect(page).toContain('id="syd-list"');
    expect(page).toContain('/syndicate/list');
    expect(page).toContain('/syndicate/send');
    expect(page).toContain('/syndicate/config');
    expect(page).toContain('/syndicate/accounts');
    expect(page).toContain('/syndicate/regenerate');
    expect(page).toContain('data-syd-send');
    expect(page).toContain('sydLoad()');           // wired into loadContent
    expect(page).toContain("prtArm(btn,'Posts publicly - click again to confirm')");
  });
```

(Match the surrounding test style: `page` is however the existing file renders the console page string; reuse the same variable.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/console.test.ts`
Expected: the new pins FAIL, the rest PASS.

- [ ] **Step 3: Add the Distribution card to `src/console/views/blog.ts`**

Append to `blogCss`:

```ts
  .syd-ch{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:8px 0 2px}
  .syd-ch-box{border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
  .syd-ch-box strong{text-transform:capitalize}
  .syd-chip{font-size:11px;font-weight:650;border-radius:9px;padding:2px 8px;white-space:nowrap}
  .syd-q{background:rgba(139,148,158,.22);color:var(--subdued)}
  .syd-sent{background:rgba(88,166,255,.16);color:#58a6ff}
  .syd-pub{background:rgba(63,185,80,.15);color:#3fb950}
  .syd-fail{background:rgba(248,81,73,.16);color:#f85149}
  .syd-cap{color:var(--subdued);font-size:12.5px;margin-top:5px;white-space:normal;overflow-wrap:anywhere}
  .syd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
```

Append a new section to `blogView` (after the Drafted posts card):

```ts
  <section class="card">
    <h2>Distribution</h2>
    <p class="sub" style="margin:0 0 10px">When you publish a guide, the worker writes channel copy and queues it here. Every channel starts <strong>manual</strong>: you review and click Send per channel, and flip a channel to <strong>Auto</strong> once you trust it (the same ramp as the profitability agent). Links carry per-channel UTM tags so Shopify analytics shows what each channel brings. No prices ever appear in the copy - pins live for months while prices move every 15 minutes.</p>
    <div id="syd-channels" class="syd-ch">Loading channels…</div>
    <div class="row" style="margin:6px 0 10px">
      <button type="button" onclick="sydAccounts(this)">Load connected accounts</button>
      <span class="muted" style="align-self:center;font-size:12px">Reads your Blotato connections so you can pick the Pinterest board and Facebook page instead of copying ids.</span>
    </div>
    <p id="syd-msg" class="msg muted"></p>
    <div id="syd-list">No published guides yet. Publish one and it appears here within 15 minutes.</div>
  </section>
```

- [ ] **Step 4: Add the browser JS to `src/console/blog-js.ts`**

ESCAPING WARNING (the template-literal gotcha): the block below is written to be pasted INSIDE the TS template literal, so every inline-onclick quote appears as `\\'` in the TS source, which emits `\'` in the browser JS. If you see `\'` in the TS file after pasting, the escaping got lost and the console will hard-break at runtime while tsc stays green. The blogEnrich button in the existing `blgItemHtml` shows the correct pattern.

Append inside the `blogJs` template literal (before the closing backtick), and add `sydLoad();` as the last line of the existing `loadContent()` function body:

```js
// --- Distribution (syndication): creative packs + per-channel sends ---
var sydState=null;
function sydChip(st){
  var cls=st==='published'?'syd-pub':(st==='sent'?'syd-sent':(st==='failed'?'syd-fail':'syd-q'));
  return '<span class="syd-chip '+cls+'">'+esc(st)+'</span>';
}
function sydChannelBox(k,ch){
  var state=ch.accountId?((k==='pinterest'&&!ch.boardId)||(k==='facebook'&&!ch.pageId)?'account linked, pick a '+(k==='pinterest'?'board':'page'):'ready'):'not linked';
  var h='<div class="syd-ch-box"><strong>'+esc(k)+'</strong>'
    +'<label><input type="checkbox" '+(ch.enabled?'checked':'')+' onchange="sydSaveConfig(\\''+esc(k)+'\\',{enabled:this.checked})"> enabled</label>'
    +'<label><input type="checkbox" '+(ch.auto?'checked':'')+' onchange="sydSaveConfig(\\''+esc(k)+'\\',{auto:this.checked})"> auto</label>'
    +'<span class="muted">'+esc(state)+'</span></div>';
  return h;
}
function sydRenderChannels(){
  var box=el('syd-channels'); if(!box||!sydState) return;
  var h='';
  var ks=['pinterest','facebook','instagram'];
  for(var i=0;i<ks.length;i++) h+=sydChannelBox(ks[i],sydState.syndicate.channels[ks[i]]||{});
  if(!sydState.blotatoConfigured) h+='<div class="syd-ch-box syd-fail" style="border-color:rgba(248,81,73,.4)">Blotato key not set - queued items wait until the BLOTATO_API_KEY secret exists.</div>';
  box.innerHTML=h;
}
function sydPostHtml(p){
  var pack=(sydState.packs&&sydState.packs[p.id])||null;
  var rows=[]; var lg=sydState.ledger||[];
  for(var i=0;i<lg.length;i++) if(lg[i].post_id===p.id) rows.push(lg[i]);
  var h='<div class="blg-item"><div class="blg-item-head"><span class="blg-item-title">'+esc(p.title)+'</span></div>';
  if(pack&&pack.captions){ h+='<div class="syd-cap"><strong>Pin:</strong> '+esc(pack.captions.pinTitle||'')+' - '+esc(pack.captions.pinDesc||'')+'</div>'
    +'<div class="syd-cap"><strong>Caption:</strong> '+esc(pack.captions.caption||'')+'</div>'; }
  else h+='<div class="syd-cap muted">No creative pack yet - it builds on the next sweep, or click a Send button to build it now.</div>';
  h+='<div class="syd-row">';
  for(var j=0;j<rows.length;j++){
    var r=rows[j];
    h+='<span>'+esc(r.channel)+' '+sydChip(r.status);
    if(r.status!=='published'&&r.status!=='sent') h+=' <button type="button" class="btn-sm" data-syd-send="'+esc(p.id)+'|'+esc(r.channel)+'">'+(r.status==='failed'?'Retry':'Send')+'</button>';
    h+='</span>';
    if(r.error) h+='<span class="syd-cap syd-fail" style="background:transparent">'+esc(r.error)+'</span>';
  }
  if(!rows.length) h+='<span class="muted" style="font-size:12px">No channels enabled yet - enable one above.</span>';
  h+=' <button type="button" class="btn-sm" data-syd-regen="'+esc(p.id)+'">Regenerate pack</button>';
  return h+'</div></div>';
}
async function sydLoad(){
  var box=el('syd-list'); if(!box) return;
  try{
    var r=await api('/syndicate/list',{});
    if(!r.ok){ box.innerHTML='<p class="muted">Could not load distribution state.</p>'; return; }
    sydState=r;
    sydRenderChannels();
    if(!r.posts||!r.posts.length){ box.innerHTML='<p class="muted">No published guides yet. Publish one and it appears here within 15 minutes.</p>'; return; }
    var h=''; for(var i=0;i<r.posts.length;i++) h+=sydPostHtml(r.posts[i]);
    box.innerHTML=h;
  }catch(e){ box.innerHTML='<p class="muted">Could not load distribution state.</p>'; }
}
async function sydSaveConfig(k,patch){
  var channels={}; channels[k]=patch;
  try{
    var r=await api('/syndicate/config',{channels:channels});
    if(!r.ok){ setMsg('syd-msg','Could not save: '+esc(r.error||'unknown'),'no'); return; }
    if(sydState) sydState.syndicate=r.syndicate;
    sydRenderChannels();
    setMsg('syd-msg','Saved.','ok');
  }catch(e){ setMsg('syd-msg','Could not save: '+errText(e),'no'); }
}
async function sydAccounts(btn){
  if(btn) btn.disabled=true;
  setMsg('syd-msg','Reading your Blotato connections…','muted');
  try{
    var r=await api('/syndicate/accounts',{});
    if(!r.ok){ setMsg('syd-msg',esc(r.error||'Could not list accounts'),'no'); if(btn) btn.disabled=false; return; }
    var lines=[];
    for(var i=0;i<r.accounts.length;i++){
      var a=r.accounts[i]; var plat=(a.platform||'').toLowerCase();
      var name=a.username||a.name||a.id;
      if(plat==='pinterest'){
        var bs=(r.boards&&r.boards[a.id])||[];
        for(var j=0;j<bs.length;j++) lines.push('<button type="button" class="btn-sm" onclick="sydSaveConfig(\\'pinterest\\',{accountId:\\''+esc(a.id)+'\\',boardId:\\''+esc(bs[j].id)+'\\'})">Pinterest: '+esc(name)+' / '+esc(bs[j].name||bs[j].id)+'</button>');
        if(!bs.length) lines.push('<span class="muted">Pinterest '+esc(name)+': no boards visible yet (new accounts can take 2-3 weeks to warm up; you can also paste the board id from Pinterest itself).</span>');
      }else if(plat==='facebook'){
        var ps=(r.pages&&r.pages[a.id])||[];
        for(var q=0;q<ps.length;q++) lines.push('<button type="button" class="btn-sm" onclick="sydSaveConfig(\\'facebook\\',{accountId:\\''+esc(a.id)+'\\',pageId:\\''+esc(ps[q].id)+'\\'})">Facebook: '+esc(ps[q].name||ps[q].id)+'</button>');
      }else if(plat==='instagram'){
        lines.push('<button type="button" class="btn-sm" onclick="sydSaveConfig(\\'instagram\\',{accountId:\\''+esc(a.id)+'\\'})">Instagram: '+esc(name)+'</button>');
      }
    }
    setMsg('syd-msg',lines.length?('Pick to wire a channel: '+lines.join(' ')):'No connected accounts found - connect them in the Blotato dashboard first.','ok');
  }catch(e){ setMsg('syd-msg','Could not list accounts: '+errText(e),'no'); }
  if(btn) btn.disabled=false;
}
async function sydSend(btn,postId,channel){
  if(!prtArm(btn,'Posts publicly - click again to confirm')) return;
  setMsg('syd-msg','Sending to '+esc(channel)+'…','muted');
  try{
    var r=await api('/syndicate/send',{postId:postId,channel:channel});
    if(!r.ok){ setMsg('syd-msg','Send failed: '+esc(r.error||'unknown'),'no'); }
    else setMsg('syd-msg','Accepted - it confirms as published on the next sweep.','ok');
    sydLoad();
  }catch(e){ setMsg('syd-msg','Send failed: '+errText(e),'no'); }
}
async function sydRegen(btn,postId){
  if(btn) btn.disabled=true;
  setMsg('syd-msg','Rebuilding the creative pack…','muted');
  try{
    var r=await api('/syndicate/regenerate',{postId:postId});
    setMsg('syd-msg',r.ok?'Pack rebuilt.':('Could not rebuild: '+esc(r.error||'unknown')),r.ok?'ok':'no');
    sydLoad();
  }catch(e){ setMsg('syd-msg','Could not rebuild: '+errText(e),'no'); }
  if(btn) btn.disabled=false;
}
(function(){
  document.addEventListener('click',function(ev){
    var t=ev.target;
    if(!t||!t.getAttribute) return;
    var send=t.getAttribute('data-syd-send');
    if(send){ var parts=send.split('|'); sydSend(t,parts[0],parts[1]); return; }
    var regen=t.getAttribute('data-syd-regen');
    if(regen) sydRegen(t,regen);
  });
})();
```

Then edit the existing `loadContent()` in the same file: add `sydLoad();` as its final statement (after the try/catch), so opening the Content view loads both lists.

- [ ] **Step 5: Run the console tests + a node smoke of the template literal**

Run: `npx vitest run tests/console.test.ts`
Expected: PASS including the new pins. If a pin fails on the `prtArm` string, match the exact quoting used in the JS above.

Also write a scratchpad smoke (NOT committed) following the `profit-js-smoke2.mjs` pattern (unescape `raw.replace(/\\\\/g,'\\')`, `new Function` with stubbed `el/esc/setMsg/api/errText/prtArm`, assert `sydSend` posts `/syndicate/send`) and run it with node. Expected: PASS lines, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/console/views/blog.ts src/console/blog-js.ts tests/console.test.ts
git commit -m "feat(console): Distribution card - channel toggles, per-post sends, account picker

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

### Task 9: Docs, states register, and the deploy gate

**Files:**
- Modify: `docs/STATES.md` (add syndication rows)
- Modify: `docs/HANDOVER.md` (one-paragraph feature note, matching its style)

- [ ] **Step 1: STATES.md rows + HANDOVER.md note**

Add this paragraph to `docs/HANDOVER.md` in its feature-notes section (adjust heading level to match neighbors):

```markdown
## Blog distribution (phase 1, 2026-07-11)

Publishing a guide queues it for social distribution: the 15-min cron builds a
creative pack (one gated LLM copy call + the article's live hero mirrored to
Blotato) and posts to Pinterest / Facebook / Instagram via the Blotato API
(`BLOTATO_API_KEY` secret; absent = dormant). Per-channel enabled/auto toggles
live in `tenant_config.syndicate` (all off by default; owner clicks Send in
the console's Content > Distribution card until a channel earns auto). Ledger:
`syndication_ledger` (queued/sent/published/failed, one row per post per
channel = idempotency + a claimed-attempts double-post fence). Links carry
utm_source/medium/campaign for per-channel attribution. Copy gates: no prices,
no supplier brands, no em-dash, length caps. Spec:
docs/superpowers/specs/2026-07-11-blog-distribution-design.md (90-day Blotato
earn-it review; native-API exit path). Phases 2 (composed creatives) and 3
(email digest + partner packs) are specced, not built.
```

- [ ] **Step 2: STATES.md rows**

Add to the states table (match existing format of state -> probe):

```markdown
| Syndication channel enabled | `wrangler d1 execute pawscout --remote --json --command "SELECT syndicate FROM tenant_config"` |
| Syndication queue/results | `wrangler d1 execute pawscout --remote --json --command "SELECT post_id, channel, status, error, attempts FROM syndication_ledger ORDER BY updated_at DESC LIMIT 20"` |
| Creative packs built | `wrangler d1 execute pawscout --remote --json --command "SELECT post_id, article_handle, pin_image_url IS NOT NULL AS has_image FROM syndication_packs"` |
| Blotato rail connected | `npx wrangler secret list` shows BLOTATO_API_KEY; console Distribution card shows no red box |
| Syndication copy spend | `wrangler d1 execute pawscout --remote --json --command "SELECT COUNT(*), SUM(cost_usd) FROM llm_usage WHERE task='blog-syndication-copy'"` |
```

- [ ] **Step 3: Typecheck + full spaced test sweep**

Run: `npx tsc --noEmit`, then in ONE batch: `npx vitest run tests/syndicate.test.ts tests/blog.test.ts tests/console.test.ts`. If workerd wedges, wait 60-75 s and re-run the failed file alone.
Expected: all green.

- [ ] **Step 4: Commit + push**

```bash
git add docs/STATES.md docs/HANDOVER.md
git commit -m "docs(syndicate): states probes + handover note for blog distribution phase 1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 5: Deploy gate (STOP - owner "go" required)**

Do NOT run these without the owner's explicit go:

```bash
npx wrangler d1 migrations apply pawscout --remote
npx wrangler deploy
```

Post-deploy verification (worker only, no theme changes in this phase):
1. `npx wrangler deployments list` shows the new version at 100%.
2. Console -> Content: Distribution card renders, channels all disabled, no console errors.
3. `wrangler d1 execute pawscout --remote --json --command "SELECT name FROM sqlite_master WHERE name LIKE 'syndication%'"` returns both tables.

Rollout checklist (owner actions, in order, after deploy):
1. Blotato account -> connect Pinterest (+ Facebook Page / Instagram if ready). Note: brand-new Pinterest accounts can take 2-3 weeks before boards are visible to automation; create the account early and the board id can also be pasted manually.
2. Generate the Blotato API key ONLY when ready to pay ($29/mo starts immediately) -> `npx wrangler secret put BLOTATO_API_KEY` (then `npx wrangler deploy` is NOT needed; secrets apply live).
3. Console: Load connected accounts -> pick board/page -> enable Pinterest.
4. Manual send an existing published guide to Pinterest; verify the pin lands on the board with the UTM link; ledger row reaches `published`.
5. Traffic board: add a "Blog syndication (Pinterest/FB/IG via Blotato)" channel row, priority 1, next action "90-day earn-it review <date+90>".
6. Flip `auto` per channel only after a few good manual sends.

---

## Self-review notes (writing-plans checklist)

- Spec coverage: pack copy + gates (Task 2), hero-image creative via live article + mirror (Tasks 5-6), ledger + idempotency (Tasks 1, 6), Blotato rail + dormancy (Task 3), per-channel auto toggles + console card (Tasks 7-8), UTMs (Task 4), cron wiring (Task 6), STATES/docs + rollout + 90-day review hook (Task 9). Phase 2 (composed creatives) and phase 3 (digest/partner packs) are explicitly out of scope per the spec's delivery phases; `digest.mode` config lands now so the block shape is stable.
- Deliberate refinements vs the spec (allowed at plan time): the pack table gains `article_handle` (URL building needs it; D1 does not store the handle); ledger status set gains `published` (Blotato submissions are async, `sent` alone cannot represent confirmed-live); channel send config ids (`accountId`/`boardId`/`pageId`) live in `tenant_config.syndicate` because they are config, not secrets; sends claim the attempts counter first (optimistic fence) so a cron tick and a console click can never double-post; the console list route sweeps with `fire: false` for the same reason.
- Type consistency: `SyndicateChannelKey` = 'pinterest'|'facebook'|'instagram' everywhere; `PackInfo` produced by `ensurePack` and consumed by `sendChannel`; ledger row field names are snake_case as returned by `TenantStore`.
- No placeholders: every step carries runnable code or exact commands.
