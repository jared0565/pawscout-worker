/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { DEFAULT_LLM } from '../src/types';
import { loadCatalog, validateMatch, matchCatalog, pickedDescriptions, REPLY_DESCRIPTION_MAX, CATALOG_MATCH_MARKER, type Catalog } from '../src/inbox/catalog-match';

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

// The catalogue list cuts descriptions at 240 characters, which is plenty for
// matching but not for the reply: the GPS collar's "needs a 4G network, SIM not
// included" sentences start near character 330, and the owner's approved note
// is always the LAST paragraph. A picked item is described from its whole page.
describe('pickedDescriptions', () => {
  const COLLAR = 'A pet collar supplied with a GPS tracker for helping locate dogs and cats. The tracker has a stated positioning accuracy of up to 10 metres and uses a lithium battery. Choose the European or American version when ordering. Includes one collar and one tracker. Please check compatibility, coverage and any required app or service before use. Connects over a 4G mobile network and shows its location in a phone app. The box holds the collar and tracker only; a SIM card with a data plan is not included.';

  it('reads the whole description of each picked handle', async () => {
    let asked: Record<string, unknown> | undefined;
    const admin = (async (_q: string, vars?: Record<string, unknown>) => {
      asked = vars;
      return { products: { nodes: [{ handle: 'gps-tracker-collar', description: COLLAR, descriptionHtml: `<p>${COLLAR}</p>` }] } };
    }) as any;
    const d = await pickedDescriptions(admin, ['gps-tracker-collar', 'metal-dog-playpen']);
    expect(String(asked?.q)).toContain('gps-tracker-collar');
    expect(String(asked?.q)).toContain('metal-dog-playpen');
    expect(d.get('gps-tracker-collar')).toBe(COLLAR);
    expect(d.has('metal-dog-playpen')).toBe(false);
  });

  it('caps a long description but always keeps the owner note at its end', async () => {
    const long = 'Key features. '.repeat(200);
    const note = 'The box holds the collar and tracker only; a SIM card with a data plan is not included.';
    const admin = (async () => ({ products: { nodes: [{ handle: 'x', description: long + note,
      descriptionHtml: `<p>${long}</p>\n<p class="pawscout-note">${note.replace('&', '&amp;')}</p>` }] } })) as any;
    const text = (await pickedDescriptions(admin, ['x'])).get('x') ?? '';
    expect(text.length).toBeLessThanOrEqual(REPLY_DESCRIPTION_MAX + note.length + 5);
    expect(text.startsWith('Key features.')).toBe(true);
    expect(text.endsWith(note)).toBe(true);
  });

  it('returns nothing when the read fails or no handle is given (the catalogue cut is the fallback)', async () => {
    expect((await pickedDescriptions((async () => { throw new Error('throttled'); }) as any, ['x'])).size).toBe(0);
    let called = false;
    expect((await pickedDescriptions((async () => { called = true; return {}; }) as any, [])).size).toBe(0);
    expect(called).toBe(false);
  });
});
