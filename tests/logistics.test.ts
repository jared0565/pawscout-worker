import { describe, it, expect } from 'vitest';
import { parseDaysRange, resolveLogistics, doorToDoorBand, formatBand, type LogisticsRoute } from '../src/logistics';
import { DEFAULT_LOGISTICS } from '../src/types';

const route = (over: Partial<LogisticsRoute> = {}): LogisticsRoute => ({
  from_country: 'CN', to_country: 'GB', channel: 'CJPacket Ordinary',
  transit_min: 4, transit_max: 9, aging_raw: '4-9', synced_at: '2026-06-21T00:00:00.000Z', ...over,
});

describe('parseDaysRange', () => {
  it('parses a hyphen range', () => expect(parseDaysRange('4-9')).toEqual({ min: 4, max: 9 }));
  it('parses with text and tilde', () => expect(parseDaysRange('8~12 days')).toEqual({ min: 8, max: 12 }));
  it('parses en/em dashes', () => {
    expect(parseDaysRange('8–12')).toEqual({ min: 8, max: 12 });
    expect(parseDaysRange('10—18')).toEqual({ min: 10, max: 18 });
  });
  it('parses a bare single number as min==max', () => expect(parseDaysRange('10')).toEqual({ min: 10, max: 10 }));
  it('returns null on junk / empty / null', () => {
    for (const v of ['', '   ', 'soon', null, undefined]) expect(parseDaysRange(v as string)).toBeNull();
  });
  it('returns null when max < min (malformed)', () => expect(parseDaysRange('9-4')).toBeNull());
});

describe('resolveLogistics', () => {
  it('fills all defaults from empty/undefined', () => {
    expect(resolveLogistics(undefined)).toEqual(DEFAULT_LOGISTICS);
    expect(resolveLogistics({ logistics: {} })).toEqual(DEFAULT_LOGISTICS);
  });
  it('overrides only the provided field, keeping sibling defaults (shallow-merge hazard)', () => {
    const r = resolveLogistics({ logistics: { processingDaysMax: 7 } });
    expect(r.processingDaysMax).toBe(7);
    expect(r.processingDaysMin).toBe(DEFAULT_LOGISTICS.processingDaysMin);
    expect(r.customsDaysMax).toBe(DEFAULT_LOGISTICS.customsDaysMax);
    expect(r.stalenessHours).toBe(DEFAULT_LOGISTICS.stalenessHours);
  });
  it('coerces non-finite/garbage fields back to defaults (no NaN)', () => {
    const r = resolveLogistics({ logistics: { processingDaysMin: NaN as unknown as number, customsDaysMax: 'x' as unknown as number } });
    expect(r.processingDaysMin).toBe(DEFAULT_LOGISTICS.processingDaysMin);
    expect(r.customsDaysMax).toBe(DEFAULT_LOGISTICS.customsDaysMax);
    expect(Object.values(r).every(Number.isFinite)).toBe(true);
  });
});

describe('doorToDoorBand', () => {
  const L = DEFAULT_LOGISTICS;
  it('adds processing + transit + customs (cross-border) + slack', () => {
    // CN->GB transit 4-9: min = 2+4 = 6; max = 5+9+5+2 = 21
    expect(doorToDoorBand(route(), L)).toEqual({ min: 6, max: 21 });
  });
  it('omits customs on a same-country route (from === to)', () => {
    // GB->GB transit 2-4: min = 2+2 = 4; max = 5+4+0+2 = 11
    expect(doorToDoorBand(route({ from_country: 'GB', to_country: 'GB', transit_min: 2, transit_max: 4 }), L)).toEqual({ min: 4, max: 11 });
  });
  it('returns null on missing route or unparsed transit (=> caller hedges)', () => {
    expect(doorToDoorBand(null, L)).toBeNull();
    expect(doorToDoorBand(undefined, L)).toBeNull();
    expect(doorToDoorBand(route({ transit_min: null, transit_max: null }), L)).toBeNull();
  });
  it('never returns NaN even if knobs were somehow non-finite (guarded upstream)', () => {
    const bad = { ...L, processingDaysMax: NaN };
    expect(doorToDoorBand(route(), bad)).toBeNull();
  });

  // THE CORRECTNESS CRUX: switching "working days" -> "calendar days" at the same
  // integer SPEEDS UP the promise ("8-12 working days" ~= 16-17 calendar). The
  // calendar band's UPPER bound must MEET OR EXCEED that legacy wall-clock arrival,
  // or we'd silently under-promise. 12 working days ~= 16-17 calendar; assert >= 16.
  it('GUARD: CN->GB calendar upper bound never under-promises vs legacy "8-12 working days"', () => {
    const LEGACY_WORKING_DAYS_UPPER = 12;
    const legacyCalendarArrival = Math.ceil(LEGACY_WORKING_DAYS_UPPER * 7 / 5); // ~17 calendar days
    const band = doorToDoorBand(route(), L)!; // verified cheapest CN->GB transit 4-9
    expect(band.max).toBeGreaterThanOrEqual(legacyCalendarArrival);
    // lower bound stays honest (>= pure transit min, not fabricated faster)
    expect(band.min).toBeGreaterThanOrEqual(route().transit_min!);
  });
});

describe('formatBand', () => {
  it('formats a range and a point, empty on null', () => {
    expect(formatBand({ min: 6, max: 21 })).toBe('6-21');
    expect(formatBand({ min: 5, max: 5 })).toBe('5');
    expect(formatBand(null)).toBe('');
  });
});
