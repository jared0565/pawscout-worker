/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore } from '../src/tenant-store';
import { listInboxThreads, getInboxThread, setInboxStatus, setInboxLabels, regenerateDraft, applyDraftTemplate, DRAFT_TEMPLATES } from '../src/inbox/routes';
import { QUALIFYING_MARKER } from '../src/inbox/partnership';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type Env } from '../src/types';
import { app } from '../src/index';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

// Seed a tenant WITH config (regenerate calls getConfig + the drafting chain).
async function seedWithConfig(inboxOver: Record<string, unknown> = {}) {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  const inbox = { ...DEFAULT_INBOX, ...inboxOver };
  await s.seedConfig({
    collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox, target: 12
  });
  await s.saveInbox(inbox); // seedConfig does not persist the inbox column
  const tid = await seed();
  await s.setThreadStatus(tid, 'needs_reply');
  return { s, tid };
}
// LLM (and any other) fetch mock; records URLs so a test can assert no email was sent.
function llmFetch(body: unknown, urls?: string[]): typeof fetch {
  return (async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (urls) urls.push(String(url));
    if (String(url).includes('openrouter') || String(url).includes('openai')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }], usage: { cost: 0.0001 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  }) as unknown as typeof fetch;
}
const REGEN_ENV = () => ({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as unknown as Env);

async function seed() {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
  const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<m@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Hi', bodyText: 'hello', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
  return tid;
}

describe('inbox routes', () => {
  it('lists threads with contact + label summary', async () => {
    const tid = await seed();
    const r = await listInboxThreads(env.DB, SHOP, null);
    expect(r.ok).toBe(true);
    expect(r.threads[0].id).toBe(tid);
    expect(r.threads[0].contactEmail).toBe('jane@x.com');
  });
  // 2026-07-05 stale-badge fix: EVERY list response carries the fresh Open-queue
  // size so the rail badge re-syncs on each Inbox fetch, whatever the filter.
  it('every list response carries openCount (the Open-queue size)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await seed();
    const r = await listInboxThreads(env.DB, SHOP, null);
    expect(r.openCount).toBe(1); // the seeded open thread
    const tid2 = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Closed one', subjectNorm: 'closed one', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new' });
    await s.setThreadStatus(tid2, 'closed');
    const r2 = await listInboxThreads(env.DB, SHOP, 'closed'); // non-open filter still reports the OPEN count
    expect(r2.openCount).toBe(1);
  });
  // Phase 3: the list carries the contact's display name + a real hasDraft flag.
  it('lists threads with contactName and hasDraft', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await seed();
    let r = await listInboxThreads(env.DB, SHOP, null);
    expect(r.threads[0].contactName).toBe('Jane');
    expect(r.threads[0].hasDraft).toBe(false);
    await s.insertDraft({ threadId: tid, bodyText: 'Hi', bodyHtml: '<p>Hi</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    r = await listInboxThreads(env.DB, SHOP, null);
    expect(r.threads[0].hasDraft).toBe(true);
    // A sent draft is no longer "ready" - the flag must clear.
    const draft = await s.getPendingDraft(tid);
    await s.setDraftStatus(draft!.id, 'sent', { sentAt: new Date().toISOString() });
    r = await listInboxThreads(env.DB, SHOP, null);
    expect(r.threads[0].hasDraft).toBe(false);
  });
  it('returns the contact row with the thread (context-rail name)', async () => {
    const tid = await seed();
    const r = await getInboxThread(env.DB, SHOP, tid);
    expect(r.ok).toBe(true);
    expect(r.contact?.name).toBe('Jane');
    expect(r.contact?.email).toBe('jane@x.com');
  });
  it('reads a thread with its messages', async () => {
    const tid = await seed();
    const r = await getInboxThread(env.DB, SHOP, tid);
    expect(r.ok).toBe(true);
    expect(r.messages![0].body_text).toBe('hello');
  });
  it('sets status and labels with validation', async () => {
    const tid = await seed();
    expect((await setInboxStatus(env.DB, SHOP, tid, 'closed')).ok).toBe(true);
    expect((await setInboxStatus(env.DB, SHOP, tid, 'bogus')).ok).toBe(false);
    expect((await setInboxLabels(env.DB, SHOP, tid, ['lead'])).ok).toBe(true);
    expect((await setInboxLabels(env.DB, SHOP, tid, ['nope'])).ok).toBe(false);
    const got = await new TenantStore(env.DB, SHOP).getThreadWithMessages(tid);
    expect(got?.thread.status).toBe('closed');
    expect(got?.labels).toEqual(['lead']);
  });
  it('404s an unknown thread', async () => {
    const r = await getInboxThread(env.DB, SHOP, 'no-such-id');
    expect(r.ok).toBe(false);
  });
  // Email engagement (2026-07-12): the thread payload carries this thread's
  // delivery/open/click events (send-time thread_id tag), newest first and
  // thread-scoped - the context rail's Email engagement block reads them.
  it('returns the thread email events newest-first, scoped to the thread', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await seed();
    const ev = (svixId: string, threadId: string, eventType: string, occurredAt: string, link: string | null = null) =>
      s.insertEmailEvent({ svixId, resendId: 're_1', email: 'jane@x.com', eventType, kind: 'reply', campaignId: null, threadId, link, occurredAt }, occurredAt);
    await ev('sv1', tid, 'delivered', '2026-07-12T08:00:00Z');
    await ev('sv2', tid, 'opened', '2026-07-12T09:00:00Z');
    await ev('sv3', tid, 'clicked', '2026-07-12T09:05:00Z', 'https://activepaw.co.uk/products/x');
    await ev('sv4', 'other-thread', 'delivered', '2026-07-12T10:00:00Z');
    const r = await getInboxThread(env.DB, SHOP, tid);
    expect(r.ok).toBe(true);
    expect(r.events!.map((e: { eventType: string }) => e.eventType)).toEqual(['clicked', 'opened', 'delivered']);
    expect(r.events![0].link).toBe('https://activepaw.co.uk/products/x');
    expect(r.events![0].occurredAt).toBe('2026-07-12T09:05:00Z');
  });
  // 2026-07-04 stale-draft fix: dismissing a thread retires its pending draft.
  // Phase 2 removed the standalone draft-Discard button, so without this the
  // draft would stay 'pending' forever and inflate the rail badge.
  it('dismissing a thread (closed/spam/converted) also discards its pending draft', async () => {
    const s = new TenantStore(env.DB, SHOP);
    for (const dismissal of ['closed', 'spam', 'converted'] as const) {
      const tid = await seed();
      const did = await s.insertDraft({ threadId: tid, bodyText: 'Hi', bodyHtml: '<p>Hi</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
      expect((await setInboxStatus(env.DB, SHOP, tid, dismissal)).ok).toBe(true);
      expect(await s.getPendingDraft(tid)).toBeNull();
      // retired as discarded (audit trail kept), never deleted
      expect((await s.getDraft(did))?.status).toBe('discarded');
    }
  });
  it('a non-dismissal status change leaves the pending draft alone', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await seed();
    await s.insertDraft({ threadId: tid, bodyText: 'Hi', bodyHtml: '<p>Hi</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    expect((await setInboxStatus(env.DB, SHOP, tid, 'needs_reply')).ok).toBe(true);
    expect((await setInboxStatus(env.DB, SHOP, tid, 'awaiting_customer')).ok).toBe(true);
    expect(await s.getPendingDraft(tid)).not.toBeNull();
  });
  it('returns the pending draft with the thread', async () => {
    const s = new TenantStore(env.DB, SHOP); const tid = await seed();
    await s.insertDraft({ threadId: tid, bodyText: 'Hi', bodyHtml: '<p>Hi</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const r = await getInboxThread(env.DB, SHOP, tid);
    expect(r.ok).toBe(true); expect(r.draft?.body_text).toBe('Hi');
  });
});

describe('regenerateDraft', () => {
  it('discards the old draft, inserts a fresh one, and keeps the thread OPEN', async () => {
    const { s, tid } = await seedWithConfig();
    const did = await s.insertDraft({ threadId: tid, bodyText: 'OLD draft', bodyHtml: '<p>OLD draft</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const r = await regenerateDraft(env.DB, REGEN_ENV(), SHOP, did, llmFetch({ bodyText: 'FRESH draft body', confidence: 88, quotesPriceOrOrder: false }));
    expect(r.ok).toBe(true);
    expect((r as { draft?: { body_text?: string } }).draft?.body_text).toContain('FRESH draft body');
    expect((await s.getDraft(did))?.status).toBe('discarded');                          // old one retired
    expect((await s.getThreadWithMessages(tid))?.thread.status).not.toBe('closed');     // NEVER closes (the discard trap)
  });

  it('NEVER auto-sends, even with autosend on + high confidence', async () => {
    const { s, tid } = await seedWithConfig({ autosend: true, autoConfidenceThreshold: 0 });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'OLD', bodyHtml: '<p>OLD</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const urls: string[] = [];
    const r = await regenerateDraft(env.DB, REGEN_ENV(), SHOP, did, llmFetch({ bodyText: 'auto would send this', confidence: 99, quotesPriceOrOrder: false }, urls));
    expect(r.ok).toBe(true);
    expect(urls.some((u) => u.includes('resend'))).toBe(false);                          // no email left the building
    expect((await s.getThreadWithMessages(tid))?.thread.status).not.toBe('awaiting_customer'); // sendReply would set this
  });

  it('leaves the current draft intact when the LLM fails (no data loss)', async () => {
    const { s, tid } = await seedWithConfig();
    const did = await s.insertDraft({ threadId: tid, bodyText: 'KEEP ME', bodyHtml: '<p>KEEP ME</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const r = await regenerateDraft(env.DB, REGEN_ENV(), SHOP, did, llmFetch({ bodyText: '', confidence: 0, quotesPriceOrOrder: false })); // empty body → draftReply null
    expect(r.ok).toBe(false);
    expect((await s.getDraft(did))?.status).toBe('pending');                             // original untouched
    expect((await s.getPendingDraft(tid))?.body_text).toBe('KEEP ME');
  });

  it('rejects a non-pending draft', async () => {
    const { s, tid } = await seedWithConfig();
    const did = await s.insertDraft({ threadId: tid, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    await s.setDraftStatus(did, 'discarded');
    const r = await regenerateDraft(env.DB, REGEN_ENV(), SHOP, did, llmFetch({ bodyText: 'x', confidence: 80, quotesPriceOrOrder: false }));
    expect(r.ok).toBe(false);
  });

  // 2026-07-06 Ishola fix: Regenerate must route like the sweep - partnership
  // funnel first. A commission-for-volume pitch on an 'other' thread used to
  // re-run only the category agent, reproducing the same decline template on
  // every click; now it reaches the qualifying questions.
  it('routes a volume pitch through the partnership funnel: regenerate yields the qualifying questions', async () => {
    const { s, tid } = await seedWithConfig();
    await s.insertInboundMessageIfNew({
      threadId: tid, messageId: '<pitch@x>', inReplyTo: null, references: [],
      from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: Hi',
      bodyText: 'If I could help your business generate 20 additional orders within the next week, would you be open to a performance-based partnership where my compensation is just 3% of the additional revenue generated?',
      bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-19T10:00:00Z'
    });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Thank you so much for the kind offer... (old decline)', bodyHtml: '<p>old</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const urls: string[] = [];
    const r = await regenerateDraft(env.DB, REGEN_ENV(), SHOP, did, llmFetch({ bodyText: 'unused', confidence: 80, quotesPriceOrOrder: false }, urls));
    expect(r.ok).toBe(true);
    const fresh = await s.getPendingDraft(tid);
    expect(fresh?.body_text).toMatch(/where would you promote/i);   // the gating questions
    expect(fresh?.body_text).toContain('tracked orders');            // earned-tier ladder (volume pitch)
    expect((await s.getDraft(did))?.status).toBe('discarded');       // old decline retired
    expect((await s.getApplicantByThread(tid))?.stage).toBe('screen_sent');
    expect(urls.some((u) => u.includes('resend'))).toBe(false);      // regenerate never sends
  });
});

// Template picker (2026-07-06, Paul Joseph case): the owner swaps the pending
// draft for a canonical template without leaving the Inbox. Must mirror the
// funnel's own bookkeeping so a templated thread behaves identically after.
describe('applyDraftTemplate', () => {
  it('rejects an unknown template key and an unknown thread', async () => {
    const { tid } = await seedWithConfig();
    expect((await applyDraftTemplate(env.DB, SHOP, tid, 'bogus')).ok).toBe(false);
    expect((await applyDraftTemplate(env.DB, SHOP, 'no-such-thread', 'qualifying')).ok).toBe(false);
    expect((await applyDraftTemplate(env.DB, SHOP, null, 'qualifying')).ok).toBe(false);
  });

  it('replaces the pending draft with the qualifying email and stamps the applicant at screen_sent', async () => {
    const { s, tid } = await seedWithConfig();
    // The Paul Joseph shape: a commission consultant whose FOLLOW-UP carries no
    // pitch vocabulary, so the funnel's on-ramp cannot claim it by itself.
    await s.insertInboundMessageIfNew({
      threadId: tid, messageId: '<pj@x>', inReplyTo: null, references: [],
      from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: Hi',
      bodyText: 'Okay, can I know what you are actually looking into at the moment?',
      bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-19T10:00:00Z'
    });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'generic LLM reply', bodyHtml: '<p>x</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const r = await applyDraftTemplate(env.DB, SHOP, tid, 'qualifying');
    expect(r.ok).toBe(true);
    const draft = (r as { draft?: { body_text?: string } }).draft;
    expect(draft?.body_text).toContain(QUALIFYING_MARKER);   // replies will be scored, never re-asked
    expect(draft?.body_text).toContain('Hi Jane,');          // salutation from the contact row
    expect((await s.getDraft(did))?.status).toBe('superseded');
    expect((await s.getApplicantByThread(tid))?.stage).toBe('screen_sent');
  });

  it('includes the earned-tiers terms when any inbound negotiated commission against volume', async () => {
    const { s, tid } = await seedWithConfig();
    await s.insertInboundMessageIfNew({
      threadId: tid, messageId: '<vol@x>', inReplyTo: null, references: [],
      from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Re: Hi',
      bodyText: 'Give me 10% commission and I will guarantee 500 units in sales every month.',
      bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-19T10:00:00Z'
    });
    const r = await applyDraftTemplate(env.DB, SHOP, tid, 'qualifying');
    expect(r.ok).toBe(true);
    expect((r as { draft?: { body_text?: string } }).draft?.body_text).toContain('rates are earned on delivered volume');
  });

  it('decline templates stamp the applicant declined and reopen a closed thread', async () => {
    const { s, tid } = await seedWithConfig();
    await s.setThreadStatus(tid, 'closed');
    const r = await applyDraftTemplate(env.DB, SHOP, tid, 'service_decline');
    expect(r.ok).toBe(true);
    expect((r as { draft?: { body_text?: string } }).draft?.body_text).toContain('in-house');
    expect((await s.getApplicantByThread(tid))?.stage).toBe('declined');
    expect((await s.getThreadWithMessages(tid))?.thread.status).toBe('needs_reply');
  });

  it('the operations decline stays clear of the actual question asked and stamps declined', async () => {
    const { s, tid } = await seedWithConfig();
    const r = await applyDraftTemplate(env.DB, SHOP, tid, 'operations_decline');
    expect(r.ok).toBe(true);
    const body = (r as { draft?: { body_text?: string } }).draft?.body_text ?? '';
    expect(body).toContain('internal operations');
    expect(body).toContain('regardless of the reason for asking'); // never engages the discovery question itself
    expect((await s.getApplicantByThread(tid))?.stage).toBe('declined');
  });

  it('creates a draft when none is pending; the holding note leaves the funnel untouched', async () => {
    const { s, tid } = await seedWithConfig();
    expect(await s.getPendingDraft(tid)).toBeNull();
    const r = await applyDraftTemplate(env.DB, SHOP, tid, 'holding_ack');
    expect(r.ok).toBe(true);
    expect((await s.getPendingDraft(tid))?.body_text).toContain('reviewing the fit');
    expect(await s.getApplicantByThread(tid)).toBeNull();
  });

  it('the keep-to-email template stays on email without declining, and leaves the funnel untouched', async () => {
    const { s, tid } = await seedWithConfig();
    const r = await applyDraftTemplate(env.DB, SHOP, tid, 'keep_to_email');
    expect(r.ok).toBe(true);
    const body = (r as { draft?: { body_text?: string } }).draft?.body_text ?? '';
    expect(body).toContain('keep all of our conversations here on email');
    expect(body).not.toMatch(/not taking on|in-house|internal operations/i); // neutral, not a decline
    expect(await s.getApplicantByThread(tid)).toBeNull(); // stage untouched
  });

  it('every registry template renders a pending draft (no key without a body)', async () => {
    for (const t of DRAFT_TEMPLATES) {
      const { s, tid } = await seedWithConfig();
      const r = await applyDraftTemplate(env.DB, SHOP, tid, t.key);
      expect(r.ok, t.key).toBe(true);
      const d = await s.getPendingDraft(tid);
      expect((d?.body_text ?? '').length, t.key).toBeGreaterThan(50);
      expect(d?.model, t.key).toBe('template');
    }
  });
});

// HTTP-level contract test for the /api/inbox/answers routes (added 01ced64).
// These two handlers are inline in src/index.ts (no extracted pure function
// to call directly), so this drives the real Hono app through shopOf's
// session-token auth, unlike the direct-function tests above.
const ANSWERS_SHOP = 'answers.myshopify.com';
const ANSWERS_SECRET = 'test-shopify-secret';

async function answersBearerToken(shop: string): Promise<string> {
  const key = new TextEncoder().encode(ANSWERS_SECRET);
  // SHOPIFY_API_KEY is a wrangler.toml var (present at runtime) that the
  // ProvidedEnv type does not declare; cast through Env like REGEN_ENV above.
  return new SignJWT({ dest: `https://${shop}`, sub: '1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience((env as unknown as Env).SHOPIFY_API_KEY)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

function answersEnv(): Env {
  return { ...env, SHOPIFY_API_SECRET: ANSWERS_SECRET } as unknown as Env;
}

async function callAnswersRoute(path: string, body: unknown, token: string) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, answersEnv());
}

describe('POST /api/inbox/answers routes (HTTP level)', () => {
  it('list returns {ok, total, disabled, rows}; toggle flips disabled and 400s bad input', async () => {
    const s = new TenantStore(env.DB, ANSWERS_SHOP);
    await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await s.upsertAnswerMemory({
      qhash: 'h1', category: 'lead', questionText: 'Do you ship worldwide?',
      questionNorm: 'ship worldwide', answerText: 'Yes.', threadId: 't1'
    });
    const token = await answersBearerToken(ANSWERS_SHOP);

    // list
    const listRes = await callAnswersRoute('/api/inbox/answers', {}, token);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { ok: boolean; total: number; disabled: number; rows: { qhash: string }[] };
    expect(listBody.ok).toBe(true);
    expect(listBody.total).toBe(1);
    expect(listBody.disabled).toBe(0);
    expect(listBody.rows[0].qhash).toBe('h1');

    // toggle: unknown qhash
    const unknownRes = await callAnswersRoute('/api/inbox/answers/toggle', { qhash: 'nope', disabled: true }, token);
    expect(unknownRes.status).toBe(200);
    const unknownBody = await unknownRes.json() as { ok: boolean; error?: string };
    expect(unknownBody.ok).toBe(false);
    expect(unknownBody.error).toBeTruthy();

    // toggle: missing qhash -> 400
    const missingQhashRes = await callAnswersRoute('/api/inbox/answers/toggle', { disabled: true }, token);
    expect(missingQhashRes.status).toBe(400);

    // toggle: non-boolean disabled -> 400
    const badDisabledRes = await callAnswersRoute('/api/inbox/answers/toggle', { qhash: 'h1', disabled: 'yes' }, token);
    expect(badDisabledRes.status).toBe(400);

    // toggle: real flip
    const toggleRes = await callAnswersRoute('/api/inbox/answers/toggle', { qhash: 'h1', disabled: true }, token);
    expect(toggleRes.status).toBe(200);
    const toggleBody = await toggleRes.json() as { ok: boolean };
    expect(toggleBody.ok).toBe(true);

    // subsequent list shows disabled:1
    const listAfterRes = await callAnswersRoute('/api/inbox/answers', {}, token);
    const listAfterBody = await listAfterRes.json() as { rows: { qhash: string; disabled: number }[] };
    expect(listAfterBody.rows.find((r) => r.qhash === 'h1')?.disabled).toBe(1);
  });
});

describe('getInboxThread - affiliate applicant', () => {
  it('includes the applicant record when present', async () => {
    const s = new TenantStore(env.DB, 'applicant.myshopify.com');
    const tid = await s.createThread({ contactEmail: 'kasim@x.com', subject: 'P', subjectNorm: 'p', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'screen_sent' });
    const r = await getInboxThread(env.DB, 'applicant.myshopify.com', tid);
    expect(r.ok).toBe(true);
    expect((r as { applicant?: { stage: string } }).applicant?.stage).toBe('screen_sent');
  });
});
