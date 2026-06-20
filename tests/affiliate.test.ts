import { describe, it, expect } from 'vitest';
import { productAffiliateEligible, ensureAffiliateCollection, AFFILIATE_ELIGIBLE_TAG } from '../src/affiliate';
import { DEFAULT_PRICING } from '../src/types';
import type { AdminGraphql } from '../src/shopify-admin';

describe('productAffiliateEligible (all-variants-clear)', () => {
  it('eligible when the single variant clears the floor', () => {
    expect(productAffiliateEligible([{ sellPriceUsd: 10 }], DEFAULT_PRICING)).toBe(true);
  });

  it('eligible when EVERY variant clears the floor', () => {
    expect(productAffiliateEligible([{ sellPriceUsd: 10 }, { sellPriceUsd: 12 }], DEFAULT_PRICING)).toBe(true);
  });

  it('ineligible when ANY variant is too thin (one bad SKU disqualifies the product)', () => {
    expect(productAffiliateEligible([{ sellPriceUsd: 10 }, { sellPriceUsd: 3 }], DEFAULT_PRICING)).toBe(false);
  });

  it('ineligible with no sellable variants', () => {
    expect(productAffiliateEligible([], DEFAULT_PRICING)).toBe(false);
    expect(productAffiliateEligible([{ sellPriceUsd: 0 }], DEFAULT_PRICING)).toBe(false);
  });
});

describe('ensureAffiliateCollection (idempotent smart collection)', () => {
  it('creates the TAG-EQUALS smart collection when absent', async () => {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const admin: AdminGraphql = (async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (query.includes('collections(')) return { collections: { nodes: [] } };
      return { collectionCreate: { collection: { id: 'gid://c/1' }, userErrors: [] } };
    }) as unknown as AdminGraphql;

    await ensureAffiliateCollection(admin);
    const create = calls.find((c) => c.query.includes('collectionCreate'))!;
    expect(create).toBeDefined();
    const input = create.variables!.input as { ruleSet: { rules: { column: string; relation: string; condition: string }[] } };
    expect(input.ruleSet.rules[0]).toEqual({ column: 'TAG', relation: 'EQUALS', condition: AFFILIATE_ELIGIBLE_TAG });
  });

  it('does nothing when the collection already exists', async () => {
    const calls: string[] = [];
    const admin: AdminGraphql = (async (query: string) => {
      calls.push(query);
      if (query.includes('collections(')) return { collections: { nodes: [{ id: 'gid://c/existing' }] } };
      return {};
    }) as unknown as AdminGraphql;

    await ensureAffiliateCollection(admin);
    expect(calls.some((q) => q.includes('collectionCreate'))).toBe(false);
  });
});
