/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../../src/tenant-store';
import { LlmClient } from '../../src/llm';
import { draftReply } from '../../src/inbox/draft';
import { DEFAULT_INBOX } from '../../src/inbox/types';
import type { CategoryAgent, Grounding } from '../../src/inbox/agents/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const CFG: TenantConfig = {
  collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
  pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS,
  fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
};

/** Minimal stub agent for testing scaffolding composition. */
const stubAgent = (commercial: boolean): CategoryAgent => ({
  category: 'other', displayName: 'Test', description: 'test agent', department: 'sales',
  commercial,
  async ground() { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment() { return 'TEST-FRAGMENT'; },
  deterministicAppendix() { return null; }
});

const GROUNDING: Grounding = { confident: true, facts: '', quotesFigure: false };

/** Captures the OpenRouter request body so tests can inspect the system prompt. */
function capturingLlm(content: unknown, sink: { system?: string; user?: string }): LlmClient {
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role: string; content: string }[] };
    sink.system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
    sink.user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0001 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'k' }, f);
}

describe('draftReply scaffolding invariants', () => {
  it('includes the anti-fabrication WORKFLOW rule in the system prompt', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Test', conversation: 'What about shipping?'
    });
    expect(sink.system).toContain('answer ONLY those, grounded in the facts');
    expect(sink.system).toContain('never answer a question they did not ask, and never invent one');
  });

  // Rose thread (2026-09-06), first regeneration under the fixed routing: the
  // draft answered only her bump and skipped the question in her first message
  // (never answered by us), and answered "can I reach you directly" with "our
  // website". WORKFLOW step (1) said "their latest message" and won over a
  // later sentence; the step itself now includes an earlier customer question
  // with no reply from us. And "how do I reach you" needs a grounded answer:
  // the public support address is a store fact.
  it('WORKFLOW step (1) covers an earlier customer question that we never answered', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, { agent: stubAgent(false), grounding: GROUNDING, subject: 'Test', conversation: 'Customer: a?\n\nCustomer: b?', latestMessage: 'b?' });
    expect(sink.system).toMatch(/\(1\) identify exactly what the customer is actually asking in their latest message[^;]*earlier customer message[^;]*no reply from us/i);
  });

  it('store facts carry the public support address so "how do I reach you" is answerable', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, { agent: stubAgent(false), grounding: GROUNDING, subject: 'Test', conversation: 'How can I reach you?' });
    expect(sink.system).toContain('contact@activepaw.co.uk');
    expect(sink.system).toMatch(/one working day/);
  });

  it('includes MOST RECENT grounding when latestMessage is provided', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Test', conversation: 'Earlier message', latestMessage: 'Latest message'
    });
    expect(sink.system).toContain("MOST RECENT message specifically");
    expect(sink.system).toMatch(/role-labeled transcript/i);
  });

  it('excludes MOST RECENT grounding when latestMessage is absent', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Test', conversation: 'Only message'
    });
    expect(sink.system).not.toContain("MOST RECENT message specifically");
    expect(sink.system).not.toMatch(/role-labeled transcript/i);
  });

  it('states shipping is destination-calculated / shown at checkout, with NO stale flat figures', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Shipping', conversation: 'What is shipping cost?'
    });
    expect(sink.system).toContain('Shipping cost is calculated by destination');
    expect(sink.system).toContain('shown exactly at checkout');
    // the stale flat published rates must be gone from every reply
    expect(sink.system).not.toContain('flat GBP 4.99');
    expect(sink.system).not.toContain('GBP 14.99');
    expect(sink.system).not.toContain('GBP 23.99');
  });

  it('injects the live free-UK clause only when gbFreeUkLive is on', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const off: { system?: string } = {};
    await draftReply(capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, off), store,
      { ...CFG, fulfil: { ...CFG.fulfil, gbFreeUkLive: false } },
      { agent: stubAgent(false), grounding: GROUNDING, subject: 'Shipping', conversation: 'Do you offer free shipping?' });
    expect(off.system).not.toContain('UK delivery is currently free');

    const on: { system?: string } = {};
    await draftReply(capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, on), store,
      { ...CFG, fulfil: { ...CFG.fulfil, gbFreeUkLive: true } },
      { agent: stubAgent(false), grounding: GROUNDING, subject: 'Shipping', conversation: 'Do you offer free shipping?' });
    expect(on.system).toContain('UK delivery is currently free');
  });

  it('grounds the one true store web address so the model never guesses activepaw.com', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Store link', conversation: 'Could you send me the link to your store?'
    });
    expect(sink.system).toContain('https://activepaw.co.uk');
    expect(sink.system).toContain('ONLY Active Paw web address');
    expect(sink.system).toContain('there is no activepaw.com');
  });

  it('includes COMMERCIAL_GUARDRAILS when agent.commercial is true', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(true), grounding: GROUNDING,
      subject: 'Test', conversation: 'What about your products?'
    });
    expect(sink.system).toContain('Commercial objective: gently advance the sale');
  });

  it('excludes COMMERCIAL_GUARDRAILS when agent.commercial is false', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Test', conversation: 'What about your products?'
    });
    expect(sink.system).not.toContain('Commercial objective: gently advance the sale');
  });

  it('includes owner guidance when cfg.inbox.replyGuidance is set', async () => {
    const cfgWithGuidance = { ...CFG, inbox: { ...CFG.inbox, replyGuidance: 'End with "Best, Active Paw"' } };
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, cfgWithGuidance, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Test', conversation: 'Hello'
    });
    expect(sink.system).toContain('Owner guidance - follow exactly');
    expect(sink.system).toContain('End with "Best, Active Paw"');
  });

  it('excludes owner guidance when cfg.inbox.replyGuidance is not set', async () => {
    const cfgNoGuidance = { ...CFG, inbox: { ...CFG.inbox, replyGuidance: '' } };
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, cfgNoGuidance, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Test', conversation: 'Hello'
    });
    expect(sink.system).not.toContain('Owner guidance - follow exactly');
  });

  it('injects previously approved answers with the override and no-personal-details rules', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Shipping', conversation: 'Do you deliver worldwide?',
      recall: [{ question: 'Do you ship worldwide?', answer: 'Yes, we ship internationally to most countries.' }],
    });
    expect(sink.system).toContain('Previously approved answers to similar past questions');
    expect(sink.system).toContain('the facts above WIN');
    expect(sink.system).toContain('NEVER copy personal details');
    expect(sink.system).toContain('[Q: Do you ship worldwide? A: Yes, we ship internationally to most countries.]');
  });

  it('omits the recall block when no recall is provided', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING, subject: 'Shipping', conversation: 'Do you deliver worldwide?'
    });
    expect(sink.system).not.toContain('Previously approved answers');
  });
});
