/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { draftReply, renderReplyHtml } from '../src/inbox/draft';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

function fakeLlm(content: unknown): LlmClient {
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
  return new LlmClient('k', f);
}

describe('renderReplyHtml', () => {
  it('escapes and paragraph-wraps plain text (no raw HTML survives)', () => {
    const h = renderReplyHtml('Hi <script>x</script>\n\nThanks');
    expect(h).toContain('&lt;script&gt;');
    expect(h).not.toContain('<script>');
    expect(h).toContain('<p>');
  });
});

describe('draftReply', () => {
  it('returns a validated draft + logs usage', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ bodyText: 'Hi Jane, yes we ship to Ireland in 5-7 days.', confidence: 92, quotesPriceOrOrder: false });
    const d = await draftReply(llm, store, CFG, { subject: 'Shipping', conversation: 'Do you ship to Ireland?', category: 'product-question' });
    expect(d?.bodyText).toContain('Ireland');
    expect(d?.confidence).toBe(92);
    expect((await store.llmSpendSince('2000-01-01T00:00:00Z')).calls).toBe(1);
  });
  it('returns null on unusable output (empty body)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    expect(await draftReply(fakeLlm({ bodyText: '', confidence: 90, quotesPriceOrOrder: false }), store, CFG, { subject: 's', conversation: 'b', category: 'other' })).toBeNull();
  });
  it('returns null when the LLM has no key', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    expect(await draftReply(new LlmClient(undefined), store, CFG, { subject: 's', conversation: 'b', category: 'other' })).toBeNull();
  });
});
