/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { sendReply } from '../src/inbox/send';
import { draftMetaFromGrounding } from '../src/inbox/sweep';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

// aramid 53d7292e (2026-10-07): a held sourcing offer quotes the supplier
// item's pre-import price. If the item was imported, refused or put up for
// profit review after the draft was written, sending it would offer a price or
// an item the store no longer honours, so the send refuses and says why.
describe('sendReply: a held sourcing offer', () => {
  async function heldOffer(shop: string) {
    const s = new TenantStore(env.DB, shop);
    await s.upsertContact({ email: 'aloha@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'aloha@x.com', subject: 'Collar', subjectNorm: 'collar', receivedAt: '2026-09-30T10:00:00Z', initialStatus: 'needs_reply' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<a1@x>', inReplyTo: null, references: [], from: 'aloha@x.com', to: 'contact@activepaw.co.uk', subject: 'Collar', bodyText: 'Do you sell a trackable collar?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-30T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'We can get the GPS collar for GBP 41.99.', bodyHtml: '<p>x</p>', confidence: 80, quotesPriceOrder: true, holdReasons: ['sourcing_offer'], model: 'm', status: 'pending', meta: { sourcingPid: 'T1' } });
    await env.DB.prepare('UPDATE inbox_drafts SET created_at = ?1 WHERE id = ?2').bind(new Date(Date.now() - 3_600_000).toISOString(), did).run();
    return { s, tid, did };
  }
  const calls: string[] = [];
  const okFetch = (async (u: unknown) => { calls.push(String(u)); return new Response(JSON.stringify({ id: 'em_s' }), { status: 200 }); }) as unknown as typeof fetch;
  async function send(s: TenantStore, tid: string, did: string) {
    calls.length = 0;
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    return sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, (await s.getDraft(did))!, undefined, okFetch);
  }

  for (const [state, why] of [['imported', /imported since this reply was written/i], ['failed', /refused/i], ['draft', /profit review/i], ['importing', /being imported/i]] as const) {
    it(`is not sent once its item is ${state} after the draft was written, and says why`, async () => {
      const { s, tid, did } = await heldOffer(`so-${state}.myshopify.com`);
      await s.putLink({ cjPid: 'T1', state, handle: state === 'imported' ? 'gps-collar' : undefined });
      const r = await send(s, tid, did);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(why);
      expect(r.error).toMatch(/regenerate/i);
      expect(calls).toEqual([]);                                // nothing reached Resend
      expect((await s.getDraft(did))!.status).toBe('pending');
    });
  }

  it('the drafted offer remembers the supplier item it quoted, and only a sourcing hold does', () => {
    expect(draftMetaFromGrounding({ confident: true, quotesFigure: true, holdReason: 'sourcing_offer', facts: 'f', data: { sourcingPid: 'T1', sourcingHandle: null } })).toEqual({ sourcingPid: 'T1' });
    expect(draftMetaFromGrounding({ confident: true, quotesFigure: true, facts: 'f', data: { sourcingPid: 'T1' } })).toBeUndefined();
    expect(draftMetaFromGrounding({ confident: true, quotesFigure: true, holdReason: 'sourcing_offer', facts: 'f' })).toBeUndefined();
  });

  it('is sent as before when its item has not changed since the draft was written', async () => {
    const { s, tid, did } = await heldOffer('so-same.myshopify.com');
    const r = await send(s, tid, did);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('is sent as before when the item changed BEFORE the draft was written', async () => {
    const { s, tid, did } = await heldOffer('so-before.myshopify.com');
    await s.putLink({ cjPid: 'T1', state: 'failed', failReason: 'import-error' });
    await env.DB.prepare('UPDATE product_links SET updated_at = ?1 WHERE cj_pid = ?2').bind(new Date(Date.now() - 2 * 3_600_000).toISOString(), 'T1').run();
    expect((await send(s, tid, did)).ok).toBe(true);
  });
});

describe('sendReply', () => {
  it('sends To the contact, stores our Message-ID outbound, flips draft+thread; reply re-threads', async () => {
    const s = new TenantStore(env.DB, 'a.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Ship?', subjectNorm: 'ship?', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<cust-1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Ship?', bodyText: 'do you ship?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Yes we do.', bodyHtml: '<p>Yes we do.</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });

    let sentTo: any = null, sentHeaders: any = null;
    const fetchImpl: typeof fetch = (async (_u: unknown, init: RequestInit) => { const b = JSON.parse(init.body as string); sentTo = b.to; sentHeaders = b.headers; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }) as unknown as typeof fetch;

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(sentTo).toEqual(['jane@x.com']);                 // To = contact, not relay
    expect(sentHeaders['In-Reply-To']).toBe('<cust-1@x>');  // threads to the customer's message

    expect((await s.getDraft(did))?.status).toBe('sent');
    expect((await s.getThreadWithMessages(tid))?.thread.status).toBe('awaiting_customer');

    // our outbound Message-ID is stored → a customer reply referencing it re-threads
    const got = await s.getThreadWithMessages(tid);
    const outbound = got!.messages.find(m => m.direction === 'outbound')!;
    const matched = await s.matchThread({ contactEmail: 'jane@x.com', inReplyTo: outbound.message_id, references: [], subjectNorm: 'ship?' });
    expect(matched).toBe(tid);
  });

  // Re-threading must NOT depend on Resend preserving our outbound Message-ID.
  // Our reply sets In-Reply-To/References to the customer's last inbound id (send.ts).
  // Per RFC 5322 §3.6.4 the customer's next reply carries References = [original inbound id, our outbound id].
  // So even if Resend OVERRODE our Message-ID (delivering a <...@resend.dev> we never stored),
  // matchThread still hits via the round-tripped inbound id. This is the load-bearing guarantee.
  it('re-threads via the round-tripped inbound id even if our outbound Message-ID was never stored (Resend override safe)', async () => {
    const s = new TenantStore(env.DB, 'b.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Ship?', subjectNorm: 'ship?', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'awaiting_customer' });
    // Original customer inbound - its Message-ID is stored and is what our reply's References points at.
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<cust-1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Ship?', bodyText: 'do you ship?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });

    // Customer's NEW reply: In-Reply-To is an id we never stored (simulating a Resend-overridden
    // <...@resend.dev> outbound id), but References still chains the original inbound id.
    const matched = await s.matchThread({
      contactEmail: 'jane@x.com',
      inReplyTo: '<NEVER-STORED-resend-generated@resend.dev>',
      references: ['<cust-1@x>', '<NEVER-STORED-resend-generated@resend.dev>'],
      subjectNorm: 'ship?'
    });
    expect(matched).toBe(tid); // matched via the round-tripped inbound id, NOT our outbound Message-ID
  });

  const okFetch: typeof fetch = (async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })) as unknown as typeof fetch;

  it('on send, auto-tags the thread with its classifier category (non-destructive) and flips status to awaiting_customer', async () => {
    const s = new TenantStore(env.DB, 'c.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Q', subjectNorm: 'q', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 50, summary: null, classifiedAt: '2026-06-18T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<c1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Q', bodyText: 'q?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'A.', bodyHtml: '<p>A.</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, okFetch);
    expect(r.ok).toBe(true);

    const got = (await s.getThreadWithMessages(tid))!;
    expect(got.thread.status).toBe('awaiting_customer');
    expect(got.labels).toContain('product-question'); // auto-tagged by classifier category, no manual step
  });

  it('sends from partnership identity when thread.declared_intent is partnerships, even if category is other and inbound arrived on support@', async () => {
    const s = new TenantStore(env.DB, 'e.myshopify.com');
    await s.upsertContact({ email: 'partner@brand.com', name: 'Sam', phone: null });
    const tid = await s.createThread({ contactEmail: 'partner@brand.com', subject: 'Collab?', subjectNorm: 'collab?', receivedAt: '2026-06-20T10:00:00Z', initialStatus: 'needs_reply', declaredIntent: 'partnerships' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 30, summary: null, classifiedAt: '2026-06-20T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<partner-1@brand>', inReplyTo: null, references: [], from: 'partner@brand.com', to: 'support@activepaw.co.uk', subject: 'Collab?', bodyText: 'want to collab', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-20T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Thanks for reaching out.', bodyHtml: '<p>Thanks for reaching out.</p>', confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'partnership-screen', status: 'pending' });

    let sentFrom: any = null;
    const fetchImpl: typeof fetch = (async (_u: unknown, init: RequestInit) => { const b = JSON.parse(init.body as string); sentFrom = b.from; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }) as unknown as typeof fetch;

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(sentFrom).toBe('Active Paw Partnerships <sales@activepaw.co.uk>');
  });

  // Rose thread (2026-09-06): classified 'affiliate' by the model, but nothing
  // she wrote asks to partner. The reply is a customer-service answer and must
  // come from the address she wrote to, not from "Active Paw Partnerships".
  it("replies from the address written to when the category is affiliate but no message asks to partner", async () => {
    const s = new TenantStore(env.DB, 'rose.myshopify.com');
    await s.upsertContact({ email: 'rose@x.com', name: 'Rose', phone: null });
    const tid = await s.createThread({ contactEmail: 'rose@x.com', subject: 'Quick question', subjectNorm: 'quick question', receivedAt: '2026-09-05T14:44:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 20, summary: null, classifiedAt: '2026-09-06T04:15:00Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<rose-1@x>', inReplyTo: null, references: [], from: 'rose@x.com', to: 'contact@activepaw.co.uk', subject: 'Quick question', bodyText: 'I am considering recommending your store to a few people. Do the products arrive exactly as shown and described?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-05T14:44:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Yes, they do.', bodyHtml: '<p>Yes, they do.</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });

    let sentFrom: any = null;
    const fetchImpl: typeof fetch = (async (_u: unknown, init: RequestInit) => { const b = JSON.parse(init.body as string); sentFrom = b.from; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }) as unknown as typeof fetch;

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(sentFrom).toBe('Active Paw <contact@activepaw.co.uk>');
  });

  // 2026-09-06: the wire From was right (resolveFromAddress) but the stored
  // outbound row said support@ for every reply, so the thread record misreported
  // which desk answered. The row must carry the bare address actually sent from.
  it('records the resolved sender address on the stored outbound row, not the support@ default', async () => {
    const s = new TenantStore(env.DB, 'rose2.myshopify.com');
    await s.upsertContact({ email: 'rose@x.com', name: 'Rose', phone: null });
    const tid = await s.createThread({ contactEmail: 'rose@x.com', subject: 'Quick question', subjectNorm: 'quick question', receivedAt: '2026-09-05T14:44:00Z', initialStatus: 'needs_reply' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<rose-1@x>', inReplyTo: null, references: [], from: 'rose@x.com', to: 'contact@activepaw.co.uk', subject: 'Quick question', bodyText: 'Do the products arrive exactly as shown and described?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-05T14:44:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Yes, they do.', bodyHtml: '<p>Yes, they do.</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const fetchImpl: typeof fetch = (async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })) as unknown as typeof fetch;

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    const outbound = (await s.getThreadWithMessages(tid))!.messages.find((m) => m.direction === 'outbound')!;
    expect(outbound.from_addr).toBe('contact@activepaw.co.uk');
  });

  // aramid llm-review 2026-09-06 (finding ab7ce5d8): the lane gate now reads
  // only what the sender wrote since our last reply, so the sales@ identity of
  // a thread already IN the funnel must come from its applicant row, not from
  // re-finding the original ask. A "thanks" after our invite still goes out as
  // Active Paw Partnerships.
  it("keeps the partnerships identity on a funnel thread whose latest message no longer asks (applicant row carries it)", async () => {
    const s = new TenantStore(env.DB, 'applicant.myshopify.com');
    await s.upsertContact({ email: 'cre@x.com', name: 'Cree', phone: null });
    const tid = await s.createThread({ contactEmail: 'cre@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-09-05T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 20, summary: null, classifiedAt: '2026-09-05T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<ap1@x>', inReplyTo: null, references: [], from: 'cre@x.com', to: 'contact@activepaw.co.uk', subject: 'Hi', bodyText: 'Do you have an affiliate programme?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-05T10:00:00Z' });
    await s.insertOutboundMessage({ threadId: tid, messageId: '<ap-r1@x>', from: 'sales@activepaw.co.uk', to: 'cre@x.com', subject: 'Re: Hi', bodyText: 'Hi Cree,\n\nThe application is on our website.\n\nBest Regards,\nActive Paw Partnerships', bodyHtml: '<p>x</p>', sentAt: '2026-09-05T11:00:00Z' });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'cre@x.com', stage: 'passed_to_form' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<ap2@x>', inReplyTo: '<ap-r1@x>', references: [], from: 'cre@x.com', to: 'contact@activepaw.co.uk', subject: 'Re: Hi', bodyText: 'Okay thanks, will do.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-06T09:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Great, we look forward to it.', bodyHtml: '<p>x</p>', confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'partnership-screen', status: 'pending' });

    let sentFrom: any = null;
    const fetchImpl: typeof fetch = (async (_u: unknown, init: RequestInit) => { const b = JSON.parse(init.body as string); sentFrom = b.from; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }) as unknown as typeof fetch;
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(sentFrom).toBe('Active Paw Partnerships <sales@activepaw.co.uk>');
    const outbound = (await s.getThreadWithMessages(tid))!.messages.filter((m) => m.direction === 'outbound').at(-1)!;
    expect(outbound.from_addr).toBe('sales@activepaw.co.uk');
  });

  // Controller fix round 2 (2026-09-27): a supplier who writes to sales@ is not
  // automatically in the partnership funnel - only a real partnership ask
  // (category != supplier) or an existing applicant row puts a thread on that
  // lane. Otherwise a supplier reply carries "Active Paw Partnerships" in the
  // From while its body signs off "Active Paw Sourcing Team", a mismatch.
  it('a supplier thread with no applicant row is not sent as Active Paw Partnerships, even when the inbound went to sales@', async () => {
    const s = new TenantStore(env.DB, 'supplier1.myshopify.com');
    await s.upsertContact({ email: 'vendor@supplier.cn', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'vendor@supplier.cn', subject: 'Our catalogue', subjectNorm: 'our catalogue', receivedAt: '2026-09-20T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'supplier', intentScore: 20, summary: null, classifiedAt: '2026-09-20T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<sup-1@x>', inReplyTo: null, references: [], from: 'vendor@supplier.cn', to: 'sales@activepaw.co.uk', subject: 'Our catalogue', bodyText: 'Please see our catalogue attached.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-20T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Thank you for sending your catalogue.\n\nActive Paw Sourcing Team', bodyHtml: '<p>x</p>', confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });

    let sentFrom: any = null;
    const fetchImpl: typeof fetch = (async (_u: unknown, init: RequestInit) => { const b = JSON.parse(init.body as string); sentFrom = b.from; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }) as unknown as typeof fetch;
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(sentFrom).not.toMatch(/^Active Paw Partnerships/);
  });

  it('a supplier thread WITH an applicant row still sends as Active Paw Partnerships', async () => {
    const s = new TenantStore(env.DB, 'supplier2.myshopify.com');
    await s.upsertContact({ email: 'vendor2@supplier.cn', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'vendor2@supplier.cn', subject: 'Our catalogue', subjectNorm: 'our catalogue', receivedAt: '2026-09-20T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'supplier', intentScore: 20, summary: null, classifiedAt: '2026-09-20T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<sup-2@x>', inReplyTo: null, references: [], from: 'vendor2@supplier.cn', to: 'sales@activepaw.co.uk', subject: 'Our catalogue', bodyText: 'Please see our catalogue attached.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-20T10:00:00Z' });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'vendor2@supplier.cn', stage: 'passed_to_form' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Thank you.\n\nActive Paw Partnerships', bodyHtml: '<p>x</p>', confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });

    let sentFrom: any = null;
    const fetchImpl: typeof fetch = (async (_u: unknown, init: RequestInit) => { const b = JSON.parse(init.body as string); sentFrom = b.from; return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }) as unknown as typeof fetch;
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, fetchImpl);
    expect(r.ok).toBe(true);
    expect(sentFrom).toBe('Active Paw Partnerships <sales@activepaw.co.uk>');
  });

  it('does NOT clobber an explicit converted/closed status on send (preserves the merchant choice)', async () => {
    const s = new TenantStore(env.DB, 'd.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Q', subjectNorm: 'q', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'converted' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<c1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Q', bodyText: 'q?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'A.', bodyHtml: '<p>A.</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, okFetch);
    expect(r.ok).toBe(true);
    expect((await s.getThreadWithMessages(tid))!.thread.status).toBe('converted'); // not downgraded to awaiting_customer
  });

  it('a successful send captures the FINAL text into answer memory (owner edits included)', async () => {
    const s = new TenantStore(env.DB, 'd.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Ship?', subjectNorm: 'ship?', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'lead', intentScore: 50, summary: null, classifiedAt: '2026-06-18T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<c1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Ship?', bodyText: 'Do you ship worldwide from your shop?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Draft answer.', bodyHtml: '<p>Draft answer.</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft,
      'Hi Jane,\n\nYes, we ship worldwide to most countries.\n\nBest Regards,\nActive Paw Sales Team', okFetch);
    expect(r.ok).toBe(true);
    const mem = await s.listAnswerMemory();
    expect(mem.total).toBe(1);
    expect(mem.rows[0].question).toBe('Do you ship worldwide from your shop?');
    expect(mem.rows[0].answer).toBe('Yes, we ship worldwide to most countries.'); // owner-edited FINAL text, wrapper stripped
    expect(mem.rows[0].category).toBe('lead');
  });

  it('a capture failure never fails the send', async () => {
    const s = new TenantStore(env.DB, 'e.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Ship?', subjectNorm: 'ship?', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'lead', intentScore: 50, summary: null, classifiedAt: '2026-06-18T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<c2@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Ship?', bodyText: 'Do you ship worldwide from your shop?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Yes we do ship worldwide.', bodyHtml: '<p>x</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    (s as any).upsertAnswerMemory = async () => { throw new Error('boom'); };
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, okFetch);
    expect(r.ok).toBe(true);
    expect((await s.getDraft(did))?.status).toBe('sent');
  });
});
