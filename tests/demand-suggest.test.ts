import { describe, it, expect } from 'vitest';
import {
  isNoisePhrase, buildSeeds, mapToCollection, rankSignals,
  researchDemandDeterministic, GoogleSuggestSource,
  type SuggestSource, type RawSuggestion
} from '../src/blog/demand-suggest';
import { proposeTopics } from '../src/blog/research';
import { LlmClient } from '../src/llm';
import type { FactPack, GroundedProduct } from '../src/blog/types';

const CFG: any = { llm: { models: {} } };
const WINDOW = { season: 'autumn', months: ['September', 'October', 'November'] };

const prod = (title: string): GroundedProduct =>
  ({ title, handle: title.toLowerCase().replace(/\W+/g, '-'), path: '/products/x', priceGbp: 9.99, available: true });

const PACKS: FactPack[] = [
  {
    collectionHandle: 'pet-health', collectionTitle: 'Pet Health', collectionPath: '/collections/pet-health',
    products: [prod('Automatic Pet Water Fountain'), prod('Stainless Steel Water Fountain'), prod('Dog Dental Care Kit')]
  },
  {
    collectionHandle: 'pet-cleaning', collectionTitle: 'Pet Cleaning', collectionPath: '/collections/pet-cleaning',
    products: [prod('Enclosed Cat Litter Box'), prod('Cat Litter Scoop')]
  }
];

function fakeSource(map: Record<string, string[] | null>): SuggestSource {
  return { name: 'fake', async suggest(seed) { return seed in map ? map[seed] : []; } };
}

describe('demand noise filter', () => {
  // Every phrase below was actually returned by Google autocomplete on
  // 2026-08-11, not invented. That is the point: the filter is pinned against
  // real junk, because a miss becomes a published article title.
  it('drops retailer and marketplace queries', () => {
    for (const p of ['dog bed bunnings', 'cat water fountain kmart', 'cat water fountain amazon', 'dog bed argos', 'cat tree pets at home']) {
      expect(isNoisePhrase(p), p).toBe(true);
    }
  });
  it('drops geo-qualified shopping queries, including our own market', () => {
    // Market-neutral on purpose: Active Paw is multi-market, so "uk" is no more
    // a content topic than "nz". Both are someone looking for a shop.
    for (const p of ['cat water fountain uk', 'cat water fountain nz', 'dog bed australia', 'pet carrier ireland']) {
      expect(isNoisePhrase(p), p).toBe(true);
    }
  });
  it('drops local, transactional and DIY intent', () => {
    for (const p of ['cat water fountain near me', 'dog bed second hand', 'cheap dog crate', 'diy cat scratching post', 'how to make a cat tree']) {
      expect(isNoisePhrase(p), p).toBe(true);
    }
  });
  // Regression: the filter briefly matched retailer tokens as SUBSTRINGS against
  // the phrase with its spaces stripped, so any token over 4 characters could hit
  // inside an unrelated word - "range" inside "orange", "target" inside
  // "targeted". Whole-word matching only.
  it('does not match a retailer token inside an unrelated word', () => {
    for (const p of ['orange cat litter box', 'targeted flea treatment', 'arrangement of cat trees', 'bmw dog crate']) {
      expect(isNoisePhrase(p), p).toBe(false);
    }
    expect(isNoisePhrase('cat tree the range')).toBe(true);   // the real retailer still goes
  });
  it('KEEPS genuine product-research phrases', () => {
    for (const p of ['cat water fountain stainless steel', 'cat water fountain filters', 'enclosed cat litter box', 'best dog bed for large dogs', 'cat litter box automatic']) {
      expect(isNoisePhrase(p), p).toBe(false);
    }
  });
});

