/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { composeDraftForThread, runInboxClassifySweep } from '../src/inbox/sweep';
import { THREAD_READER_MARKER } from '../src/inbox/thread-read';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const ENV = { ...env, OPENROUTER_API_KEY: 'k' } as any;

async function seed(opts: { email: string; name: string; category: string; inbound: string[]; outboundAfterFirst?: string; status?: string }) {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.seedConfig({ collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX }, target: 12 });
  await s.saveInbox({ ...DEFAULT_INBOX });
  await s.upsertContact({ email: opts.email, name: opts.name, phone: null });
  const tid = await s.createThread({ contactEmail: opts.email, subject: 'Hello', subjectNorm: 'hello', receivedAt: '2026-09-20T10:00:00Z', initialStatus: 'new' });
  let i = 0;
  for (const body of opts.inbound) {
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<m${i}@x>`, inReplyTo: null, references: [], from: opts.email, to: 'contact@activepaw.co.uk', subject: 'Hello', bodyText: body, bodyHtml: null, headersJson: '{}', receivedAt: `2026-09-2${i}T10:00:00Z` });
    if (i === 0 && opts.outboundAfterFirst) {
      await s.insertOutboundMessage({ threadId: tid, messageId: '<o1@activepaw.co.uk>', from: 'contact@activepaw.co.uk', to: opts.email, subject: 'Re: Hello', bodyText: opts.outboundAfterFirst, bodyHtml: '', sentAt: '2026-09-20T12:00:00Z' });
    }
    i++;
  }
  await s.setThreadClassification(tid, { status: (opts.status ?? 'needs_reply') as any, primaryCategory: opts.category, intentScore: 10, summary: 's', classifiedAt: '2026-09-20T10:05:00Z' });
  return { s, tid };
}

/** Mocked OpenRouter: the reader call gets `reading`, every other call gets `draft`. */
function llm(reading: unknown, draft = { customerAsks: ['q'], bodyText: 'Thank you for sharing your tofu cat litter range. You are welcome to email over your catalogue. Please send us your website or Alibaba store link for our reference, and let us know whether you offer dropshipping, that is sending single orders directly to our customers. We keep supplier details on file for reference.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (!String(url).includes('openrouter')) return new Response('{}', { status: 200 });
    const sys = JSON.parse(String(init.body)).messages?.[0]?.content ?? '';
    const isReader = sys.startsWith(THREAD_READER_MARKER);
    calls.push(isReader ? 'reader' : 'draft');
    const content = reading === 'FAIL' && isReader ? 'not json' : JSON.stringify(isReader ? reading : draft);
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const supplierReading = { senderRole: 'goods-supplier', openAsks: [], offered: 'private-label tofu cat litter', alreadyAnswered: [], replyNeeded: true,
  supplier: { company: 'Hebei Douke Pet Products', contactName: 'Sabrina Liu', website: null, storeLinks: [], kind: 'goods', productLines: ['tofu cat litter'], shipsFrom: 'CN', nicheFit: 'on-niche', dropship: 'unknown' } };

describe('composeDraftForThread with the thread reader', () => {
  it('re-routes a supplier filed as other to the supplier lane, registers them, and drafts a Sourcing Team reply', async () => {
    const { s, tid } = await seed({ email: 'sales@doukecatlitter.com', name: 'Sabrina Liu', category: 'other', inbound: ['We are an OEM tofu cat litter factory. Would a catalogue be of interest?'] });
    const { fetchImpl } = llm(supplierReading);
    const r = await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
    const got = await s.getThreadWithMessages(tid);
    expect(got?.thread.primary_category).toBe('supplier');
    expect(got?.labels).toEqual(['supplier']);
    expect(JSON.parse(got!.thread.reading_json!).senderRole).toBe('goods-supplier');
    const draft = await s.getPendingDraft(tid);
    expect(draft?.body_text).toContain('Active Paw Sourcing Team');
    expect(draft?.body_text).not.toMatch(/affiliate/i);
    const row = await s.getSupplier('sales@doukecatlitter.com');
    expect(row?.company).toBe('Hebei Douke Pet Products');
    expect(row?.dropship).toBe('unknown');
  });

  // Owner ruling 2026-09-28: the reader moves a thread into the supplier lane
  // only from other, wholesale-b2b or affiliate. A lane that already names a
  // customer need (a complaint, an order, a lead) keeps its lane and its agent,
  // even when the reader thinks the sender is a supplier; the register still
  // records what they offered.
  it.each(['lead', 'product-question', 'order-status', 'shipping-returns', 'complaint'])(
    'keeps a %s thread in its lane when the reader says goods supplier, and still registers the supplier', async (lane) => {
      const { s, tid } = await seed({ email: 'sales@doukecatlitter.com', name: 'Sabrina Liu', category: lane, inbound: ['We are an OEM tofu cat litter factory. Would a catalogue be of interest?'] });
      const { fetchImpl } = llm(supplierReading);
      await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
      const got = await s.getThreadWithMessages(tid);
      expect(got?.thread.primary_category).toBe(lane);
      expect(got?.labels).not.toContain('supplier');
      expect((await s.getSupplier('sales@doukecatlitter.com'))?.company).toBe('Hebei Douke Pet Products');
    });

  it.each(['wholesale-b2b', 'affiliate'])(
    're-routes a supplier filed as %s to the supplier lane', async (lane) => {
      const { s, tid } = await seed({ email: 'sales@doukecatlitter.com', name: 'Sabrina Liu', category: lane, inbound: ['We are an OEM tofu cat litter factory. Would a catalogue be of interest?'] });
      const { fetchImpl } = llm(supplierReading);
      await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
      const got = await s.getThreadWithMessages(tid);
      expect(got?.thread.primary_category).toBe('supplier');
      expect(got?.labels).toEqual(['supplier']);
    });

  it('holds a supplier draft that still promises something after the revisions', async () => {
    const { s, tid } = await seed({ email: 'sales@x.cn', name: 'Leon', category: 'supplier', inbound: ['We are a pet products factory.'] });
    const { fetchImpl } = llm(supplierReading, { customerAsks: [], bodyText: 'Thank you for your pet product range. We will be in touch about an order and look forward to working together.', confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const draft = await s.getPendingDraft(tid);
    expect(JSON.parse(draft!.hold_reasons!)).toContain('supplier_commitment');
  });

  it('writes no draft for a bare thank-you after our reply, and parks the thread', async () => {
    const { s, tid } = await seed({ email: 'a@x.com', name: 'Ayatullah', category: 'other', inbound: ['Would you be open to ideas?', 'Thank you for your response.'], outboundAfterFirst: 'Yes, this is Active Paw.' });
    const { fetchImpl, calls } = llm({ senderRole: 'marketer', openAsks: [], offered: '', alreadyAnswered: ['Yes, this is Active Paw'], replyNeeded: false });
    const r = await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(r).toEqual({ noReply: true });
    expect(calls).toEqual(['reader']);
    expect(await s.getPendingDraft(tid)).toBeNull();
    expect((await s.getThreadWithMessages(tid))?.thread.status).toBe('awaiting_customer');
  });

  it('REVIEW FOCUS 1: a first message is always drafted, even if the reading says no reply is needed', async () => {
    const { s, tid } = await seed({ email: 'c@x.com', name: 'Cara', category: 'other', inbound: ['Thanks!'] });
    const { fetchImpl } = llm({ senderRole: 'customer', openAsks: [], offered: '', alreadyAnswered: [], replyNeeded: false });
    const r = await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
  });

  it('Draft anyway (force) drafts even when no reply is needed', async () => {
    const { s, tid } = await seed({ email: 'a@x.com', name: 'Ayatullah', category: 'other', inbound: ['Hi', 'Thanks.'], outboundAfterFirst: 'Hello.' });
    const { fetchImpl } = llm({ senderRole: 'unknown', openAsks: [], offered: '', alreadyAnswered: [], replyNeeded: false });
    const r = await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl, { force: true });
    expect(r && 'draftId' in r).toBe(true);
  });

  it('REVIEW FOCUS 4: a failed reading drafts exactly as before (no reading stored, general agent)', async () => {
    const { s, tid } = await seed({ email: 'c@x.com', name: 'Cara', category: 'other', inbound: ['Do you ship to Germany?'] });
    const { fetchImpl, calls } = llm('FAIL', { customerAsks: ['ship to Germany'], bodyText: 'Yes, we ship to Germany, and the delivery cost is shown at checkout before payment.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false });
    const r = await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
    expect(calls[0]).toBe('reader');
    expect((await s.getThreadWithMessages(tid))?.thread.reading_json).toBeNull();
    expect((await s.getPendingDraft(tid))?.body_text).toContain('Active Paw Customer Support');
  });

  it('REVIEW FOCUS 3: a thread already in the partnership funnel is never re-routed to suppliers', async () => {
    const { s, tid } = await seed({ email: 'v@x.com', name: 'Vic', category: 'other', inbound: ['We make pet toys and want to promote them.'] });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'v@x.com', stage: 'passed_to_form' });
    const { fetchImpl } = llm(supplierReading);
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect((await s.getThreadWithMessages(tid))?.thread.primary_category).toBe('other');
    // Controller ruling (task 9): primary_category alone does not prove the funnel
    // drafted this - assert the pending draft actually came from the partnership
    // funnel (model 'partnership-screen', the holding-ack sign-off), not the
    // generic 'other' category agent (which would sign off "Active Paw Customer
    // Support" and stamp its own resolved-chain model).
    const draft = await s.getPendingDraft(tid);
    expect(draft?.model).toBe('partnership-screen');
    expect(draft?.body_text).toContain('Active Paw Partnerships');
  });

  it('a marketer gets the prove-first template, not the creator invite (Raphael, 2026-09-24)', async () => {
    // Raphael's real follow-up (thread c34c08ab, 2026-09-24): the regex on-ramp
    // pulls it into the funnel; the reading picks the prove-first branch.
    const raphael = "That's great. Would you be open to a partnership based on a 2% commission model? My goal is to help your website build toward 10+ daily orders by identifying the main growth opportunities, improving organic visibility, and optimizing the customer journey so more of your traffic can turn into sales. There's no upfront service fee from my side. My compensation would be based on the agreed commission structure, so we can focus on building results together. If you're interested, I'd be happy to share the plan and explain exactly what I would work on first. Would you be open to discussing it?";
    const { s, tid } = await seed({ email: 'r@voltscale.site', name: 'Raphael', category: 'other', inbound: ['Am I correct?', raphael], outboundAfterFirst: 'Yes, you have reached Active Paw.' });
    const { fetchImpl } = llm({ senderRole: 'marketer', openAsks: ['open to a 2% commission partnership?'], offered: 'growth services on commission', alreadyAnswered: ['Yes, this is Active Paw'], replyNeeded: true });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const body = (await s.getPendingDraft(tid))?.body_text ?? '';
    expect(body).toMatch(/tracked/i);            // the prove-first wording
    expect(body).not.toMatch(/tell us where you would promote/i); // the creator invite
  });

  it('a marketer reading alone never pulls a plain thread into the funnel (no applicant row)', async () => {
    const { s, tid } = await seed({ email: 'y@x.com', name: 'Yussuf', category: 'other', inbound: ['Your products caught my attention. Would you like me to share one thing I noticed?'] });
    const { fetchImpl } = llm({ senderRole: 'marketer', openAsks: ['share what I noticed?'], offered: 'store advice', alreadyAnswered: [], replyNeeded: true });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(await s.getApplicantByThread(tid)).toBeNull();
  });

  it('Regenerate never loses the current draft when a supplier re-route is followed by a failed draft', async () => {
    const { s, tid } = await seed({ email: 'sales@x.cn', name: 'Leon', category: 'other', inbound: ['We are a pet products factory.'] });
    const old = await s.insertDraft({ threadId: tid, bodyText: 'old draft', bodyHtml: '', confidence: 50, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (!String(url).includes('openrouter')) return new Response('{}', { status: 200 });
      const sys = JSON.parse(String(init.body)).messages?.[0]?.content ?? '';
      if (sys.startsWith(THREAD_READER_MARKER)) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(supplierReading) } }], usage: { cost: 0 } }), { status: 200 });
      return new Response('upstream down', { status: 500 });
    }) as unknown as typeof fetch;
    const { regenerateDraft } = await import('../src/inbox/routes');
    const r = await regenerateDraft(env.DB, ENV, SHOP, old, fetchImpl);
    expect(r.ok).toBe(false);
    expect((await s.getDraft(old))?.status).toBe('pending');
  });

  it('the funnel stands down for a supplier who says partnership or cooperation', async () => {
    const { s, tid } = await seed({ email: 'daisy@andasea.com', name: 'Daisy', category: 'supplier', inbound: ['We make felt pet products and welcome long-term agency partnership and cooperation.'] });
    const { fetchImpl } = llm({ ...supplierReading, supplier: { ...supplierReading.supplier, company: 'Beijing Andasea Pet Products' } });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(await s.getApplicantByThread(tid)).toBeNull();
    expect((await s.getPendingDraft(tid))?.body_text).toContain('Active Paw Sourcing Team');
  });
});

describe('controller rulings (task 8)', () => {
  it('RULING 1: a supplier thread never reaches the invoice model and still gets a draft (no invoice row)', async () => {
    const { s, tid } = await seed({ email: 'sales@quote.cn', name: 'Leon', category: 'supplier', inbound: ['We are a pet products factory. Our price is USD 2.10 per unit, MOQ 500.'] });
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (!String(url).includes('openrouter')) return new Response('{}', { status: 200 });
      const sys = String(JSON.parse(String(init.body)).messages?.[0]?.content ?? '');
      let content: unknown;
      if (sys.startsWith(THREAD_READER_MARKER)) { calls.push('reader'); content = supplierReading; }
      else if (sys.includes('isInvoiceMoment')) { calls.push('invoice'); content = { isInvoiceMoment: true, lineRequests: [{ query: 'cat litter', qty: 2 }], coverText: 'Here is your invoice.', confidence: 95 }; }
      else { calls.push('draft'); content = { customerAsks: [], bodyText: 'Thank you for sharing your pet product range. Please send us your website or Alibaba store link for our reference.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false }; }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await runInboxClassifySweep(ENV, fetchImpl);
    expect(calls).not.toContain('invoice');
    expect(calls).toContain('draft');
    expect(await s.getPendingDraft(tid)).not.toBeNull();
    const inv = await env.DB.prepare(`SELECT COUNT(*) AS n FROM inbox_invoices WHERE shop = ?1 AND thread_id = ?2`).bind(SHOP, tid).first<{ n: number }>();
    expect(inv?.n).toBe(0);
  });

  it('RULING 2: with the inbox switched off, the thread is never read (no reader call, no reading stored)', async () => {
    const { s, tid } = await seed({ email: 'sales@off.cn', name: 'Leon', category: 'other', inbound: ['We are a pet products factory.'] });
    const { fetchImpl, calls } = llm(supplierReading);
    const cfg = (await s.getConfig())!;
    const r = await composeDraftForThread(ENV, s, { ...cfg, inbox: { ...cfg.inbox, enabled: false } }, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(r).toBeNull();
    expect(calls).not.toContain('reader');
    const got = await s.getThreadWithMessages(tid);
    expect(got?.thread.reading_json).toBeNull();
    expect(got?.thread.primary_category).toBe('other');
  });

  it('RULING 3: a D1 failure saving the reading never blocks drafting', async () => {
    const { s, tid } = await seed({ email: 'sales@hiccup.cn', name: 'Leon', category: 'other', inbound: ['We are an OEM tofu cat litter factory.'] });
    s.saveThreadReading = async () => { throw new Error('D1 hiccup'); };
    const { fetchImpl } = llm(supplierReading);
    const r = await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
    expect((await s.getPendingDraft(tid))?.body_text).toContain('Active Paw Sourcing Team');
  });

  it('RULING (task 9): sendReply sees the RE-ROUTED category, not the stale one captured before drafting', async () => {
    // Thread starts 'other'; the reader calls the sender a supplier, and
    // composeDraftForThread re-routes it to 'supplier' mid-draft. The sweep's
    // drafting loop captured the thread row BEFORE that re-route, so draftOne
    // must re-fetch before calling sendReply, or the send labels the thread
    // under the stale category (observable via the thread's label set).
    const { s, tid } = await seed({ email: 'sales@resend.cn', name: 'Leon', category: 'other', inbound: ['We are a pet products factory.'] });
    const cfg = (await s.getConfig())!;
    await s.saveInbox({ ...cfg.inbox, autosend: true, agents: { supplier: { autosend: true } } });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const u = String(url);
      if (u.includes('openrouter')) {
        const sys = JSON.parse(String(init.body)).messages?.[0]?.content ?? '';
        const isReader = sys.startsWith(THREAD_READER_MARKER);
        const content = isReader
          ? supplierReading
          : { customerAsks: [], bodyText: 'Thank you for sharing your pet product range. Please send us your website or Alibaba store link for our reference, and let us know whether you offer dropshipping.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0 } }), { status: 200 });
      }
      if (u.includes('resend.com')) return new Response(JSON.stringify({ id: 'em_ruling9' }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await runInboxClassifySweep({ ...ENV, RESEND_API_KEY: 'rk' } as any, fetchImpl);
    const got = await s.getThreadWithMessages(tid);
    expect(got?.thread.primary_category).toBe('supplier');
    // The bug: sendReply labelling off the stale pre-draft thread would add
    // 'other' alongside 'supplier' (addThreadLabel is additive, never a
    // replace). The fix keeps the label set exactly what the re-route set it to.
    expect(got?.labels).toEqual(['supplier']);
  });
});

describe('closed threads (owner decision 2026-09-27)', () => {
  it('reopens a closed thread when a customer asks a real question (Investor Mark, June)', async () => {
    // shipping-returns, not lead: the sweep offers a lead to the invoice path first.
    const { s, tid } = await seed({ email: 'm@x.com', name: 'Mark', category: 'shipping-returns', inbound: ['Am I speaking to the owner?', 'Do you ship internationally?'], outboundAfterFirst: 'Hello, I am part of the team.', status: 'closed' });
    const { fetchImpl } = llm({ senderRole: 'customer', openAsks: ['Do you ship internationally?'], offered: '', alreadyAnswered: [], replyNeeded: true },
      { customerAsks: ['ship internationally'], bodyText: 'Yes, we ship internationally to most countries, and the delivery cost is shown at checkout before payment.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false });
    await runInboxClassifySweep(ENV, fetchImpl);
    const got = await s.getThreadWithMessages(tid);
    expect(got?.thread.status).toBe('needs_reply');
    expect(await s.getPendingDraft(tid)).not.toBeNull();
  });

  it('keeps a closed thread closed for a pitch, and does not re-read it until a new message arrives', async () => {
    const { s, tid } = await seed({ email: 'p@x.com', name: 'Pat', category: 'other', inbound: ['Hi', 'I can grow your sales 10x, can I send a plan?'], outboundAfterFirst: 'Hello.', status: 'closed' });
    const { fetchImpl, calls } = llm({ senderRole: 'marketer', openAsks: ['can I send a plan?'], offered: 'growth', alreadyAnswered: [], replyNeeded: true });
    await runInboxClassifySweep(ENV, fetchImpl);
    expect((await s.getThreadWithMessages(tid))?.thread.status).toBe('closed');
    const before = calls.length;
    await runInboxClassifySweep(ENV, fetchImpl);
    expect(calls.length).toBe(before); // read_at now covers the last inbound
  });

  it('never touches automated or spam threads', async () => {
    const { s } = await seed({ email: 'n@x.com', name: 'N', category: 'automated', inbound: ['receipt', 'receipt 2'], outboundAfterFirst: 'x', status: 'closed' });
    expect(await s.closedReopenCandidates()).toEqual([]);
  });

  // Fix round 2 (2026-09-27): the newest closed thread must be checked first,
  // never the oldest - an old thread whose reading keeps failing must not block
  // newer customers behind it, up to the 10-per-cycle cap.
  it('with two qualifying closed threads and limit 1, the newer one (by last_message_at) is returned', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await s.upsertContact({ email: 'old@x.com', name: 'Old', phone: null });
    await s.upsertContact({ email: 'new@x.com', name: 'New', phone: null });

    const oldTid = await s.createThread({ contactEmail: 'old@x.com', subject: 'Old', subjectNorm: 'old', receivedAt: '2026-08-01T10:00:00Z', initialStatus: 'new' });
    await s.insertInboundMessageIfNew({ threadId: oldTid, messageId: '<old1@x>', inReplyTo: null, references: [], from: 'old@x.com', to: 'contact@activepaw.co.uk', subject: 'Old', bodyText: 'A real question', bodyHtml: null, headersJson: '{}', receivedAt: '2026-08-01T10:00:00Z' });
    await s.setThreadClassification(oldTid, { status: 'closed', primaryCategory: 'other', intentScore: 10, summary: 's', classifiedAt: '2026-01-01T00:00:00Z' });
    await s.touchThread(oldTid, '2026-08-01T10:00:00Z');

    const newTid = await s.createThread({ contactEmail: 'new@x.com', subject: 'New', subjectNorm: 'new', receivedAt: '2026-09-01T10:00:00Z', initialStatus: 'new' });
    await s.insertInboundMessageIfNew({ threadId: newTid, messageId: '<new1@x>', inReplyTo: null, references: [], from: 'new@x.com', to: 'contact@activepaw.co.uk', subject: 'New', bodyText: 'Another real question', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-01T10:00:00Z' });
    await s.setThreadClassification(newTid, { status: 'closed', primaryCategory: 'other', intentScore: 10, summary: 's', classifiedAt: '2026-01-01T00:00:00Z' });
    await s.touchThread(newTid, '2026-09-01T10:00:00Z');

    const candidates = await s.closedReopenCandidates(1);
    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe(newTid);
  });
});
