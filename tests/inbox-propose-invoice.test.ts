/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { proposeInvoice } from '../src/inbox/propose-invoice';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

function fakeLlm(content: unknown): LlmClient {
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
  return new LlmClient('k', f);
}

describe('proposeInvoice', () => {
  it('passes through a valid invoice-moment payload and logs usage', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({
      isInvoiceMoment: true,
      lineRequests: [{ query: 'red dog collar', qty: 2 }],
      coverText: 'Happy to set that up.',
      confidence: 92
    });
    const result = await proposeInvoice(llm, store, CFG, {
      subject: 'Order enquiry',
      conversation: 'Hi, I would like to buy 2 red dog collars please.',
      category: 'lead'
    });
    expect(result).not.toBeNull();
    expect(result?.isInvoiceMoment).toBe(true);
    expect(result?.lineRequests).toHaveLength(1);
    expect(result?.lineRequests[0].query).toBe('red dog collar');
    expect(result?.lineRequests[0].qty).toBe(2);
    expect(result?.coverText).toBe('Happy to set that up.');
    expect(result?.confidence).toBe(92);
    expect((await store.llmSpendSince('2000-01-01T00:00:00Z')).calls).toBe(1);
  });

  it('passes through isInvoiceMoment:false with empty lineRequests', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({
      isInvoiceMoment: false,
      lineRequests: [],
      coverText: '',
      confidence: 30
    });
    const result = await proposeInvoice(llm, store, CFG, {
      subject: 'Hi',
      conversation: 'Just browsing, thanks!',
      category: 'other'
    });
    expect(result).not.toBeNull();
    expect(result?.isInvoiceMoment).toBe(false);
    expect(result?.lineRequests).toHaveLength(0);
  });

  it('returns null when qty is 0 (validate rejects malformed payload)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({
      isInvoiceMoment: true,
      lineRequests: [{ query: 'dog collar', qty: 0 }],
      coverText: 'Sure!',
      confidence: 80
    });
    expect(await proposeInvoice(llm, store, CFG, {
      subject: 's', conversation: 'b', category: 'lead'
    })).toBeNull();
  });

  it('returns null when a required field is missing', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({
      isInvoiceMoment: true,
      // lineRequests missing
      coverText: 'Sure!',
      confidence: 80
    });
    expect(await proposeInvoice(llm, store, CFG, {
      subject: 's', conversation: 'b', category: 'lead'
    })).toBeNull();
  });

  it('returns null when coverText exceeds 1000 chars', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({
      isInvoiceMoment: true,
      lineRequests: [{ query: 'cat toy', qty: 1 }],
      coverText: 'x'.repeat(1001),
      confidence: 80
    });
    expect(await proposeInvoice(llm, store, CFG, {
      subject: 's', conversation: 'b', category: 'lead'
    })).toBeNull();
  });

  it('returns null when LLM has no key', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    expect(await proposeInvoice(new LlmClient(undefined), store, CFG, {
      subject: 's', conversation: 'b', category: 'other'
    })).toBeNull();
  });
});
