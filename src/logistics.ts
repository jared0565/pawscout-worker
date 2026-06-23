import { DEFAULT_LOGISTICS, type LogisticsConfig, type Fulfil } from './types';

/**
 * Synced CJ delivery-TIME matrix - pure helpers (no I/O).
 *
 * CJ logisticAging is TRANSIT-only (dispatch->door), a CALENDAR-day range, and
 * route/channel-driven (weight-independent). The customer-facing ORDER->DOOR band
 * = processing + transit + customs (cross-border) + slack, ALL CALENDAR days.
 *
 * GOVERNING RULE: only surface what is real and defensible. Anything unknown
 * (missing/stale row, unparseable aging) degrades to null => caller hedges; this
 * module never throws and never emits NaN.
 *
 * Spec: docs/superpowers/specs/2026-06-21-cj-logistics-store-design.md
 */

export interface DayRange { min: number; max: number }

/** One row of the cj_logistics matrix as the accessor returns it. */
export interface LogisticsRoute {
  from_country: string;
  to_country: string;
  channel: string;
  transit_min: number | null;
  transit_max: number | null;
  aging_raw: string;
  synced_at: string;
}

/**
 * Parse a CJ logisticAging string into a CALENDAR-day {min,max}. Handles "4-9",
 * "8~12 days", en/em dashes, a bare "10" (min==max), and surrounding text. Returns
 * null on anything unexpected (claim-safe: a novel format degrades to the hedge,
 * never a wrong number). Mirrors freight.ts sanitizeDays but yields a range.
 */
export function parseDaysRange(raw: string | null | undefined): DayRange | null {
  const m = String(raw ?? '').replace(/[~\u2013\u2014]/g, '-').match(/(\d{1,3})\s*(?:-\s*(\d{1,3}))?/);
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] != null ? Number(m[2]) : min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return null;
  return { min, max };
}

/** Coerce a number-or-default with a finite guard (defeats the shallow-merge NaN). */
function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Resolve the logistics policy knobs with PER-FIELD defaults. getConfig shallow-
 * merges the `fulfil` JSON one level deep, so a stored partial `logistics` object
 * would otherwise drop sibling defaults => NaN. This is the single chokepoint that
 * guarantees finite knobs regardless of what's persisted.
 */
export function resolveLogistics(fulfil: Pick<Fulfil, 'logistics'> | undefined | null): LogisticsConfig {
  const l = fulfil?.logistics ?? {};
  return {
    processingDaysMin: numOr(l.processingDaysMin, DEFAULT_LOGISTICS.processingDaysMin),
    processingDaysMax: numOr(l.processingDaysMax, DEFAULT_LOGISTICS.processingDaysMax),
    customsDaysMax: numOr(l.customsDaysMax, DEFAULT_LOGISTICS.customsDaysMax),
    transitSlackDays: numOr(l.transitSlackDays, DEFAULT_LOGISTICS.transitSlackDays),
    stalenessHours: numOr(l.stalenessHours, DEFAULT_LOGISTICS.stalenessHours),
  };
}

/**
 * Customer-facing ORDER->DOOR band (CALENDAR days) from a matrix route + resolved
 * knobs. min = processingMin + transitMin; max = processingMax + transitMax +
 * customs(if cross-border) + slack. Null-guards the route and Number.isFinite-
 * guards the output => returns null (never NaN, never throws) when the route is
 * missing or has no parsed transit. Conservative by construction (the owner chose
 * the "never under-promise" envelope); see the units guard test.
 */
export function doorToDoorBand(route: LogisticsRoute | null | undefined, l: LogisticsConfig): DayRange | null {
  if (!route) return null;
  const { transit_min: tmin, transit_max: tmax } = route;
  if (tmin == null || tmax == null || !Number.isFinite(tmin) || !Number.isFinite(tmax)) return null;
  const customs = route.from_country !== route.to_country ? l.customsDaysMax : 0;
  const min = l.processingDaysMin + tmin;
  const max = l.processingDaysMax + tmax + customs + l.transitSlackDays;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return null;
  return { min, max };
}

/** Format a band for customer-facing copy, e.g. {min:6,max:21} -> "6-21". Empty on null. */
export function formatBand(band: DayRange | null): string {
  if (!band) return '';
  return band.min === band.max ? `${band.min}` : `${band.min}-${band.max}`;
}

/**
 * Door-to-door band straight from a CJ freight quote's aging string - for the
 * PER-PRODUCT "actual" estimate (quote the product's own variant). Null on an
 * unparseable aging => caller omits the figure. Same conservative model as the
 * matrix path (parse -> doorToDoorBand).
 */
export function bandFromQuote(aging: string | null | undefined, from: string, to: string, l: LogisticsConfig): DayRange | null {
  const r = parseDaysRange(aging);
  if (!r) return null;
  return doorToDoorBand({ from_country: from, to_country: to, transit_min: r.min, transit_max: r.max, channel: '', aging_raw: aging ?? '', synced_at: '' }, l);
}
