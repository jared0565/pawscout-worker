/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { DEFAULT_LLM } from '../src/types';
import { loadCatalog, validateMatch, matchCatalog, CATALOG_MATCH_MARKER, type Catalog } from '../src/inbox/catalog-match';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const catalog: Catalog = {
  products: [
    { handle: 'gps-tracker-collar', title: 'GPS Tracker Collar for Dogs and Cats', productType: '', description: 'A collar with a GPS tracker for helping locate dogs and cats.', collections: ['pet-accessories'] },
    { handle: 'metal-dog-playpen', title: '6-Panel Metal Dog Playpen', productType: '', description: 'Create a safe, secure space for your dog.', collections: ['pet-accessories'] },
    { handle: 'pet-glasses', title: 'Pet Glasses Windproof Eye Protection Accessories', productType: 'Pet Accessories', description: 'Windproof glasses.', collections: ['pet-accessories'] },
    { handle: 'cat-teaser', title: 'Hanging Cat Teaser Toy', productType: 'Pet Toys', description: 'A toy.', collections: ['pet-toys'] },
  ],
  collections: [
    { handle: 'pet-accessories', title: 'Pet Accessories' },
    { handle: 'pet-toys', title: 'Pet Toys' },
  ],
};

describe('validateMatch', () => {
  it('keeps only catalogue handles, drops duplicates and caps at three', () => {
    const m = validateMatch({ handles: ['metal-dog-playpen', 'made-up', 'metal-dog-playpen', 'gps-tracker-collar', 'pet-glasses', 'cat-teaser'], collection: null }, catalog);
    expect(m).toEqual({ handles: ['metal-dog-playpen', 'gps-tracker-collar', 'pet-glasses'], collection: null });
  });

  it('keeps a catalogue collection and drops an invented one', () => {
    expect(validateMatch({ handles: [], collection: 'pet-accessories' }, catalog)).toEqual({ handles: [], collection: 'pet-accessories' });
    expect(validateMatch({ handles: [], collection: 'pet-hats' }, catalog)).toEqual({ handles: [], collection: null });
  });

  it('accepts an honest empty answer (nothing in the catalogue fits)', () => {
    expect(validateMatch({ handles: [], collection: null }, catalog)).toEqual({ handles: [], collection: null });
  });

  it('rejects an answer whose every handle is invented: a garbled pick is not a "none"', () => {
    expect(validateMatch({ handles: ['gps-collar-xl'], collection: null }, catalog)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(validateMatch(null, catalog)).toBeNull();
    expect(validateMatch('pet-glasses', catalog)).toBeNull();
    expect(validateMatch({ handles: 'pet-glasses' }, catalog)).toBeNull();
  });
});

describe('loadCatalog', () => {
  const page = {
    products: { nodes: [
      { handle: 'gps-tracker-collar', title: 'GPS Tracker Collar for Dogs and Cats', productType: '', description: 'A collar.', collections: { nodes: [{ handle: 'pet-accessories' }] } },
      { handle: 'cat-teaser', title: 'Hanging Cat Teaser Toy', productType: 'Pet Toys', description: 'A toy.', collections: { nodes: [] } },
    ] },
    collections: { nodes: [
      { handle: 'frontpage', title: 'Home page' },
      { handle: 'pet-accessories', title: 'Pet Accessories' },
    ] },
  };

  it('reads only active products published to the Online Store, and published collections', async () => {
    let asked = '';
    const c = await loadCatalog((async (q: string) => { asked = q; return page; }) as any);
    expect(asked).toContain('status:active');
    expect(asked).toContain('published_status:published');
    expect(c?.products.map((p) => p.handle)).toEqual(['gps-tracker-collar', 'cat-teaser']);
    expect(c?.products[0].collections).toEqual(['pet-accessories']);
  });

  it('leaves out the home page collection, which is not a range a shopper asks for', async () => {
    const c = await loadCatalog((async () => page) as any);
    expect(c?.collections).toEqual([{ handle: 'pet-accessories', title: 'Pet Accessories' }]);
  });

  it('returns null when the read fails or the catalogue is empty', async () => {
    expect(await loadCatalog((async () => { throw new Error('throttled'); }) as any)).toBeNull();
    expect(await loadCatalog((async () => ({ products: { nodes: [] }, collections: { nodes: [] } })) as any)).toBeNull();
  });
});

describe('matchCatalog', () => {
  const cfg = { llm: DEFAULT_LLM } as any;
  const ask = { message: 'Hi, any anti escape pet accessory in your store please?', subject: 'any anti escape pet accessory?', productQuery: 'anti escape pet accessory' };
  const answering = (content: string, seen?: { sys?: string; user?: string }) => (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (seen) { seen.sys = body.messages?.[0]?.content; seen.user = body.messages?.[1]?.content; }
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0001 } }), { status: 200 });
  }) as unknown as typeof fetch;

  it('returns the validated match, showing the model the whole catalogue and the message', async () => {
    const seen: { sys?: string; user?: string } = {};
    const m = await matchCatalog(new LlmClient({ openrouter: 'k' }, answering('{"handles":["gps-tracker-collar","metal-dog-playpen"],"collection":null}', seen)),
      new TenantStore(env.DB, 'a.myshopify.com'), cfg, ask, catalog);
    expect(m).toEqual({ handles: ['gps-tracker-collar', 'metal-dog-playpen'], collection: null });
    expect(seen.sys?.startsWith(CATALOG_MATCH_MARKER)).toBe(true);
    for (const p of catalog.products) expect(seen.user).toContain(p.handle);
    expect(seen.user).toContain('anti escape');
  });

  it('returns null with no model, or when the model answers garbage (the caller keeps the title search)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    expect(await matchCatalog(new LlmClient({}), store, cfg, ask, catalog)).toBeNull();
    expect(await matchCatalog(new LlmClient({ openrouter: 'k' }, answering('not json')), store, cfg, ask, catalog)).toBeNull();
  });
});
