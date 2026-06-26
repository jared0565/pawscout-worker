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
import { resolveNearestRoute } from './nearest-route';
import { freightUsdToGbp } from './pricing';
import type { LogisticsRoute } from '../logistics';

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

/** A mirrored zone -> DeliveryLocationGroupZoneInput (countries list of {code} or [{restOfWorld:true}]).
 *  includeAllProvinces:true is required by Shopify for province-bearing countries (GB/US/CA),
 *  else deliveryProfileCreate fails "must have at least one province associated". */
function zoneToInput(zone: DeliveryZone): unknown {
  const countries = zone.restOfWorld ? [{ restOfWorld: true }] : zone.countryCodes.map((c) => ({ code: c, includeAllProvinces: true }));
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
    countries: [{ code: 'GB', includeAllProvinces: true }],
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

const PROFILE_MEMBERS_QUERY = `query pawscoutGbProfileMembers($id: ID!) {
  deliveryProfile(id: $id) {
    profileItems(first: 250) { edges { node { product { id } } } }
  }
}`;

const PRODUCT_VARIANTS_QUERY = `query pawscoutProductVariants($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product { id variants(first: 100) { nodes { id } } }
  }
}`;

const UPDATE_PROFILE_MUTATION = `mutation pawscoutUpdateDeliveryProfile($id: ID!, $profile: DeliveryProfileInput!) {
  deliveryProfileUpdate(id: $id, profile: $profile) {
    profile { id }
    userErrors { field message }
  }
}`;

/** Resolve all Shopify variant ids for the given product ids (batched; nodes(ids) is capped). */
async function resolveVariantIds(admin: AdminGraphql, productIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < productIds.length; i += 50) {
    const chunk = productIds.slice(i, i + 50);
    const res = (await admin(PRODUCT_VARIANTS_QUERY, { ids: chunk })) as any;
    for (const n of (res?.nodes ?? []) as any[]) {
      for (const v of (n?.variants?.nodes ?? []) as any[]) if (v?.id) out.push(v.id);
    }
  }
  return out;
}

/** Zones in each location group that do NOT cover GB (EU, International, Rest-of-World).
 *  A zone covers GB iff its countryCodes include 'GB'. restOfWorld zones never cover GB
 *  specifically, so they are deletion candidates for a UK-only profile. Groups with no
 *  deletable zone are omitted (so the result is empty when already UK-only). */
export function computeNonUkZoneIds(
  groups: { id: string; zones: { id: string; countryCodes: string[]; restOfWorld: boolean }[] }[]
): { locationGroupId: string; zoneIds: string[] }[] {
  const out: { locationGroupId: string; zoneIds: string[] }[] = [];
  for (const g of groups) {
    const zoneIds = g.zones.filter((z) => !z.countryCodes.includes('GB')).map((z) => z.id);
    if (zoneIds.length) out.push({ locationGroupId: g.id, zoneIds });
  }
  return out;
}

const GB_LOCAL_GROUPS_QUERY = `query pawscoutGbLocalGroups {
  deliveryProfiles(first: 30) {
    edges { node { id name profileLocationGroups {
      locationGroup { id }
      locationGroupZones(first: 50) { edges { node { zone { id name countries { code { countryCode restOfWorld } } } } } }
    } } }
  }
}`;

/** Restrict the existing GB Local profile to UK-only by deleting its non-UK zones (the
 *  wrong mirrored EU/International zones). Idempotent: a no-op when already UK-only.
 *  This stops GB-only items being checkout-able to destinations they cannot reach. */
