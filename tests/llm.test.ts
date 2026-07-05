import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { LlmClient, extractJson, curateProduct, classifyKeyword, getKeywordMeta, pickHeroImage, rewriteDescription } from '../src/llm';
import { replenishWarehouse } from '../src/jobs';
import { searchBackfill } from '../src/proxy/search';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, type TenantConfig } from '../src/types';
import type { CjClient, CjSearchItem, CjDetail } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const CFG: TenantConfig = {
  collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' } },
  gates: DEFAULT_GATES,
  pricing: DEFAULT_PRICING,
  floors: { ...DEFAULT_FLOORS, warehouseDepth: 3 },
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
  target: 12
};

function llmFetch(content: unknown, opts: { status?: number; cost?: number; raw?: string } = {}): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: opts.raw ?? JSON.stringify(content) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, cost: opts.cost ?? 0.0002 }
      }),
      { status: opts.status ?? 200 }
    )) as typeof fetch;
}

const DETAIL: CjDetail = {
  pid: 'P1',
  nameEn: '2026 New Pet Dog Toys Bite Resistant Molar Cotton Rope HOT SALE',
  images: ['https://i/1.jpg'],
  descriptionHtml: '<p>rope toy</p>',
  variants: [{ vid: 'v1', name: 'Red', sellPriceUsd: 10, sku: 'S1', stock: 50 }],
  listedNum: 10,
  categoryName: 'Pet Toys',
  stock: 50,
  // Local-for-local (2026-07-05): pool admission and storefront suggestions
  // require PROVEN home-local (GB) origin evidence - originless rows fail closed.
  origins: { GB: 50 }
};

const GOOD_CURATION = {
  relevanceScore: 85,
  category: 'pet-toys',
  title: 'Bite-Resistant Cotton Rope Dog Toy',
  descriptionHtml: '<p>A durable rope toy for daily play.</p>',
  petClass: 'dog' as const
};

const CHAIN_OR = [{ provider: 'openrouter' as const, models: ['m/x'] }];

describe('LlmClient', () => {
  it('parses validated JSON and returns usage with cost', async () => {
    const llm = new LlmClient({ openrouter: 'sk-or-key' }, llmFetch({ a: 1 }));
    const r = await llm.jsonChain({ chain: CHAIN_OR, system: 's', user: 'u', validate: (v) => v as { a: number } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1 });
      expect(r.usage.costUsd).toBe(0.0002);
    }
  });

  it('strips markdown fences before parsing', async () => {
    const llm = new LlmClient({ openrouter: 'k' },llmFetch(null, { raw: '```json\n{"a":2}\n```' }));
    const r = await llm.jsonChain({ chain: CHAIN_OR, system: 's', user: 'u', validate: (v) => v as { a: number } });
    expect(r.ok && r.value.a === 2).toBe(true);
  });

  it('recovers JSON wrapped in prose preamble/postamble (the prod non-JSON failure)', async () => {
    const llm = new LlmClient({ openrouter: 'k' },llmFetch(null, { raw: 'Here is the result:\n{"a":7}\nHope that helps!' }));
    const r = await llm.jsonChain({ chain: CHAIN_OR, system: 's', user: 'u', validate: (v) => v as { a: number } });
    expect(r.ok && r.value.a === 7).toBe(true);
  });

  it('retries once and recovers when the first response is non-JSON', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      const content = n === 1 ? 'thinking… no json yet' : JSON.stringify({ a: 5 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0001 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const llm = new LlmClient({ openrouter: 'k' },fetchImpl);
    const r = await llm.jsonChain({ chain: CHAIN_OR, system: 's', user: 'u', validate: (v) => v as { a: number } });
    expect(r.ok && r.value.a === 5).toBe(true);
    expect(n).toBe(2); // retried exactly once
  });

  it('extractJson handles fences, prose-wrapped objects/arrays, and unrecoverable text', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} thanks')).toEqual({ a: 3 });
    expect(extractJson('Sure! ["x","y"] done')).toEqual(['x', 'y']);
    expect(extractJson('sorry, I cannot')).toBeUndefined();
  });

  it.each([
    ['HTTP error', llmFetch({}, { status: 500 })],
    ['non-JSON content', llmFetch(null, { raw: 'sorry, I cannot' })],
    ['network throw', (async () => { throw new Error('down'); }) as typeof fetch]
  ])('degrades to ok:false on %s - never throws', async (_name, fetchImpl) => {
    const llm = new LlmClient({ openrouter: 'k' },fetchImpl);
    const r = await llm.jsonChain({ chain: CHAIN_OR, system: 's', user: 'u', validate: (v) => v });
    expect(r.ok).toBe(false);
  });

  it('is unavailable without a key and says so', async () => {
    const llm = new LlmClient({});
    expect(llm.available).toBe(false);
    const r = await llm.jsonChain({ chain: CHAIN_OR, system: 's', user: 'u', validate: (v) => v });
    expect(r.ok).toBe(false);
  });
});

