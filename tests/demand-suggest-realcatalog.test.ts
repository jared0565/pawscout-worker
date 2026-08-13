import { describe, it, expect } from 'vitest';
import { buildSeeds, mapToCollection, rankSignals, type RawSuggestion } from '../src/blog/demand-suggest';
import type { FactPack, GroundedProduct } from '../src/blog/types';

// REAL live catalog, pulled from the public storefront on 2026-08-11
// (activepaw.co.uk/collections/<handle>/products.json). The other demand tests
// use tidy invented titles like "Automatic Pet Water Fountain"; the real catalog
// is long de-branded CJ titles with sizes, ampersands and multiple clauses. The
// bigram seeder and the token-overlap mapper both behave differently against
// those, so a fixture that does not look like production proves very little.
const REAL: Record<string, { title: string; products: string[] }> = {
  'pet-health': {
    title: 'Pet Health',
    products: [
      'Stainless Steel Cat Water Fountain with Window, 3.2L',
      'Pet Tooth Cleaning Powder 40g',
      'Pet Tooth Cleaning Pen',
      'Pet Dental Care Finger Wipes',
      'Automatic Pet Water Fountain 2.2L with LED Indicator',
      'Pet Water Bottle Bowl for Walks, 400ml',
      'Digital Pet Weighing Scale for Cats and Small Dogs',
      'Pet First Aid Kit for Home and Travel'
    ]
  },
  'pet-cleaning': {
    title: 'Pet Cleaning',
    products: [
      'Enclosed Cat Litter Box with Top Exit and Side Scoop, 55cm',
      'Enclosed Cat Litter Box with Front Door and Top Exit',
      'Enclosed Cat Litter Box with Top Entry, Scoop & Deodoriser',
      'Foldable Cat Litter Tray with Lid, Scoop & Deodorant',
      'Biodegradable Pet Waste Bags - 1000 Pack',
      'Cat Litter Mat with Honeycomb Trap Design',
      'Pet Hair Remover Roller, Reusable',
      'Portable Dog Paw Cleaner Cup',
      'Pet Stain and Odour Remover Spray',
      'Silicone Cat Litter Scoop with Holder'
    ]
  },
  'pet-toys': {
    title: 'Pet Toys',
    products: [
      'Dog Sofa Bed with Orthopedic Support & Rope Toy',
      '63cm Cat Scratching Post with Sisal Rope',
      '88cm Cat Tree with Sisal Scratching Post and Hanging Toys',
      'Automatic Tennis Ball Roller Toy for Dogs',
      'Rechargeable Hanging Interactive Cat Teaser Toy',
      'Interactive Treat Dispensing Dog Puzzle Toy',
      'Squeaky Plush Dog Toy Set, 4 Pack',
      'Slow Feeder Dog Bowl with Maze Design',
      'Cat Wand Teaser with Feather Refills',
      'Durable Rubber Chew Toy for Aggressive Chewers',
      'Snuffle Mat for Dogs, Enrichment Feeding'
    ]
  },
  'pet-accessories': {
    title: 'Pet Accessories',
    products: [
      'Transformable Cat Tunnel Bed with Interactive Play Features',
      '6-Panel Metal Dog Playpen, Indoor & Outdoor',
      'Multi-Storey Cat Tree Tower with Scratching Post and Cave',
      'Waterproof Dog Car Seat Protector Hammock',
      'Breathable Mesh Pet Front Carrier Backpack',
      'Elevated Cooling Dog Bed with Mesh Top',
      'Adjustable No-Pull Dog Harness with Reflective Strips',
      'Foldable Pet Travel Carrier with Shoulder Strap',
      'Dog Car Booster Seat with Safety Tether',
      'Orthopedic Memory Foam Dog Bed, Large',
      'Retractable Dog Lead 5m with Brake',
      'Pet Stroller for Small Dogs and Cats'
    ]
  },
  'pet-grooming': {
    title: 'Pet Grooming',
    products: [
      'White LED Dog Nail Trimmer and Grinder 2-in-1',
      '2-in-1 LED Nail Clipper & Grinder for Cats & Dogs',
      'Professional Cordless LED Pet Hair Grooming Clippers',
      'Silicone Pet Bath and Massage Glove Brush',
      'Self-Cleaning Slicker Brush for Cats and Dogs',
      'Pet Grooming Scissors Set with Rounded Tips'
    ]
  }
};

const PACKS: FactPack[] = Object.entries(REAL).map(([handle, v]) => ({
  collectionHandle: handle,
  collectionTitle: v.title,
  collectionPath: `/collections/${handle}`,
  products: v.products.map((title): GroundedProduct => ({
    title, handle: title.toLowerCase().replace(/\W+/g, '-'), path: '/products/x', priceGbp: 19.99, available: true
  }))
}));

