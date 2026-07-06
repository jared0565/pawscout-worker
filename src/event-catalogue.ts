// The recurring events catalogue (2026-07-06, owner design): every UK retail
// moment pre-built with its design and wording, dated by ARITHMETIC rather
// than by anyone remembering. Bank holiday dates are computable (Easter by
// algorithm, the rest are fixed days or nth-Mondays), so each template can
// always say when its next occurrence runs. The owner enables a template once
// and the nightly rotation keeps it scheduled year after year; the dates here
// are never stored anywhere - the Shopify discount created from them remains
// the only record of a live occurrence.
//
// Copy rules (house style): real end dates only, no invented scarcity, no
// dashes, chips only for categories the store actually stocks, and headlines
// carry a {pct} placeholder interpolated from the LIVE discount percentage so
// an owner-edited percentage can never disagree with the storefront.

export interface EventWindow {
  startsAt: string; // ISO instant, 00:00:00Z on the first day
  endsAt: string;   // ISO instant, 23:59:59Z on the last day
}

export interface EventTemplate {
  key: string;          // stable slug, e.g. 'summer-bank-holiday'
  name: string;         // card title
  code: string;         // the discount code, stable across years (no pct digits - pct is editable)
  defaultPct: number;
  headline: string;     // modal headline; {pct} interpolates from the live discount
  subline: string;      // modal supporting line
  chips: string[];      // seasonal search shortcuts - real stocked categories only
  /** First occurrence window whose END is still in the future at `nowMs`. */
  nextWindow(nowMs: number): EventWindow;
  /** All occurrence windows intersecting [fromMs, toMs] - reserved-date checks. */
  windowsInRange(fromMs: number, toMs: number): EventWindow[];
}

const DAY = 86_400_000;

