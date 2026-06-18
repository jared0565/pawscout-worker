import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { connectCj, saveGates, savePricing, getStatus } from '../src/console/routes';
import { Vault } from '../src/vault';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function seedTenant(shop: string) {
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  const dek = await vault.newTenantDek();
  await new TenantStore(env.DB, shop).upsertTenant({ accessTokenEnc: await vault.seal(dek, 't'), dekWrapped: dek, scopes: 's' });
  await new TenantStore(env.DB, shop).seedConfig({
    collectionMap: {},
    gates: { popularityFloor: 50, priceMin: 5, priceMax: 80, relevance: 'title' },
    pricing: DEFAULT_PRICING,
    floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
    target: 16
  });
  return vault;
}

describe('console handlers', () => {
  it('connectCj validates then stores a sealed credential (never plaintext)', async () => {
    const vault = await seedTenant('a.myshopify.com');
    const okValidate = async () => ({ ok: true as const });
    const res = await connectCj(env.DB, vault, 'a.myshopify.com', 'CJkey@api@tok', okValidate);
    expect(res.ok).toBe(true);
    const cred = await new TenantStore(env.DB, 'a.myshopify.com').getSupplierCredential('cj');
    expect(cred?.api_key_enc).not.toContain('CJkey');
    expect(await vault.open((await new TenantStore(env.DB, 'a.myshopify.com').getTenant())!.dek_wrapped, cred!.api_key_enc)).toBe('CJkey@api@tok');
  });

  it('connectCj stores nothing when validation fails', async () => {
    const vault = await seedTenant('a.myshopify.com');
    const badValidate = async () => ({ ok: false as const, error: 'bad' });
    const res = await connectCj(env.DB, vault, 'a.myshopify.com', 'bad', badValidate);
    expect(res.ok).toBe(false);
    expect(await new TenantStore(env.DB, 'a.myshopify.com').getSupplierCredential('cj')).toBeNull();
  });

  it('saveGates persists gates and getStatus reports connection without leaking secrets', async () => {
    const vault = await seedTenant('a.myshopify.com');
    await saveGates(env.DB, 'a.myshopify.com', { popularityFloor: 99, priceMin: 2, priceMax: 40, relevance: 'strict' });
    const okValidate = async () => ({ ok: true as const });
    await connectCj(env.DB, vault, 'a.myshopify.com', 'CJk@api@t', okValidate);
    const status = await getStatus(env.DB, 'a.myshopify.com');
    expect(status.cjConnected).toBe(true);
    expect(status.gates.popularityFloor).toBe(99);
    expect(JSON.stringify(status)).not.toContain('CJk@api@t'); // no secret in status payload
  });

  it('savePricing persists the rule and getStatus returns it (defaults when unset)', async () => {
    await seedTenant('a.myshopify.com');
    expect((await getStatus(env.DB, 'a.myshopify.com')).pricing).toEqual(DEFAULT_PRICING);
    const custom = { multiplier: 2.8, floor: 2.2, minMarginGbp: 5, fxUsdToGbp: 0.8, fxBufferPct: 1 };
    await savePricing(env.DB, 'a.myshopify.com', custom);
    expect((await getStatus(env.DB, 'a.myshopify.com')).pricing).toEqual(custom);
  });

  it('saveGates updates the target when given, and preserves it when omitted', async () => {
    await seedTenant('a.myshopify.com');
    const gates = { popularityFloor: 50, priceMin: 5, priceMax: 80, relevance: 'title' as const };
    await saveGates(env.DB, 'a.myshopify.com', gates, 32);
    expect((await getStatus(env.DB, 'a.myshopify.com')).target).toBe(32);
    await saveGates(env.DB, 'a.myshopify.com', gates);
    expect((await getStatus(env.DB, 'a.myshopify.com')).target).toBe(32); // unchanged
  });
});
