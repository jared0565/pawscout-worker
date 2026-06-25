import { describe, it, expect, vi } from 'vitest';
import { readDeliveryConfig } from '../../src/shipping/delivery-profile';

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
