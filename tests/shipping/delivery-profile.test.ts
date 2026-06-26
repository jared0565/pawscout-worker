import { describe, it, expect, test, vi } from 'vitest';
import { readDeliveryConfig, ensureGbLocalProfile, syncGbProfileMembership, computeNonUkZoneIds, restrictGbProfileToUk, buildSignatureZones, signatureProfileName, syncSignatureProfiles, type DeliveryZone } from '../../src/shipping/delivery-profile';
import type { LogisticsRoute } from '../../src/logistics';

const routeRow = (from: string, to: string, freight: number | null): LogisticsRoute => ({
  from_country: from, to_country: to, channel: '', transit_min: 5, transit_max: 9,
  aging_raw: '5-9', freight_cost_usd: freight, synced_at: '2026-06-26T00:00:00Z',
});

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
    // zonesToDelete is a TOP-LEVEL field on DeliveryProfileInput (not on the location group).
    expect(upd.v.profile.zonesToDelete).toContain('z-eu');
    expect(upd.v.profile.zonesToDelete).not.toContain('z-uk');
    expect(upd.v.profile.locationGroupsToUpdate).toBeUndefined();
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

test('buildSignatureZones: GB-only signature yields a UK zone only', () => {
  const lookup = (o: string, d: string) => (o === 'GB' && d === 'GB' ? routeRow('GB','GB',0) : null);
  const zones = buildSignatureZones(['GB'], ['GB','DE','US'], lookup, 0.8, 0);
  expect(zones.map((z) => z.name)).toEqual(['GB']);
  expect(zones[0].countries).toEqual([{ code: 'GB', includeAllProvinces: true }]);
});

test('buildSignatureZones: CN signature omits a destination with no route (FR)', () => {
  const lookup = (o: string, d: string) => (o === 'CN' && d === 'DE' ? routeRow('CN','DE',9.83) : null);
  const zones = buildSignatureZones(['CN'], ['DE','FR'], lookup, 0.8, 0);
  expect(zones.map((z) => z.name)).toEqual(['DE']); // FR omitted (unfulfillable)
});

// ---------------------------------------------------------------------------
// signatureProfileName
// ---------------------------------------------------------------------------
test('signatureProfileName: GB -> GB Local', () => {
  expect(signatureProfileName('GB')).toBe('GB Local');
});

test('signatureProfileName: CN -> Origin CN', () => {
  expect(signatureProfileName('CN')).toBe('Origin CN');
});

test('signatureProfileName: US,DE -> Origin US,DE', () => {
  expect(signatureProfileName('US,DE')).toBe('Origin US,DE');
});

