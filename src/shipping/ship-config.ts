import type { Fulfil } from '../types';
import { LOGISTICS_DESTINATIONS } from '../inbox/freight';

export interface ShipConfig { fx: number; handlingGbp: number; servedCountries: string[] }
export const DEFAULT_SHIP_FX = 0.82;

function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Resolve shipping cost knobs with PER-FIELD defaults (never NaN, never an empty served
 *  list). servedCountries defaults to LOGISTICS_DESTINATIONS so the profile sync only offers
 *  destinations the CJ logistics sync actually populates. */
export function resolveShipConfig(fulfil: Pick<Fulfil, 'shipFx' | 'shipHandlingGbp' | 'servedCountries'> | undefined | null): ShipConfig {
  const f = fulfil ?? {};
  const served = Array.isArray(f.servedCountries) && f.servedCountries.length ? f.servedCountries : LOGISTICS_DESTINATIONS;
  return {
    fx: numOr(f.shipFx, DEFAULT_SHIP_FX),
    handlingGbp: numOr(f.shipHandlingGbp, 0),
    servedCountries: served,
  };
}
