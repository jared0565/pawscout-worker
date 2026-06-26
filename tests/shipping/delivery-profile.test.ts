import { describe, it, expect, test, vi } from 'vitest';
import { readDeliveryConfig, ensureGbLocalProfile, syncGbProfileMembership, computeNonUkZoneIds, restrictGbProfileToUk, type DeliveryZone } from '../../src/shipping/delivery-profile';

// A representative live-shaped deliveryProfiles payload: one default profile with a
// GB location group holding three zones (UK / Europe / Rest of World) each with a
// flat rate, plus a second non-default profile. Mirrors the Admin GraphQL 2026-04
// shape used by readDeliveryConfig (profileLocationGroups + locationGroupZones).
const FULL = {
  deliveryProfiles: { edges: [
    { node: {
      id: 'gid://shopify/DeliveryProfile/1', name: 'General Profile', default: true,
      profileLocationGroups: [{
        locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/9', locations: { nodes: [
          { id: 'gid://shopify/Location/5', name: 'Main', address: { country: 'United Kingdom', countryCode: 'GB' } }
        ] } },
        locationGroupZones: { edges: [
          { node: {
            zone: { id: 'gid://shopify/DeliveryZone/100', name: 'United Kingdom', countries: [{ code: { countryCode: 'GB', restOfWorld: false } }] },
            methodDefinitions: { edges: [{ node: { name: 'Standard', rateProvider: { price: { amount: '4.99', currencyCode: 'GBP' } } } }] }
          } },
          { node: {
            zone: { id: 'gid://shopify/DeliveryZone/101', name: 'Europe', countries: [{ code: { countryCode: 'FR', restOfWorld: false } }, { code: { countryCode: 'DE', restOfWorld: false } }] },
            methodDefinitions: { edges: [{ node: { name: 'Standard', rateProvider: { price: { amount: '14.99', currencyCode: 'GBP' } } } }] }
          } },
          { node: {
            zone: { id: 'gid://shopify/DeliveryZone/102', name: 'Rest of World', countries: [{ code: { countryCode: null, restOfWorld: true } }] },
            methodDefinitions: { edges: [{ node: { name: 'Standard', rateProvider: { price: { amount: '23.99', currencyCode: 'GBP' } } } }] }
          } }
        ] }
      }]
    } },
    { node: { id: 'gid://shopify/DeliveryProfile/2', name: 'Custom', default: false, profileLocationGroups: [] } }
  ] }
};

describe('readDeliveryConfig', () => {
  it('picks the default profile id (not a non-default one)', async () => {
    const admin = vi.fn().mockResolvedValue(FULL);
    const cfg = await readDeliveryConfig(admin as any);
    expect(cfg.defaultProfileId).toBe('gid://shopify/DeliveryProfile/1');
  });

  it('reads the location group id and its location ids', async () => {
    const admin = vi.fn().mockResolvedValue(FULL);
    const cfg = await readDeliveryConfig(admin as any);
    expect(cfg.locationGroups[0].id).toBe('gid://shopify/DeliveryLocationGroup/9');
    expect(cfg.locationGroups[0].locationIds).toEqual(['gid://shopify/Location/5']);
  });

  it('flattens locations with name + country', async () => {
    const admin = vi.fn().mockResolvedValue(FULL);
    const cfg = await readDeliveryConfig(admin as any);
    expect(cfg.locations).toEqual([
      { id: 'gid://shopify/Location/5', name: 'Main', country: 'United Kingdom', countryCode: 'GB' }
    ]);
  });

  it('parses zones with country codes, restOfWorld, and flat rates (to mirror into GB Local)', async () => {
    const admin = vi.fn().mockResolvedValue(FULL);
    const cfg = await readDeliveryConfig(admin as any);
    const zones = cfg.locationGroups[0].zones;
    expect(zones.map((z) => z.name)).toEqual(['United Kingdom', 'Europe', 'Rest of World']);
    const eu = zones.find((z) => z.name === 'Europe')!;
    expect(eu.countryCodes).toEqual(['FR', 'DE']);
    expect(eu.restOfWorld).toBe(false);
    expect(eu.rates).toEqual([{ name: 'Standard', amount: '14.99', currencyCode: 'GBP' }]);
    const row = zones.find((z) => z.name === 'Rest of World')!;
    expect(row.restOfWorld).toBe(true);
    expect(row.countryCodes).toEqual([]);
    expect(row.rates[0].amount).toBe('23.99');
  });

  it('sets ukZonePresent true when a zone covers GB', async () => {
    const admin = vi.fn().mockResolvedValue(FULL);
    const cfg = await readDeliveryConfig(admin as any);
    expect(cfg.ukZonePresent).toBe(true);
  });

  it('degrades safely on an empty/missing payload (no throw, empty + false)', async () => {
    const admin = vi.fn().mockResolvedValue({ deliveryProfiles: { edges: [] } });
    const cfg = await readDeliveryConfig(admin as any);
    expect(cfg.defaultProfileId).toBe('');
    expect(cfg.locationGroups).toEqual([]);
    expect(cfg.locations).toEqual([]);
    expect(cfg.ukZonePresent).toBe(false);
  });
});

