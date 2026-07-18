import { describe, it, expect, vi } from 'vitest';
import {
  titleTokens, numericUnits, titleSimilarity, buildMarketQuery, matchCandidates, credibleMarketGbp,
  EbaySource, ebayFromEnv, type MarketCandidate
} from '../src/market';

const C = (title: string, itemGbp: number, deliveryGbp = 0): MarketCandidate =>
  ({ title, itemGbp, deliveryGbp, deliveredGbp: Math.round((itemGbp + deliveryGbp) * 100) / 100 });

describe('market title normalisation', () => {
  it('titleTokens keeps content words, drops stopwords/numbers/noise', () => {
    expect(titleTokens('The Premium Portable Dog Water Bottle with Bowl, New UK')).toEqual(['dog', 'water', 'bottle', 'bowl']);
  });
  it('numericUnits normalises sizes and pack counts', () => {
    expect(numericUnits('800ml Dogs Water Bottle')).toEqual(['800ml']);
    expect(numericUnits('3.2 L fountain, pack of 2')).toEqual(expect.arrayContaining(['3.2l', '2pack']));
    expect(numericUnits('Cat tunnel x3')).toEqual(['3pack']);
  });
  it('titleSimilarity rewards token overlap + agreeing sizes, punishes size conflicts', () => {
    const ours = '800ml Dog Water Bottle Portable Leakproof';
    const same = titleSimilarity(ours, 'Portable Dog Water Bottle 800ml Leak Proof Travel');
    const diffSize = titleSimilarity(ours, 'Portable Dog Water Bottle 350ml Leak Proof Travel');
    const unrelated = titleSimilarity(ours, 'Cat Scratching Post Sisal Tower');
    expect(same).toBeGreaterThan(0.6);
    expect(diffSize).toBeLessThan(same);
    expect(unrelated).toBeLessThan(0.15);
  });
  it('buildMarketQuery caps to 8 informative tokens', () => {
    const q = buildMarketQuery('Elevated Waterproof Pet Bed with Steel Frame for Large Dogs Outdoor Garden Camping Two Sizes');
    expect(q.split(' ').length).toBeLessThanOrEqual(8);
    expect(q).toContain('elevated');
  });
});

describe('matchCandidates (deterministic tiers)', () => {
  const OURS = '800ml Dog Water Bottle Portable Leakproof';
  const GOOD = [
    C('Portable Dog Water Bottle 800ml Leakproof', 9.99, 2.99),
    C('Dog Water Bottle 800ml Portable Travel Leakproof', 11.49),
    C('800ml Leakproof Portable Dog Water Bottle Drinking', 8.99, 3.49)
  ];

  it('3+ strong matches -> high confidence at the credible MEDIAN delivered price', () => {
    const m = matchCandidates(OURS, 12.99, GOOD);
    expect(m).toMatchObject({ kind: 'match', estimateGbp: 12.48, confidence: 'high', matched: 3 });
    // 9.99+2.99=12.98, 11.49, 8.99+3.49=12.48 -> median 12.48 (no outliers to drop)
    if (m.kind === 'match') expect(m.candidates.length).toBe(3); // matched set exposed for the seller-credibility pass
  });

  it('2 strong matches -> medium confidence', () => {
    const m = matchCandidates(OURS, 12.99, GOOD.slice(0, 2));
    expect(m.kind).toBe('match');
    if (m.kind === 'match') expect(m.confidence).toBe('medium');
  });

  it('credibleMarketGbp = median of survivors after the junk drop (below 55% of median)', () => {
    expect(credibleMarketGbp([2.5, 11.99, 12.49, 12.99])).toBe(12.49); // 2.50 = junk/part; median of the 3 survivors
    expect(credibleMarketGbp([9.99])).toBe(9.99);
    expect(credibleMarketGbp([10, 12])).toBe(11);                      // even count -> mean of the middle pair
    expect(credibleMarketGbp([1, 1.2, 9.99, 10.49])).toBe(10.24);      // junk-heavy list still lands on the credible middle
  });

  it('implausible prices are filtered before matching (multipacks/parts)', () => {
    const m = matchCandidates(OURS, 12.99, [C('Portable Dog Water Bottle 800ml Leakproof', 89.99), C('Dog Water Bottle 800ml Portable', 1.20)]);
    expect(m.kind).toBe('none'); // both outside [0.2x, 3.5x] of our GBP 12.99
  });

  it('weak-only overlap -> ambiguous shortlist for the classifier', () => {
    const m = matchCandidates(OURS, 12.99, [
      C('Dog Travel Bottle Water Dispenser', 10.99),
      C('Pet Bottle Water Feeder for Dogs', 12.49)
    ]);
    expect(m.kind).toBe('ambiguous');
    if (m.kind === 'ambiguous') expect(m.shortlist.length).toBe(2);
  });

  it('nothing comparable -> none', () => {
    expect(matchCandidates(OURS, 12.99, [C('Cat Scratching Post Tower', 12.99)]).kind).toBe('none');
  });
});