describe('seeds + collection mapping', () => {
  it('seeds from real collections and their product vocabulary, capped', () => {
    const seeds = buildSeeds(PACKS, 6);
    expect(seeds).toContain('pet health');
    expect(seeds).toContain('pet cleaning');
    expect(seeds.length).toBeLessThanOrEqual(6);
    expect(new Set(seeds).size).toBe(seeds.length);  // deduped: each seed is an HTTP request
  });
  it('maps a phrase to the collection that actually stocks it, or drops it', () => {
    expect(mapToCollection('stainless steel water fountain', PACKS)).toBe('pet-health');
    expect(mapToCollection('enclosed cat litter box', PACKS)).toBe('pet-cleaning');
    // Nothing in the catalog answers this, so it must NOT be forced into a
    // collection: a topic we cannot back with products is the failure this gate
    // exists to prevent.
    expect(mapToCollection('aquarium filter media', PACKS)).toBeNull();
  });
});

describe('ranking', () => {
  const raw: RawSuggestion[] = [
    { phrase: 'stainless steel water fountain', seed: 'pet health', rank: 4 },
    { phrase: 'stainless steel water fountain', seed: 'water fountain', rank: 1 },
    { phrase: 'enclosed cat litter box', seed: 'pet cleaning', rank: 2 },
    { phrase: 'cat water fountain amazon', seed: 'pet health', rank: 0 },   // noise, rank 0
    { phrase: 'aquarium filter media', seed: 'pet health', rank: 1 }        // unstocked
  ];
  it('ranks recurrence above raw position and drops noise and unstocked phrases', () => {
    const out = rankSignals(raw, PACKS, 8);
    const terms = out.map((s) => s.term);
    expect(terms[0]).toBe('stainless steel water fountain');   // seen across 2 seeds
    expect(terms).toContain('enclosed cat litter box');
    expect(terms).not.toContain('cat water fountain amazon');  // noise beats its rank-0 position
    expect(terms).not.toContain('aquarium filter media');      // nothing stocks it
  });
  it('explains itself from evidence, never from a model', () => {
    const out = rankSignals(raw, PACKS, 8);
    expect(out[0].why).toMatch(/rank 2/);            // bestRank 1, reported 1-based
    expect(out[0].why).toMatch(/recurring across 2/);
    expect(out[0].sourceUrl).toBeUndefined();        // no citations to fabricate
  });
  it('is deterministic: identical input yields an identical list', () => {
    expect(rankSignals(raw, PACKS, 8)).toEqual(rankSignals(raw, PACKS, 8));
  });
  it('spreads picks across collections instead of five of one', () => {
    const many: RawSuggestion[] = Array.from({ length: 10 }, (_, i) =>
      ({ phrase: `water fountain variant ${i}`, seed: 'pet health', rank: i }));
    const out = rankSignals([...many, { phrase: 'enclosed cat litter box', seed: 'pet cleaning', rank: 9 }], PACKS, 6);
    const health = out.filter((s) => s.collectionHandle === 'pet-health').length;
    expect(health).toBeLessThanOrEqual(3);  // ceil(6/2)
  });
});

describe('researchDemandDeterministic', () => {
  it('collects, filters and ranks across seeds', async () => {
    const src = fakeSource({
      'pet health': ['cat water fountain stainless steel', 'cat water fountain amazon', 'cat water fountain uk'],
      'pet cleaning': ['enclosed cat litter box', 'cat litter box near me']
    });
    const out = await researchDemandDeterministic(PACKS, src, { maxSeeds: 12 });
    expect(out.sourceFailed).toBe(false);
    const terms = out.signals.map((s) => s.term);
    expect(terms).toContain('cat water fountain stainless steel');
    expect(terms).toContain('enclosed cat litter box');
    expect(terms.some((t) => /amazon|uk|near me/.test(t))).toBe(false);
  });
  it('reports sourceFailed when EVERY seed fails, and returns no signals', async () => {
    const dead: SuggestSource = { name: 'dead', async suggest() { return null; } };
    const out = await researchDemandDeterministic(PACKS, dead, { maxSeeds: 4 });
    expect(out.sourceFailed).toBe(true);
    expect(out.signals).toEqual([]);
  });
  it('a source answering with nothing is NOT a failure', async () => {
    const empty: SuggestSource = { name: 'empty', async suggest() { return []; } };
    const out = await researchDemandDeterministic(PACKS, empty, { maxSeeds: 4 });
    expect(out.sourceFailed).toBe(false);
  });
});