describe('ensureGbLocalProfile', () => {
  const mirrorZones: DeliveryZone[] = [
    { id: 'z-eu', name: 'Europe', countryCodes: ['FR', 'DE'], restOfWorld: false, rates: [{ name: 'Standard', amount: '14.99', currencyCode: 'GBP' }] },
    { id: 'z-row', name: 'Rest of World', countryCodes: [], restOfWorld: true, rates: [{ name: 'Standard', amount: '23.99', currencyCode: 'GBP' }] },
  ];

  it('creates the GB Local profile with a free UK rate + mirrored EU/World zones when absent', async () => {
    const calls: { q: string; v: any }[] = [];
    const admin = vi.fn().mockImplementation((q: string, v: any) => {
      calls.push({ q, v });
      if (q.includes('deliveryProfiles(')) return Promise.resolve({ deliveryProfiles: { edges: [] } }); // no "GB Local" yet
      if (q.includes('deliveryProfileCreate')) return Promise.resolve({ deliveryProfileCreate: { profile: { id: 'gid://shopify/DeliveryProfile/77' }, userErrors: [] } });
      return Promise.resolve({});
    });
    const r = await ensureGbLocalProfile(admin as any, { locationIds: ['gid://shopify/Location/5'], ukRateAmount: '0.00', mirrorZones });
    expect(r).toEqual({ profileId: 'gid://shopify/DeliveryProfile/77', created: true });

    const create = calls.find((c) => c.q.includes('deliveryProfileCreate'))!;
    const prof = create.v.profile;
    expect(prof.name).toBe('GB Local');
    expect(prof.locationGroupsToCreate[0].locationsToAdd).toEqual(['gid://shopify/Location/5']);
    const zones = prof.locationGroupsToCreate[0].zonesToCreate;
    const uk = zones.find((z: any) => z.name === 'United Kingdom');
    // includeAllProvinces is required by Shopify for province-bearing countries (GB/US/CA),
    // else deliveryProfileCreate fails "must have at least one province associated".
    expect(uk.countries).toEqual([{ code: 'GB', includeAllProvinces: true }]);
    expect(uk.methodDefinitionsToCreate[0].rateDefinition.price).toEqual({ amount: '0.00', currencyCode: 'GBP' });
    const eu = zones.find((z: any) => z.name === 'Europe');
    expect(eu.countries).toEqual([{ code: 'FR', includeAllProvinces: true }, { code: 'DE', includeAllProvinces: true }]);
    expect(eu.methodDefinitionsToCreate[0].rateDefinition.price).toEqual({ amount: '14.99', currencyCode: 'GBP' });
    const row = zones.find((z: any) => z.name === 'Rest of World');
    expect(row.countries).toEqual([{ restOfWorld: true }]);
    expect(row.methodDefinitionsToCreate[0].rateDefinition.price).toEqual({ amount: '23.99', currencyCode: 'GBP' });
  });

  it('is idempotent: returns the existing GB Local profile and never creates a duplicate', async () => {
    const admin = vi.fn().mockImplementation((q: string) => {
      if (q.includes('deliveryProfiles(')) return Promise.resolve({ deliveryProfiles: { edges: [{ node: { id: 'gid://shopify/DeliveryProfile/99', name: 'GB Local' } }] } });
      if (q.includes('deliveryProfileCreate')) throw new Error('must NOT create when GB Local already exists');
      return Promise.resolve({});
    });
    const r = await ensureGbLocalProfile(admin as any, { locationIds: ['L1'], ukRateAmount: '0.00', mirrorZones });
    expect(r).toEqual({ profileId: 'gid://shopify/DeliveryProfile/99', created: false });
  });

  it('throws on userErrors from create (never silently swallows)', async () => {
    const admin = vi.fn().mockImplementation((q: string) => {
      if (q.includes('deliveryProfiles(')) return Promise.resolve({ deliveryProfiles: { edges: [] } });
      if (q.includes('deliveryProfileCreate')) return Promise.resolve({ deliveryProfileCreate: { profile: null, userErrors: [{ field: ['name'], message: 'name taken' }] } });
      return Promise.resolve({});
    });
    await expect(ensureGbLocalProfile(admin as any, { locationIds: ['L1'], ukRateAmount: '0.00', mirrorZones })).rejects.toThrow(/name taken/);
  });
});

