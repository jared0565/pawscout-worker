import { describe, it, expect, vi } from 'vitest';
import { ghostCardClearsFloor } from '../src/proxy/search';
import { DEFAULT_PROFIT, DEFAULT_PRICING } from '../src/types';
import type { TenantConfig } from '../src/types';

function cfg(over: Partial<typeof DEFAULT_PROFIT> = {}): TenantConfig {
  return {
    pricing: { ...DEFAULT_PRICING },
    profit: { ...DEFAULT_PROFIT, enabled: true, ...over },
  } as unknown as TenantConfig;
}

// WHICH CARDS ACTUALLY FAIL, measured against the real defaults rather than
// assumed. Under DEFAULT_PRICING (multiplier 2.5, minMarginGbp 6) and
// DEFAULT_PROFIT (adShareOfRevenue 0.33, VAT 0.20), net works out at roughly
// -0.04 x landed cost once the multiplier rather than the minimum margin is
// binding. So EXPENSIVE items fail and cheap ones pass - the minMarginGbp 6
// floor hands a 50 cent product a fat relative margin, while a 33% ad share
// eats a 2.5x multiplier outright at the top end. The intuitive guess (cheap
// junk fails) is wrong here, which is exactly why these cases are pinned.

describe('ghostCardClearsFloor', () => {
  it('keeps a cheap card, which minMarginGbp lifts to a healthy margin', () => {
    expect(ghostCardClearsFloor({ sellPriceUsd: 0.5 }, cfg(), 0)).toBe(true);
  });

  it('DROPS an expensive card whose multiplier cannot carry a 33% ad share', () => {
    expect(ghostCardClearsFloor({ sellPriceUsd: 100 }, cfg(), 0)).toBe(false);
  });

  it('passes the same expensive card when the profit gate is disabled', () => {
    // Same card as above - proves the switch, not the maths.
    expect(ghostCardClearsFloor({ sellPriceUsd: 100 }, cfg({ enabled: false }), 0)).toBe(true);
  });

  it('a lower ad share rescues the expensive card (the floor is the lever)', () => {
    // The owner's live config runs a far lower ad share than the default; this
    // pins that the gate tracks the config rather than a hardcoded verdict.
    expect(ghostCardClearsFloor({ sellPriceUsd: 100 }, cfg({ adShareOfRevenue: 0.10 }), 0)).toBe(true);
  });

  it('fails OPEN on an unusable price rather than hiding the card', () => {
    // productNetAfterAds returns null with no usable price. Absence of data is
    // not a profitability failure - the same fail-open stance as the import gate.
    expect(ghostCardClearsFloor({ sellPriceUsd: 0 }, cfg(), 0)).toBe(true);
  });

  it('makes ZERO network calls - it runs on a live shopper request', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    ghostCardClearsFloor({ sellPriceUsd: 30 }, cfg(), 2);
    ghostCardClearsFloor({ sellPriceUsd: 100 }, cfg(), 0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is synchronous - an async gate here would add latency per card', () => {
    expect(ghostCardClearsFloor({ sellPriceUsd: 30 }, cfg(), 2)).not.toBeInstanceOf(Promise);
  });
});
