import { describe, it, expect, vi } from 'vitest';
import { readDeliveryConfig, ensureGbLocalProfile, type DeliveryZone } from '../../src/shipping/delivery-profile';

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
    expect(uk.countries).toEqual([{ code: 'GB' }]);
    expect(uk.methodDefinitionsToCreate[0].rateDefinition.price).toEqual({ amount: '0.00', currencyCode: 'GBP' });
    const eu = zones.find((z: any) => z.name === 'Europe');
    expect(eu.countries).toEqual([{ code: 'FR' }, { code: 'DE' }]);
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
