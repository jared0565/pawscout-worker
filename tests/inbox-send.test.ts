/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { sendReply } from '../src/inbox/send';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

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