export async function restrictGbProfileToUk(admin: AdminGraphql): Promise<{ deletedZoneIds: string[]; profileId: string }> {
  const root = (await admin(GB_LOCAL_GROUPS_QUERY)) as any;
  const node = ((root?.deliveryProfiles?.edges ?? []) as any[]).map((e) => e?.node).find((n) => n?.name === GB_LOCAL_PROFILE_NAME);
  if (!node?.id) return { deletedZoneIds: [], profileId: '' };
  const groups = ((node.profileLocationGroups ?? []) as any[]).map((plg) => ({
    id: plg?.locationGroup?.id,
    zones: ((plg?.locationGroupZones?.edges ?? []) as any[]).map((ze) => {
      const z = ze?.node?.zone; const codes: string[] = []; let row = false;
      for (const c of (z?.countries ?? []) as any[]) { if (c?.code?.restOfWorld) row = true; else if (c?.code?.countryCode) codes.push(c.code.countryCode); }
      return { id: z?.id, countryCodes: codes, restOfWorld: row };
    }).filter((z: any) => z.id),
  })).filter((g: any) => g.id);

  const dels = computeNonUkZoneIds(groups);
  if (!dels.length) return { deletedZoneIds: [], profileId: node.id };
  const profile = { locationGroupsToUpdate: dels.map((d) => ({ id: d.locationGroupId, zonesToDelete: d.zoneIds })) };
  const res = (await admin(UPDATE_PROFILE_MUTATION, { id: node.id, profile })) as any;
  const errs = (res?.deliveryProfileUpdate?.userErrors ?? []) as { message?: string }[];
  if (errs.length) throw new Error(`restrictGbProfileToUk failed: ${errs.map((e) => e.message).join('; ')}`);
  return { deletedZoneIds: dels.flatMap((d) => d.zoneIds), profileId: node.id };
}

/** Minimal store surface syncGbProfileMembership needs (the real TenantStore satisfies it). */
interface GbMembershipStore {
  listGbWarehousedShopifyProductIds(): Promise<string[]>;
}

/**
 * Reconcile GB Local profile membership: ensure the profile exists (mirroring the live
 * default profile's non-UK zones), then diff its current product members against the GB-
 * warehoused product set and associate/dissociate the corresponding VARIANTS (Shopify
 * delivery profiles associate by variant id, not product id). Idempotent: a no-op when
 * membership already matches. Throws on a deliveryProfileUpdate userError.
 */
export async function syncGbProfileMembership(
  admin: AdminGraphql,
  store: GbMembershipStore,
  opts: { ukRateAmount?: string } = {}
): Promise<{ added: number; removed: number; profileId: string }> {
  const cfg = await readDeliveryConfig(admin);

  // SAFETY (quote==checkout): the mirror below drops every zone containing GB (the UK zone is
  // replaced with the free rate). If GB is BUNDLED with other countries in a single default
  // zone, dropping it would strip those countries' coverage from GB items - a silent checkout
  // breakage that bites even with the agent flag off. Refuse + log; the owner isolates GB into
  // its own zone first. Self-protecting so the daily cron can never arm a broken profile.
  const gbZones = cfg.locationGroups.flatMap((g) => g.zones).filter((z) => z.countryCodes.includes('GB'));
  const gbBundled = gbZones.some((z) => z.countryCodes.some((c) => c !== 'GB'));
  if (gbBundled) {
    console.warn('GB Local sync skipped: GB is bundled with other countries in a default-profile zone; isolate GB into its own zone before enabling free UK shipping.');
    return { added: 0, removed: 0, profileId: '' };
  }

  const locationIds = cfg.locations.map((l) => l.id);
  // Mirror the default profile's NON-UK zones (the UK zone is replaced with the free rate).
  const mirrorZones = cfg.locationGroups.flatMap((g) => g.zones).filter((z) => !z.countryCodes.includes('GB'));

  const { profileId } = await ensureGbLocalProfile(admin, { locationIds, ukRateAmount: opts.ukRateAmount ?? '0.00', mirrorZones });

  const membersRes = (await admin(PROFILE_MEMBERS_QUERY, { id: profileId })) as any;
  const current = new Set(
    ((membersRes?.deliveryProfile?.profileItems?.edges ?? []) as any[]).map((e) => e?.node?.product?.id).filter(Boolean)
  );
  const desired = new Set(await store.listGbWarehousedShopifyProductIds());

  const toAdd = [...desired].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !desired.has(id));
  if (!toAdd.length && !toRemove.length) return { added: 0, removed: 0, profileId };

  const variantsToAssociate = toAdd.length ? await resolveVariantIds(admin, toAdd) : [];
  const variantsToDissociate = toRemove.length ? await resolveVariantIds(admin, toRemove) : [];

  const profile: Record<string, unknown> = {};
  if (variantsToAssociate.length) profile.variantsToAssociate = variantsToAssociate;
  if (variantsToDissociate.length) profile.variantsToDissociate = variantsToDissociate;

  if (Object.keys(profile).length) {
    const res = (await admin(UPDATE_PROFILE_MUTATION, { id: profileId, profile })) as any;
    const errs = (res?.deliveryProfileUpdate?.userErrors ?? []) as { message?: string }[];
    if (errs.length) throw new Error(`deliveryProfileUpdate failed: ${errs.map((e) => e.message).join('; ')}`);
  }

  return { added: toAdd.length, removed: toRemove.length, profileId };
}