function iso(y: number, m: number, d: number, end = false): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}T${end ? '23:59:59.000' : '00:00:00.000'}Z`;
}

/** Anonymous Gregorian algorithm: Easter Sunday for a year (month 1-12, day). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** UTC day-of-week (0=Sunday) for a calendar date. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Date of the last Monday of a month. */
export function lastMonday(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const w = dow(year, month, lastDay);
  return lastDay - ((w + 6) % 7);
}

/** Date of the first Monday of a month. */
export function firstMonday(year: number, month: number): number {
  const w = dow(year, month, 1);
  return 1 + ((8 - w) % 7);
}

/** Fourth Thursday of November (US Thanksgiving) - Black Friday is the day after. */
export function fourthThursdayOfNovember(year: number): number {
  const w = dow(year, 11, 1);
  return 1 + ((11 - w) % 7) + 21;
}

/** Shift a UTC calendar date by whole days, returning {y,m,d}. */
function shiftDate(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = Date.UTC(y, m - 1, d) + days * DAY;
  const nd = new Date(t);
  return { y: nd.getUTCFullYear(), m: nd.getUTCMonth() + 1, d: nd.getUTCDate() };
}

/** Window helper: from a holiday Monday (or last day), run Friday-before to that day. */
function longWeekend(y: number, m: number, monday: number): EventWindow {
  const fri = shiftDate(y, m, monday, -3);
  return { startsAt: iso(fri.y, fri.m, fri.d), endsAt: iso(y, m, monday, true) };
}

type WindowForYear = (year: number) => EventWindow;

function makeTemplate(t: Omit<EventTemplate, 'nextWindow' | 'windowsInRange'> & { windowForYear: WindowForYear }): EventTemplate {
  const { windowForYear, ...rest } = t;
  return {
    ...rest,
    nextWindow(nowMs: number): EventWindow {
      const y = new Date(nowMs).getUTCFullYear();
      for (const year of [y - 1, y, y + 1]) {
        const w = windowForYear(year);
        if (Date.parse(w.endsAt) > nowMs) return w;
      }
      return windowForYear(y + 1); // unreachable in practice
    },
    windowsInRange(fromMs: number, toMs: number): EventWindow[] {
      const out: EventWindow[] = [];
      const y0 = new Date(fromMs).getUTCFullYear() - 1;
      const y1 = new Date(toMs).getUTCFullYear() + 1;
      for (let year = y0; year <= y1; year++) {
        const w = windowForYear(year);
        if (Date.parse(w.startsAt) < toMs && Date.parse(w.endsAt) > fromMs) out.push(w);
      }
      return out;
    }
  };
}

export const EVENT_TEMPLATES: EventTemplate[] = [
  makeTemplate({
    key: 'new-year-sale', name: 'New Year sale', code: 'NEWYEAR', defaultPct: 10,
    headline: '{pct}% off everything in the New Year sale',
    subline: 'Start the year with the whole store on offer.',
    chips: ['Dog beds', 'Cat trees', 'Grooming', 'Litter boxes'],
    windowForYear: (y) => ({ startsAt: iso(y, 1, 1), endsAt: iso(y, 1, 4, true) })
  }),
  makeTemplate({
    key: 'easter-weekend', name: 'Easter weekend', code: 'EASTER', defaultPct: 10,
    headline: '{pct}% off everything this Easter weekend',
    subline: 'Good Friday to Easter Monday, across the whole store.',
    chips: ['Dog toys', 'Cat toys', 'Treat toys', 'Grooming'],
    windowForYear: (y) => {
      const e = easterSunday(y);
      const goodFriday = shiftDate(y, e.month, e.day, -2);
      const easterMonday = shiftDate(y, e.month, e.day, 1);
      return { startsAt: iso(goodFriday.y, goodFriday.m, goodFriday.d), endsAt: iso(easterMonday.y, easterMonday.m, easterMonday.d, true) };
    }
  }),
  makeTemplate({
    key: 'early-may-bank-holiday', name: 'Early May bank holiday', code: 'MAYDAY', defaultPct: 10,
    headline: '{pct}% off everything this bank holiday weekend',
    subline: 'Long weekend savings across the whole store.',
    chips: ['Dog toys', 'Cat trees', 'Grooming', 'Pet health'],
    windowForYear: (y) => longWeekend(y, 5, firstMonday(y, 5))
  }),
  makeTemplate({
    key: 'spring-bank-holiday', name: 'Spring bank holiday', code: 'SPRINGSALE', defaultPct: 10,
    headline: '{pct}% off everything this bank holiday weekend',
    subline: 'Long weekend savings across the whole store.',
    chips: ['Cooling mats', 'Dog toys', 'Grooming', 'Cat trees'],
    windowForYear: (y) => longWeekend(y, 5, lastMonday(y, 5))
  }),
  makeTemplate({
    key: 'summer-bank-holiday', name: 'Summer bank holiday', code: 'SUMMERSALE', defaultPct: 15,
    headline: '{pct}% off everything for the Summer bank holiday',
    subline: 'The long weekend deal: every product in the store.',
    chips: ['Cooling mats', 'Dog toys', 'Cat trees', 'Litter boxes'],
    windowForYear: (y) => longWeekend(y, 8, lastMonday(y, 8))
  }),
  makeTemplate({
    key: 'black-friday', name: 'Black Friday to Cyber Monday', code: 'BLACKFRIDAY', defaultPct: 15,
    headline: '{pct}% off everything for Black Friday',
    subline: 'Through to Cyber Monday, across the whole store.',
    chips: ['Cat trees', 'Dog beds', 'Litter boxes', 'Grooming'],
    windowForYear: (y) => {
      const friday = fourthThursdayOfNovember(y) + 1;
      const f = shiftDate(y, 11, friday, 0);
      const cyberMonday = shiftDate(y, 11, friday, 3);
      return { startsAt: iso(f.y, f.m, f.d), endsAt: iso(cyberMonday.y, cyberMonday.m, cyberMonday.d, true) };
    }
  }),
  makeTemplate({
    key: 'boxing-day-sale', name: 'Boxing Day sale', code: 'BOXINGSALE', defaultPct: 20,
    headline: '{pct}% off everything in the Boxing Day sale',
    subline: "The biggest offer of the year, until New Year's Eve.",
    chips: ['Dog beds', 'Cat trees', 'Dog toys', 'Grooming'],
    windowForYear: (y) => ({ startsAt: iso(y, 12, 26), endsAt: iso(y, 12, 31, true) })
  })
];

export function templateByKey(key: string): EventTemplate | null {
  return EVENT_TEMPLATES.find((t) => t.key === key) ?? null;
}

export function templateByCode(code: string): EventTemplate | null {
  const c = code.trim().toUpperCase();
  return EVENT_TEMPLATES.find((t) => t.code === c) ?? null;
}

/** Which template's occurrence window overlaps [startsAt, endsAt]? Reserved
 * dates: bank-holiday windows belong to their pre-built events, whether or not
 * the event is enabled - a custom event can never be allocated onto them. */
export function reservedWindowClash(startsAt: string, endsAt: string): { template: EventTemplate; window: EventWindow } | null {
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  for (const t of EVENT_TEMPLATES) {
    const hit = t.windowsInRange(s, e)[0];
    if (hit) return { template: t, window: hit };
  }
  return null;
}

/** Render a template headline with the live discount percentage. */
export function renderHeadline(template: EventTemplate, pct: number | null): string {
  return template.headline.replace('{pct}', String(pct ?? template.defaultPct));
}
