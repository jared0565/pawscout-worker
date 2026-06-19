import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { searchBackfill, normalizeKeyword, relevanceMatch, keywordTokens, liveCjPasses, querySpecies, isLikelyPetProduct, isPetProductStrict, titleSignature, signaledCategory, categoryAdmitsLiveCj } from '../src/proxy/search';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, type TenantConfig } from '../src/types';
import type { CjClient, CjSearchItem } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const CFG: TenantConfig = {
  collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' } },
  gates: DEFAULT_GATES, // floor 50, $5–80, title relevance
  pricing: DEFAULT_PRICING,
  floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
  target: 12
};

function item(over: Partial<CjSearchItem>): CjSearchItem {
  return { pid: 'P1', nameEn: 'Dog Toy Rope', image: 'https://i/1.jpg', sellPriceUsd: 10, listedNum: 100, categoryName: 'Pet Toys', ...over };
}

function fakeCj(items: CjSearchItem[], calls: string[] = []): CjClient {
  return { search: async (kw: string) => { calls.push(kw); return items; } } as unknown as CjClient;
}

describe('isLikelyPetProduct (mechanical floor)', () => {
  it('admits anything with an explicit pet signal', () => {
    expect(isLikelyPetProduct('Pet Grooming Scissors Set with Comb')).toBe(true);
    expect(isLikelyPetProduct('Dog Nail Clipper')).toBe(true);
    expect(isLikelyPetProduct('Cat Scratch Board')).toBe(true);
  });
  it('rejects clear non-pet tools that have no pet signal', () => {
    expect(isLikelyPetProduct('Kitchen Knife Sharpener 5 In 1')).toBe(false);
    expect(isLikelyPetProduct('21V Cordless Electric Pruning Shears Tree Branch Cutter')).toBe(false);
    expect(isLikelyPetProduct('Hairdressing scissors')).toBe(false);
    expect(isLikelyPetProduct('Barber scissors')).toBe(false);
    expect(isLikelyPetProduct('Tailor scissors handmade scissors')).toBe(false);
  });
  it('rejects human jewelry / accessories that have no pet signal', () => {
    expect(isLikelyPetProduct('Set Diamond Love More Pendant')).toBe(false);
    expect(isLikelyPetProduct('Wear More Magnet Love Four-leaf Clover Necklace')).toBe(false);
    expect(isLikelyPetProduct('Love You More Couple Pendant Sweater Pearl Chain')).toBe(false);
    expect(isLikelyPetProduct('Love Yourself More Phone Case Drop-resistant')).toBe(false);
  });
  it('does NOT over-reject pet items: a pet token admits before the marker check', () => {
    // pet apparel/jewelry-charm products are real — the explicit pet signal wins first
    expect(isLikelyPetProduct('Dog Sweater Knitted Pet Hat')).toBe(true);
    expect(isLikelyPetProduct('Pet Collar with Pearl Chain Charm')).toBe(true);
  });
  it('admits ambiguous items (no signal either way) — the LLM tightens when up', () => {
    expect(isLikelyPetProduct('Silicone Bath Brush')).toBe(true);
  });
});

describe('isPetProductStrict (live-feed pet gate — precision over recall)', () => {
  it('requires an explicit pet signal: pet products pass, human/ambiguous are rejected', () => {
    expect(isPetProductStrict('Pet Dog Shampoo Oatmeal Soothing')).toBe(true);
    expect(isPetProductStrict('Cat Litter Deodorizing Mat')).toBe(true);
    // the exact bug: a bare "shampoo" search must not surface human shampoo (no pet token)
    expect(isPetProductStrict('Argan Oil Hair Shampoo 500ml')).toBe(false);
    // INTENTIONAL: ambiguous title with no pet token is dropped on the supplemental live
    // feed (isLikelyPetProduct ADMITS this — a deliberately different, stricter gate).
    expect(isPetProductStrict('Silicone Bath Brush')).toBe(false);
  });
});

describe('categoryAdmitsLiveCj (CJ top-category hard-drop gate)', () => {
  it('drops unambiguously non-pet top categories (even with a pet-token title)', () => {
    for (const c of ['Jewelry & Watches', 'Phones & Accessories', 'Health, Beauty & Hair', 'Apparel', 'CONSUMER ELECTRONICS', 'Automobiles & Motorcycles']) {
      expect(categoryAdmitsLiveCj(c)).toBe(false);
    }
  });
  it('defers pet / ambiguous catch-all / blank top categories to the title floor', () => {
    for (const c of ['Pet Supplies', 'Home, Garden & Furniture', 'Sports & Outdoors', '', undefined]) {
      expect(categoryAdmitsLiveCj(c)).toBe(true);
    }
  });
});

describe('titleSignature (dedupe)', () => {
  it('collapses literal twins and reorderings to one signature', () => {
    expect(titleSignature('Pet Teeth Cleaning Powder 100g')).toBe(titleSignature('Teeth Cleaning Powder 100g for Pets'));
    expect(titleSignature('Silicone Bath Massage Brush')).toBe(titleSignature('Massage Silicone Brush Bath'));
  });
  it('keeps genuinely different products distinct', () => {
    expect(titleSignature('Silicone Bath Brush')).not.toBe(titleSignature('Silicone Spa Massage Glove Brush'));
  });
});

