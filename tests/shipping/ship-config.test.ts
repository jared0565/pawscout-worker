import { test, expect } from 'vitest';
import { resolveShipConfig, DEFAULT_SHIP_FX } from '../../src/shipping/ship-config';
import { LOGISTICS_DESTINATIONS } from '../../src/inbox/freight';

test('defaults when fulfil is absent', () => {
  const c = resolveShipConfig(undefined);
  expect(c.fx).toBe(DEFAULT_SHIP_FX);
  expect(c.handlingGbp).toBe(0);
  expect(c.servedCountries.length).toBeGreaterThan(0);
  expect(c.servedCountries).toContain('GB');
});
test('partial fulfil keeps sibling defaults and is finite', () => {
  const c = resolveShipConfig({ shipFx: 0.9 } as any);
  expect(c.fx).toBe(0.9);
  expect(c.handlingGbp).toBe(0);
  expect(c.servedCountries).toEqual(LOGISTICS_DESTINATIONS);
});
test('non-finite fx falls back to the default (never NaN)', () => {
  const c = resolveShipConfig({ shipFx: Number.NaN } as any);
  expect(c.fx).toBe(DEFAULT_SHIP_FX);
});
test('explicit servedCountries override is respected; empty falls back', () => {
  expect(resolveShipConfig({ servedCountries: ['GB', 'US'] } as any).servedCountries).toEqual(['GB', 'US']);
  expect(resolveShipConfig({ servedCountries: [] } as any).servedCountries).toEqual(LOGISTICS_DESTINATIONS);
});
