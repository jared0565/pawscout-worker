/// <reference types="@cloudflare/vitest-plugin" />
// llm.menu (the owner's providers, pins and hides) lives inside the same
// tenant_config.llm JSON as the model selection, and two different console
// saves write that JSON: "Save AI models" (saveLlm) and the menu controls
// (saveModelMenu). Each must keep what the other owns. getConfig used to rebuild
// llm from enabled, scoreThreshold and models only, which would have silently
// dropped the menu on every read.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { saveLlm, saveModelMenu, saveGates } from '../src/console/routes';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, type ModelMenuConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'menu.myshopify.com';
const MENU: ModelMenuConfig = { providers: ['anthropic', 'x-ai'], pins: ['openai/gpt-5.6-luna'], hides: ['anthropic/claude-opus-5.5'] };
const GATES = { popularityFloor: 50, priceMin: 5, priceMax: 80, relevance: 'title' as const };

async function seed(llm = DEFAULT_LLM): Promise<TenantStore> {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await store.seedConfig({
    collectionMap: {}, gates: GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm,
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 16,
  });
  return store;
}

describe('llm.menu storage', () => {
  it('getConfig round-trips llm.menu', async () => {
    const store = await seed({ ...DEFAULT_LLM, menu: MENU });
    expect((await store.getConfig())!.llm.menu).toEqual(MENU);
  });

  it('getConfig drops a malformed stored menu instead of throwing', async () => {
    const store = await seed();
    await env.DB.prepare('UPDATE tenant_config SET llm = ?1 WHERE shop = ?2').bind('{"menu":{"providers":"x"}}', SHOP).run();
    expect((await store.getConfig())!.llm.menu).toBeUndefined();
  });

  it('saveLlm keeps the stored menu', async () => {
    const store = await seed();
    await saveModelMenu(env.DB, SHOP, MENU);
    await saveLlm(env.DB, SHOP, { enabled: true, scoreThreshold: 70, models: { text: 'openai/gpt-5.6-luna' } });
    const llm = (await store.getConfig())!.llm;
    expect(llm.menu).toEqual(MENU);
    expect(llm.scoreThreshold).toBe(70);
  });

  it('saveModelMenu keeps models (with efforts), enabled and scoreThreshold', async () => {
    const store = await seed();
    const models = { text: 'openai/gpt-5.6-luna', fallback: 'openai/gpt-5.6-luna', textEffort: 'high' as const };
    await saveLlm(env.DB, SHOP, { enabled: false, scoreThreshold: 42, models });
    await saveModelMenu(env.DB, SHOP, MENU);
    expect((await store.getConfig())!.llm).toEqual({ enabled: false, scoreThreshold: 42, models, menu: MENU });
  });

  it('a gates save keeps the menu', async () => {
    const store = await seed();
    await saveModelMenu(env.DB, SHOP, MENU);
    await saveGates(env.DB, SHOP, { ...GATES, popularityFloor: 60 });
    expect((await store.getConfig())!.llm.menu).toEqual(MENU);
  });
});
