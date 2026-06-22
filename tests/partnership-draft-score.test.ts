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
});
