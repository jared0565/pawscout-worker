import { describe, it, expect } from 'vitest';
import { deriveDestinationCountry, countryLabel, buildShippingLine, isShippingIntent, LOGISTICS_DESTINATIONS } from '../src/inbox/freight';

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
    expect(deriveDestinationCountry('shipping to indianapolis warehouse', '', 'a@b.com')).toBeNull();
  });

  it('does not read the ".co.uk" in a quoted email footer as a UK destination (the Texas-thread bug)', () => {
    // A bare email/URL domain ".uk" must NOT derive GB - it previously stapled a "Delivery
    // to the UK" line onto a US (Texas) shipping question.
    expect(deriveDestinationCountry('how long to Texas? On Tue Active Paw <support@activepaw.co.uk> wrote:', '', 'a@gmail.com')).toBeNull();
    // ...but a genuine UK mention still maps to GB.
    expect(deriveDestinationCountry('please ship to the UK', '', 'a@gmail.com')).toBe('GB');
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

describe('LOGISTICS_DESTINATIONS', () => {
  it('includes GB, excludes the CN origin, and is de-duplicated', () => {
    expect(LOGISTICS_DESTINATIONS).toContain('GB');
    expect(LOGISTICS_DESTINATIONS).toContain('FR');
    expect(LOGISTICS_DESTINATIONS).not.toContain('CN');
    expect(new Set(LOGISTICS_DESTINATIONS).size).toBe(LOGISTICS_DESTINATIONS.length);
  });
});

describe('buildShippingLine (pure time-only formatter)', () => {
  it('formats a calendar-day band, no price', () => {
    expect(buildShippingLine('France', { min: 11, max: 19 })).toBe('Delivery to France: estimated 11-19 days.');
  });
  it('collapses a point band to a single number', () => {
    expect(buildShippingLine('the UK', { min: 7, max: 7 })).toBe('Delivery to the UK: estimated 7 days.');
  });
  it('returns null on a null band (caller keeps the safe hedge)', () => {
    expect(buildShippingLine('France', null)).toBeNull();
  });
});
