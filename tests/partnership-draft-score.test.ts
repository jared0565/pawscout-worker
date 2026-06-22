/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { composeDraftForThread } from '../src/inbox/sweep';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

function llmReturning(content: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 })) as unknown as typeof fetch;
}
const factsJson = (o: Record<string, unknown>) => JSON.stringify({
  channelUrls: ['https://tiktok.com/@dogmum'], disqualifier: 'none', audienceRelevance: 'pet_uk', acceptsTerms: 'yes',
  engagement: 'plausible', evidence: 'concrete', experience: 'some', method: 'content', specificity: 'specific', ...o });

async function seedAnswered(shop: string) {
  const s = new TenantStore(env.DB, shop);
  await s.upsertContact({ email: 'kasim@x.com', name: 'Kasim', phone: null });
  const tid = await s.createThread({ contactEmail: 'kasim@x.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 60, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
  // original pitch (inbound)
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<a1@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'I run a dog IG, want to promote you for commission', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
  // we SENT the qualifying email (outbound) — the precondition for scoring their reply
  await s.insertOutboundMessage({ threadId: tid, messageId: '<screen@ap>', from: 'sales@activepaw.co.uk', to: 'kasim@x.com', subject: 'Re: Partnership', bodyText: 'a few quick questions...', bodyHtml: '<p>a few quick questions...</p>', sentAt: '2026-06-22T10:30:00Z' });
  // they replied with answers (inbound)
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<a2@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'answers: my tiktok @dogmum, 8k UK dog owners, honest review, fine with #ad', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T11:00:00Z' });
  await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'screen_sent' }); // already screened
  return { s, tid };
}

describe('partnership scoring branch', () => {
  it('clear pass → form-invite draft, applicant passed_to_form', async () => {
    const { s, tid } = await seedAnswered('a.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env, OPENROUTER_API_KEY: 'k' } as any, s, CFG, thread, llmReturning(factsJson({})));
    expect(r!.send).toBe(false);
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/partner application/i);
    const app = await s.getApplicantByThread(tid);
    expect(app!.stage).toBe('passed_to_form');
    expect(app!.score).toBeGreaterThanOrEqual(8);
  });

  it('hard gate → respectful decline draft, applicant declined', async () => {
    const { s, tid } = await seedAnswered('b.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env, OPENROUTER_API_KEY: 'k' } as any, s, CFG, thread, llmReturning(factsJson({ channelUrls: [] })));
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/right fit right now/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
    expect(r!.send).toBe(false);
  });

  it('extraction failure → escalate (holding ack), applicant escalated', async () => {
    const { s, tid } = await seedAnswered('c.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env, OPENROUTER_API_KEY: 'k' } as any, s, CFG, thread, llmReturning('not json'));
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/reviewing|taking a look/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('escalated');
    expect(r!.send).toBe(false);
  });

  // Premature-scoring race: applicant is at screen_sent but the qualifying email was
  // never actually sent (no outbound) — e.g. its pending draft was superseded by a
  // follow-up. Must RE-ISSUE the questions, NOT score the non-answer into a decline.
  it('re-issues the qualifying email (does NOT score/decline) when the screen was never sent', async () => {
    const s = new TenantStore(env.DB, 'race.myshopify.com');
    await s.upsertContact({ email: 'kasim@x.com', name: 'Kasim', phone: null });
    const tid = await s.createThread({ contactEmail: 'kasim@x.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 60, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<race1@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'I can bring you tons of sales!', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'screen_sent' }); // drafted, NOT sent
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<race2@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'are you there?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:05:00Z' });

    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env, OPENROUTER_API_KEY: 'k' } as any, s, CFG, thread, llmReturning(factsJson({ channelUrls: [] })));
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i); // re-issued questions
    expect(draft!.body_text).not.toMatch(/right fit right now/i);  // NOT a decline
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent'); // unchanged
  });
});
