/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { ingestParsed } from '../src/inbox/ingest';
import { runInboxClassifySweep } from '../src/inbox/sweep';
import { approveDraft } from '../src/inbox/routes';
import { DEFAULT_INBOX } from '../src/inbox/types';
import type { ParsedEmail } from '../src/inbox/types';
import {
  ACTIVE_PAW_COLLECTION_MAP,
  DEFAULT_PRICING,
  DEFAULT_FLOORS,
  DEFAULT_LLM,
  DEFAULT_ADDONS,
  DEFAULT_FULFIL,
} from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => { vi.restoreAllMocks(); });

const SHOP = 'a.myshopify.com';

function pe(over: Partial<ParsedEmail>): ParsedEmail {
  return {
    messageId: '<m1@x>',
    inReplyTo: null,
    references: [],
    from: { email: 'jane@x.com', name: 'Jane' },
    to: ['support@activepaw.co.uk'],
    subject: 'Do you have the large pet bed in stock?',
    date: '2026-06-18T10:00:00Z',
    text: 'Hi, I want to buy the large pet bed. Is it in stock?',
    html: null,
    headers: { 'authentication-results': 'mx; spf=pass dkim=pass dmarc=pass' },
    ...over,
  };
}

async function seedShop() {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await store.seedConfig({
    collectionMap: ACTIVE_PAW_COLLECTION_MAP,
    gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING,
    floors: DEFAULT_FLOORS,
    llm: DEFAULT_LLM,
    addons: DEFAULT_ADDONS,
    fulfil: DEFAULT_FULFIL,
    inbox: { ...DEFAULT_INBOX, alertEmail: 'owner@gmail.com' },
    target: 12,
  });
  // saveInbox is required — seedConfig does NOT persist the inbox column
  await store.saveInbox({ ...DEFAULT_INBOX, alertEmail: 'owner@gmail.com', autosend: false });
  return store;
}

/**
 * Fake fetch that branches on URL and system prompt:
 *  - openrouter + system mentions "triage"  → classify response (lead, needs_reply)
 *  - openrouter + anything else              → draft response (confident, price-free)
 *  - anything else (Resend)                 → { id: 'em_1' }
 */
function makeFakeFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('openrouter')) {
      const body = JSON.parse((init?.body as string) ?? '{}');
      const systemPrompt: string = (body.messages?.[0]?.content as string) ?? '';
      if (systemPrompt.includes('triage')) {
        // classify call
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  isHuman: true,
                  category: 'lead',
                  intentScore: 85,
                  summary: 'Customer wants to buy the large pet bed.',
                  labels: ['lead'],
                }),
              },
            }],
            usage: { cost: 0.0001 },
          }),
          { status: 200 },
        );
      } else {
        // draft call
        return new Response(
          JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  bodyText:
                    'Thank you for your interest in our large pet bed! Yes, it is currently in stock and ready to ship. Please add it to your cart to complete your purchase.',
                  confidence: 92,
                  quotesPriceOrOrder: false,
                }),
              },
            }],
            usage: { cost: 0.0001 },
          }),
          { status: 200 },
        );
      }
    }
    // Resend
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('W-INBOX-2 end-to-end integration', () => {
  it('full multi-turn flow: ingest → classify → pending draft → approve → send → re-thread reply re-opens', async () => {
    const store = await seedShop();
    const fakeFetch = makeFakeFetch();

    // ── Step 1: ingest an inbound email ─────────────────────────────────────
    const { threadId } = await ingestParsed(store, pe({}));
    const afterIngest = await store.getThreadWithMessages(threadId);
    expect(afterIngest?.thread.status).toBe('new');

    // ── Step 2: classify sweep (fake LLM: triage → lead/needs_reply) ────────
    // stub global fetch so approveDraft (which calls defaultFetch) also uses the fake
    vi.stubGlobal('fetch', fakeFetch);

    await runInboxClassifySweep(
      { ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any,
      fakeFetch,
    );

    const afterSweep = await store.getThreadWithMessages(threadId);
    expect(afterSweep?.thread.status).toBe('needs_reply');         // classified
    expect(afterSweep?.thread.primary_category).toBe('lead');
    expect(afterSweep?.thread.intent_score).toBe(85);
    expect(afterSweep?.labels).toContain('lead');

    // A pending draft should exist (autosend is OFF → held)
    const draft = await store.getPendingDraft(threadId);
    expect(draft).not.toBeNull();
    expect(draft?.status).toBe('pending');
    expect(draft?.body_text).toContain('pet bed');                 // drafted

    // ── Step 3: HITL approve → reply sent, outbound Message-ID stored ───────
    const draftId = draft!.id;
    const approveResult = await approveDraft(env.DB, SHOP, { ...env, RESEND_API_KEY: 'rk' } as any, draftId);
    expect(approveResult.ok).toBe(true);

    expect((await store.getDraft(draftId))?.status).toBe('sent'); // draft flipped
    const afterApprove = await store.getThreadWithMessages(threadId);
    expect(afterApprove?.thread.status).toBe('awaiting_customer'); // thread flipped

    // Outbound message row with a stored Message-ID must exist
    const outbound = afterApprove?.messages.find((m) => m.direction === 'outbound');
    expect(outbound).toBeDefined();
    expect(outbound?.message_id).toBeTruthy();                     // our controlled Message-ID

    // ── Step 4: customer reply referencing our outbound Message-ID re-threads ─
    const outboundMsgId = outbound!.message_id!;
    const replyResult = await ingestParsed(
      store,
      pe({
        messageId: '<m2@x>',
        inReplyTo: outboundMsgId,
        references: [outboundMsgId],
        subject: 'A completely unrelated subject line',
        text: 'Great, I will order it now. Thanks!',
      }),
    );

    // Must land in the SAME thread (re-threaded via Message-ID match)
    expect(replyResult.threadId).toBe(threadId);

    const afterReply = await store.getThreadWithMessages(threadId);
    // Thread re-opens to needs_reply because awaiting_customer + new inbound
    expect(afterReply?.thread.status).toBe('needs_reply');
    // Old pending draft (if any) superseded — there was none after approve, but verify no stale draft
    expect(await store.getPendingDraft(threadId)).toBeNull();
  });
});