/** Human-readable profile name for an origin signature.
 *  'GB' maps to GB_LOCAL_PROFILE_NAME; every other signature gets 'Origin <sig>'. */
export function signatureProfileName(sig: string): string {
  return sig === 'GB' ? GB_LOCAL_PROFILE_NAME : `Origin ${sig}`;
}

/** Ensure a signature delivery profile exists (create) or refresh its zones (found-path
 *  recreate). Returns the profile id. Throws on userErrors.
 *
 *  Create path: deliveryProfileCreate with locationGroupsToCreate.
 *  Found path: deliveryProfileUpdate to delete all existing zone ids then recreate from
 *  the formula result. Operates on the first location group (one group is the standard
 *  layout for all profiles we create). */
async function ensureSignatureProfile(
  admin: AdminGraphql,
  opts: { name: string; locationIds: string[]; zones: unknown[] }
): Promise<string> {
  const root = (await admin(GB_LOCAL_GROUPS_QUERY)) as any;
  const existing = ((root?.deliveryProfiles?.edges ?? []) as any[])
    .map((e) => e?.node)
    .find((n) => n?.name === opts.name);

  if (!existing?.id) {
    // Create path: new profile
    const profile = {
      name: opts.name,
      locationGroupsToCreate: [{
        locationsToAdd: opts.locationIds,
        zonesToCreate: opts.zones,
      }],
    };
    const res = (await admin(CREATE_PROFILE_MUTATION, { profile })) as any;
    const payload = res?.deliveryProfileCreate;
    const errs = (payload?.userErrors ?? []) as { message?: string }[];
    if (errs.length) throw new Error(`deliveryProfileCreate failed: ${errs.map((e) => e.message).join('; ')}`);
    const id = payload?.profile?.id;
    if (!id) throw new Error('deliveryProfileCreate returned no profile id');
    return id;
  }

  // Found path: recreate zones in the first location group to keep formula-fresh
  const firstPlg = ((existing.profileLocationGroups ?? []) as any[])[0];
  const locationGroupId = firstPlg?.locationGroup?.id;
  if (!locationGroupId) throw new Error(`ensureSignatureProfile: no location group found for profile ${existing.id}`);
  const existingZoneIds = ((firstPlg?.locationGroupZones?.edges ?? []) as any[])
    .map((ze: any) => ze?.node?.zone?.id)
    .filter(Boolean);

  const profile: Record<string, unknown> = {
    locationGroupsToUpdate: [{
      id: locationGroupId,
      zonesToDelete: existingZoneIds,
      zonesToCreate: opts.zones,
    }],
  };
  const res = (await admin(UPDATE_PROFILE_MUTATION, { id: existing.id, profile })) as any;
  const errs = (res?.deliveryProfileUpdate?.userErrors ?? []) as { message?: string }[];
  if (errs.length) throw new Error(`deliveryProfileUpdate (zone recreate) failed: ${errs.map((e) => e.message).join('; ')}`);
  return existing.id;
}

/**
 * Materialize the nearest-warehouse shipping formula into one Shopify delivery profile
 * per origin signature. One profile per unique signature (e.g. 'GB', 'CN', 'US,DE').
 *
 * For each signature: build its zones via buildSignatureZones (routes from store),
 * ensure a delivery profile with those zones exists (create or zone-recreate), then
 * reconcile which product variants belong to that profile (associate/dissociate).
 *
 * Defensive: a signature that produces zero zones is skipped (checkout blocked = honest).
 */
