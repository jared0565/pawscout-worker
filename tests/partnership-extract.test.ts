/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { extractScreenFacts } from '../src/inbox/partnership';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

// A fetch stub that returns one OpenRouter-shaped chat completion with `content`.
function llmReturning(content: string): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 }
  }), { status: 200 })) as unknown as typeof fetch;
}

const validFacts = JSON.stringify({
  channelUrls: ['https://tiktok.com/@dogmum'], disqualifier: 'none', audienceRelevance: 'pet_uk',
  acceptsTerms: 'yes', engagement: 'plausible', evidence: 'concrete', experience: 'some',
  method: 'content', specificity: 'specific'
});

describe('extractScreenFacts', () => {
  it('parses + validates the controlled-vocabulary JSON', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = new LlmClient({ openrouter: 'k' }, llmReturning(validFacts));
    const facts = await extractScreenFacts(llm, store, CFG, 'my tiktok is @dogmum, 8k UK dog owners, honest review, fine with #ad and performance');
    expect(facts).not.toBeNull();
    expect(facts!.channelUrls).toEqual(['https://tiktok.com/@dogmum']);
    expect(facts!.method).toBe('content');
  });
  it('returns null on an invalid enum (degrade → caller escalates)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const bad = JSON.stringify({ ...JSON.parse(validFacts), method: 'telepathy' });
    const llm = new LlmClient({ openrouter: 'k' }, llmReturning(bad));
    expect(await extractScreenFacts(llm, store, CFG, 'x')).toBeNull();
  });
  it('returns null when the LLM is unavailable (no keys)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = new LlmClient({}, llmReturning(validFacts));
    expect(await extractScreenFacts(llm, store, CFG, 'x')).toBeNull();
  });
});
