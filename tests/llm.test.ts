import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { LlmClient, curateProduct, classifyKeyword, getKeywordMeta } from '../src/llm';
import { replenishWarehouse } from '../src/jobs';
import { searchBackfill } from '../src/proxy/search';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, type TenantConfig } from '../src/types';
import type { CjClient, CjSearchItem, CjDetail } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const CFG: TenantConfig = {
  collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys' } },
  gates: DEFAULT_GATES,
  pricing: DEFAULT_PRICING,
  floors: { ...DEFAULT_FLOORS, warehouseDepth: 3 },
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS,
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
  stock: 50
};

const GOOD_CURATION = {
  relevanceScore: 85,
  category: 'pet-toys',
  title: 'Bite-Resistant Cotton Rope Dog Toy',
  descriptionHtml: '<p>A durable rope toy for daily play.</p>',
  petClass: 'dog' as const
};

describe('LlmClient', () => {
  it('parses validated JSON and returns usage with cost', async () => {
    const llm = new LlmClient('sk-or-key', llmFetch({ a: 1 }));
    const r = await llm.json({ model: 'm/x', system: 's', user: 'u', validate: (v) => v as { a: number } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1 });
      expect(r.usage.costUsd).toBe(0.0002);
    }
  });

  it('strips markdown fences before parsing', async () => {
    const llm = new LlmClient('k', llmFetch(null, { raw: '```json\n{"a":2}\n```' }));
    const r = await llm.json({ model: 'm/x', system: 's', user: 'u', validate: (v) => v as { a: number } });
    expect(r.ok && r.value.a === 2).toBe(true);
  });

  it.each([
    ['HTTP error', llmFetch({}, { status: 500 })],
    ['non-JSON content', llmFetch(null, { raw: 'sorry, I cannot' })],
    ['network throw', (async () => { throw new Error('down'); }) as typeof fetch]
  ])('degrades to ok:false on %s — never throws', async (_name, fetchImpl) => {
    const llm = new LlmClient('k', fetchImpl);
    const r = await llm.json({ model: 'm/x', system: 's', user: 'u', validate: (v) => v });
    expect(r.ok).toBe(false);
  });

  it('is unavailable without a key and says so', async () => {
    const llm = new LlmClient(undefined);
    expect(llm.available).toBe(false);
    const r = await llm.json({ model: 'm/x', system: 's', user: 'u', validate: (v) => v });
    expect(r.ok).toBe(false);
  });
});

describe('curateProduct', () => {
  it('returns validated curation and logs usage cost', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient('k', llmFetch(GOOD_CURATION));
    const c = await curateProduct(llm, store, CFG, DETAIL, 'dog toy');
    expect(c).toMatchObject({ relevanceScore: 85, category: 'pet-toys', title: 'Bite-Resistant Cotton Rope Dog Toy' });
    const spend = await store.llmSpendSince(new Date(Date.now() - 60_000).toISOString());
    expect(spend.calls).toBe(1);
    expect(spend.costUsd).toBeCloseTo(0.0002);
  });

  it('rejects an unknown category but keeps the rest', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient('k', llmFetch({ ...GOOD_CURATION, category: 'made-up' }));
    const c = await curateProduct(llm, store, CFG, DETAIL, 'dog toy');
    expect(c?.category).toBeNull();
  });

  it('returns null on LLM failure (caller falls back to mechanical gates)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const llm = new LlmClient('k', llmFetch({}, { status: 429 }));
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
      detail: async (pid: string): Promise<CjDetail> => ({ ...DETAIL, pid, nameEn: `Pet Dog Toys ${pid}` }),
      stockByPid: async () => new Map([['v1', 50]])
    } as unknown as CjClient);

  it('admits with rewritten copy and the curated category', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const admitted = await replenishWarehouse(store, cjFake(), CFG, {
      pause: async () => {},
      curate: async () => GOOD_CURATION
    });
    expect(admitted).toBe(3);
    const row = await store.getWarehouseProduct('p3'); // best-seller ordering: highest listedNum admitted first
    expect(row?.title).toBe('Bite-Resistant Cotton Rope Dog Toy');
    const detail = JSON.parse(row!.detail) as CjDetail;
    expect(detail.nameEn).toBe('Bite-Resistant Cotton Rope Dog Toy');
    expect(detail.originalNameEn).toContain('Pet Dog Toys'); // CJ original kept for audit
    expect(detail.llmScore).toBe(85);
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

describe('keyword classification + synonym search', () => {
  it('classifyKeyword caches meta once and logs usage', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const calls: number[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      return (llmFetch({ category: 'pet-toys', synonyms: ['dog toy', 'chew rope'] }) as () => Promise<Response>)();
    }) as unknown as typeof fetch;
    const llm = new LlmClient('k', fetchImpl);

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

    const cj = { search: async () => [] } as unknown as CjClient;
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

    const cj = { search: async () => [] } as unknown as CjClient;
    const strictCfg = { ...CFG, gates: { ...CFG.gates, relevance: 'strict' as const } };
    const cards = await searchBackfill(store, cj, strictCfg, 'puppy chew', 0, 12);
    expect(cards).toEqual([]);
  });
});