describe('curateProduct via resolveChain', () => {
  it('routes through the text chain (no cfg.llm.model)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ model: 'cur/y', choices: [{ message: { content: JSON.stringify({ relevanceScore: 80, category: null, title: 'T', descriptionHtml: '<p>d</p>', petClass: 'dog' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })
    });
    const llm = new LlmClient({ openrouter: 'k' }, fetchImpl as any);
    const cfg: any = { collectionMap: {}, llm: { enabled: true, scoreThreshold: 60, models: { text: 'cur/y' } } };
    const r = await curateProduct(llm, store, cfg, DETAIL, 'dog chew');
    expect(r?.relevanceScore).toBe(80);
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as any).body).models).toEqual(['cur/y']);
  });
});

describe('curateProduct', () => {
  it('returns validated curation and logs usage cost', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch(GOOD_CURATION));
    const c = await curateProduct(llm, store, CFG, DETAIL, 'dog toy');
    expect(c).toMatchObject({ relevanceScore: 85, category: 'pet-toys', title: 'Bite-Resistant Cotton Rope Dog Toy' });
    const spend = await store.llmSpendSince(new Date(Date.now() - 60_000).toISOString());
    expect(spend.calls).toBe(1);
    expect(spend.costUsd).toBeCloseTo(0.0002);
  });

  it('rejects an unknown category but keeps the rest', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({ ...GOOD_CURATION, category: 'made-up' }));
    const c = await curateProduct(llm, store, CFG, DETAIL, 'dog toy');
    expect(c?.category).toBeNull();
  });

  it('returns null on LLM failure (caller falls back to mechanical gates)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({}, { status: 429 }));
    expect(await curateProduct(llm, store, CFG, DETAIL, 'dog toy')).toBeNull();
  });
});

describe('replenishWarehouse with curation', () => {
  const items = (n: number): CjSearchItem[] =>
    Array.from({ length: n }, (_, i) => ({
      pid: `p${i}`, nameEn: `Pet Dog Toys p${i}`, image: 'https://i/x.jpg',
      sellPriceUsd: 10, listedNum: 10 + i, categoryName: 'Pet Toys'
    }));

  const cjFake = (): CjClient =>
    ({
      search: async () => items(4),
      searchByWarehouse: async () => items(4), // replenish sources via the home-warehouse filter (local-for-local)
      detail: async (pid: string): Promise<CjDetail> => ({ ...DETAIL, pid, nameEn: `Pet Dog Toys ${pid}` }),
      stockByPid: async () => new Map([['v1', 50]])
    } as unknown as CjClient);

  it('admits with rewritten copy and the curated category', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // Unique curated titles per product (dedupe-at-admission would collapse identical ones).
    const admitted = await replenishWarehouse(store, cjFake(), CFG, {
      pause: async () => {},
      curate: async (d) => ({ ...GOOD_CURATION, title: `Cotton Rope Dog Toy ${d.pid}` })
    });
    expect(admitted).toBe(3);
    const row = await store.getWarehouseProduct('p3'); // best-seller ordering: highest listedNum admitted first
    expect(row?.title).toBe('Cotton Rope Dog Toy p3');
    const detail = JSON.parse(row!.detail) as CjDetail;
    expect(detail.nameEn).toBe('Cotton Rope Dog Toy p3');
    expect(detail.originalNameEn).toContain('Pet Dog Toys'); // CJ original kept for audit
    expect(detail.llmScore).toBe(85);
  });

  it('mechanical fallback rejects non-pet items but keeps pet ones (LLM down)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const mixed = [
      { pid: 'pet', nameEn: 'Dog Chew Toy', image: 'https://i/x.jpg', sellPriceUsd: 10, listedNum: 30, categoryName: 'Pet Toys' },
      { pid: 'junk', nameEn: 'Kitchen Knife Sharpener', image: 'https://i/x.jpg', sellPriceUsd: 10, listedNum: 20, categoryName: 'Home' }
    ] as CjSearchItem[];
    const cj = {
      search: async () => mixed,
      searchByWarehouse: async () => mixed,
      detail: async (pid: string): Promise<CjDetail> => ({ ...DETAIL, pid, nameEn: pid === 'junk' ? 'Kitchen Knife Sharpener' : 'Dog Chew Toy', categoryName: pid === 'junk' ? 'Home Kitchen' : 'Pet Toys' }),
      stockByPid: async () => new Map([['v1', 50]])
    } as unknown as CjClient;
    const admitted = await replenishWarehouse(store, cj, CFG, { pause: async () => {} }); // no curate → mechanical path
    expect(admitted).toBe(1);
    expect(await store.getWarehouseProduct('pet')).not.toBeNull();
    expect(await store.getWarehouseProduct('junk')).toBeNull(); // non-pet rejected by the floor
  });

  it('dedupe-at-admission skips a product already stocked under the same title signature', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putWarehouseProduct({
      cjPid: 'existing', category: 'pet-toys', title: 'Pet Teeth Cleaning Powder 100g',
      detailJson: JSON.stringify({ ...DETAIL, pid: 'existing' }), priceUsd: 10, listedNum: 5, stock: 50
    });
    const dupItems = [{ pid: 'dup', nameEn: 'Teeth Cleaning Powder 100g for Pets', image: 'https://i/x.jpg', sellPriceUsd: 10, listedNum: 40, categoryName: 'Pet Health' }] as CjSearchItem[];
    const cj = {
      search: async () => dupItems,
      searchByWarehouse: async () => dupItems,
      detail: async (pid: string): Promise<CjDetail> => ({ ...DETAIL, pid, nameEn: 'Teeth Cleaning Powder 100g for Pets' }),
      stockByPid: async () => new Map([['v1', 50]])
    } as unknown as CjClient;
    const admitted = await replenishWarehouse(store, cj, CFG, { pause: async () => {} });
    expect(admitted).toBe(0); // same significant-title signature as the stocked product
    expect(await store.getWarehouseProduct('dup')).toBeNull();
  });

  it('hard-rejects candidates scoring below the threshold', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const admitted = await replenishWarehouse(store, cjFake(), CFG, {
      pause: async () => {},
      curate: async () => ({ ...GOOD_CURATION, relevanceScore: 20 }) // the gecko case
    });
    expect(admitted).toBe(0);
  });

  it('degrades to mechanical admission when curation returns null', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const admitted = await replenishWarehouse(store, cjFake(), CFG, {
      pause: async () => {},
      curate: async () => null
    });
    expect(admitted).toBe(3);
    expect((await store.getWarehouseProduct('p3'))?.title).toBe('Pet Dog Toys p3'); // CJ title kept
  });
});

