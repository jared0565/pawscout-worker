/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { draftReply, renderReplyHtml } from '../src/inbox/draft';
import { DEFAULT_INBOX } from '../src/inbox/types';
import type { CategoryAgent, Grounding } from '../src/inbox/agents/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

// A minimal stub agent: emits a recognisable fragment token and never appends. The
// generic-drafter behaviour (fragment + facts injection, commercialIntent) is covered
// by tests/agents/draft-generic.test.ts; here we exercise the validate/log/salutation path.
const stubAgent: CategoryAgent = {
  category: 'other', displayName: 'X', description: '', commercial: false,
  async ground() { return { confident: false, facts: '', quotesFigure: false }; },
  promptFragment() { return 'STUB-FRAGMENT'; },
  deterministicAppendix() { return null; }
};
const GROUNDING: Grounding = { confident: false, facts: '', quotesFigure: false };
const base = { agent: stubAgent, grounding: GROUNDING };

function fakeLlm(content: unknown): LlmClient {
  const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'k' }, f);
}

/** Captures the OpenRouter request body so tests can inspect the system + user prompt. */
function capturingLlm(content: unknown, sink: { system?: string; user?: string }): LlmClient {
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role: string; content: string }[] };
    sink.system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
    sink.user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0001 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'k' }, f);
}

/** Returns a different JSON content per call, in order, for exercising the revise loop. */
function sequenceLlm(contents: unknown[]): LlmClient {
  let i = 0;
  const f = (async () => {
    const content = contents[Math.min(i, contents.length - 1)];
    i++;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0001 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'k' }, f);
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
    const d = await draftReply(llm, store, CFG, { ...base, subject: 'Shipping', conversation: 'Do you ship to Ireland?' });
    expect(d?.bodyText).toContain('Ireland');
    expect(d?.confidence).toBe(92);
    expect((await store.llmSpendSince('2000-01-01T00:00:00Z')).calls).toBe(1);
  });
  it('returns null on unusable output (empty body)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    expect(await draftReply(fakeLlm({ bodyText: '', confidence: 90, quotesPriceOrOrder: false }), store, CFG, { ...base, subject: 's', conversation: 'b' })).toBeNull();
  });
  it('returns null when the LLM has no key', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    expect(await draftReply(new LlmClient({}), store, CFG, { ...base, subject: 's', conversation: 'b' })).toBeNull();
  });

  it('injects the agent prompt fragment into the system prompt', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi there.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, { ...base, subject: 's', conversation: 'b' });
    expect(sink.system).toContain('STUB-FRAGMENT');
  });

  it('self-corrects a filler-padded first draft via the runtime revise loop', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const padded = { bodyText: 'Thank you for getting in touch! We do ship to Ireland.', confidence: 80, quotesPriceOrOrder: false };
    const clean = { bodyText: 'Yes, we ship to Ireland. Your tracking link follows on dispatch.', confidence: 88, quotesPriceOrOrder: false };
    const llm = sequenceLlm([padded, clean]);
    const d = await draftReply(llm, store, CFG, { ...base, subject: 'Shipping', conversation: 'Do you ship to Ireland?', latestMessage: 'Do you ship to Ireland?' });
    expect(d?.bodyText).toContain('Yes, we ship to Ireland');
    expect(d?.bodyText).not.toMatch(/thank you for getting in touch|do not hesitate/i);
  });
});

describe('draftReply salutation', () => {
  it('opens with the customer first name from the contact record', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ bodyText: 'Yes, we ship to Ireland in 5-7 days.', confidence: 92, quotesPriceOrOrder: false });
    const d = await draftReply(llm, store, CFG, { ...base, subject: 'Shipping', conversation: 'Do you ship to Ireland?', customerName: 'Jane Smith' });
    expect(d?.bodyText.startsWith('Hi Jane,\n\n')).toBe(true);
    expect(d?.bodyText).toContain('Ireland');
  });

  it('falls back to "Hi there," when there is no usable name', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ bodyText: 'Yes, we can help.', confidence: 80, quotesPriceOrOrder: false });
    const d = await draftReply(llm, store, CFG, { ...base, subject: 's', conversation: 'b', customerName: null });
    expect(d?.bodyText.startsWith('Hi there,\n\n')).toBe(true);
  });

  it('rejects role-inbox / non-name display names and uses the fallback', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ bodyText: 'Thanks for getting in touch.', confidence: 80, quotesPriceOrOrder: false });
    for (const junk of ['info', 'sales@shop.com', '   ', '123']) {
      const d = await draftReply(llm, store, CFG, { ...base, subject: 's', conversation: 'b', customerName: junk });
      expect(d?.bodyText.startsWith('Hi there,')).toBe(true);
    }
  });

  it('title-cases a shouty display name (JANE -> Jane)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ bodyText: 'Happy to help.', confidence: 80, quotesPriceOrOrder: false });
    const d = await draftReply(llm, store, CFG, { ...base, subject: 's', conversation: 'b', customerName: 'JANE' });
    expect(d?.bodyText.startsWith('Hi Jane,')).toBe(true);
  });

  it('strips an inline greeting the model added anyway (no double salutation)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ bodyText: 'Hi Jane, thanks for your message - yes we can help.', confidence: 88, quotesPriceOrOrder: false });
    const d = await draftReply(llm, store, CFG, { ...base, subject: 's', conversation: 'b', customerName: 'Jane' });
    expect(d?.bodyText.startsWith('Hi Jane,\n\nthanks for your message')).toBe(true);
    expect(d?.bodyText).not.toMatch(/Hi Jane,[\s\S]*Hi Jane,/); // exactly one salutation
  });

  it('strips an own-line greeting too', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const llm = fakeLlm({ bodyText: 'Hello there,\n\nYes, we are open and shipping.', confidence: 85, quotesPriceOrOrder: false });
    const d = await draftReply(llm, store, CFG, { ...base, subject: 's', conversation: 'b', customerName: 'Bob' });
    expect(d?.bodyText.startsWith('Hi Bob,\n\nYes, we are open')).toBe(true);
  });

  it('instructs the model not to add its own greeting', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Yes.', confidence: 80, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, { ...base, subject: 's', conversation: 'b', customerName: 'Jane' });
    expect(sink.system).toMatch(/Do NOT open with a greeting or salutation/i);
  });
});
