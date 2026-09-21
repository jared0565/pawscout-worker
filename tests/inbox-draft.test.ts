/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { draftReply, renderReplyHtml, openInboundText, openInboundTexts } from '../src/inbox/draft';
import { DEFAULT_INBOX } from '../src/inbox/types';
import type { CategoryAgent, Grounding } from '../src/inbox/agents/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

// A minimal stub agent: emits a recognisable fragment token and never appends. The
// generic-drafter behaviour (fragment + facts injection, commercialIntent) is covered
// by tests/agents/draft-generic.test.ts; here we exercise the validate/log/salutation path.
const stubAgent: CategoryAgent = {
  category: 'other', displayName: 'X', description: '', department: 'sales', commercial: false,
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

  // Owner ask 2026-07-12: URLs in replies must be REAL anchors - client-side
  // auto-linking of bare text is unreliable (Outlook desktop often renders
  // dead text). Linkify runs on the raw text with per-segment escaping, so
  // the no-raw-HTML guarantee above is unchanged.
  it('turns http(s) URLs into anchors, leaving trailing prose punctuation outside', () => {
    const h = renderReplyHtml('See https://activepaw.co.uk/products/dog-bed. More at https://example.com/a?b=1&c=2 today.');
    expect(h).toContain('<a href="https://activepaw.co.uk/products/dog-bed">https://activepaw.co.uk/products/dog-bed</a>.');
    expect(h).toContain('<a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a> today.');
    expect(h).not.toContain('b=1&c'); // ampersands entity-escaped inside href and text
  });

  it('links a BARE store-domain mention with an https href', () => {
    const h = renderReplyHtml('Browse activepaw.co.uk/collections/pet-toys or just activepaw.co.uk today');
    expect(h).toContain('<a href="https://activepaw.co.uk/collections/pet-toys">activepaw.co.uk/collections/pet-toys</a>');
    expect(h).toContain('<a href="https://activepaw.co.uk">activepaw.co.uk</a> today');
  });

  it('never mangles email addresses on the store domain', () => {
    const h = renderReplyHtml('Contact support@activepaw.co.uk anytime');
    expect(h).not.toContain('<a');
    expect(h).toContain('support@activepaw.co.uk');
  });

  it('still neutralizes raw HTML around and inside URLs', () => {
    const h = renderReplyHtml('click <a href="https://evil.com">here</a>');
    expect(h).toContain('&lt;a href=');
    expect(h).not.toContain('<a href="https://evil.com">here'); // the injected tag never survives as markup
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

  // Rose thread (2026-09-05/06): her first message asked whether products
  // arrive as described, the reply to it was superseded before it went out, and
  // her bump asked something else. "Answer the MOST RECENT message" alone lets
  // the drafter drop a question we never answered. The prompt now names that
  // case: a question in an earlier customer turn with no Active Paw reply after
  // it is still open and gets answered too.
  it('tells the drafter that an earlier customer question with no reply from us is still open', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Yes.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      ...base, subject: 'Quick question',
      conversation: 'Customer: Do the products arrive exactly as shown?\n\nCustomer: Just checking back in, can I reach you directly?',
      latestMessage: 'Just checking back in, can I reach you directly?',
    });
    expect(sink.system).toMatch(/earlier customer message .* no "Active Paw:" reply .* still open/i);
  });

  it('teaches the drafter the conversation is a two-sided role-labeled transcript, and passes it through', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string; user?: string } = {};
    const llm = capturingLlm({ bodyText: 'Around 5-7 days.', confidence: 85, quotesPriceOrOrder: false }, sink);
    const transcript =
      'Customer: Do you deliver to Spain?\n\n' +
      'Active Paw: Yes, we ship to Spain; cost shows at checkout.\n\n' +
      'Customer: Great, and how long does it take?';
    await draftReply(llm, store, CFG, {
      ...base, subject: 'Shipping', conversation: transcript, latestMessage: 'Great, and how long does it take?',
    });
    // Prompt now frames the transcript and its trust boundary.
    expect(sink.system).toMatch(/role-labeled transcript/i);
    expect(sink.system).toMatch(/"Active Paw:" are our own earlier replies/i);
    expect(sink.system).toMatch(/UNTRUSTED/);
    // Our own prior reply actually reaches the model, so the follow-up is answerable.
    expect(sink.user).toContain('Active Paw: Yes, we ship to Spain');
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

