// tests/shipping/nearest-route.test.ts
import { test, expect } from 'vitest';
import { resolveNearestRoute } from '../../src/shipping/nearest-route';
import type { LogisticsRoute } from '../../src/logistics';

const row = (from: string, to: string, freight: number | null, tmin = 5, tmax = 9): LogisticsRoute => ({
  from_country: from, to_country: to, channel: '', transit_min: tmin, transit_max: tmax,
  aging_raw: `${tmin}-${tmax}`, freight_cost_usd: freight, synced_at: '2026-06-26T00:00:00Z',
});

test('empty candidates -> not fulfillable', () => {
  expect(resolveNearestRoute([])).toEqual({ fulfillable: false });
});

test('domestic route wins over a cheaper-looking cross-border row', () => {
  const r = resolveNearestRoute([row('CN', 'US', 8.0), row('US', 'US', 0)]);
  expect(r).toMatchObject({ fulfillable: true, nearest: { origin: 'US' } });
});

test('domestic wins even when its freight is unsynced (null)', () => {
  const r = resolveNearestRoute([row('CN', 'GB', 8.99), row('GB', 'GB', null)]);
  expect(r).toMatchObject({ fulfillable: true, nearest: { origin: 'GB' } });
});

test('cross-border only -> cheapest, tie-break shortest transit', () => {
  const r = resolveNearestRoute([row('CN', 'DE', 9.83, 8, 12), row('CN', 'DE', 9.83, 6, 10)]);
  expect(r).toMatchObject({ fulfillable: true, nearest: { origin: 'CN', route: { transit_min: 6 } } });
});
