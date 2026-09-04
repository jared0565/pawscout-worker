import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  validateEventRequest, findOverlappingPromo, buildEventCampaign, publicEventPayload, eventDayLabel
} from '../src/storewide-event';
import type { PromoWindow } from '../src/affiliate-discounts';

const NOW = Date.parse('2026-07-06T12:00:00Z');

// validateEventRequest and buildEventCampaign read Date.now() directly (the
// end-date-in-the-past check and the "from <weekday>" future-start line). The
// fixtures below hardcode a 2026-08-28 event, so once the real clock passed
// that date both tests went red for a calendar reason, not a code one, and the
// aramid pre-push gate blocked every push (2026-09-04). Pin the clock to NOW
// for exactly those two describes; the rest of the file is pure or takes a
// nowMs argument.
function pinClockToNow() {
  beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterAll(() => { vi.useRealTimers(); });
}

function promo(over: Partial<PromoWindow>): PromoWindow {
  return {
    title: 'WELCOME10', kind: 'Basic', source: 'code', percentage: 10, status: 'ACTIVE',
    startsAt: '2026-07-04T00:00:00Z', endsAt: '2026-07-19T23:59:59Z', code: 'WELCOME10', ...over
  };
}

describe('validateEventRequest', () => {
  pinClockToNow();
  it('normalises the code and builds full-day UTC instants', () => {
    const r = validateEventRequest({ code: 'bankhol15', pctOff: 15, startDate: '2026-08-28', endDate: '2026-08-31' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.code).toBe('BANKHOL15');
      expect(r.value.startsAt).toBe('2026-08-28T00:00:00.000Z');
      expect(r.value.endsAt).toBe('2026-08-31T23:59:59.000Z');
    }
  });
  it('rejects bad codes, percentages and date ranges', () => {
    expect(validateEventRequest({ code: 'x', pctOff: 10, startDate: '2026-08-01', endDate: '2026-08-02' }).ok).toBe(false);
    expect(validateEventRequest({ code: 'SALE10', pctOff: 95, startDate: '2026-08-01', endDate: '2026-08-02' }).ok).toBe(false);
    expect(validateEventRequest({ code: 'SALE10', pctOff: 10, startDate: '2026-08-02', endDate: '2026-08-01' }).ok).toBe(false);
    expect(validateEventRequest({ code: 'SALE10', pctOff: 10, startDate: '2026-08-01', endDate: 'nope' }).ok).toBe(false);
    // Entirely in the past: nothing to run.
    expect(validateEventRequest({ code: 'SALE10', pctOff: 10, startDate: '2020-01-01', endDate: '2020-01-02' }).ok).toBe(false);
  });
});

describe('findOverlappingPromo', () => {
  it('blocks a window that intersects a running promotion and allows one after it', () => {
    const promos = [promo({})];
    expect(findOverlappingPromo(promos, '2026-07-10T00:00:00Z', '2026-07-25T23:59:59Z')?.title).toBe('WELCOME10');
    expect(findOverlappingPromo(promos, '2026-07-20T00:00:00Z', '2026-07-25T23:59:59Z')).toBeNull();
  });
  it('treats an open-ended promotion as overlapping everything after its start', () => {
    const promos = [promo({ endsAt: null })];
    expect(findOverlappingPromo(promos, '2027-01-01T00:00:00Z', '2027-01-05T00:00:00Z')?.title).toBe('WELCOME10');
  });
});

describe('buildEventCampaign', () => {
  pinClockToNow();
  it('bakes the real dates and code into the copy (no drift possible)', () => {
    const d = buildEventCampaign({ code: 'BANKHOL15', pctOff: 15, startsAt: '2026-08-28T00:00:00.000Z', endsAt: '2026-08-31T23:59:59.000Z' });
    expect(d.subject).toBe('15% off everything until 31 August');
    expect(d.bodyText).toContain('BANKHOL15');
    expect(d.bodyText).toContain('until Monday 31 August'); // 2026-08-31 is a Monday
    expect(d.bodyText).toContain('from Friday 28 August');  // future start is announced
    expect(d.bodyText).not.toMatch(/[–—]/);       // house style: no dashes
  });
});

describe('publicEventPayload', () => {
  it('advertises the running code event with a plain end label', () => {
    const p = publicEventPayload([promo({})], NOW);
    expect(p).toEqual({ active: true, code: 'WELCOME10', pctOff: 10, endsAt: '2026-07-19T23:59:59Z', endsLabel: '19 July' });
  });
  it('goes inactive when the event has ended - the modal tears itself down', () => {
    expect(publicEventPayload([promo({})], Date.parse('2026-07-20T00:00:01Z')).active).toBe(false);
  });
  it('ignores scheduled events, automatic discounts and code-less rows', () => {
    expect(publicEventPayload([promo({ status: 'SCHEDULED' })], NOW).active).toBe(false);
    expect(publicEventPayload([promo({ source: 'automatic', code: null })], NOW).active).toBe(false);
    expect(publicEventPayload([promo({ code: null })], NOW).active).toBe(false);
  });
  it('picks the biggest percentage when several code events run', () => {
    const p = publicEventPayload([promo({}), promo({ title: 'MEGA20', code: 'MEGA20', percentage: 20 })], NOW);
    expect(p.code).toBe('MEGA20');
  });
  it('catalogue codes carry their pre-written wording, pct interpolated from the LIVE discount', () => {
    const p = publicEventPayload([promo({ title: 'SUMMERSALE', code: 'SUMMERSALE', percentage: 12, startsAt: '2026-07-01T00:00:00Z', endsAt: '2026-07-10T23:59:59Z' })], NOW);
    expect(p.headline).toBe('12% off everything for the Summer bank holiday');
    expect(p.subline).toContain('long weekend');
    expect(p.chips).toContain('Cooling mats');
  });
  it('codes without a template (WELCOME10, customs) carry no wording - the modal keeps its theme copy', () => {
    const p = publicEventPayload([promo({})], NOW);
    expect(p.headline).toBeUndefined();
    expect(p.chips).toBeUndefined();
  });
});

describe('eventDayLabel', () => {
  it('renders weekday day month in UTC', () => {
    expect(eventDayLabel('2026-07-19T23:59:59Z')).toBe('Sunday 19 July');
  });
});