// ---------------------------------------------------------------------------
// syncSignatureProfiles (end-to-end mock-admin test)
// ---------------------------------------------------------------------------
describe('syncSignatureProfiles', () => {
  // Fake store: GB warehouses product 1, CN warehouses product 2.
  // Routes: GB->GB free (freight 0); CN->DE has freight 9.83; GB->DE and CN->GB have no route.
  const storeOf = (memberships: Map<string, string[]>, routes: Record<string, LogisticsRoute | null>) => ({
    listSignatureMemberships: async () => memberships,
    getLogisticsRoute: async (from: string, to: string, _staleness: number) =>
      routes[`${from}|${to}`] ?? null,
  });

  function makeAdmin() {
    let profileCounter = 100;
    const calls: { q: string; v: any }[] = [];
    const admin = vi.fn().mockImplementation((q: string, v: any) => {
      calls.push({ q, v });
      // readDeliveryConfig: anonymous query with profileLocationGroups + methodDefinitions
      // Discriminate on methodDefinitions (not present in pawscoutGbLocalGroups)
      if (q.includes('profileLocationGroups') && q.includes('methodDefinitions')) {
        return Promise.resolve({
          deliveryProfiles: { edges: [{
            node: {
              id: 'gid://shopify/DeliveryProfile/1',
              name: 'General Profile',
              default: true,
              profileLocationGroups: [{
                locationGroup: {
                  id: 'gid://shopify/DeliveryLocationGroup/9',
                  locations: { nodes: [{ id: 'gid://shopify/Location/1', name: 'Main', address: { country: 'United Kingdom', countryCode: 'GB' } }] },
                },
                locationGroupZones: { edges: [] },
              }],
            },
          }] },
        });
      }
      // ensureSignatureProfile: pawscoutGbLocalGroups (find profile by name to decide create vs update)
      if (q.includes('pawscoutGbLocalGroups')) {
        // No existing signature profiles found -> always create
        return Promise.resolve({ deliveryProfiles: { edges: [] } });
      }
      // deliveryProfileCreate -> return a fresh profile id
      if (q.includes('deliveryProfileCreate')) {
        const id = `gid://shopify/DeliveryProfile/${++profileCounter}`;
        return Promise.resolve({ deliveryProfileCreate: { profile: { id, name: v?.profile?.name ?? '' }, userErrors: [] } });
      }
      // PROFILE_MEMBERS_QUERY: no current members for any profile
      if (q.includes('profileItems')) {
        return Promise.resolve({ deliveryProfile: { profileItems: { edges: [] } } });
      }
      // PRODUCT_VARIANTS_QUERY: one variant per product
      if (q.includes('nodes(ids')) {
        const variantMap: Record<string, string> = {
          'gid://shopify/Product/1': 'gid://shopify/ProductVariant/11',
          'gid://shopify/Product/2': 'gid://shopify/ProductVariant/22',
        };
        return Promise.resolve({
          nodes: (v.ids as string[]).map((id: string) => ({
            id,
            variants: { nodes: variantMap[id] ? [{ id: variantMap[id] }] : [] },
          })),
        });
      }
      // UPDATE_PROFILE_MUTATION (membership reconcile)
      if (q.includes('deliveryProfileUpdate')) {
        return Promise.resolve({ deliveryProfileUpdate: { profile: { id: v?.id }, userErrors: [] } });
      }
      return Promise.resolve({});
    });
    return { admin, calls };
  }

  it('creates one profile per signature, zones correct, variants associated', async () => {
    const { admin, calls } = makeAdmin();
    const memberships = new Map<string, string[]>([
      ['GB', ['gid://shopify/Product/1']],
      ['CN', ['gid://shopify/Product/2']],
    ]);
    const routes: Record<string, LogisticsRoute | null> = {
      'GB|GB': routeRow('GB', 'GB', 0),
      'GB|DE': null,
      'CN|GB': null,
      'CN|DE': routeRow('CN', 'DE', 9.83),
    };
    const result = await syncSignatureProfiles(
      admin as any,
      storeOf(memberships, routes),
      { servedCountries: ['GB', 'DE'], fx: 0.8, handlingGbp: 0, stalenessHours: 72 }
    );

    // Two profiles created (GB and CN)
    expect(result.profiles).toHaveLength(2);

    const gbEntry = result.profiles.find((p) => p.sig === 'GB')!;
    expect(gbEntry).toBeDefined();
    expect(gbEntry.zones).toBe(1);
    expect(gbEntry.added).toBe(1);
    expect(gbEntry.profileId).toBeTruthy();

    const cnEntry = result.profiles.find((p) => p.sig === 'CN')!;
    expect(cnEntry).toBeDefined();
    expect(cnEntry.zones).toBe(1);
    expect(cnEntry.added).toBe(1);
    expect(cnEntry.profileId).toBeTruthy();

    // GB profile named 'GB Local', CN profile named 'Origin CN'
    const createCalls = calls.filter((c) => c.q.includes('deliveryProfileCreate'));
    expect(createCalls).toHaveLength(2);

    const gbCreate = createCalls.find((c) => c.v.profile.name === 'GB Local')!;
    expect(gbCreate).toBeDefined();
    const gbZones = gbCreate.v.profile.locationGroupsToCreate[0].zonesToCreate;
    expect(gbZones).toHaveLength(1);
    expect(gbZones[0].name).toBe('GB');
    expect(gbZones[0].methodDefinitionsToCreate[0].rateDefinition.price.amount).toBe('0.00');

    const cnCreate = createCalls.find((c) => c.v.profile.name === 'Origin CN')!;
    expect(cnCreate).toBeDefined();
    const cnZones = cnCreate.v.profile.locationGroupsToCreate[0].zonesToCreate;
    expect(cnZones).toHaveLength(1);
    expect(cnZones[0].name).toBe('DE');
    expect(cnZones[0].methodDefinitionsToCreate[0].rateDefinition.price.amount).toBe('7.86');
    // CN has no GB route so no GB zone
    expect(cnZones.find((z: any) => z.name === 'GB')).toBeUndefined();

    // Both profiles use location id from config
    expect(gbCreate.v.profile.locationGroupsToCreate[0].locationsToAdd).toEqual(['gid://shopify/Location/1']);
    expect(cnCreate.v.profile.locationGroupsToCreate[0].locationsToAdd).toEqual(['gid://shopify/Location/1']);

    // Membership updates: each product's variant should be associated
    const updateCalls = calls.filter((c) => c.q.includes('deliveryProfileUpdate'));
    expect(updateCalls).toHaveLength(2);
    const associatedVariants = updateCalls.flatMap((c) => c.v.profile.variantsToAssociate ?? []);
    expect(associatedVariants).toContain('gid://shopify/ProductVariant/11');
    expect(associatedVariants).toContain('gid://shopify/ProductVariant/22');
  });

  it('batches variant association into chunks of <=250 (Shopify array cap)', async () => {
    const calls: { q: string; v: any }[] = [];
    let pc = 100;
    const VARIANTS = Array.from({ length: 294 }, (_, i) => `gid://shopify/ProductVariant/${i}`);
    const admin = vi.fn().mockImplementation((q: string, v: any) => {
      calls.push({ q, v });
      if (q.includes('profileLocationGroups') && q.includes('methodDefinitions')) {
        return Promise.resolve({ deliveryProfiles: { edges: [{ node: {
          id: 'gid://shopify/DeliveryProfile/1', name: 'General Profile', default: true,
          profileLocationGroups: [{ locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/9', locations: { nodes: [{ id: 'gid://shopify/Location/1', name: 'Main', address: { country: 'United Kingdom', countryCode: 'GB' } }] } }, locationGroupZones: { edges: [] } }],
        } }] } });
      }
      if (q.includes('pawscoutGbLocalGroups')) return Promise.resolve({ deliveryProfiles: { edges: [] } });
      if (q.includes('deliveryProfileCreate')) return Promise.resolve({ deliveryProfileCreate: { profile: { id: `gid://shopify/DeliveryProfile/${++pc}`, name: v?.profile?.name ?? '' }, userErrors: [] } });
      if (q.includes('profileItems')) return Promise.resolve({ deliveryProfile: { profileItems: { edges: [] } } });
      if (q.includes('nodes(ids')) {
        return Promise.resolve({ nodes: (v.ids as string[]).map((id: string) => ({ id, variants: { nodes: VARIANTS.map((vid) => ({ id: vid })) } })) });
      }
      if (q.includes('deliveryProfileUpdate')) return Promise.resolve({ deliveryProfileUpdate: { profile: { id: v?.id }, userErrors: [] } });
      return Promise.resolve({});
    });
    const memberships = new Map<string, string[]>([['CN', ['gid://shopify/Product/1']]]);
    const routes: Record<string, LogisticsRoute | null> = { 'CN|DE': routeRow('CN', 'DE', 9.83) };
    await syncSignatureProfiles(admin as any, storeOf(memberships, routes), { servedCountries: ['DE'], fx: 0.8, handlingGbp: 0, stalenessHours: 72 });

    const assocCalls = calls.filter((c) => c.q.includes('deliveryProfileUpdate') && Array.isArray(c.v.profile?.variantsToAssociate));
    expect(assocCalls.length).toBe(2); // 294 -> 250 + 44, two calls
    for (const c of assocCalls) expect(c.v.profile.variantsToAssociate.length).toBeLessThanOrEqual(250);
    const all = assocCalls.flatMap((c) => c.v.profile.variantsToAssociate as string[]);
    expect(all.length).toBe(294);
    expect(new Set(all).size).toBe(294);
  });

  it('I1 safety net: restrictGbProfileToUk runs at start of every sync, stripping EU zone from existing GB Local profile', async () => {
    // This is the I1 regression guard. If buildSignatureZones returns [] for 'GB' (D1 row
    // absent), ensureSignatureProfile is never called and the old GB Local profile (with EU
    // zones) stays armed, letting GB items be bought in the EU. The safety net at the top of
    // syncSignatureProfiles calls restrictGbProfileToUk regardless, stripping those zones.
    //
    // Setup: GB Local profile exists with a UK zone and a stale EU zone. Memberships has
    // only 'CN' (no 'GB' signature) so the membership loop never touches the GB profile.
    // The ONLY deliveryProfileUpdate carrying zonesToDelete should be the restrict call.
    const calls: { q: string; v: any }[] = [];
    const admin = vi.fn().mockImplementation((q: string, v: any) => {
      calls.push({ q, v });
      // readDeliveryConfig (has profileLocationGroups + methodDefinitions)
      if (q.includes('profileLocationGroups') && q.includes('methodDefinitions')) {
        return Promise.resolve({
          deliveryProfiles: { edges: [{
            node: {
              id: 'gid://shopify/DeliveryProfile/1', name: 'General Profile', default: true,
              profileLocationGroups: [{
                locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/9', locations: { nodes: [{ id: 'gid://shopify/Location/1', name: 'Main', address: { country: 'United Kingdom', countryCode: 'GB' } }] } },
                locationGroupZones: { edges: [] },
              }],
            },
          }] },
        });
      }
      // restrictGbProfileToUk + ensureSignatureProfile both use pawscoutGbLocalGroups.
      // Return GB Local with UK + EU zones so restrict has something to delete.
      if (q.includes('pawscoutGbLocalGroups')) {
        return Promise.resolve({
          deliveryProfiles: { edges: [{
            node: {
              id: 'gid://shopify/DeliveryProfile/55', name: 'GB Local',
              profileLocationGroups: [{
                locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/20' },
                locationGroupZones: { edges: [
                  { node: { zone: { id: 'z-uk', name: 'United Kingdom', countries: [{ code: { countryCode: 'GB', restOfWorld: false } }] } } },
                  { node: { zone: { id: 'z-eu', name: 'Europe', countries: [{ code: { countryCode: 'DE', restOfWorld: false } }] } } },
                ] },
              }],
            },
          }] },
        });
      }
      if (q.includes('deliveryProfileCreate')) {
        return Promise.resolve({ deliveryProfileCreate: { profile: { id: 'gid://shopify/DeliveryProfile/101' }, userErrors: [] } });
      }
      if (q.includes('profileItems')) {
        return Promise.resolve({ deliveryProfile: { profileItems: { edges: [] } } });
      }
      if (q.includes('nodes(ids')) {
        return Promise.resolve({ nodes: (v.ids as string[]).map((id: string) => ({ id, variants: { nodes: [] } })) });
      }
      if (q.includes('deliveryProfileUpdate')) {
        return Promise.resolve({ deliveryProfileUpdate: { profile: { id: v?.id }, userErrors: [] } });
      }
      return Promise.resolve({});
    });

    const memberships = new Map<string, string[]>([['CN', ['gid://shopify/Product/2']]]);
    const routes: Record<string, LogisticsRoute | null> = { 'CN|DE': routeRow('CN', 'DE', 9.83), 'CN|GB': null };
    const store = {
      listSignatureMemberships: async () => memberships,
      getLogisticsRoute: async (from: string, to: string) => routes[`${from}|${to}`] ?? null,
    };
    await syncSignatureProfiles(admin as any, store, { servedCountries: ['GB', 'DE'], fx: 0.8, handlingGbp: 0, stalenessHours: 72 });

    // The restrict call must have issued a deliveryProfileUpdate with TOP-LEVEL zonesToDelete
    // containing z-eu (zonesToDelete is on DeliveryProfileInput, not the location group).
    const restrictUpdate = calls.find((c) =>
      c.q.includes('deliveryProfileUpdate') &&
      ((c.v.profile?.zonesToDelete ?? []) as string[]).includes('z-eu')
    );
    expect(restrictUpdate).toBeDefined();
  });

  it('skips a signature with no fulfillable zones (no profile created, zones:0 in result)', async () => {
    const { admin, calls } = makeAdmin();
    // CN has no routes to any served country
    const memberships = new Map<string, string[]>([
      ['CN', ['gid://shopify/Product/2']],
    ]);
    const routes: Record<string, LogisticsRoute | null> = {
      'CN|GB': null,
      'CN|DE': null,
    };
    const result = await syncSignatureProfiles(
      admin as any,
      storeOf(memberships, routes),
      { servedCountries: ['GB', 'DE'], fx: 0.8, handlingGbp: 0, stalenessHours: 72 }
    );
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toEqual({ sig: 'CN', profileId: '', added: 0, removed: 0, zones: 0 });
    // No create or update mutations were called
    const createCalls = calls.filter((c) => c.q.includes('deliveryProfileCreate'));
    expect(createCalls).toHaveLength(0);
  });
});
