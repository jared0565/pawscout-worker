/// <reference types="@cloudflare/vitest-plugin" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { composeDraftForThread, runInboxClassifySweep } from '../src/inbox/sweep';
import { THREAD_READER_MARKER } from '../src/inbox/thread-read';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { AFFILIATE_APPLY_URL, buildSignupInvite, buildSecondTouch, buildCollaborationDecline } from '../src/inbox/partnership';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const ENV = { ...env, OPENROUTER_API_KEY: 'k' } as any;

async function seed(opts: { email: string; name: string; category: string; inbound: string[]; outboundAfterFirst?: string; status?: string; subject?: string }) {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.seedConfig({ collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX }, target: 12 });
  await s.saveInbox({ ...DEFAULT_INBOX });
  await s.upsertContact({ email: opts.email, name: opts.name, phone: null });
  const subject = opts.subject ?? 'Hello';
  const tid = await s.createThread({ contactEmail: opts.email, subject, subjectNorm: subject.toLowerCase(), receivedAt: '2026-09-20T10:00:00Z', initialStatus: 'new' });
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
  it('both the reader and the drafter see which files arrived (design 2026-11-14, 5.7)', async () => {
    const { s, tid } = await seed({ email: 'sales@doukecatlitter.com', name: 'Sabrina Liu', category: 'supplier', inbound: ['Please find our catalogue attached.'] });
    const mid = (await s.getThreadWithMessages(tid))!.messages[0].id;
    await s.insertAttachment({ id: 'a1', thread_id: tid, message_id: mid, filename: 'catalogue.pdf', content_type: 'application/pdf', size_bytes: 10, status: 'stored', r2_key: `inbox/${SHOP}/${tid}/a1` });
    await s.insertAttachment({ id: 'a2', thread_id: tid, message_id: mid, filename: 'prices.xlsm', content_type: 'application/octet-stream', size_bytes: 10, status: 'skipped_type', r2_key: null });
    const { fetchImpl: inner } = llm(supplierReading);
    const bodies: { reader: boolean; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(url).includes('openrouter')) {
        const body = String(init.body);
        bodies.push({ reader: (JSON.parse(body).messages?.[0]?.content ?? '').startsWith(THREAD_READER_MARKER), body });
      }
      return inner(url, init);
    }) as unknown as typeof fetch;
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const reader = bodies.find((b) => b.reader);
    const drafter = bodies.find((b) => !b.reader);
    for (const b of [reader, drafter]) {
      expect(b?.body).toContain('[Files with this message: catalogue.pdf]');
      expect(b?.body).toContain('[Files sent but not kept: prices.xlsm (file type not accepted)]');
      expect(b?.body).toContain('lists the only files we hold from the sender');
    }
  });

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

  // FOOFEE thread 2d6559b9 (design 2026-11-14, rule A): the reply thanked them
  // for a catalogue we never held. The model keeps the claim through both
  // revisions, so the draft is held, and the missing-file sentence is added.
  it('a supplier draft that still claims a receipt is held with file_claim', async () => {
    const { s, tid } = await seed({ email: 'info@foofee.com', name: 'Mia', category: 'supplier', inbound: ['Please find our catalogue attached.'] });
    const foofee = 'Thank you for sending the FOOFEE catalogue and the details of your range. We have received the information.';
    const { fetchImpl, calls } = llm(supplierReading, { customerAsks: [], bodyText: foofee, confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const draft = await s.getPendingDraft(tid);
    expect(JSON.parse(draft!.hold_reasons!)).toContain('file_claim');
    expect(draft!.body_text).toContain('Unfortunately the file you mentioned did not reach us. Could you send it again, or share a link to it?');
    expect(calls.filter((c) => c === 'draft').length).toBe(3); // the reviser was asked first
  });

  it('a refused file gets the refused-file sentence, and a held file is never claimed falsely', async () => {
    const { s, tid } = await seed({ email: 'info@bowls.com', name: 'Ann', category: 'supplier', inbound: ['Our prices are attached.'] });
    const mid = (await s.getThreadWithMessages(tid))!.messages[0].id;
    await s.insertAttachment({ id: 'r1', thread_id: tid, message_id: mid, filename: 'prices.xlsm', content_type: 'application/octet-stream', size_bytes: 10, status: 'skipped_type', r2_key: null });
    const plain = 'Thank you for your message about your bowls range. We keep supplier details on file for reference.';
    const { fetchImpl } = llm(supplierReading, { customerAsks: [], bodyText: plain, confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toContain('We were not able to accept the file you sent. Could you send it as a PDF, or share a link to it?');
    expect(draft!.body_text).not.toContain('did not reach us'); // a record exists, so rule C stays quiet
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).not.toContain('file_claim');
  });

  // Owner decision 2026-09-28 (the Douke preview asked for neither): a supplier
  // who gave no link and no dropshipping answer is asked both, even when the
  // model and both revisions keep leaving the questions out.
  it('a supplier draft that still misses the owed questions after the revisions gets them added', async () => {
    const { s, tid } = await seed({ email: 'sales@doukecatlitter.com', name: 'Sabrina Liu', category: 'supplier', inbound: ['We are an OEM tofu cat litter factory.'] });
    const miss = 'Thank you for the information. We will keep your supplier details on file for reference. If you have any other questions, please do not hesitate to get in touch.';
    const { fetchImpl, calls } = llm(supplierReading, { customerAsks: [], bodyText: miss, confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const draft = await s.getPendingDraft(tid);
    expect(draft?.body_text).toMatch(/your website or your Alibaba/i);
    expect(draft?.body_text).toMatch(/dropshipping/i);
    expect(calls.filter((c) => c === 'draft').length).toBe(3); // the model was asked to revise first
  });

  // The model sometimes signs off although it is told not to. The questions go
  // above the one footer, never under a sign-off of the model's own.
  it('adds the owed questions above the footer when the model signed off anyway', async () => {
    const { s, tid } = await seed({ email: 'sales@doukecatlitter.com', name: 'Sabrina Liu', category: 'supplier', inbound: ['We are an OEM tofu cat litter factory.'] });
    const signedMiss = 'Thank you for the information. We will keep your supplier details on file for reference.\n\nBest regards,\nActive Paw';
    const { fetchImpl } = llm(supplierReading, { customerAsks: [], bodyText: signedMiss, confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const body = (await s.getPendingDraft(tid))!.body_text;
    expect(body.match(/regards/gi)?.length).toBe(1);
    expect(body.indexOf('your website or your Alibaba')).toBeGreaterThan(0);
    expect(body.indexOf('your website or your Alibaba')).toBeLessThan(body.indexOf('Best Regards,\nActive Paw Sourcing Team'));
  });

  it('never asks again for a link our earlier reply already asked for (Andasea, 2026-09-18)', async () => {
    const { s, tid } = await seed({ email: 'daisy.service@andasea.com', name: 'Daisy', category: 'supplier', inbound: ['We make felt pet products.', 'Here is our new felt cat cave range.'],
      outboundAfterFirst: 'Thank you. It is better if you can leave your website address or preferably alibaba store if you have for our later reference.' });
    const asksDropshipOnly = 'Thank you for sharing your felt cat cave range. You are welcome to email over your catalogue. Do you offer dropshipping, meaning sending single orders directly to our customers? We keep supplier details on file for reference.';
    const { fetchImpl } = llm(supplierReading, { customerAsks: [], bodyText: asksDropshipOnly, confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const draft = await s.getPendingDraft(tid);
    expect(draft?.body_text).toContain('Do you offer dropshipping');
    expect(draft?.body_text).not.toMatch(/your website or your Alibaba/i);
  });

  // FOOFEE (design 2026-11-14, 8.1): the second thread from the same supplier
  // re-asked for the link and the dropshipping answer that the first thread's
  // reply had already asked for. The asks are owed once per supplier now.
  it('a second thread from the same supplier is not asked again what the first reply asked', async () => {
    const email = 'info@foofee.com';
    const { s } = await seed({ email, name: 'Mia', category: 'supplier', inbound: ['We make pet bowls.'],
      outboundAfterFirst: 'Thank you for informing us! Could you send us the link to your website or your Alibaba or other online store, for our reference? Do you offer dropshipping, meaning sending single orders directly to our customers?' });
    const tid2 = await s.createThread({ contactEmail: email, subject: 'New range', subjectNorm: 'new range', receivedAt: '2026-10-01T10:00:00Z', initialStatus: 'new' });
    await s.insertInboundMessageIfNew({ threadId: tid2, messageId: '<foofee2@x>', inReplyTo: null, references: [], from: email, to: 'contact@activepaw.co.uk', subject: 'New range', bodyText: 'Here is our new bowls range for 2027.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-10-01T10:00:00Z' });
    await s.setThreadClassification(tid2, { status: 'needs_reply', primaryCategory: 'supplier', intentScore: 10, summary: 's', classifiedAt: '2026-10-01T10:05:00Z' });
    const plain = 'Thank you for informing us! We keep supplier details on file for reference.';
    const { fetchImpl } = llm(supplierReading, { customerAsks: [], bodyText: plain, confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid2))!.thread, fetchImpl);
    const body = (await s.getPendingDraft(tid2))!.body_text;
    expect(body).not.toMatch(/your website or your Alibaba/i);
    expect(body).not.toMatch(/dropshipping/i);
  });

  // Design 2026-11-14 (8.2): the owner rules an off-niche supplier gets nothing
  // about files and no questions, only a short note that their details are kept.
  it('an off-niche supplier gets the short prompt, no owed questions and no file sentence', async () => {
    const { s, tid } = await seed({ email: 'sales@solarpanels.cn', name: 'Wei', category: 'supplier', inbound: ['We make solar panels. Please find our catalogue attached.'] });
    const offNiche = { ...supplierReading, supplier: { ...supplierReading.supplier, productLines: ['solar panels'], nicheFit: 'off-niche' } };
    const { fetchImpl: inner } = llm(offNiche, { customerAsks: [], bodyText: 'Thank you for informing us! We have noted your details and keep them on file for reference.', confidence: 95, quotesPriceOrOrder: false, commercialIntent: false });
    let drafterSystem = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(url).includes('openrouter')) {
        const sys = JSON.parse(String(init.body)).messages?.[0]?.content ?? '';
        if (!sys.startsWith(THREAD_READER_MARKER)) drafterSystem = sys;
      }
      return inner(url, init);
    }) as unknown as typeof fetch;
    await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl);
    const body = (await s.getPendingDraft(tid))!.body_text;
    expect(drafterSystem).toContain('outside our range');
    expect(body).not.toMatch(/your website or your Alibaba|dropshipping|did not reach us/i);
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

// Design 2026-11-19, 1d: a reply that adds no new words gets no draft once we
// have answered. The reading says a reply is needed, so the reader's own gate
// is not what stops these drafts.
describe('replies that add no new words', () => {
  const customerReading = { senderRole: 'customer', openAsks: ['q'], offered: '', alreadyAnswered: [], replyNeeded: true, supplier: null, productQuery: null, senderName: null };
  const compose = async (s: TenantStore, tid: string, fetchImpl: typeof fetch, force = false) =>
    composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, fetchImpl, { force });

  it('a bump after our reply gets no draft and waits', async () => {
    const { s, tid } = await seed({ email: 'ana@example.com', name: 'Ana', category: 'other', inbound: ['Do you ship to Ireland?', 'Hi active paw'], outboundAfterFirst: 'Yes, we deliver to Ireland.' });
    const r = await compose(s, tid, llm(customerReading).fetchImpl);
    expect(r).toEqual({ noReply: true });
    expect((await s.getThreadWithMessages(tid))!.thread.status).toBe('awaiting_customer');
    expect(await s.getPendingDraft(tid)).toBeNull();
  });
  it('Regenerate (force) still drafts a bump', async () => {
    const { s, tid } = await seed({ email: 'ana@example.com', name: 'Ana', category: 'other', inbound: ['Do you ship to Ireland?', 'Hi active paw'], outboundAfterFirst: 'Yes, we deliver to Ireland.' });
    const r = await compose(s, tid, llm(customerReading).fetchImpl, true);
    expect(r && 'draftId' in r).toBe(true);
  });
  it('a photo-only reply after our reply is answered', async () => {
    const { s, tid } = await seed({ email: 'ana@example.com', name: 'Ana', category: 'other', inbound: ['My bowl arrived cracked', ''], outboundAfterFirst: 'Sorry to hear that. Please send a photo.' });
    const msgs = (await s.getThreadWithMessages(tid))!.messages;
    const photoMsg = msgs[msgs.length - 1];
    await s.insertAttachment({ id: 'ph1', thread_id: tid, message_id: photoMsg.id, filename: 'bowl.jpg', content_type: 'image/jpeg', size_bytes: 10, status: 'stored', r2_key: `inbox/${SHOP}/${tid}/ph1` });
    const r = await compose(s, tid, llm(customerReading).fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
  });
  it('a reply that is only a refused file is answered', async () => {
    const { s, tid } = await seed({ email: 'ana@example.com', name: 'Ana', category: 'other', inbound: ['My bowl arrived cracked', ''], outboundAfterFirst: 'Sorry to hear that. Please send a photo.' });
    const msgs = (await s.getThreadWithMessages(tid))!.messages;
    await s.insertAttachment({ id: 'ph2', thread_id: tid, message_id: msgs[msgs.length - 1].id, filename: 'bowl.heic', content_type: 'image/heic', size_bytes: 10, status: 'skipped_type', r2_key: null });
    const r = await compose(s, tid, llm(customerReading).fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
  });
  it('an empty first message with a real subject is answered', async () => {
    const { s, tid } = await seed({ email: 'ana@example.com', name: 'Ana', category: 'other', inbound: [''], subject: 'Do you ship to Ireland?' });
    const r = await compose(s, tid, llm(customerReading).fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
  });
  it('an empty first message with an empty subject gets no draft and the no-content label', async () => {
    const { s, tid } = await seed({ email: 'ana@example.com', name: 'Ana', category: 'other', inbound: ['?'], subject: 'Hi' });
    const r = await compose(s, tid, llm(customerReading).fetchImpl);
    expect(r).toEqual({ noReply: true });
    const got = (await s.getThreadWithMessages(tid))!;
    expect(got.thread.status).toBe('awaiting_customer');
    expect(got.labels).toContain('no-content');
  });
});

// Design 2026-11-19 (the De Zimar audit): a scripted seller who kept bumping
// was sent the same "still stands" pointer again and again. Now the bump gets
// the one friendly final answer, and after it has gone out, quiet.
describe('the De Zimar shape', () => {
  it('the De Zimar shape: a seller bump gets the final answer, then quiet', async () => {
    const marketer = { senderRole: 'marketer', openAsks: ['yes or no'], offered: 'store growth services', alreadyAnswered: [], replyNeeded: true, supplier: null, productQuery: null, senderName: null };
    const { s, tid } = await seed({ email: 'zara@example.com', name: 'Zara', category: 'affiliate', inbound: ['I can grow your store sales with my e-commerce services.'] });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'zara@example.com', stage: 'passed_to_form' });
    const turns: Array<[string, string]> = [
      [buildSignupInvite('Zara'), 'I am not looking for affiliate work, I offer growth services.'],
      [buildSecondTouch('signup_invite', 'Zara'), 'Did you see my report?'],
      [`Hi Zara,\n\nOur earlier reply still stands: ${AFFILIATE_APPLY_URL}\n\nBest Regards,\nActive Paw Partnerships`, 'Please reply yes or no.'],
      [`Hi Zara,\n\nAs before, the code trial is here: ${AFFILIATE_APPLY_URL}\n\nBest Regards,\nActive Paw Partnerships`,
        `Hi active paw\n\nOn Mon, Nov 16, 2026 at 10:00 AM Active Paw <sales@activepaw.co.uk> wrote:\n> Hi Zara,\n> As before, the code trial is here.`],
    ];
    let day = 1;
    for (const [ours, theirs] of turns) {
      await s.insertOutboundMessage({ threadId: tid, messageId: `<z${day}@activepaw.co.uk>`, from: 'sales@activepaw.co.uk', to: 'zara@example.com', subject: 'Re: Hello', bodyText: ours, bodyHtml: '', sentAt: `2026-10-0${day}T10:00:00Z` });
      await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<zr${day}@example.com>`, inReplyTo: null, references: [], from: 'zara@example.com', to: 'sales@activepaw.co.uk', subject: 'Re: Hello', bodyText: theirs, bodyHtml: null, headersJson: '{}', receivedAt: `2026-10-0${day}T12:00:00Z` });
      day++;
    }
    const cfg = (await s.getConfig())!;
    const thread = async () => (await s.getThreadWithMessages(tid))!.thread;
    const r1 = await composeDraftForThread(ENV, s, cfg, await thread(), llm(marketer).fetchImpl);
    const final = (await s.getPendingDraft(tid))!;
    expect(r1 && 'draftId' in r1).toBe(true);
    expect(final.body_text).toBe(buildCollaborationDecline('Zara'));

    await s.setDraftStatus(final.id, 'sent', { sentMessageId: '<zfin@activepaw.co.uk>', sentAt: '2026-10-08T10:00:00Z' });
    await s.insertOutboundMessage({ threadId: tid, messageId: '<zfin@activepaw.co.uk>', from: 'sales@activepaw.co.uk', to: 'zara@example.com', subject: 'Re: Hello', bodyText: final.body_text, bodyHtml: '', sentAt: '2026-10-08T10:00:00Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<zr9@example.com>', inReplyTo: null, references: [], from: 'zara@example.com', to: 'sales@activepaw.co.uk', subject: 'Re: Hello', bodyText: 'Hi', bodyHtml: null, headersJson: '{}', receivedAt: '2026-10-09T10:00:00Z' });
    const r2 = await composeDraftForThread(ENV, s, cfg, await thread(), llm(marketer).fetchImpl);
    expect(r2).toEqual({ noReply: true });
    expect(await s.getPendingDraft(tid)).toBeNull();

    // A message with words after the final answer: still quiet for a seller
    // (the declined branch), never the generic drafter.
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<zr10@example.com>', inReplyTo: null, references: [], from: 'zara@example.com', to: 'sales@activepaw.co.uk', subject: 'Re: Hello', bodyText: 'So is it a yes or a no? I need an answer today.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-10-10T10:00:00Z' });
    const r3 = await composeDraftForThread(ENV, s, cfg, await thread(), llm(marketer).fetchImpl);
    expect(r3).toEqual({ noReply: true });
    expect(await s.getPendingDraft(tid)).toBeNull();
  });
});

// Final review, Important 3: when the thread's file list cannot be read, the
// contentless gate cannot know whether the reply carried a file, so it fails
// open and drafts (in doubt, we draft).
describe('the contentless gate fails open', () => {
  it('a file list that cannot be read never silences a reply', async () => {
    const reading = { senderRole: 'customer', openAsks: ['q'], offered: '', alreadyAnswered: [], replyNeeded: true, supplier: null, productQuery: null, senderName: null };
    const { tid } = await seed({ email: 'ana@example.com', name: 'Ana', category: 'other', inbound: ['My bowl arrived cracked', ''], outboundAfterFirst: 'Sorry to hear that. Please send a photo.' });
    class FilesDown extends TenantStore { async listAttachmentsForThread(): Promise<never> { throw new Error('D1 unavailable'); } }
    const s = new FilesDown(env.DB, SHOP);
    const r = await composeDraftForThread(ENV, s, (await s.getConfig())!, (await s.getThreadWithMessages(tid))!.thread, llm(reading).fetchImpl);
    expect(r && 'draftId' in r).toBe(true);
  });
});
