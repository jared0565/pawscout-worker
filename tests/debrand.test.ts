import { describe, it, expect } from 'vitest';
import { debrandTitle, debrandText, BRAND_TOKENS } from '../src/debrand';

describe('debrandTitle', () => {
  // The exact 9 live titles that carried the PawHut brand (scanned 2026-07-08).
  const cases: [string, string][] = [
    ['PawHut Stainless Steel Cat Litter Tray, Extra Large Enclosed', 'Stainless Steel Cat Litter Tray, Extra Large Enclosed'],
    ['PawHut Hooded Cat Litter Box with Flap Door & Filter', 'Hooded Cat Litter Box with Flap Door & Filter'],
    ['PawHut Hooded Cat Litter Box with Filter and Scoop', 'Hooded Cat Litter Box with Filter and Scoop'],
    ['PawHut XXL Stainless Steel Cat Litter Box with High Sides', 'XXL Stainless Steel Cat Litter Box with High Sides'],
    ['PawHut Stainless Steel Cat Litter Box with Lid & Scoop', 'Stainless Steel Cat Litter Box with Lid & Scoop'],
    ['PawHut Panda XL Stainless Steel Enclosed Cat Litter Box', 'Panda XL Stainless Steel Enclosed Cat Litter Box'],
    ['PawHut XL Stainless Steel Cat Litter Box with High Sides', 'XL Stainless Steel Cat Litter Box with High Sides'],
    ['PawHut 63cm Cat Scratching Post with Sisal Rope', '63cm Cat Scratching Post with Sisal Rope'],
    ['PawHut 88cm Cat Tree with Sisal Scratching Post and Hanging Toys', '88cm Cat Tree with Sisal Scratching Post and Hanging Toys']
  ];
  it('strips the PawHut prefix from every real branded title', () => {
    for (const [input, expected] of cases) expect(debrandTitle(input)).toBe(expected);
  });
  it('leaves un-branded titles untouched', () => {
    const clean = 'Hooded Cat Litter Tray with Scoop and Deodorants';
    expect(debrandTitle(clean)).toBe(clean);
  });
  it('is case-insensitive for titles (any casing of the brand goes)', () => {
    expect(debrandTitle('PAWHUT Litter Box')).toBe('Litter Box');
    expect(debrandTitle('pawhut cat tree')).toBe('cat tree');
  });
  it('strips a brand appearing mid-title as a whole word', () => {
    expect(debrandTitle('New PawHut Deluxe Bed')).toBe('New Deluxe Bed');
  });
  it('never returns an empty title (brand-only falls back to original)', () => {
    expect(debrandTitle('PawHut')).toBe('PawHut');
  });
  it('does not strip a brand fragment inside another word', () => {
    expect(debrandTitle('Pawhutch Rabbit Home')).toBe('Pawhutch Rabbit Home');
  });
});

describe('debrandText (HTML-safe, case-sensitive)', () => {
  it('de-brands the visible link text but never the lowercase handle in the href', () => {
    const input = '<p>Try the <a href="/products/pawhut-stainless-steel-cat-litter-tray-extra-large-enclosed">PawHut Stainless Steel Cat Litter Tray in Extra Large Enclosed</a> today.</p>';
    const expected = '<p>Try the <a href="/products/pawhut-stainless-steel-cat-litter-tray-extra-large-enclosed">Stainless Steel Cat Litter Tray in Extra Large Enclosed</a> today.</p>';
    const out = debrandText(input);
    expect(out).toBe(expected);
    // the handle (and therefore the link) is preserved exactly
    expect(out).toContain('/products/pawhut-stainless-steel-cat-litter-tray-extra-large-enclosed');
    expect(out).not.toContain('>PawHut ');
  });
  it('is a no-op when the body has no proper-case brand', () => {
    const body = '<p>A clean article about litter boxes and pawhut-style trays.</p>';
    expect(debrandText(body)).toBe(body);
  });
  it('is idempotent', () => {
    const input = '<a href="/products/pawhut-x">PawHut X</a>';
    const once = debrandText(input);
    expect(debrandText(once)).toBe(once);
  });
});

describe('BRAND_TOKENS', () => {
  it('contains PawHut', () => {
    expect(BRAND_TOKENS).toContain('PawHut');
  });
});