describe('pickHeroImage (vision)', () => {
  const URLS = ['https://i/0.jpg', 'https://i/1.jpg', 'https://i/2.jpg'];

  it('sends the images as vision content blocks alongside the text', async () => {
    const store = new TenantStore(env.DB, SHOP);
    let body: any;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ index: 2, reason: 'shows full set' }) } }],
        usage: { prompt_tokens: 80, completion_tokens: 10, cost: 0.0003 }
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const llm = new LlmClient({ openrouter: 'k' },fetchImpl);
    const pick = await pickHeroImage(llm, store, CFG, 'Pet Grooming Scissors Set with Comb', URLS);
    expect(pick).toEqual({ ok: true, index: 2, drop: [] });
    const content = body.messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.filter((c: any) => c.type === 'image_url').map((c: any) => c.image_url.url)).toEqual(URLS);
    const spend = await store.llmSpendSince(new Date(Date.now() - 60_000).toISOString());
    expect(spend.calls).toBe(1);
  });

  it('is ok with index null when the model picks image 0 (already correct - cacheable)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({ index: 0, reason: 'fine' }));
    expect(await pickHeroImage(llm, store, CFG, 'Dog Toy', URLS)).toEqual({ ok: true, index: null, drop: [] });
  });

  it('is ok with index null for fewer than 2 images, without calling the LLM', async () => {
    const store = new TenantStore(env.DB, SHOP);
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    const llm = new LlmClient({ openrouter: 'k' },fetchImpl);
    expect(await pickHeroImage(llm, store, CFG, 'Dog Toy', ['https://i/0.jpg'])).toEqual({ ok: true, index: null, drop: [] });
    expect(called).toBe(false);
  });

  it('returns the indices of incongruent images to drop (e.g. a cat on a dog listing)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({ index: 2, drop: [0, 1], reason: 'cats; dog at 2' }));
    expect(await pickHeroImage(llm, store, CFG, 'Dog Grooming Earmuffs', URLS)).toEqual({ ok: true, index: 2, drop: [0, 1] });
  });

  it('never drops the chosen hero, and ignores out-of-range drop indices', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({ index: 1, drop: [1, 9, 0], reason: 'x' }));
    // 1 == hero (excluded), 9 out of range (excluded) → only 0 survives
    expect(await pickHeroImage(llm, store, CFG, 'Dog Toy', URLS)).toEqual({ ok: true, index: 1, drop: [0] });
  });

  it('is NOT ok (retryable) on an out-of-range index from the model', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({ index: 9, reason: 'oops' }));
    expect(await pickHeroImage(llm, store, CFG, 'Dog Toy', URLS)).toEqual({ ok: false, index: null, drop: [] });
  });

  it('is NOT ok (retryable) when the LLM is unavailable', async () => {
    const store = new TenantStore(env.DB, SHOP);
    expect(await pickHeroImage(new LlmClient({}), store, CFG, 'Dog Toy', URLS)).toEqual({ ok: false, index: null, drop: [] });
  });
});