export async function syncSignatureProfiles(
  admin: AdminGraphql,
  store: {
    listSignatureMemberships(): Promise<Map<string, string[]>>;
    getLogisticsRoute(from: string, to: string, staleness: number): Promise<LogisticsRoute | null>;
  },
  opts: { servedCountries: string[]; fx: number; handlingGbp: number; stalenessHours: number }
): Promise<{ profiles: { sig: string; profileId: string; added: number; removed: number; zones: number }[] }> {
  // Safety net: always restrict the GB Local profile to UK-only at the start of each run.
  // If buildSignatureZones returns [] (D1 row absent/stale), the GB signature is skipped
  // and ensureSignatureProfile never runs - but the old profile (with EU zones) stays armed.
  // Restricting here ensures the profile is UK-only even when D1 is empty for that run.
  try { await restrictGbProfileToUk(admin); } catch (e) { console.warn(`gb restrict (safety net) failed: ${(e as Error).message}`); }

  const cfg = await readDeliveryConfig(admin);
  const locationIds = cfg.locations.map((l) => l.id);
  const memberships = await store.listSignatureMemberships();

  const profiles: { sig: string; profileId: string; added: number; removed: number; zones: number }[] = [];

  for (const [sig, productIds] of memberships) {
    const originCodes = sig.split(',');

    // Prefetch route lookup for all origin x dest combinations
    const routeMap = new Map<string, LogisticsRoute | null>();
    for (const origin of originCodes) {
      for (const dest of opts.servedCountries) {
        routeMap.set(`${origin}|${dest}`, await store.getLogisticsRoute(origin, dest, opts.stalenessHours));
      }
    }
    const lookup = (o: string, d: string): LogisticsRoute | null => routeMap.get(`${o}|${d}`) ?? null;

    const zones = buildSignatureZones(originCodes, opts.servedCountries, lookup, opts.fx, opts.handlingGbp);

    if (zones.length === 0) {
      console.warn(`syncSignatureProfiles: signature '${sig}' has no fulfillable zones for served countries [${opts.servedCountries.join(',')}]; skipping profile creation`);
      profiles.push({ sig, profileId: '', added: 0, removed: 0, zones: 0 });
      continue;
    }

    const name = signatureProfileName(sig);
    const profileId = await ensureSignatureProfile(admin, { name, locationIds, zones });

    // Reconcile membership: diff current product members vs desired productIds
    const membersRes = (await admin(PROFILE_MEMBERS_QUERY, { id: profileId })) as any;
    const current = new Set(
      ((membersRes?.deliveryProfile?.profileItems?.edges ?? []) as any[])
        .map((e: any) => e?.node?.product?.id)
        .filter(Boolean)
    );
    if (current.size >= 250) console.warn(`signature ${sig}: profile membership at/over the 250 read cap; some members may be unpaged`);
    const desired = new Set(productIds);

    const toAdd = [...desired].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !desired.has(id));

    let added = 0;
    let removed = 0;

    if (toAdd.length || toRemove.length) {
      const variantsToAssociate = toAdd.length ? await resolveVariantIds(admin, toAdd) : [];
      const variantsToDissociate = toRemove.length ? await resolveVariantIds(admin, toRemove) : [];

      const profile: Record<string, unknown> = {};
      if (variantsToAssociate.length) profile.variantsToAssociate = variantsToAssociate;
      if (variantsToDissociate.length) profile.variantsToDissociate = variantsToDissociate;

      if (Object.keys(profile).length) {
        const res = (await admin(UPDATE_PROFILE_MUTATION, { id: profileId, profile })) as any;
        const errs = (res?.deliveryProfileUpdate?.userErrors ?? []) as { message?: string }[];
        if (errs.length) throw new Error(`deliveryProfileUpdate failed: ${errs.map((e) => e.message).join('; ')}`);
        added = toAdd.length;
        removed = toRemove.length;
      }
    }

    profiles.push({ sig, profileId, added, removed, zones: zones.length });
  }

  return { profiles };
}

export function buildSignatureZones(
  originCodes: string[], servedCountries: string[],
  lookup: (origin: string, dest: string) => LogisticsRoute | null,
  fx: number, handlingGbp: number
) {
  const zones: { name: string; countries: { code: string; includeAllProvinces: true }[]; methodDefinitionsToCreate: unknown[] }[] = [];
  for (const dest of servedCountries) {
    const candidates = originCodes.map((o) => lookup(o, dest)).filter((r): r is LogisticsRoute => !!r);
    const res = resolveNearestRoute(candidates);
    if (!res.fulfillable) continue; // omit -> checkout blocked there (honest)
    const amount = freightUsdToGbp(res.nearest.route.freight_cost_usd, fx, handlingGbp);
    zones.push({
      name: dest,
      countries: [{ code: dest, includeAllProvinces: true }],
      methodDefinitionsToCreate: [{ name: 'Standard', rateDefinition: { price: { amount, currencyCode: 'GBP' } } }],
    });
  }
  return zones;
}