describe('EbaySource (Browse API client)', () => {
  const tokenResp = { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 7200 }) };

  it('parses summaries into delivered candidates (GBP only, shipping summed, non-GBP skipped)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tokenResp)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ itemSummaries: [
        { title: 'Dog Bottle 800ml', price: { value: '9.99', currency: 'GBP' }, shippingOptions: [{ shippingCost: { value: '2.99', currency: 'GBP' } }] },
        { title: 'Free Post Bottle', price: { value: '12.50', currency: 'GBP' } },
        { title: 'US listing', price: { value: '9.99', currency: 'USD' } }
      ] }) });
    const src = new EbaySource('id', 'secret', fetchImpl as any);
    const out = await src.search('dog bottle 800ml');
    expect(out).toEqual([
      { title: 'Dog Bottle 800ml', itemGbp: 9.99, deliveryGbp: 2.99, deliveredGbp: 12.98 },
      { title: 'Free Post Bottle', itemGbp: 12.5, deliveryGbp: 0, deliveredGbp: 12.5 }
    ]);
    const browseCall = fetchImpl.mock.calls[1];
    expect(browseCall[0]).toContain('item_summary/search?q=dog%20bottle%20800ml');
    expect(browseCall[0]).toContain('itemLocationCountry%3AGB');
    expect((browseCall[1] as any).headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_GB');
  });

  it('skips listings sold by Temu (owner rule 2026-07-12: not a credible market reference)', async () => {
    // URL-dispatched mock: the module-level token cache may already be warm
    // from an earlier test, so the token call cannot be assumed to happen.
    const fetchImpl = vi.fn(async (url: string) => url.includes('item_summary/search')
      ? { ok: true, status: 200, json: async () => ({ itemSummaries: [
          { title: 'Dog Bottle 800ml', price: { value: '4.99', currency: 'GBP' }, seller: { username: 'temu_official_uk' } },
          { title: 'Dog Bottle 800ml Travel', price: { value: '3.99', currency: 'GBP' }, seller: { username: 'TEMU' } },
          { title: 'Dog Bottle 800ml Leakproof', price: { value: '9.99', currency: 'GBP' }, seller: { username: 'petsupplies-gb' } },
          { title: 'Dog Bottle 800ml No Seller Field', price: { value: '10.99', currency: 'GBP' } }
        ] }) }
      : tokenResp);
    const src = new EbaySource('id', 'secret', fetchImpl as any);
    const out = await src.search('dog bottle 800ml');
    expect(out?.map((c) => c.title)).toEqual(['Dog Bottle 800ml Leakproof', 'Dog Bottle 800ml No Seller Field']);
  });

  it('returns null (source failure) on auth or HTTP errors - callers may fall back', async () => {
    const authFail = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await new EbaySource('id', 'bad', authFail as any).search('x')).toBeNull();
  });

  it('ebayFromEnv is dormant without both secrets', () => {
    expect(ebayFromEnv({} as any)).toBeNull();
    expect(ebayFromEnv({ EBAY_CLIENT_ID: 'a' } as any)).toBeNull();
    expect(ebayFromEnv({ EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b' } as any)).not.toBeNull();
  });
});