describe('rewriteDescription', () => {
  const RAW = '<div class="cj-description"><p>prevent oral diseases. We accept returns and refunds within 30 days.</p><img src="https://cf.cjdropshipping.com/x.jpg"></div>';

  it('returns clean rewritten HTML and logs usage', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({ descriptionHtml: '<p>A reusable finger toothbrush that helps maintain fresh breath.</p>' }));
    const out = await rewriteDescription(llm, store, CFG, 'Silicone Finger Toothbrush', RAW);
    expect(out).toBe('<p>A reusable finger toothbrush that helps maintain fresh breath.</p>');
    const spend = await store.llmSpendSince(new Date(Date.now() - 60_000).toISOString());
    expect(spend.calls).toBe(1);
  });

  it('rejects output that still contains a hotlink or supplier marker (defensive)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient({ openrouter: 'k' },llmFetch({ descriptionHtml: '<p>Nice toy</p><img src="https://cf.cjdropshipping.com/y.jpg">' }));
    expect(await rewriteDescription(llm, store, CFG, 'Toy', RAW)).toBeNull();
  });

  it('returns null on empty source text without calling the model', async () => {
    const store = new TenantStore(env.DB, SHOP);
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    expect(await rewriteDescription(new LlmClient({ openrouter: 'k' },fetchImpl), store, CFG, 'X', '   ')).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when the LLM is unavailable', async () => {
    const store = new TenantStore(env.DB, SHOP);
    expect(await rewriteDescription(new LlmClient({}), store, CFG, 'X', RAW)).toBeNull();
  });
});

describe('keyword classification + synonym search', () => {
  it('classifyKeyword caches meta once and logs usage', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      return (llmFetch({ category: 'pet-toys', synonyms: ['dog toy', 'chew rope'] }) as () => Promise<Response>)();
    }) as unknown as typeof fetch;
    const llm = new LlmClient({ openrouter: 'k' },fetchImpl);

    await classifyKeyword(llm, store, CFG, 'puppy chew');
    await classifyKeyword(llm, store, CFG, 'puppy chew'); // cached → no second call
    expect(calls).toHaveLength(1);
    expect(await getKeywordMeta(store, 'puppy chew')).toEqual({ category: 'pet-toys', synonyms: ['dog toy', 'chew rope'] });
  });

  it('searchBackfill finds warehouse rows via synonyms for classified keywords', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putWarehouseProduct({
      cjPid: 'A', category: 'pet-toys', title: 'Dog Rope Toy',
      detailJson: JSON.stringify({ ...DETAIL, pid: 'A', nameEn: 'Dog Rope Toy' }),
      priceUsd: 10, listedNum: 10, stock: 50
    });
    await store.putSearchCache('kw-meta:puppy chew', JSON.stringify({ category: 'pet-toys', synonyms: ['dog toy'] }), 30);

    const cj = { search: async () => [], searchByWarehouse: async () => [] } as unknown as CjClient;
    const cards = await searchBackfill(store, cj, CFG, 'puppy chew', 0, 12);
    expect(cards.map((c) => c.pid)).toEqual(['A']); // matched via synonym, not the literal query
  });

  it('strict relevance ignores synonyms', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putWarehouseProduct({
      cjPid: 'A', category: 'pet-toys', title: 'Dog Rope Toy',
      detailJson: JSON.stringify({ ...DETAIL, pid: 'A', nameEn: 'Dog Rope Toy' }),
      priceUsd: 10, listedNum: 10, stock: 50
    });
    await store.putSearchCache('kw-meta:puppy chew', JSON.stringify({ category: 'pet-toys', synonyms: ['dog toy'] }), 30);

    const cj = { search: async () => [], searchByWarehouse: async () => [] } as unknown as CjClient;
    const strictCfg = { ...CFG, gates: { ...CFG.gates, relevance: 'strict' as const } };
    const cards = await searchBackfill(store, cj, strictCfg, 'puppy chew', 0, 12);
    expect(cards).toEqual([]);
  });
});
