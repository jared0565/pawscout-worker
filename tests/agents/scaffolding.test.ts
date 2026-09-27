/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../../src/tenant-store';
import { LlmClient } from '../../src/llm';
import { draftReply } from '../../src/inbox/draft';
import { SHARED_SCAFFOLDING, STORE_FACTS } from '../../src/inbox/agents/scaffolding';
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

/** Captures the drafter's system prompt via draftReply itself, for tests that need
 * to pass extra draftReply input (such as `reading`) beyond what capturingLlm's
 * caller-assembled CFG/base input covers. */
async function captureDraftSystem(extra: Record<string, unknown> = {}) {
  const sink = { system: '' };
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    sink.system = JSON.parse(String(init.body)).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ customerAsks: ['q'], bodyText: 'Yes, we ship to Germany, and the cost is shown at checkout before payment.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false }) } }], usage: { cost: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const { draftReply } = await import('../../src/inbox/draft');
  const { LlmClient } = await import('../../src/llm');
  const { TenantStore } = await import('../../src/tenant-store');
  const { otherAgent } = await import('../../src/inbox/agents/other');
  const { DEFAULT_INBOX } = await import('../../src/inbox/types');
  const { DEFAULT_LLM } = await import('../../src/types');
  await draftReply(new LlmClient({ openrouter: 'k' }, fetchImpl), new TenantStore(env.DB, 'a.myshopify.com'),
    { llm: DEFAULT_LLM, inbox: { ...DEFAULT_INBOX } } as any,
    { agent: otherAgent, grounding: { confident: true, facts: '', quotesFigure: false }, subject: 's', conversation: 'Customer: Do you ship to Germany?', latestMessage: 'Do you ship to Germany?', ...extra } as any);
  return sink;
}

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

// Owner rule 2026-09-17 (prove-first). The shared scaffolding beats every
// agent's own prompt, so as long as it told every agent to decline a marketing
// pitch with "not something we are looking into right now", 29 vendors in 30
// days got exactly that blank decline. It now points a pitch at the prove-first
// rule, and a goods supplier at a thank-you with no commitment.
describe('shared scaffolding pitch rule (prove-first)', () => {
  it('no longer tells every agent to decline a marketing pitch blankly', () => {
    expect(SHARED_SCAFFOLDING).not.toContain('not something we are looking into right now');
    expect(SHARED_SCAFFOLDING).toContain('prove-first');
    expect(SHARED_SCAFFOLDING).toContain('SUPPLY US goods');
    // the WhatsApp rule survives on its own
    expect(SHARED_SCAFFOLDING).toContain('move to WhatsApp');
  });
  // Owner follow-up 2026-09-17: every agent, with or without the partnership
  // stance, refuses store access plainly; it is never a question of trust or
  // timing, and it never leaks a collaborator request code.
  it('tells every agent that store access is never granted and the request code is never shared', () => {
    expect(SHARED_SCAFFOLDING).toContain('collaborator or staff access');
    expect(SHARED_SCAFFOLDING).toContain('collaborator request code');
  });
});

// Sofia thread (2026-09-19/20). Asked "if five customers order at the same time,
// can you fulfil them all?", the drafter answered that fulfilment arrangements
// and capacity "are kept private": the BUSINESS ITSELF rule swallowed a buying
// question, and that reply was sent. Owner rule 2026-09-21: a quantity is a
// purchase. The store facts now say how a quantity is ordered and where its
// delivery cost appears, and the privacy rule names the carve-out itself,
// because the shared scaffolding beats every agent's own prompt.
describe('quantity purchases (shared store facts and the privacy carve-out)', () => {
  // Measured at the live checkout on 2026-09-21: one flat delivery rate per order
  // per origin, the same for 1 unit as for 5, FREE to the UK for a China-held
  // item. "The number of items" was the supplier's cost to us, never the
  // customer's line, and it is gone from every fact.
  it('store facts say any quantity can be ordered on the website and delivery depends on destination and basket, priced at checkout', () => {
    expect(STORE_FACTS).toMatch(/any quantity/i);
    expect(STORE_FACTS).toMatch(/several orders/i);
    expect(STORE_FACTS).toMatch(/destination and what is in the (?:order|basket)/i);
    expect(STORE_FACTS).not.toMatch(/number of items/i);
    // the sentence the older shipping test pins is still there, word for word
    expect(STORE_FACTS).toContain('Shipping cost is calculated by destination');
    expect(STORE_FACTS).toContain('shown exactly at checkout');
  });
  // First real draft after the fix (2026-09-21): the purchase was welcomed but the
  // delivery sentence was dropped, because the workflow rule says to answer only
  // what was asked. The facts now say it is part of the answer to "how do I buy".
  it('store facts say a buyer of several is told about basket delivery even when they did not ask', () => {
    expect(STORE_FACTS).toMatch(/several items or several orders, always tell them/i);
    expect(STORE_FACTS).toMatch(/even if they did not ask about delivery/i);
  });
  it('store facts forbid reading a quantity as a wholesale request', () => {
    expect(STORE_FACTS).toMatch(/never treat a quantity[^.]*as a wholesale or trade request/i);
  });
  it('the BUSINESS ITSELF rule no longer covers "can you fulfil my order(s)"', () => {
    expect(SHARED_SCAFFOLDING).toMatch(/whether we can supply or fulfil[^.]*is NOT a question about the business/i);
    expect(SHARED_SCAFFOLDING).toMatch(/never answer (?:it|one) with the privacy reply/i);
    // the privacy rule itself stands
    expect(SHARED_SCAFFOLDING).toContain('BUSINESS ITSELF');
    expect(SHARED_SCAFFOLDING).toContain('details about the business are something we keep private');
  });
});