// Sofia thread (2026-09-20): the customer's own words reach the runtime gate, so
// a trade decline she never asked for is rewritten before anyone reviews it, and
// the same decline stands untouched for a customer who did ask for terms.
describe('draftReply sends a volunteered trade decline back for a rewrite', () => {
  const decline = { bodyText: 'We are focused on individual retail orders and are not offering wholesale or trade terms at the moment. You are welcome to place individual orders through https://activepaw.co.uk.', confidence: 98, quotesPriceOrOrder: false };
  const helpful = { bodyText: 'Yes, you can order as many as you need through https://activepaw.co.uk. The delivery cost for the whole basket depends on the number of items and your destination, and it is shown at checkout before payment. Which product do you have in mind?', confidence: 90, quotesPriceOrOrder: false };

  it('rewrites it when the customer only mentioned a quantity', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const ask = 'I have 5 customers who need this product for an event in two weeks. Is it available?';
    const d = await draftReply(sequenceLlm([decline, helpful]), store, CFG, { ...base, subject: '', conversation: `Customer: ${ask}`, latestMessage: ask });
    expect(d?.bodyText).not.toMatch(/wholesale|trade terms/i);
    expect(d?.bodyText).toContain('number of items');
  });

  it('leaves it alone when the customer asked for wholesale terms', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const ask = 'Can I buy 500 units wholesale?';
    const d = await draftReply(sequenceLlm([decline, helpful]), store, CFG, { ...base, subject: 'Bulk', conversation: `Customer: ${ask}`, latestMessage: ask });
    expect(d?.bodyText).toMatch(/not offering wholesale/i);
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

// Rose thread (2026-09-05/06): two customer messages, no reply from us, and the
// drafter was handed only the bump as "what they are asking". Every customer
// message since our last reply is still unanswered, so all of them together are
// the latest ask; once we have replied, only what came after counts.
describe('openInboundText', () => {
  const inb = (t: string) => ({ direction: 'inbound', body_text: t }) as any;
  const outb = (t: string) => ({ direction: 'outbound', body_text: t }) as any;
  it('joins every inbound message when we have never replied', () => {
    expect(openInboundText([inb('Do they arrive as shown?'), inb('Just checking back in, can I reach you directly?')]))
      .toBe('Do they arrive as shown?\n\nJust checking back in, can I reach you directly?');
  });
  it('after a reply from us, only the messages since then are open', () => {
    expect(openInboundText([inb('Do they arrive as shown?'), outb('Yes.'), inb('Great, and to Spain?')])).toBe('Great, and to Spain?');
    expect(openInboundText([inb('a?'), outb('A.'), inb('b?'), inb('c?')])).toBe('b?\n\nc?');
  });
  // aramid llm-review 2026-09-06 (finding ab7ce5d8): the lane gate needs the
  // same "since our last reply" scope as the drafter, as a list per message.
  it('openInboundTexts is the per-message form of the same scope', () => {
    expect(openInboundTexts([inb('a?'), outb('A.'), inb('b?'), inb('c?')])).toEqual(['b?', 'c?']);
    expect(openInboundTexts([inb('a?'), inb('b?')])).toEqual(['a?', 'b?']);
    expect(openInboundTexts([inb('a?'), outb('A.')])).toEqual([]);
  });
  it('strips quoted chains and skips empty turns; empty when nothing is open', () => {
    expect(openInboundText([inb('New text\n\nOn Sat, 5 Sept 2026 Rose wrote:\n> old'), inb('   ')])).toBe('New text');
    expect(openInboundText([inb('a?'), outb('A.')])).toBe('');
  });
});