describe('signaledCategory (category re-audit)', () => {
  it('returns the single clear category', () => {
    expect(signaledCategory('Pet Dental Wipes for Teeth & Gum Care')).toBe('pet-health');
    expect(signaledCategory('Self-Cleaning Slicker Brush for Dogs')).toBe('pet-grooming');
    expect(signaledCategory('No-Pull Reflective Dog Harness')).toBe('pet-accessories');
  });
  it('returns null when signals are mixed (leave it where it is)', () => {
    expect(signaledCategory('Suction-Cup Tug Ball & Tooth-Cleaning Dog Toy')).toBeNull(); // toy + tooth
    expect(signaledCategory('Pet Bath Brush Cat Dog Massage Comb')).toBeNull(); // bath + comb
  });
  it('returns null when no signal matches', () => {
    expect(signaledCategory('Mystery Gadget')).toBeNull();
  });
});

describe('relevance + normalization', () => {
  it('normalizes keywords', () => {
    expect(normalizeKeyword('  Dog   TOY ')).toBe('dog toy');
  });
  it('title mode needs one token, strict needs all', () => {
    expect(relevanceMatch('dog rope', 'Big Dog Bed', 'title')).toBe(true);
    expect(relevanceMatch('dog rope', 'Big Dog Bed', 'strict')).toBe(false);
    expect(relevanceMatch('dog rope', 'Dog Rope Toy', 'strict')).toBe(true);
    expect(relevanceMatch('cat tree', 'Sisal Scratching Post', 'loose')).toBe(true); // loose trusts source
    expect(relevanceMatch('cat tree', 'Dog Bed', 'loose')).toBe(false); // ...but the species gate still applies
  });
  it('plural query matches a singular title (the strict "cat toys" bug)', () => {
    // "toys" must match "Toy"; "cat toys" must accept cat toys, reject dog toys
    expect(relevanceMatch('cat toys', 'Gravity Rolling Ball Cat Teaser Toy', 'strict')).toBe(true);
    expect(relevanceMatch('cat toys', 'Squeaky Duck Chew Toy for Dogs', 'strict')).toBe(false);
    expect(relevanceMatch('brushes', 'Pet Bath Brush', 'strict')).toBe(true);
  });
  it('drops stopwords so "toys for cats" behaves like "toy cat"', () => {
    expect(keywordTokens('toys for cats')).toEqual(['toy', 'cat']);
    expect(relevanceMatch('toys for cats', 'Smart Self-Rotating Cat Ball Toy', 'strict')).toBe(true);
  });
  it('word-boundary: "cat" must not match inside "catapult"', () => {
    // the live bug: "Pet Food Catapult Feeder Funny Dog Toy" wrongly passed "cat toys"
    expect(relevanceMatch('cat toys', 'Pet Food Catapult Feeder Funny Dog Toy', 'strict')).toBe(false);
    expect(relevanceMatch('cat', 'Catnip Scratcher', 'strict')).toBe(false); // "cat" not the word "catnip"
    expect(relevanceMatch('cat', 'Cats Love This', 'strict')).toBe(true); // plural title word still matches
  });
  it('species gate rejects the opposite animal in any mode', () => {
    expect(querySpecies('dog toy')).toBe('dog');
    expect(relevanceMatch('dog toy', 'Squeaky Cat Toy', 'title')).toBe(false); // cat in a dog search
    expect(relevanceMatch('cat toy', 'Dog Chew Toy', 'loose')).toBe(false); // even loose
  });
});

describe('liveCjPasses (species-required, trusts listV2 relevance)', () => {
  const G = DEFAULT_GATES; // floor 1, $5-80, title
  const it_ = (over: Partial<CjSearchItem>) => item({ listedNum: 5, ...over });
  it('reaches fill: a real dog product passes "dog toy" without the literal word "toy"', () => {
    expect(liveCjPasses(it_({ nameEn: 'Herding Ball for Dogs - Chew Resistant' }), G, 'dog toy')).toBe(true);
    expect(liveCjPasses(it_({ nameEn: 'Squeaky Plush Puppy Friend' }), G, 'dog toy')).toBe(true);
  });
  it('blocks the wrong species and species-less junk for a species query', () => {
    expect(liveCjPasses(it_({ nameEn: 'Electric Jumping Shrimp Cat Toy' }), G, 'dog toy')).toBe(false);
    expect(liveCjPasses(it_({ nameEn: 'Basketball Advent Calendar 2026 Mini Toys' }), G, 'cat toys')).toBe(false);
  });
  it('still enforces price and popularity', () => {
    expect(liveCjPasses(it_({ nameEn: 'Dog Toy', sellPriceUsd: 500 }), G, 'dog toy')).toBe(false);
    expect(liveCjPasses(it_({ nameEn: 'Dog Toy', listedNum: 0 }), { ...G, popularityFloor: 1 }, 'dog toy')).toBe(false);
  });
  it('non-species query falls back to category-token matching', () => {
    expect(liveCjPasses(it_({ nameEn: 'Steel Slicker Brush' }), G, 'slicker brush')).toBe(true);
    expect(liveCjPasses(it_({ nameEn: 'Cotton Rope Knot' }), G, 'slicker brush')).toBe(false);
  });
});

