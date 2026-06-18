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
});
