import { describe, it, expect } from 'vitest';
import { deriveDestinationCountry, countryLabel, buildShippingLine, isShippingIntent } from '../src/inbox/freight';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import { DEFAULT_INBOX } from '../src/inbox/types';

const CFG: TenantConfig = {
  collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
  pricing: { ...DEFAULT_PRICING, fxUsdToGbp: 0.8, fxBufferPct: 0 }, // £ = $ × 0.8 (no buffer) for a clean assert
  floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
};

/** Minimal mocked CjClient surface used by buildShippingLine. */
function mockCj(impl: () => Promise<{ priceUsd: number; days: string; name: string } | null>) {
  return { freightEstimate: impl } as unknown as Parameters<typeof buildShippingLine>[0];
}

describe('deriveDestinationCountry', () => {
  it('reads an explicitly named country (wins over email TLD)', () => {
    expect(deriveDestinationCountry('Do you ship to Spain?', 'Shipping', 'jane@example.com')).toBe('ES');
    expect(deriveDestinationCountry("I'm in Ireland", '', 'x@gmail.com')).toBe('IE');
    expect(deriveDestinationCountry('Can you deliver to the United States?', '', 'a@a.de')).toBe('US');
  });

  it('maps UK aliases to GB (home market)', () => {
    expect(deriveDestinationCountry('I live in Scotland', '', 'a@b.com')).toBe('GB');
    expect(deriveDestinationCountry('shipping to the United Kingdom', '', 'a@b.com')).toBe('GB');
  });

  it('falls back to an unambiguous email ccTLD when no country is named', () => {
    expect(deriveDestinationCountry('When will my order arrive?', 'Delivery', 'pierre@orange.fr')).toBe('FR');
    expect(deriveDestinationCountry('any update?', '', 'sean@eircom.ie')).toBe('IE');
  });

  it('returns null for generic TLDs and unknown destinations', () => {
    expect(deriveDestinationCountry('When will it arrive?', '', 'a@gmail.com')).toBeNull();
    expect(deriveDestinationCountry('hello', '', 'a@company.org')).toBeNull();
    expect(deriveDestinationCountry('do you ship to Narnia?', '', 'a@a.net')).toBeNull();
  });

  it('returns null when two different countries are named (ambiguous)', () => {
    expect(deriveDestinationCountry('I move between France and Germany', '', 'a@b.com')).toBeNull();
  });

  it('does not match substrings inside longer words', () => {
    // "indianapolis" must not match "india"; no other country named → ccTLD (none) → null
    expect(deriveDestinationCountry('shipping to indianapolis warehouse', '', 'a@b.com')).toBeNull();
  });
});

describe('isShippingIntent', () => {
  it('is true for the shipping-returns category regardless of text', () => {
    expect(isShippingIntent('shipping-returns', 'Re: order', 'thanks')).toBe(true);
  });
  it('is true when the body mentions delivery even for another category', () => {
    expect(isShippingIntent('product-question', '', 'how long is delivery to France?')).toBe(true);
  });
  it('is false for an unrelated product question', () => {
    expect(isShippingIntent('product-question', 'Sizing', 'what size is the large harness?')).toBe(false);
  });
});

describe('countryLabel', () => {
  it('gives a friendly label, falling back to the raw code', () => {
    expect(countryLabel('FR')).toBe('France');
    expect(countryLabel('NL')).toBe('the Netherlands');
    expect(countryLabel('ZZ')).toBe('ZZ');
  });
});

describe('buildShippingLine', () => {
  const REP = 'rep-vid-test';

  it('builds a claim-safe £ line from a real quote (FX-converted, days sanitised)', async () => {
    const cj = mockCj(async () => ({ priceUsd: 5, days: '8-12 days', name: 'Economy' }));
    const line = await buildShippingLine(cj, CFG, 'FR', countryLabel('FR'), REP);
    // 5 USD × 0.8 = £4.00; "8-12 days" → "8-12"
    expect(line).toBe('Delivery to France: shipping from approx £4.00, est. 8-12 working days.');
  });

  it('omits the days clause when CJ aging is unparseable', async () => {
    const cj = mockCj(async () => ({ priceUsd: 10, days: 'varies', name: 'Standard' }));
    const line = await buildShippingLine(cj, CFG, 'ES', countryLabel('ES'), REP);
    expect(line).toBe('Delivery to Spain: shipping from approx £8.00.');
  });

  it('returns null when the representative variant is unset (degrade to safe hedge)', async () => {
    const cj = mockCj(async () => ({ priceUsd: 5, days: '8-12', name: 'Economy' }));
    expect(await buildShippingLine(cj, CFG, 'FR', 'France', '')).toBeNull();
  });

  it('returns null for the GB home market (handled by store facts)', async () => {
    const cj = mockCj(async () => ({ priceUsd: 5, days: '2-4', name: 'UK' }));
    expect(await buildShippingLine(cj, CFG, 'GB', 'the UK', REP)).toBeNull();
  });

  it('returns null when CJ has no quote', async () => {
    const cj = mockCj(async () => null);
    expect(await buildShippingLine(cj, CFG, 'FR', 'France', REP)).toBeNull();
  });

  it('returns null (never throws) when the CJ call errors', async () => {
    const cj = mockCj(async () => { throw new Error('CJ HTTP 500'); });
    await expect(buildShippingLine(cj, CFG, 'FR', 'France', REP)).resolves.toBeNull();
  });

  it('returns null when the quoted price is zero or negative', async () => {
    const cj = mockCj(async () => ({ priceUsd: 0, days: '8-12', name: 'Free?' }));
    expect(await buildShippingLine(cj, CFG, 'FR', 'France', REP)).toBeNull();
  });
});