// Owner design 2026-09-17: "is there a running event?" must get a grounded
// answer. Every draft carries the storewide event facts from the same feed the
// storefront reads: the running event with its code and end date, or that
// nothing runs (with the next event by name and dates only), or a hedge when
// the feed is cold and Shopify is unreachable.
describe('storewide event facts in the system prompt', () => {
  it('injects the running event with its code and end date when the feed says so', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putSearchCache('public:event', JSON.stringify({
      active: true, name: 'Black Friday to Cyber Monday', code: 'BLACKFRIDAY', pctOff: 15,
      endsAt: '2026-11-30T23:59:59.000Z', endsLabel: '30 November'
    }), 1);
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, { agent: stubAgent(false), grounding: GROUNDING, subject: 'Sale?', conversation: 'Is there a sale on?' });
    expect(sink.system).toContain('BLACKFRIDAY');
    expect(sink.system).toContain('15%');
    expect(sink.system).toContain('30 November');
  });
  it('hedges when the feed is cold and no Shopify client is available', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, { agent: stubAgent(false), grounding: GROUNDING, subject: 'Sale?', conversation: 'Is there a sale on?' });
    expect(sink.system).toMatch(/not known to you/i);
    expect(sink.system).toMatch(/do not invent a code/i);
  });
});

// Task 7 (2026-09-27): the drafter now reads the thread reading (Task 3) and
// grounds its reply in it, and the sender rules move from three separate dated
// sentences into ONE ordered block keyed by WHO IS WRITING.
describe('drafter grounded in the thread reading', () => {
  it('grounds the drafter in the thread reading when one is given', async () => {
    const { validateReading } = await import('../../src/inbox/thread-read');
    const reading = validateReading({ senderRole: 'customer', openAsks: ['Do you ship to Germany?'], offered: '', alreadyAnswered: ['Yes, this is Active Paw'], replyNeeded: true });
    const sink = await captureDraftSystem({ reading });
    expect(sink.system).toContain('THREAD READING');
    expect(sink.system).toContain('Do you ship to Germany?');
  });
});

describe('sender rules in one ordered block', () => {
  it('keys the sender rules in one ordered block, with the vague-opener rule steering to products or orders', () => {
    expect(SHARED_SCAFFOLDING).toContain('WHO IS WRITING');
    expect(SHARED_SCAFFOLDING).toMatch(/is this Active Paw/);
    expect(SHARED_SCAFFOLDING).toMatch(/question about our products or an order/);
    expect(SHARED_SCAFFOLDING).toMatch(/never invite them to share ideas/i);
    expect(SHARED_SCAFFOLDING).toMatch(/warehousing, fulfilment or logistics/);
    // en dash (8211) / em dash (8212), built via char code: typing the escape
    // literally into a file-writing tool can come out as the real glyph.
    expect(SHARED_SCAFFOLDING).not.toContain(String.fromCharCode(8211));
    expect(SHARED_SCAFFOLDING).not.toContain(String.fromCharCode(8212));
  });

  // Controller ruling (2026-09-27): the shared rule wins over the supplier
  // agent's own prompt, so it must not read as forbidding the supplier lane's
  // two informational asks (the website/store link, and, for goods or
  // packaging only, whether they dropship).
  it('names the supplier lane\'s two asks as information gathering, not a commitment', () => {
    expect(SHARED_SCAFFOLDING).toContain('information gathering, not a commitment');
  });
});
