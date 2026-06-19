import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

describe('semantic_terms store', () => {
  it('upserts and reads expansions; second upsert overwrites (no dup row)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertSemanticTerm('pet-cleaning', 'shampoo', ['dog shampoo', 'pet bath'], 'suggest');
    let hit = await s.getSemanticExpansions('pet-cleaning', 'shampoo');
    expect(hit?.expansions).toEqual(['dog shampoo', 'pet bath']);
    await s.upsertSemanticTerm('pet-cleaning', 'shampoo', ['puppy shampoo'], 'lazy');
    hit = await s.getSemanticExpansions('pet-cleaning', 'shampoo');
    expect(hit?.expansions).toEqual(['puppy shampoo']);
    const list = await s.listSemanticTermsForCollection('pet-cleaning');
    expect(list.map((x) => x.term)).toEqual(['shampoo']);
  });
  it('returns null on a miss and isolates by collection', async () => {
    const s = new TenantStore(env.DB, SHOP);
    expect(await s.getSemanticExpansions('pet-toys', 'ball')).toBeNull();
    await s.upsertSemanticTerm('pet-toys', 'ball', ['dog ball'], 'suggest');
    expect(await s.getSemanticExpansions('pet-cleaning', 'ball')).toBeNull();
    expect((await s.getSemanticExpansions('pet-toys', 'ball'))?.expansions).toEqual(['dog ball']);
  });
});