describe('syncGbProfileMembership', () => {
  // Route a mocked admin by query content. Order matters: the config read and the
  // name-lookup both contain "deliveryProfiles(", so check the more specific markers first.
  function routedAdmin(opts: {
    profileEdges: any[];          // result of the GB Local name lookup (and any create)
    currentMembers: string[];     // product ids currently in the profile
    variantsByProduct: Record<string, string[]>;
    onUpdate?: () => void;
    updateUserErrors?: any[];
  }) {
    const calls: { q: string; v: any }[] = [];
    const admin = vi.fn().mockImplementation((q: string, v: any) => {
      calls.push({ q, v });
      if (q.includes('profileLocationGroups')) return Promise.resolve(FULL); // readDeliveryConfig
      if (q.includes('deliveryProfileCreate')) return Promise.resolve({ deliveryProfileCreate: { profile: { id: 'gid://shopify/DeliveryProfile/77' }, userErrors: [] } });
      if (q.includes('deliveryProfileUpdate')) { opts.onUpdate?.(); return Promise.resolve({ deliveryProfileUpdate: { profile: { id: 'gid://shopify/DeliveryProfile/77' }, userErrors: opts.updateUserErrors ?? [] } }); }
      if (q.includes('profileItems')) return Promise.resolve({ deliveryProfile: { profileItems: { edges: opts.currentMembers.map((id) => ({ node: { product: { id } } })) } } });
      if (q.includes('nodes(ids')) return Promise.resolve({ nodes: (v.ids as string[]).map((id) => ({ id, variants: { nodes: (opts.variantsByProduct[id] ?? []).map((vid) => ({ id: vid })) } })) });
      if (q.includes('deliveryProfiles(')) return Promise.resolve({ deliveryProfiles: { edges: opts.profileEdges } }); // name lookup
      return Promise.resolve({});
    });
    return { admin, calls };
  }

  const storeOf = (ids: string[]) => ({ listGbWarehousedShopifyProductIds: async () => ids });

  it('associates variants for newly GB-warehoused products and reports product counts', async () => {
    const { admin, calls } = routedAdmin({
      profileEdges: [], // no GB Local yet -> create
      currentMembers: [],
      variantsByProduct: { 'gid://shopify/Product/1': ['gid://shopify/ProductVariant/11'] },
    });
    const r = await syncGbProfileMembership(admin as any, storeOf(['gid://shopify/Product/1']) as any);
    expect(r).toEqual({ added: 1, removed: 0, profileId: 'gid://shopify/DeliveryProfile/77' });
    const upd = calls.find((c) => c.q.includes('deliveryProfileUpdate'))!;
    expect(upd.v.profile.variantsToAssociate).toEqual(['gid://shopify/ProductVariant/11']);
    expect(upd.v.profile.variantsToDissociate).toBeUndefined();
  });

  it('is a no-op (no update call) when membership already matches', async () => {
    let updated = false;
    const { admin } = routedAdmin({
      profileEdges: [{ node: { id: 'gid://shopify/DeliveryProfile/77', name: 'GB Local' } }],
      currentMembers: ['gid://shopify/Product/1'],
      variantsByProduct: {},
      onUpdate: () => { updated = true; },
    });
    const r = await syncGbProfileMembership(admin as any, storeOf(['gid://shopify/Product/1']) as any);
    expect(r).toEqual({ added: 0, removed: 0, profileId: 'gid://shopify/DeliveryProfile/77' });
    expect(updated).toBe(false);
  });

  it('dissociates variants for products no longer GB-warehoused', async () => {
    const { admin, calls } = routedAdmin({
      profileEdges: [{ node: { id: 'gid://shopify/DeliveryProfile/77', name: 'GB Local' } }],
      currentMembers: ['gid://shopify/Product/9'],
      variantsByProduct: { 'gid://shopify/Product/9': ['gid://shopify/ProductVariant/99'] },
    });
    const r = await syncGbProfileMembership(admin as any, storeOf([]) as any); // P9 no longer GB
    expect(r).toEqual({ added: 0, removed: 1, profileId: 'gid://shopify/DeliveryProfile/77' });
    const upd = calls.find((c) => c.q.includes('deliveryProfileUpdate'))!;
    expect(upd.v.profile.variantsToDissociate).toEqual(['gid://shopify/ProductVariant/99']);
    expect(upd.v.profile.variantsToAssociate).toBeUndefined();
  });

  it('refuses to sync (no create or update) when GB is bundled with other countries in a default zone', async () => {
    // The default profile bundles GB + IE in one "UK & Ireland" zone. Mirroring drops every
    // GB-containing zone, so creating GB Local would strip IE coverage from GB items (a silent
    // checkout breakage). The worker must refuse + log, never create a broken profile.
    const bundled = {
      deliveryProfiles: { edges: [{ node: {
        id: 'gid://shopify/DeliveryProfile/1', default: true,
        profileLocationGroups: [{
          locationGroup: { id: 'lg1', locations: { nodes: [{ id: 'L1', name: 'Main', address: { country: 'United Kingdom', countryCode: 'GB' } }] } },
          locationGroupZones: { edges: [{ node: {
            zone: { id: 'z1', name: 'UK & Ireland', countries: [{ code: { countryCode: 'GB', restOfWorld: false } }, { code: { countryCode: 'IE', restOfWorld: false } }] },
            methodDefinitions: { edges: [{ node: { name: 'Standard', rateProvider: { price: { amount: '4.99', currencyCode: 'GBP' } } } }] }
          } }] }
        }]
      } }] }
    };
    let mutated = false;
    const admin = vi.fn().mockImplementation((q: string) => {
      if (q.includes('profileLocationGroups')) return Promise.resolve(bundled);
      if (q.includes('deliveryProfileCreate') || q.includes('deliveryProfileUpdate')) { mutated = true; return Promise.resolve({}); }
      if (q.includes('deliveryProfiles(')) return Promise.resolve({ deliveryProfiles: { edges: [] } });
      return Promise.resolve({});
    });
    const store = { listGbWarehousedShopifyProductIds: async () => ['gid://shopify/Product/1'] };
    const r = await syncGbProfileMembership(admin as any, store as any);
    expect(r).toEqual({ added: 0, removed: 0, profileId: '' });
    expect(mutated).toBe(false); // never created or updated a delivery profile
  });

  it('throws on deliveryProfileUpdate userErrors', async () => {
    const { admin } = routedAdmin({
      profileEdges: [{ node: { id: 'gid://shopify/DeliveryProfile/77', name: 'GB Local' } }],
      currentMembers: [],
      variantsByProduct: { 'gid://shopify/Product/1': ['gid://shopify/ProductVariant/11'] },
      updateUserErrors: [{ message: 'limit exceeded' }],
    });
    await expect(syncGbProfileMembership(admin as any, storeOf(['gid://shopify/Product/1']) as any)).rejects.toThrow(/limit exceeded/);
  });
});

