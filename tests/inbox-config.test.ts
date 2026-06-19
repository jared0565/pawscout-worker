/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL
} from '../src/types';
import { DEFAULT_INBOX } from '../src/inbox/types';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function seed(store: TenantStore) {
  return store.seedConfig({
    collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS,
    fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
  });
}

describe('inbox config', () => {
  it('defaults inbox when the column is empty', async () => {
    const s = new TenantStore(env.DB, 'a.myshopify.com');
    await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    await seed(s);
    const cfg = await s.getConfig();
    expect(cfg?.inbox.enabled).toBe(true);
    expect(cfg?.inbox.intentThreshold).toBe(70);
    expect(cfg?.inbox.autosend).toBe(false);
    expect(cfg?.inbox.labels).toContain('lead');
    expect(cfg?.inbox.autoConfidenceThreshold).toBe(80);
    expect(cfg?.inbox.replyGuidance).toBe('');
    expect(cfg?.inbox.autoInvoice).toBe(false);
    expect(cfg?.inbox.invoiceConfidenceThreshold).toBe(95);
    expect(cfg?.inbox.invoiceValueCeiling).toBe(250);
    expect(cfg?.inbox.invoiceRateLimit).toBe(2);
  });

  it('saveInbox round-trips and is scoped to shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    await seed(a);
    await a.saveInbox({ ...DEFAULT_INBOX, alertEmail: 'owner@gmail.com', intentThreshold: 80 });
    const cfg = await a.getConfig();
    expect(cfg?.inbox.alertEmail).toBe('owner@gmail.com');
    expect(cfg?.inbox.intentThreshold).toBe(80);
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getConfig()).toBeNull();
  });
});
