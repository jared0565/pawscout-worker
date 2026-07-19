import { describe, it, expect } from 'vitest';
import {
  extractBodyProductHandles, resolveHandleLiveness, healArticleBody, runArticleHealth
} from '../src/blog/article-health';
import { LlmClient } from '../src/llm';
import type { AdminGraphql } from '../src/shopify-admin';

const CFG: any = { llm: { models: {} } };
const STORE: any = { logLlmUsage: async () => {} };
const ENV_LLM: any = { OPENROUTER_API_KEY: 'k' };
const ENV_NO_LLM: any = {};

// OpenRouter-shaped fake LLM (same pattern as tests/blog.test.ts).
function fakeLlm(objs: unknown[]): LlmClient {
  let i = 0;
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(objs[Math.min(i++, objs.length - 1)]) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 }, model: 'test'
  }), { status: 200 })) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'k' }, fetchImpl);
}
const noLlm = new LlmClient({}, (async () => new Response('', { status: 500 })) as unknown as typeof fetch);

const CANDIDATES = [
  { title: 'Elevated Mesh Dog Bed', handle: 'elevated-mesh-dog-bed', path: '/products/elevated-mesh-dog-bed' },
  { title: 'Cooling Mat XL', handle: 'cooling-mat-xl', path: '/products/cooling-mat-xl' }
];

describe('extractBodyProductHandles', () => {
  it('collects distinct handles in order, both quote styles, ignores collections + external', () => {
    const html = '<p><a href="/products/a-1">x</a> <a href=\'/products/b\'>y</a> ' +
      '<a href="/products/a-1">again</a> <a href="/collections/c">c</a> <a href="https://x.com/products/z">ext</a></p>';
    expect(extractBodyProductHandles(html)).toEqual(['a-1', 'b']);
  });
});

describe('resolveHandleLiveness', () => {
  it('absent handles are dead, null onlineStoreUrl is dead, url is live', async () => {
    const admin = (async () => ({ products: { nodes: [
      { handle: 'live-one', onlineStoreUrl: 'https://activepaw.co.uk/products/live-one' },
      { handle: 'archived-one', onlineStoreUrl: null }
    ] } })) as unknown as AdminGraphql;
    const map = await resolveHandleLiveness(admin, ['live-one', 'archived-one', 'gone-entirely']);
    expect(map.get('live-one')).toBe(true);
    expect(map.get('archived-one')).toBe(false);
    expect(map.get('gone-entirely')).toBe(false);
  });
});

describe('healArticleBody', () => {
  const BODY = '<p>Try the <a href="/products/dead-bed">Waterproof Elevated Bed</a> today. ' +
    'Pair it with a <a href="/products/live-bowl">travel bowl</a>. ' +
    'The <a href="/products/dead-bed">same bed</a> again.</p>';

  it('LLM pick inside the cage relinks every anchor of the dead handle', async () => {
    const llm = fakeLlm([{ handle: 'elevated-mesh-dog-bed', anchorText: 'Elevated Mesh Dog Bed' }]);
    const r = await healArticleBody(llm, STORE, CFG, {
      body: BODY, articleTitle: 'Beds guide', deadHandles: ['dead-bed'],
      candidates: CANDIDATES, collectionPath: '/collections/pet-accessories'
    });
    expect(r.body).not.toContain('/products/dead-bed');
    expect(r.body).toContain('<a href="/products/elevated-mesh-dog-bed">Elevated Mesh Dog Bed</a>');
    expect((r.body.match(/elevated-mesh-dog-bed/g) ?? []).length).toBe(2); // both anchors relinked
    expect(r.body).toContain('/products/live-bowl'); // untouched
    expect(r.samples[0]).toContain('/products/dead-bed -> /products/elevated-mesh-dog-bed');
  });

  it('an out-of-cage LLM handle falls back to the funnel collection, words kept', async () => {
    const llm = fakeLlm([{ handle: 'not-a-candidate', anchorText: 'Hacked' }]);
    const r = await healArticleBody(llm, STORE, CFG, {
      body: BODY, articleTitle: 'Beds guide', deadHandles: ['dead-bed'],
      candidates: CANDIDATES, collectionPath: '/collections/pet-accessories'
    });
    expect(r.body).not.toContain('not-a-candidate');
    expect(r.body).not.toContain('/products/dead-bed');
    expect(r.body).toContain('<a href="/collections/pet-accessories">Waterproof Elevated Bed</a>');
  });

  it('LLM declining ({handle:null}) and LLM-unavailable both fall back deterministically', async () => {
    for (const llm of [fakeLlm([{ handle: null }]), noLlm]) {
      const r = await healArticleBody(llm, STORE, CFG, {
        body: BODY, articleTitle: 'Beds guide', deadHandles: ['dead-bed'],
        candidates: CANDIDATES, collectionPath: '/collections/pet-accessories'
      });
      expect(r.body).toContain('<a href="/collections/pet-accessories">Waterproof Elevated Bed</a>');
    }
  });

  it('no funnel at all unwraps the dead anchor, keeping the words', async () => {
    const r = await healArticleBody(noLlm, STORE, CFG, {
      body: BODY, articleTitle: 'Beds guide', deadHandles: ['dead-bed'],
      candidates: [], collectionPath: null
    });
    expect(r.body).not.toContain('/products/dead-bed');
    expect(r.body).toContain('Waterproof Elevated Bed');
    expect(r.samples[0]).toContain('(unlinked)');
  });

  it('a healthy body is returned byte-identical', async () => {
    const r = await healArticleBody(noLlm, STORE, CFG, {
      body: BODY, articleTitle: 'Beds guide', deadHandles: [],
      candidates: CANDIDATES, collectionPath: '/collections/pet-accessories'
    });
    expect(r.body).toBe(BODY);
    expect(r.samples).toEqual([]);
  });
});