describe('GoogleSuggestSource parsing', () => {
  const respond = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('parses the real autocomplete payload shape', async () => {
    // Byte-for-byte shape observed on 2026-08-11.
    const real = '["cat water fountain",["cat water fountain","cat water fountain stainless steel","cat water fountain filters"],[],{"google:suggestsubtypes":[[512],[512],[512]]}]';
    const out = await new GoogleSuggestSource(respond(real)).suggest('cat water fountain');
    expect(out).toEqual(['cat water fountain', 'cat water fountain stainless steel', 'cat water fountain filters']);
  });
  it('returns null on HTTP failure so the caller can degrade, not [] which means "nothing found"', async () => {
    expect(await new GoogleSuggestSource(respond('rate limited', 429)).suggest('x')).toBeNull();
    expect(await new GoogleSuggestSource(respond('<html>not json</html>')).suggest('x')).toBeNull();
  });
});

describe('fast vs deep wiring', () => {
  const llm = new LlmClient({ openrouter: 'k' }, (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ topics: [
      { title: 'Stainless steel fountains explained', angle: 'a', targetKeyword: 'k', collectionHandle: 'pet-health', demandTerm: 'cat water fountain stainless steel', whyNow: 'w', keyPoints: ['a', 'b', 'c'] }
    ] }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 }, model: 'test'
  }), { status: 200 })) as unknown as typeof fetch);

  it('fast mode uses the injected suggest source and spends nothing on search', async () => {
    let llmSearchCalls = 0;
    const src: SuggestSource = {
      name: 'fake',
      async suggest(seed) { return seed === 'pet health' ? ['cat water fountain stainless steel'] : []; }
    };
    const spyStore: any = {
      logLlmUsage: async (task: string) => { if (/demand/.test(task)) llmSearchCalls++; },
      saveDemandSnapshot: async () => {}
    };
    const { demand } = await proposeTopics(llm, spyStore, CFG, { packs: PACKS, window: WINDOW, mode: 'fast', suggestSource: src });
    expect(demand.grounded).toBe(true);
    expect(demand.signals[0].term).toBe('cat water fountain stainless steel');
    expect(demand.note).toMatch(/autocomplete/i);
    expect(llmSearchCalls).toBe(0);          // the expensive pass never ran
  });

  it('fast mode snapshots the signals so the trend diff can be built later', async () => {
    const saved: unknown[] = [];
    const spyStore: any = { logLlmUsage: async () => {}, saveDemandSnapshot: async (mode: string, sigs: unknown) => { saved.push({ mode, sigs }); } };
    const src: SuggestSource = { name: 'fake', async suggest(seed) { return seed === 'pet health' ? ['cat water fountain stainless steel'] : []; } };
    await proposeTopics(llm, spyStore, CFG, { packs: PACKS, window: WINDOW, mode: 'fast', suggestSource: src });
    expect(saved).toHaveLength(1);
    expect((saved[0] as any).mode).toBe('fast');
  });

  it('a dead suggest source degrades visibly and NEVER escalates to the paid path', async () => {
    let llmSearchCalls = 0;
    const spyStore: any = {
      logLlmUsage: async (task: string) => { if (/demand/.test(task)) llmSearchCalls++; },
      saveDemandSnapshot: async () => {}
    };
    const dead: SuggestSource = { name: 'dead', async suggest() { return null; } };
    const { candidates, demand } = await proposeTopics(llm, spyStore, CFG, { packs: PACKS, window: WINDOW, mode: 'fast', suggestSource: dead });
    expect(demand.grounded).toBe(false);
    expect(demand.note).toMatch(/unavailable/i);
    expect(llmSearchCalls).toBe(0);          // spending $0.21 unasked is the worse failure
    expect(candidates.length).toBeGreaterThan(0);   // still usable, just evergreen
  });
});
