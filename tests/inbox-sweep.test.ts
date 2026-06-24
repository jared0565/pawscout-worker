/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { runInboxClassifySweep, composeAgentDraft } from '../src/inbox/sweep';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function seedShopWithThread() {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await store.seedConfig({
    collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS,
    fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX, alertEmail: 'owner@gmail.com' }, target: 12
  });
  // seedConfig does NOT persist the inbox column - saveInbox must be called separately.
  await store.saveInbox({ ...DEFAULT_INBOX, alertEmail: 'owner@gmail.com' });
  await store.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
  const tid = await store.createThread({ contactEmail: 'jane@x.com', subject: 'Buy a bed', subjectNorm: 'buy a bed', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new' });
  await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<m@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Buy a bed', bodyText: 'I want to buy the large bed now', bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-06-18T10:00:00Z' });
  return tid;
}

describe('runInboxClassifySweep', () => {
  it('classifies pending threads and alerts the owner for a hot lead', async () => {
    const tid = await seedShopWithThread();
    // OpenRouter mock (classify) returns a hot lead; Resend mock captures the alert.
    let alertTo: unknown = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(url).includes('openrouter')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isHuman: true, category: 'lead', intentScore: 92, summary: 'Wants the large bed', labels: ['lead'] }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      }
      // Resend
      alertTo = JSON.parse(init.body as string).to;
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;

    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);

    const got = await new TenantStore(env.DB, SHOP).getThreadWithMessages(tid);
    expect(got?.thread.status).toBe('needs_reply');
    expect(got?.thread.primary_category).toBe('lead');
    expect(got?.thread.intent_score).toBe(92);
    expect(got?.labels).toContain('lead');
    expect(alertTo).toEqual(['owner@gmail.com']);
  });

  it('HTML-escapes attacker-controlled values in the owner alert email', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await store.seedConfig({
      collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
      pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS,
      fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX, alertEmail: 'owner@gmail.com' }, target: 12
    });
    await store.saveInbox({ ...DEFAULT_INBOX, alertEmail: 'owner@gmail.com' });
    await store.upsertContact({ email: 'attacker@evil.com', name: 'Attacker', phone: null });
    const tid = await store.createThread({ contactEmail: 'attacker@evil.com', subject: '<img src=x onerror=alert(1)>', subjectNorm: 'img src x', receivedAt: '2026-06-18T11:00:00Z', initialStatus: 'new' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<atk@evil>', inReplyTo: null, references: [], from: 'attacker@evil.com', to: 'support@activepaw.co.uk', subject: '<img src=x onerror=alert(1)>', bodyText: 'I want to buy now', bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-06-18T11:00:00Z' });

    let capturedHtml: string | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(url).includes('openrouter')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isHuman: true, category: 'lead', intentScore: 92, summary: 'Wants to buy <script>xss</script>', labels: ['lead'] }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      }
      capturedHtml = JSON.parse(init.body as string).html;
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;

    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);

    expect(capturedHtml).not.toBeNull();
    expect(capturedHtml).toContain('&lt;img');
    expect(capturedHtml).not.toContain('<img src=x onerror=');
    expect(capturedHtml).toContain('&lt;script&gt;');
    expect(capturedHtml).not.toContain('<script>xss</script>');
  });

  it('leaves the thread unclassified when the LLM is unavailable (no key)', async () => {
    const tid = await seedShopWithThread();
    await runInboxClassifySweep({ ...env } as any); // no OPENROUTER_API_KEY
    const got = await new TenantStore(env.DB, SHOP).getThreadWithMessages(tid);
    expect(got?.thread.classified_at).toBeNull();
    expect(got?.thread.status).toBe('new');
  });

  it('drafts a reply for a needs_reply thread and HOLDS it when autosend is off', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-06-18T10:05:00Z' });
    const fetchImpl = (async (url: string) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bodyText: 'Yes, we ship there.', confidence: 95, quotesPriceOrOrder: false }) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k' } as any, fetchImpl);
    const d = await store.getPendingDraft(tid);
    expect(d?.body_text).toContain('ship');           // drafted
    expect(d?.status).toBe('pending');                // held (autosend off by default)
  });

  it('auto-sends a confident safe draft when autosend is on', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    // Auto requires BOTH the global switch AND the per-agent opt-in (resolveAgents
    // defaults every label to autosend:false), so opt the product-question agent in.
    await store.saveInbox({ ...DEFAULT_INBOX, autosend: true, agents: { 'product-question': { autosend: true } }, alertEmail: 'owner@gmail.com' });
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-06-18T10:05:00Z' });
    let sent = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(url).includes('openrouter')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bodyText: 'Yes, we ship there in a few days.', confidence: 95, quotesPriceOrOrder: false }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      sent = true; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); // Resend
    }) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);
    expect(sent).toBe(true);
    expect((await store.getThreadWithMessages(tid))?.thread.status).toBe('awaiting_customer');
  });
});

describe('composeAgentDraft', () => {
  it('returns the LLM body unchanged when there is no appendix', () => {
    const out = composeAgentDraft({ bodyText: 'Hi there, happy to help.', quotesPriceOrOrder: false }, null);
    expect(out.bodyText).toBe('Hi there, happy to help.');
    expect(out.quotesPriceOrder).toBe(false);
  });

  it('still flags money-hold from the LLM body when no appendix is present', () => {
    const out = composeAgentDraft({ bodyText: 'That bed is £45.', quotesPriceOrOrder: false }, null);
    expect(out.quotesPriceOrder).toBe(true); // mentionsMoney caught the £ figure
  });

  it('appends the trusted appendix AFTER the LLM body', () => {
    const line = 'Delivery to France: shipping from approx £4.00, est. 8-12 working days.';
    const out = composeAgentDraft({ bodyText: 'Yes, we ship to France.', quotesPriceOrOrder: false }, line);
    expect(out.bodyText).toBe(`Yes, we ship to France.\n\n${line}`);
  });

  it('does NOT force quotesPriceOrder for a trusted appendix figure (money flag is the LLM body only)', () => {
    // The £ figure lives in the WORKER's trusted appendix, not the LLM body. The money
    // flag is computed on the body alone, so a trusted appendix is exempt and the draft
    // is not held purely because an appendix was attached.
    const line = 'Delivery to France: shipping from approx £4.00, est. 8-12 working days.';
    const out = composeAgentDraft({ bodyText: 'Yes, we ship internationally.', quotesPriceOrOrder: false }, line);
    expect(out.quotesPriceOrder).toBe(false);
  });
});