describe('searchBackfill', () => {
  it('applies gates, prices in GBP, and logs the demand signal', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const items = [
      item({ pid: 'ok' }),
      item({ pid: 'unpopular', listedNum: 0 }),
      item({ pid: 'pricey', sellPriceUsd: 500 }),
      item({ pid: 'offtopic', nameEn: 'Garden Hose' })
    ];
    const cards = await searchBackfill(store, fakeCj(items), CFG, 'dog toy', 4, 12);

    expect(cards.map((c) => c.pid)).toEqual(['ok']);
    expect(cards[0].price).toBe(19.99); // 10 USD under default pricing
    expect(cards[0].state).toBe('ghost');

    const since = new Date(Date.now() - 60_000).toISOString();
    const log = await store.recentSearches(since, 10);
    expect(log).toHaveLength(1);
    expect(log[0].keyword_norm).toBe('dog toy');
    expect(Number(log[0].avg_store_hits)).toBe(4);
    expect(Number(log[0].avg_ghost_hits)).toBe(1);
  });

  it('swaps in the cached curated hero for a card when one exists', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putSearchCache('hero:ok', JSON.stringify({ sig: 'x', images: ['https://i/HERO.jpg', 'https://i/2.jpg'] }), 30);
    const cards = await searchBackfill(store, fakeCj([item({ pid: 'ok' })]), CFG, 'dog toy', 0, 12);
    expect(cards.find((c) => c.pid === 'ok')!.image).toBe('https://i/HERO.jpg');
  });

  it('serves repeats from cache — CJ is hit once per keyword', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: string[] = [];
    const cj = fakeCj([item({})], calls);
    await searchBackfill(store, cj, CFG, 'Dog Toy', 0, 12);
    await searchBackfill(store, cj, CFG, 'dog   toy', 0, 12); // same after normalization
    expect(calls).toEqual(['dog toy']);
  });

  it('marks already-imported products with their real PDP url', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://1', handle: 'dog-toy-rope' });
    const cards = await searchBackfill(store, fakeCj([item({})]), CFG, 'dog toy', 0, 12);
    expect(cards[0]).toMatchObject({ state: 'imported', url: '/products/dog-toy-rope' });
  });

  it('re-offers archived products as ghosts (demand can revive them)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'archived', shopifyProductId: 'gid://1', handle: 'dog-toy-rope' });
    const cards = await searchBackfill(store, fakeCj([item({})]), CFG, 'dog toy', 0, 12);
    expect(cards[0]).toMatchObject({ state: 'ghost', url: null });
  });

  it('respects the limit', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const items = Array.from({ length: 20 }, (_, i) => item({ pid: `p${i}` }));
    const cards = await searchBackfill(store, fakeCj(items), CFG, 'dog toy', 0, 3);
    expect(cards).toHaveLength(3);
  });

  it('excludes pids already shown on the page (no duplicate cards)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const items = [item({ pid: 'shown' }), item({ pid: 'fresh' })];
    const cards = await searchBackfill(store, fakeCj(items), CFG, 'dog toy', 4, 12, { exclude: ['shown'] });
    expect(cards.map((c) => c.pid)).toEqual(['fresh']);
  });

  it('drops non-pet products (human shampoo) from the live feed on a bare query; keeps pet ones', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    // 'shampoo' is a non-species query, so liveCjPasses lets both through on title match —
    // the pet floor is the only thing separating the human product from the pet one.
    const items = [
      item({ pid: 'human', nameEn: 'Argan Oil Hair Shampoo 500ml' }),
      item({ pid: 'pet', nameEn: 'Pet Dog Shampoo Oatmeal Soothing' })
    ];
    const cards = await searchBackfill(store, fakeCj(items), CFG, 'shampoo', 1, 12);
    expect(cards.map((c) => c.pid)).toEqual(['pet']);
  });

  it('hard-drops a pet-token item filed under a non-pet CJ top category; keeps the Pet Supplies one', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    // Both titles carry a pet token, so the title floor (isPetProductStrict) ADMITS both —
    // only CJ's top category separates the fashion necklace from the genuine pet collar tag.
    const items = [
      item({ pid: 'NECK', nameEn: 'Dog Mom Necklace Pendant', topCategory: 'Jewelry & Watches' }),
      item({ pid: 'REAL', nameEn: 'Dog Necklace Tag Pet Collar', topCategory: 'Pet Supplies' })
    ];
    const cards = await searchBackfill(store, fakeCj(items), CFG, 'dog necklace', 0, 12);
    const pids = cards.map((c) => c.pid);
    expect(pids).toContain('REAL');
    expect(pids).not.toContain('NECK');
  });
});
