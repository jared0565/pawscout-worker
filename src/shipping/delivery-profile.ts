// src/shipping/delivery-profile.ts
//
// Origin-aware shipping cost, Phase 1: read the live Shopify delivery config so the
// worker can build a "GB Local" delivery profile that mirrors the real per-merchant
// zones/rates (read at RUNTIME, never hardcoded from a snapshot). All per-merchant
// values (location-group ids, the EU/World zone country lists + rates to mirror) come
// from readDeliveryConfig; only the API-version-defined GraphQL shape is fixed here.
//
// Defensive by construction: any missing field degrades to '' / [] / false and the
// reader never throws, so a malformed payload yields an empty config (the caller then
// no-ops) rather than a crash.
import type { AdminGraphql } from '../shopify-admin';

export interface DeliveryRate {
  name: string;
  amount: string | null;       // decimal string, e.g. "14.99"; null when no DeliveryRateDefinition price
  currencyCode: string | null; // e.g. "GBP"
}

export interface DeliveryZone {
  id: string;
  name: string;
  countryCodes: string[]; // ISO-2 codes the zone covers (empty for a Rest-of-World zone)
  restOfWorld: boolean;   // true when the zone is the catch-all "Rest of World"
  rates: DeliveryRate[];  // the zone's flat method rates
}

export interface DeliveryLocationGroup {
  id: string;
  locationIds: string[];
  zones: DeliveryZone[];
}

export interface DeliveryLocationInfo {
  id: string;
  name: string;
  country: string;            // human-readable, e.g. "United Kingdom"
  countryCode: string | null; // ISO-2, e.g. "GB"
}

export interface DeliveryConfig {
  defaultProfileId: string;            // the profile flagged default:true ('' when none)
  locationGroups: DeliveryLocationGroup[];
  locations: DeliveryLocationInfo[];   // flattened across the default profile's groups
  ukZonePresent: boolean;              // a zone in the default profile covers GB
}