describe('demand mining against the REAL catalog', () => {
  it('produces seeds that are usable search phrases, not title fragments', () => {
    const seeds = buildSeeds(PACKS, 15);
    // Every collection contributes.
    for (const v of Object.values(REAL)) expect(seeds).toContain(v.title.toLowerCase());
    // A seed must be something a person could plausibly type. The failure mode
    // this guards is bigrams lifted out of long CJ titles, e.g. "transformable
    // cat" or "panel metal", which return junk from autocomplete.
    for (const s of seeds) {
      expect(s.length).toBeGreaterThan(2);
      expect(s.split(' ').length).toBeLessThanOrEqual(3);
      expect(s).not.toMatch(/\d/);         // "63cm cat", "6 panel" are not search phrases
    }
    // The recurrence rule (a bigram must appear in >= 2 products) is strict, and
    // if it filtered EVERYTHING we would silently fall back to five bare
    // collection titles - a quieter, worse version of the feature that no other
    // assertion here would catch. At least one real product-vocabulary seed must
    // survive against the live catalog.
    const titles = Object.values(REAL).map((v) => v.title.toLowerCase());
    const vocab = seeds.filter((s) => !titles.includes(s));
    expect(vocab.length, `seeds collapsed to collection titles only: ${JSON.stringify(seeds)}`).toBeGreaterThan(0);
  });

  it('maps REAL autocomplete-shaped phrases onto the collection that stocks them', () => {
    // Phrases in the shape autocomplete actually returns: short, 3-5 tokens,
    // matched against long multi-clause product titles. This is the case the
    // MAP_MIN_SIM threshold has to survive.
    const cases: [string, string][] = [
      ['cat water fountain stainless steel', 'pet-health'],
      ['enclosed cat litter box', 'pet-cleaning'],
      ['cat scratching post sisal', 'pet-toys'],
      ['orthopedic dog bed', 'pet-accessories'],
      ['dog nail grinder', 'pet-grooming'],
      ['pet hair remover roller', 'pet-cleaning']
    ];
    const mapped = cases.map(([phrase, want]) => [phrase, mapToCollection(phrase, PACKS), want]);
    const wrong = mapped.filter(([, got, want]) => got !== want);
    // Report the whole picture on failure, so a threshold regression is legible
    // rather than showing up as one cryptic assertion.
    expect(wrong, `mis-mapped: ${JSON.stringify(mapped, null, 1)}`).toEqual([]);
  });

  // Both of these are REAL defects from the first live run of the deployed fast
  // path (2026-08-13), fixed the same day. They are pinned with the actual
  // phrases that came back, because both looked perfectly reasonable in the
  // unit fixtures and only failed against the live catalog + live autocomplete.
  it('drops a category-level query we cannot sell against', () => {
    // Seeding with the collection title "Pet Health" made autocomplete return
    // "pet health insurance", which matched the COLLECTION NAME strongly and was
    // published as a demand signal. We do not sell insurance; no product in the
    // catalog resembles it, so it must not map anywhere.
    expect(mapToCollection('pet health insurance', PACKS)).toBeNull();
    expect(mapToCollection('pet adoption near you', PACKS)).toBeNull();
    // ...while genuine product-level demand in the same collection still maps.
    expect(mapToCollection('cat water fountain filters', PACKS)).toBe('pet-health');
  });

  it('drops suggestions that merely echo the seed that produced them', () => {
    const raw: RawSuggestion[] = [
      { phrase: 'pet toys', seed: 'pet toys', rank: 0 },                 // echo
      { phrase: 'pet accessories', seed: 'pet accessories', rank: 0 },   // echo
      { phrase: 'enclosed cat bed', seed: 'cat bed', rank: 2 }           // real discovery
    ];
    const terms = rankSignals(raw, PACKS, 8).map((s) => s.term);
    expect(terms).not.toContain('pet toys');
    expect(terms).not.toContain('pet accessories');
    expect(terms).toContain('enclosed cat bed');
  });

  it('does not force unrelated demand into a collection', () => {
    for (const p of ['aquarium filter media', 'budgie cage cover', 'horse riding boots']) {
      expect(mapToCollection(p, PACKS), p).toBeNull();
    }
  });

  it('end-to-end: real phrases rank into a usable, diverse signal list', () => {
    const raw: RawSuggestion[] = [
      { phrase: 'cat water fountain stainless steel', seed: 'pet health', rank: 1 },
      { phrase: 'cat water fountain filters', seed: 'pet health', rank: 2 },
      { phrase: 'enclosed cat litter box', seed: 'pet cleaning', rank: 0 },
      { phrase: 'cat litter box automatic', seed: 'pet cleaning', rank: 3 },
      { phrase: 'dog nail grinder', seed: 'pet grooming', rank: 1 },
      { phrase: 'orthopedic dog bed', seed: 'pet accessories', rank: 2 },
      { phrase: 'cat scratching post sisal', seed: 'pet toys', rank: 1 },
      // the junk classes, all observed live
      { phrase: 'dog bed bunnings', seed: 'pet accessories', rank: 0 },
      { phrase: 'cat water fountain uk', seed: 'pet health', rank: 0 },
      { phrase: 'diy cat scratching post', seed: 'pet toys', rank: 0 }
    ];
    const out = rankSignals(raw, PACKS, 8);
    expect(out.length).toBeGreaterThanOrEqual(5);
    const terms = out.map((s) => s.term);
    expect(terms.some((t) => /bunnings|\buk\b|diy/.test(t))).toBe(false);
    // More than one collection represented, so the topic list will not be five
    // flavours of one category.
    expect(new Set(out.map((s) => s.collectionHandle)).size).toBeGreaterThanOrEqual(3);
    for (const s of out) expect(s.why).toMatch(/rank \d/);
  });
});
