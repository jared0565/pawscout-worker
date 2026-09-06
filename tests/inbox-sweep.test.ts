/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { runInboxClassifySweep, composeAgentDraft } from '../src/inbox/sweep';
import { normalizeQuestion, ANSWER_BACKFILL_FLAG } from '../src/inbox/answer-memory';
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
    const fetchImpl = (async (_url: string) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bodyText: 'Yes, we ship there.', confidence: 95, quotesPriceOrOrder: false }) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k' } as any, fetchImpl);
    const d = await store.getPendingDraft(tid);
    expect(d?.body_text).toContain('ship');           // drafted
    expect(d?.status).toBe('pending');                // held (autosend off by default)
  });

  // 2026-07-04 bait-opener fix: classification was one-shot on the FIRST message,
  // so an innocuous opener ("is this Active Paw?" -> other) locked a thread out of
  // the affiliate lane when the real pitch arrived in a follow-up. The sweep now
  // re-classifies the sender's LATEST new text when an inbound postdates the stamp.
  it('re-classifies on a follow-up inbound and reroutes the thread to the new lane', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'shipping-returns', intentScore: 30, summary: 'Shipping question', classifiedAt: '2026-06-18T10:05:00Z' });
    await store.setThreadLabels(tid, ['shipping-returns']);
    const staleId = await store.insertDraft({ threadId: tid, bodyText: 'Yes, we ship to Europe.', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: ['autosend_off'], model: 'm', status: 'pending' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<m2@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: Buy a bed', bodyText: 'What commission would I get if I drive 30 orders a day?', bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-06-18T12:00:00Z' });

    let alerted = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('openrouter')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isHuman: true, category: 'affiliate', intentScore: 20, summary: 'Asks about affiliate commission', labels: ['affiliate'] }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      }
      alerted = true;
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);

    const got = await store.getThreadWithMessages(tid);
    expect(got?.thread.primary_category).toBe('affiliate');
    expect(got?.labels).toContain('affiliate');
    // the stale shipping-agent draft is retired and the SAME sweep re-drafts via
    // the partnership lane (decline template), held because autosend is off here
    expect((await store.getDraft(staleId))?.status).toBe('superseded');
    const fresh = await store.getPendingDraft(tid);
    expect(fresh).not.toBeNull();
    expect(fresh!.body_text).toContain('Active Paw Partnerships');
    expect(alerted).toBe(true); // affiliate approaches alert the owner regardless of intent
  });

  // 2026-07-05 Samlarry incident: an in-funnel applicant's screening ANSWERS
  // (marketing jargon, no links) were reclassified to spam, silently pulling
  // the thread out of the Open queue and the funnel. Applicant threads belong
  // to the partnership funnel: reclassification must stamp and stand down.
  it('never re-files a thread that has an applicant record (Samlarry guard)', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 20, summary: 'pitch', classifiedAt: '2026-06-18T10:05:00Z' });
    await store.upsertApplicant({ threadId: tid, contactEmail: 'jane@x.com', stage: 'screen_sent' });
    // Their screening answers arrive AFTER the classification stamp - the exact
    // shape that qualified for reclassification and got spam-bucketed.
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<ans@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: questions', bodyText: 'I generate qualified traffic through SEO, content marketing and conversion optimization.', bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-06-18T12:00:00Z' });
    // If the guard failed, this classifier verdict would re-file the thread as spam.
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('openrouter')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isHuman: false, category: 'spam', intentScore: 0, summary: 'spam', labels: ['spam'] }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);

    const got = await store.getThreadWithMessages(tid);
    expect(got?.thread.primary_category).toBe('affiliate'); // lane untouched
    expect(got?.thread.status).not.toBe('spam');            // still in the Open queue
    expect(got!.thread.classified_at! > '2026-06-18T10:05:00Z').toBe(true); // stamped: stops re-qualifying
  });

  it('a same-lane follow-up refreshes the stamp and keeps the pending draft', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-06-18T10:05:00Z' });
    await store.setThreadLabels(tid, ['product-question']);
    const staleId = await store.insertDraft({ threadId: tid, bodyText: 'It fits large dogs.', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: ['autosend_off'], model: 'm', status: 'pending' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<m3@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: Buy a bed', bodyText: 'And does it come in grey?', bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-06-18T12:00:00Z' });
    const fetchImpl = (async (_url: string) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isHuman: true, category: 'product-question', intentScore: 45, summary: 'Colour question', labels: ['product-question'] }) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k' } as any, fetchImpl);

    const got = await store.getThreadWithMessages(tid);
    expect(got?.thread.primary_category).toBe('product-question');
    expect(got!.thread.classified_at! > '2026-06-18T10:05:00Z').toBe(true); // stamped: not re-judged every sweep
    expect((await store.getPendingDraft(tid))?.id).toBe(staleId); // draft untouched
  });

  it('an all-quote follow-up skips the LLM and just refreshes the stamp', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-06-18T10:05:00Z' });
    await store.insertDraft({ threadId: tid, bodyText: 'It fits large dogs.', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: ['autosend_off'], model: 'm', status: 'pending' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<m4@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: Buy a bed', bodyText: 'On Thu, Jun 18, 2026, Active Paw <support@activepaw.co.uk> wrote:\n> It fits large dogs.\n> Best regards', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T12:00:00Z' });
    const llmUrls: string[] = [];
    const fetchImpl = (async (url: string) => {
      llmUrls.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { cost: 0.0001 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k' } as any, fetchImpl);

    expect(llmUrls.filter((u) => u.includes('openrouter'))).toHaveLength(0); // nothing new to judge
    const got = await store.getThreadWithMessages(tid);
    expect(got!.thread.classified_at! > '2026-06-18T10:05:00Z').toBe(true); // stamped so it will not re-qualify
    expect(got?.thread.primary_category).toBe('product-question');
  });

  it('reclassifyCandidates selects only open classified threads with a newer inbound', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    // A: classified in the past, follow-up arrives after -> candidate
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 5, summary: 's', classifiedAt: '2026-06-18T10:05:00Z' });
    // B: classified AFTER its only message (stamp in the future) -> not a candidate
    const tidB = await store.createThread({ contactEmail: 'jane@x.com', subject: 'Other q', subjectNorm: 'other q', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new' });
    await store.insertInboundMessageIfNew({ threadId: tidB, messageId: '<b1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Other q', bodyText: 'hi', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    await store.setThreadClassification(tidB, { status: 'needs_reply', primaryCategory: 'other', intentScore: 5, summary: 's', classifiedAt: new Date(Date.now() + 60_000).toISOString() });
    // C: same shape as A but dismissed -> not a candidate
    const tidC = await store.createThread({ contactEmail: 'jane@x.com', subject: 'Closed q', subjectNorm: 'closed q', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new' });
    await store.insertInboundMessageIfNew({ threadId: tidC, messageId: '<c1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Closed q', bodyText: 'hi', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    await store.setThreadClassification(tidC, { status: 'closed', primaryCategory: 'other', intentScore: 5, summary: 's', classifiedAt: '2026-06-18T10:05:00Z' });

    const ids = (await store.reclassifyCandidates()).map((t) => t.id);
    expect(ids).toContain(tid);
    expect(ids).not.toContain(tidB);
    expect(ids).not.toContain(tidC);
  });

  it('auto-sends a confident safe draft when autosend is on', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    // Auto requires BOTH the global switch AND the per-agent opt-in (resolveAgents
    // defaults every label to autosend:false), so opt the product-question agent in.
    await store.saveInbox({ ...DEFAULT_INBOX, autosend: true, agents: { 'product-question': { autosend: true } }, alertEmail: 'owner@gmail.com' });
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-06-18T10:05:00Z' });
    let sent = false;
    const fetchImpl = (async (url: string, _init: RequestInit) => {
      if (String(url).includes('openrouter')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bodyText: 'Yes, we ship there in a few days.', confidence: 95, quotesPriceOrOrder: false }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      sent = true; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); // Resend
    }) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);
    expect(sent).toBe(true);
    expect((await store.getThreadWithMessages(tid))?.thread.status).toBe('awaiting_customer');
  });

  it('drafting grounds with recalled approved answers, and the sweep runs the one-time backfill', async () => {
    await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertAnswerMemory({
      qhash: 'seed1', category: 'lead',
      questionText: 'Can I buy the large bed?', questionNorm: normalizeQuestion('Can I buy the large bed?').join(' '),
      answerText: 'The large bed is available on our website.', threadId: 'prior-thread',
    });
    let draftSystem = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(url).includes('openrouter')) {
        const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] };
        const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
        if (system.includes('customer-service email reply')) { // the drafter (vs the classifier)
          draftSystem = system;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ customerAsks: ['buy the large bed'], bodyText: 'Yes, the large bed is available.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false }) } }], usage: { cost: 0.0001 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isHuman: true, category: 'lead', intentScore: 60, summary: 'Wants the large bed', labels: ['lead'] }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;

    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);

    expect(draftSystem).toContain('Previously approved answers to similar past questions');
    expect(draftSystem).toContain('The large bed is available on our website.');
    // The flag-guarded one-time backfill ran during this sweep.
    expect(await store.getSearchCache(ANSWER_BACKFILL_FLAG)).toBeTruthy();
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

  it('appends the department footer LAST (body, then appendix, then footer) so HITL sees the exact outbound', () => {
    const line = 'Delivery to the UK: estimated 4-12 days.';
    const out = composeAgentDraft({ bodyText: 'Yes, we ship to the UK.', quotesPriceOrOrder: false }, line, 'service');
    expect(out.bodyText).toBe(`Yes, we ship to the UK.\n\n${line}\n\nBest Regards,\nActive Paw Customer Support`);
  });

  it('strips a stray LLM sign-off from the body BEFORE the appendix so it cannot sit mid-draft', () => {
    const line = 'Delivery to the UK: estimated 4-12 days.';
    const out = composeAgentDraft(
      { bodyText: 'Yes, we ship to the UK.\n\nBest regards,\nActive Paw', quotesPriceOrOrder: false }, line, 'sales'
    );
    expect(out.bodyText).toBe(`Yes, we ship to the UK.\n\n${line}\n\nBest Regards,\nActive Paw Sales Team`);
  });

  it('keeps the legacy 2-arg behavior (no footer) for callers that do not pass a department', () => {
    const out = composeAgentDraft({ bodyText: 'Hello.', quotesPriceOrOrder: false }, null);
    expect(out.bodyText).toBe('Hello.');
  });

  it('appends the agent postscript AFTER the footer (the classic post-signature P.S. slot)', () => {
    const ps = 'P.S. 🔍 Try the search bar.';
    const out = composeAgentDraft({ bodyText: 'Happy to help.', quotesPriceOrOrder: false }, null, 'sales', ps);
    expect(out.bodyText).toBe(`Happy to help.\n\nBest Regards,\nActive Paw Sales Team\n\n${ps}`);
  });

  it('omits the postscript when null (follow-up replies)', () => {
    const out = composeAgentDraft({ bodyText: 'Happy to help.', quotesPriceOrOrder: false }, null, 'sales', null);
    expect(out.bodyText).toBe('Happy to help.\n\nBest Regards,\nActive Paw Sales Team');
  });
});

// Owner rule 2026-09-04: an LLM draft that repeats a reply we already sent on
// the thread is held with a named reason and never auto-sends. The reviser is
// asked for a shorter, non-repeating reply first; when it comes back the same
// (this mock always does), the hold is what protects the customer.
describe('LLM draft that repeats a prior reply', () => {
  it('is held with repeats_prior_reply', async () => {
    const tid = await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-06-18T11:05:00Z' }); // stamped after the follow-up: no re-classification pass
    const SENT = 'Yes, we ship to Ireland, and delivery usually takes five to seven working days from dispatch.';
    await store.insertOutboundMessage({ threadId: tid, messageId: '<o1@activepaw>', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Buy a bed', bodyText: 'Hi Jane,\n\n' + SENT + '\n\nBest Regards,\nActive Paw', bodyHtml: '<p>x</p>', sentAt: '2026-06-18T10:30:00Z' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<m2@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: Buy a bed', bodyText: 'Great, and is that the same for Northern Ireland?', bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-06-18T11:00:00Z' });
    await store.reopenThread(tid);
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bodyText: SENT, confidence: 95, quotesPriceOrOrder: false }) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k' } as any, fetchImpl);
    const d = await store.getPendingDraft(tid);
    expect(d).not.toBeNull();
    expect(JSON.parse(d!.hold_reasons ?? '[]')).toContain('repeats_prior_reply');
    expect(d!.status).toBe('pending');
  });
});