describe('runArticleHealth (end to end with fake admin)', () => {
  function makeFakeAdmin() {
    const bodyUpdates: { id: string; body: string }[] = [];
    const admin = (async (query: string, vars?: Record<string, unknown>) => {
      if (query.includes('pawscoutHealthArticles')) {
        return { blogs: { nodes: [{
          handle: 'guides',
          articles: { nodes: [
            { id: 'gid://a/1', title: 'Beds guide', tags: ['pet-accessories'],
              body: '<p>Get the <a href="/products/dead-bed">Elevated Bed</a> and a <a href="/products/live-bowl">bowl</a>.</p>',
              metafield: { value: '["dead-bed","live-bowl"]' } },
            { id: 'gid://a/2', title: 'Healthy guide', tags: ['pet-health'],
              body: '<p>All good: <a href="/products/live-bowl">bowl</a>.</p>',
              metafield: { value: '["live-bowl"]' } }
          ], pageInfo: { hasNextPage: false } }
        }] } };
      }
      if (query.includes('pawscoutProductsByHandles')) {
        return { products: { nodes: [
          { handle: 'live-bowl', onlineStoreUrl: 'https://x/products/live-bowl' },
          { handle: 'elevated-mesh-dog-bed', onlineStoreUrl: 'https://x/products/elevated-mesh-dog-bed' }
          // dead-bed absent = dead
        ] } };
      }
      if (query.includes('pawscoutBlogGround')) {
        // groundCollection's read - serve one live product for the funnel.
        return { collections: { nodes: [{ handle: 'pet-accessories', title: 'Pet Accessories',
          products: { nodes: [
            { handle: 'elevated-mesh-dog-bed', title: 'Elevated Mesh Dog Bed',
              onlineStoreUrl: 'https://x/products/elevated-mesh-dog-bed', featuredImage: null,
              variants: { nodes: [{ price: '39.99', availableForSale: true }] } }
          ] } }] } };
      }
      if (query.includes('pawscoutHealthArticleUpdate')) {
        bodyUpdates.push({ id: vars?.id as string, body: (vars?.article as { body: string }).body });
        return { articleUpdate: { userErrors: [] } };
      }
      throw new Error('unexpected query: ' + query.slice(0, 60));
    }) as unknown as AdminGraphql;
    return { admin, bodyUpdates };
  }

  it('heals the dead body link, refreshes the dead shop block, leaves the healthy article alone', async () => {
    const { admin, bodyUpdates } = makeFakeAdmin();
    const enrichCalls: string[] = [];
    const fakeEnrich = (async (_e: any, _s: any, _c: any, o: { articleId?: string }) => {
      enrichCalls.push(o.articleId!);
      return { ok: true, articleId: o.articleId };
    }) as any;
    const llmFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ handle: 'elevated-mesh-dog-bed', anchorText: 'Elevated Mesh Dog Bed' }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 }, model: 'test'
    }), { status: 200 })) as unknown as typeof fetch;

    const r = await runArticleHealth(ENV_LLM, STORE, CFG, admin, llmFetch, fakeEnrich);
    expect(r.articlesScanned).toBe(2);
    expect(r.deadLinks).toBe(1);
    expect(r.bodiesHealed).toBe(1);
    expect(r.metafieldsRefreshed).toBe(1);
    expect(r.errors).toEqual([]);
    expect(bodyUpdates).toHaveLength(1);
    expect(bodyUpdates[0].id).toBe('gid://a/1');
    expect(bodyUpdates[0].body).toContain('/products/elevated-mesh-dog-bed');
    expect(bodyUpdates[0].body).not.toContain('/products/dead-bed');
    expect(enrichCalls).toEqual(['gid://a/1']); // only the article with dead curated picks
  });

  it('without an LLM the heal still lands on the funnel collection', async () => {
    const { admin, bodyUpdates } = makeFakeAdmin();
    const fakeEnrich = (async () => ({ ok: true })) as any;
    const r = await runArticleHealth(ENV_NO_LLM, STORE, CFG, admin, undefined as any, fakeEnrich);
    expect(r.bodiesHealed).toBe(1);
    expect(bodyUpdates[0].body).toContain('href="/collections/pet-accessories"');
    expect(bodyUpdates[0].body).not.toContain('/products/dead-bed');
  });
});
