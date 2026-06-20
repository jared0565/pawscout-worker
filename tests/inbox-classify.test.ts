/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { classifyEmail, decideDisposition } from '../src/inbox/classify';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const CFG: TenantConfig = {
  collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
  pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS,
  fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
};

// A fake OpenRouter that returns a fixed chat-completion JSON body.
function fakeLlm(content: unknown): LlmClient {
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 }
  }), { status: 200 })) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'test-key' }, fetchImpl);
}

describe('classifyEmail', () => {
  it('returns a validated classification and logs usage', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ isHuman: true, category: 'lead', intentScore: 85, summary: 'Wants to buy a bed', labels: ['lead', 'product-question'] });
    const c = await classifyEmail(llm, store, CFG, { subject: 'Beds', body: 'I want to buy the large bed', fromEmail: 'jane@x.com', auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } });
    expect(c).not.toBeNull();
    expect(c!.category).toBe('lead');
    expect(c!.intentScore).toBe(85);
    const spend = await store.llmSpendSince('2000-01-01T00:00:00Z');
    expect(spend.calls).toBe(1);
  });

  it('returns null when the model emits an unknown category', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ isHuman: true, category: 'nonsense', intentScore: 50, summary: 'x', labels: [] });
    expect(await classifyEmail(llm, store, CFG, { subject: 's', body: 'b', fromEmail: 'a@b.com', auth: { spf: 'none', dkim: 'none', dmarc: 'none' } })).toBeNull();
  });

  it('returns null when the LLM has no key (degrades, never throws)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const c = await classifyEmail(new LlmClient({}), store, CFG, { subject: 's', body: 'b', fromEmail: 'a@b.com', auth: { spf: 'none', dkim: 'none', dmarc: 'none' } });
    expect(c).toBeNull();
  });
});

describe('decideDisposition', () => {
  it('routes a hot human lead to needs_reply with alert', () => {
    const d = decideDisposition({ isHuman: true, category: 'lead', intentScore: 90, summary: 's', labels: ['lead'] });
    expect(d.status).toBe('needs_reply');
    expect(d.primaryCategory).toBe('lead');
    expect(d.alert).toBe(true);
  });
  it('routes a non-human message to spam, no alert', () => {
    const d = decideDisposition({ isHuman: false, category: 'spam', intentScore: 0, summary: 's', labels: ['spam'] });
    expect(d.status).toBe('spam');
    expect(d.alert).toBe(false);
  });
  it('routes a low-intent human question to needs_reply without alert', () => {
    const d = decideDisposition({ isHuman: true, category: 'product-question', intentScore: 20, summary: 's', labels: ['product-question'] });
    expect(d.status).toBe('needs_reply');
    expect(d.alert).toBe(false);
  });
  it('ALWAYS alerts on an affiliate enquiry, even at low buying-intent', () => {
    const d = decideDisposition({ isHuman: true, category: 'affiliate', intentScore: 15, summary: 'commission partnership pitch', labels: ['affiliate'] });
    expect(d.status).toBe('needs_reply');
    expect(d.primaryCategory).toBe('affiliate');
    expect(d.alert).toBe(true); // surfaced regardless of intentScore (it's a partnership opportunity, not a purchase)
  });
});
