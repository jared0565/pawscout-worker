import { describe, it, expect } from 'vitest';
import {
  EVENT_TEMPLATES, templateByKey, templateByCode, easterSunday, firstMonday, lastMonday,
  fourthThursdayOfNovember, reservedWindowClash, renderHeadline
} from '../src/event-catalogue';

const NOW = Date.parse('2026-07-06T12:00:00Z');

describe('date arithmetic', () => {
  it('computes Easter correctly (movable feast)', () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });   // 5 April 2026
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });  // 28 March 2027
    expect(easterSunday(2025)).toEqual({ month: 4, day: 20 });  // 20 April 2025
  });
  it('computes the Monday anchors for 2026', () => {
    expect(firstMonday(2026, 5)).toBe(4);               // Early May: Mon 4 May
    expect(lastMonday(2026, 5)).toBe(25);               // Spring: Mon 25 May
    expect(lastMonday(2026, 8)).toBe(31);               // Summer: Mon 31 Aug
    expect(fourthThursdayOfNovember(2026)).toBe(26);    // Black Friday = 27 Nov
  });
});

describe('templates and windows', () => {
  it('every template computes a future-ending next window with start before end', () => {
    for (const t of EVENT_TEMPLATES) {
      const w = t.nextWindow(NOW);
      expect(Date.parse(w.endsAt), t.key).toBeGreaterThan(NOW);
      expect(Date.parse(w.startsAt), t.key).toBeLessThan(Date.parse(w.endsAt));
    }
  });
  it('the Summer bank holiday 2026 window is Friday 28 to Monday 31 August', () => {
    const w = templateByKey('summer-bank-holiday')!.nextWindow(NOW);
    expect(w.startsAt).toBe('2026-08-28T00:00:00.000Z');
    expect(w.endsAt).toBe('2026-08-31T23:59:59.000Z');
  });
  it('the Easter 2026 window is Good Friday 3 to Easter Monday 6 April (already past at NOW: rolls to 2027)', () => {
    const t = templateByKey('easter-weekend')!;
    const w2026 = t.nextWindow(Date.parse('2026-03-01T00:00:00Z'));
    expect(w2026.startsAt).toBe('2026-04-03T00:00:00.000Z');
    expect(w2026.endsAt).toBe('2026-04-06T23:59:59.000Z');
    const rolled = t.nextWindow(NOW); // July: Easter 2026 is over
    expect(rolled.startsAt.slice(0, 4)).toBe('2027');
  });
  it('rolls an event to next year the moment this year\'s occurrence ends (evergreen)', () => {
    const t = templateByKey('summer-bank-holiday')!;
    const after = t.nextWindow(Date.parse('2026-09-01T00:00:00Z'));
    expect(after.startsAt.slice(0, 4)).toBe('2027');
    expect(Date.parse(after.startsAt)).toBeLessThan(Date.parse(after.endsAt));
  });
  it('looks up templates by key and by code', () => {
    expect(templateByKey('black-friday')!.code).toBe('BLACKFRIDAY');
    expect(templateByCode('summersale')!.key).toBe('summer-bank-holiday');
    expect(templateByCode('WELCOME10')).toBeNull();
  });
  it('interpolates the live percentage into the headline', () => {
    const t = templateByKey('summer-bank-holiday')!;
    expect(renderHeadline(t, 12)).toBe('12% off everything for the Summer bank holiday');
    expect(renderHeadline(t, null)).toContain('15%'); // falls back to the template default
  });
});

describe('reserved windows', () => {
  it('refuses custom dates on a bank-holiday window, enabled or not', () => {
    const clash = reservedWindowClash('2026-08-29T00:00:00Z', '2026-08-30T23:59:59Z');
    expect(clash?.template.key).toBe('summer-bank-holiday');
  });
  it('allows custom dates outside every reserved window', () => {
    expect(reservedWindowClash('2026-08-10T00:00:00Z', '2026-08-12T23:59:59Z')).toBeNull();
  });
  it('reserves next year\'s windows too', () => {
    const clash = reservedWindowClash('2027-12-27T00:00:00Z', '2027-12-28T23:59:59Z');
    expect(clash?.template.key).toBe('boxing-day-sale');
  });
});