test('computeNonUkZoneIds selects every zone that does not cover GB', () => {
  const groups = [{
    id: 'lg1',
    zones: [
      { id: 'z-uk', countryCodes: ['GB'], restOfWorld: false },
      { id: 'z-eu', countryCodes: ['DE', 'FR'], restOfWorld: false },
      { id: 'z-row', countryCodes: [], restOfWorld: true },
    ],
  }];
  expect(computeNonUkZoneIds(groups)).toEqual([{ locationGroupId: 'lg1', zoneIds: ['z-eu', 'z-row'] }]);
});

test('computeNonUkZoneIds is a no-op when only a UK zone exists', () => {
  const groups = [{ id: 'lg1', zones: [{ id: 'z-uk', countryCodes: ['GB'], restOfWorld: false }] }];
  expect(computeNonUkZoneIds(groups)).toEqual([]);
});

describe('restrictGbProfileToUk', () => {
  // Mock payload for the GB_LOCAL_GROUPS_QUERY: a GB Local profile with one location
  // group containing a UK zone and an EU zone.
  function makeGbLocalPayload(zones: { id: string; name: string; countryCodes: string[]; restOfWorld: boolean }[]) {
    return {
      deliveryProfiles: {
        edges: [{
          node: {
            id: 'gid://shopify/DeliveryProfile/55',
            name: 'GB Local',
            profileLocationGroups: [{
              locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/20' },
              locationGroupZones: {
                edges: zones.map((z) => ({
                  node: {
                    zone: {
                      id: z.id,
                      name: z.name,
                      countries: z.restOfWorld
                        ? [{ code: { countryCode: null, restOfWorld: true } }]
                        : z.countryCodes.map((c) => ({ code: { countryCode: c, restOfWorld: false } })),
                    },
                  },
                })),
              },
            }],
          },
        }],
      },
    };
  }

  it('deletes non-UK zones and returns their ids', async () => {
    const calls: { q: string; v: any }[] = [];
    const payload = makeGbLocalPayload([
      { id: 'z-uk', name: 'United Kingdom', countryCodes: ['GB'], restOfWorld: false },
      { id: 'z-eu', name: 'Europe', countryCodes: ['DE', 'FR'], restOfWorld: false },
    ]);
    const admin = vi.fn().mockImplementation((q: string, v: any) => {
      calls.push({ q, v });
      if (q.includes('deliveryProfileUpdate')) {
        return Promise.resolve({ deliveryProfileUpdate: { profile: { id: 'gid://shopify/DeliveryProfile/55' }, userErrors: [] } });
      }
      return Promise.resolve(payload);
    });
    const r = await restrictGbProfileToUk(admin as any);
    expect(r.profileId).toBe('gid://shopify/DeliveryProfile/55');
    expect(r.deletedZoneIds).toContain('z-eu');
    expect(r.deletedZoneIds).not.toContain('z-uk');
    const upd = calls.find((c) => c.q.includes('deliveryProfileUpdate'))!;
    expect(upd).toBeDefined();
    const lg = upd.v.profile.locationGroupsToUpdate[0];
    expect(lg.zonesToDelete).toContain('z-eu');
    expect(lg.zonesToDelete).not.toContain('z-uk');
  });

  it('is idempotent: sends no update when only a UK zone exists', async () => {
    let mutated = false;
    const payload = makeGbLocalPayload([
      { id: 'z-uk', name: 'United Kingdom', countryCodes: ['GB'], restOfWorld: false },
    ]);
    const admin = vi.fn().mockImplementation((q: string) => {
      if (q.includes('deliveryProfileUpdate')) { mutated = true; return Promise.resolve({}); }
      return Promise.resolve(payload);
    });
    const r = await restrictGbProfileToUk(admin as any);
    expect(r.deletedZoneIds).toEqual([]);
    expect(r.profileId).toBe('gid://shopify/DeliveryProfile/55');
    expect(mutated).toBe(false);
  });
});