const DELIVERY_CONFIG_QUERY = `{
  deliveryProfiles(first: 10) {
    edges {
      node {
        id
        name
        default
        profileLocationGroups {
          locationGroup {
            id
            locations(first: 50) { nodes { id name address { country countryCode } } }
          }
          locationGroupZones(first: 50) {
            edges {
              node {
                zone { id name countries { code { countryCode restOfWorld } } }
                methodDefinitions(first: 10) {
                  edges { node { name rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } } } }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Read the live delivery config for the default profile: its location groups (with
 * their location ids) and each group's zones (country coverage + flat rates). The GB
 * Local profile (Task 4) mirrors the EU/World zones read here, and assigns GB products
 * to the gbLocationGroupId resolved from these groups (Task 5).
 */
export async function readDeliveryConfig(admin: AdminGraphql): Promise<DeliveryConfig> {
  const root = (await admin(DELIVERY_CONFIG_QUERY)) as any;
  const edges = (root?.deliveryProfiles?.edges ?? []) as any[];
  const nodes = edges.map((e) => e?.node).filter(Boolean);
  const def = nodes.find((n) => n?.default === true) ?? null;

  const locationGroups: DeliveryLocationGroup[] = [];
  const locations: DeliveryLocationInfo[] = [];

  for (const plg of (def?.profileLocationGroups ?? []) as any[]) {
    const lg = plg?.locationGroup;
    if (!lg?.id) continue;

    const locationIds: string[] = [];
    for (const ln of (lg.locations?.nodes ?? []) as any[]) {
      if (!ln?.id) continue;
      locationIds.push(ln.id);
      locations.push({
        id: ln.id,
        name: String(ln.name ?? ''),
        country: String(ln.address?.country ?? ''),
        countryCode: ln.address?.countryCode ?? null,
      });
    }

    const zones: DeliveryZone[] = [];
    for (const ze of (plg?.locationGroupZones?.edges ?? []) as any[]) {
      const z = ze?.node?.zone;
      if (!z?.id) continue;
      const countryCodes: string[] = [];
      let restOfWorld = false;
      for (const c of (z.countries ?? []) as any[]) {
        const code = c?.code;
        if (code?.restOfWorld === true) restOfWorld = true;
        else if (code?.countryCode) countryCodes.push(code.countryCode);
      }
      const rates: DeliveryRate[] = [];
      for (const me of (ze?.node?.methodDefinitions?.edges ?? []) as any[]) {
        const m = me?.node;
        if (!m) continue;
        const price = m.rateProvider?.price;
        rates.push({ name: String(m.name ?? ''), amount: price?.amount ?? null, currencyCode: price?.currencyCode ?? null });
      }
      zones.push({ id: z.id, name: String(z.name ?? ''), countryCodes, restOfWorld, rates });
    }

    locationGroups.push({ id: lg.id, locationIds, zones });
  }

  const ukZonePresent = locationGroups.some((g) => g.zones.some((z) => z.countryCodes.includes('GB')));

  return { defaultProfileId: String(def?.id ?? ''), locationGroups, locations, ukZonePresent };
}

export const GB_LOCAL_PROFILE_NAME = 'GB Local';

const PROFILES_BY_NAME_QUERY = `{ deliveryProfiles(first: 30) { edges { node { id name } } } }`;

const CREATE_PROFILE_MUTATION = `mutation pawscoutCreateDeliveryProfile($profile: DeliveryProfileInput!) {
  deliveryProfileCreate(profile: $profile) {
    profile { id name }
    userErrors { field message }
  }
}`;

/** A zone's flat rates mapped to methodDefinitionsToCreate input (DeliveryRateDefinitionInput). */
function ratesToMethodInput(rates: DeliveryRate[]): unknown[] {
  const list = rates.length ? rates : [{ name: 'Standard', amount: '0.00', currencyCode: 'GBP' }];
  return list.map((r) => ({
    name: r.name || 'Standard',
    rateDefinition: { price: { amount: r.amount ?? '0.00', currencyCode: r.currencyCode ?? 'GBP' } },
  }));
}

/** A mirrored zone -> DeliveryLocationGroupZoneInput (countries list of {code} or [{restOfWorld:true}]). */
function zoneToInput(zone: DeliveryZone): unknown {
  const countries = zone.restOfWorld ? [{ restOfWorld: true }] : zone.countryCodes.map((c) => ({ code: c }));
  return { name: zone.name, countries, methodDefinitionsToCreate: ratesToMethodInput(zone.rates) };
}

/**
 * Idempotently ensure a "GB Local" delivery profile exists: free UK shipping (ukRateAmount,
 * default "0.00") with the merchant's EU/World zones MIRRORED from the live default profile
 * (passed in as mirrorZones, so rates are never hardcoded). Returns the existing profile if
 * already present (created:false), else creates it (created:true). Throws on userErrors.
 *
 * The UK zone is replaced with the free rate; mirrorZones should be the default profile's
 * NON-UK zones (the caller filters out the GB-covering zone).
 */
export async function ensureGbLocalProfile(
  admin: AdminGraphql,
  opts: { locationIds: string[]; ukRateAmount: string; mirrorZones: DeliveryZone[] }
): Promise<{ profileId: string; created: boolean }> {
  const existing = (await admin(PROFILES_BY_NAME_QUERY)) as any;
  const found = ((existing?.deliveryProfiles?.edges ?? []) as any[])
    .map((e) => e?.node)
    .find((n) => n?.name === GB_LOCAL_PROFILE_NAME);
  if (found?.id) return { profileId: found.id, created: false };

  const ukZone = {
    name: 'United Kingdom',
    countries: [{ code: 'GB' }],
    methodDefinitionsToCreate: [{ name: 'Standard', rateDefinition: { price: { amount: opts.ukRateAmount, currencyCode: 'GBP' } } }],
  };
  const profile = {
    name: GB_LOCAL_PROFILE_NAME,
    locationGroupsToCreate: [{
      locationsToAdd: opts.locationIds,
      zonesToCreate: [ukZone, ...opts.mirrorZones.map(zoneToInput)],
    }],
  };

  const res = (await admin(CREATE_PROFILE_MUTATION, { profile })) as any;
  const payload = res?.deliveryProfileCreate;
  const errs = (payload?.userErrors ?? []) as { message?: string }[];
  if (errs.length) throw new Error(`deliveryProfileCreate failed: ${errs.map((e) => e.message).join('; ')}`);
  const id = payload?.profile?.id;
  if (!id) throw new Error('deliveryProfileCreate returned no profile id');
  return { profileId: id, created: true };
}
