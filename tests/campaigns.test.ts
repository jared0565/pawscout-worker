import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  fetchSubscribedBuyers, resolveCampaignAudience, buildCampaignEmail,
  sendCampaignBatch, sendCampaignTest, validateCampaignPayload, campaignSendBlock
} from '../src/campaigns';
import { TenantStore } from '../src/tenant-store';
import type { Env } from '../src/types';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const POSTAL = '123 Example Street, London, AB1 2CD, United Kingdom';
const NOW = 1_750_000_000_000;

function makeEnv(over: Partial<Env> = {}): Env {
  return { DB: env.DB, RESEND_API_KEY: 're_x', SHOPIFY_API_SECRET: 'shpss_test', SHOPIFY_APP_URL: 'https://pawscout.activepaw.co.uk', ...over } as unknown as Env;
}
function captureFetch(sends: { body: Record<string, unknown> }[], status = 200): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    sends.push({ body: JSON.parse(init.body) });
    return new Response(JSON.stringify(status === 200 ? { id: 'em_1' } : { message: 'boom' }), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}
function buyersAdmin(pages: { email?: string | null; state?: string }[][]): AdminGraphql {
  let call = 0;
  return (async (q: string) => {
    if (!q.includes('pawscoutCampaignBuyers')) return {};
    const page = pages[call] ?? [];
    const hasNext = call < pages.length - 1;
    call++;
    return {
      customers: {
        pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `c${call}` : null },
        nodes: page.map((p) => ({ email: p.email, emailMarketingConsent: p.state === undefined ? null : { marketingState: p.state } }))
      }
    };
  }) as unknown as AdminGraphql;
}
async function seedCampaign(store: TenantStore, audience = 'buyers'): Promise<import('../src/tenant-store').CampaignRow> {
  const id = await store.insertCampaign({ audience, subject: 'Summer sale', bodyText: 'Hi all,\n\nCooling gear is 15% off this week.' });
  return (await store.getCampaign(id))!;
}

describe('fetchSubscribedBuyers', () => {
  it('keeps only SUBSCRIBED consent, fails closed on missing state, dedupes case-insensitively', async () => {
    const emails = await fetchSubscribedBuyers(buyersAdmin([[
      { email: 'Yes@Example.com', state: 'SUBSCRIBED' },
      { email: 'yes@example.com', state: 'SUBSCRIBED' },   // dupe by case
      { email: 'no@example.com', state: 'NOT_SUBSCRIBED' },
      { email: 'out@example.com', state: 'UNSUBSCRIBED' },
      { email: 'null@example.com' },                        // consent object missing
      { email: null, state: 'SUBSCRIBED' }                  // no email
    ]]));
    expect(emails).toEqual(['yes@example.com']);
  });
  it('walks pagination', async () => {
    const emails = await fetchSubscribedBuyers(buyersAdmin([
      [{ email: 'a@x.com', state: 'SUBSCRIBED' }],
      [{ email: 'b@x.com', state: 'SUBSCRIBED' }]
    ]));
    expect(emails.sort()).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('resolveCampaignAudience (partners)', () => {
  it('returns only ACTIVE partners who explicitly opted in', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const p1 = await store.upsertAffiliatePartner({ contactEmail: 'in@x.com' });
    await store.upsertAffiliatePartner({ contactEmail: 'silent@x.com' });
    await store.setPartnerMarketingConsent(p1, true);
    const r = await resolveCampaignAudience(store, null, 'partners');
    expect(r.ok && r.emails).toEqual(['in@x.com']);
  });
  it('consent can be withdrawn', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const p1 = await store.upsertAffiliatePartner({ contactEmail: 'in@x.com' });
    await store.setPartnerMarketingConsent(p1, true);
    await store.setPartnerMarketingConsent(p1, false);
    const r = await resolveCampaignAudience(store, null, 'partners');
    expect(r.ok && r.emails).toEqual([]);
  });
  it('buyers audience without an admin client refuses rather than guessing', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await resolveCampaignAudience(store, null, 'buyers');
    expect(r.ok).toBe(false);
  });
});

describe('buildCampaignEmail', () => {
  const base = { to: 'a@x.com', subject: 'Sale', bodyText: 'Big news.\n\nCome look.', unsubUrl: 'https://x/unsubscribe?token=t', postalAddress: POSTAL } as const;
  it('carries the unsubscribe link, one-click headers and postal address in text AND html', () => {
    const m = buildCampaignEmail({ ...base, audience: 'buyers' });
    expect(m.text).toContain('https://x/unsubscribe?token=t');
    expect(m.text).toContain(POSTAL);
    expect(m.html).toContain('https://x/unsubscribe?token=t');
    expect(m.html).toContain(POSTAL);
    expect(m.headers['List-Unsubscribe']).toBe('<https://x/unsubscribe?token=t>');
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
  it('identifies the sender per audience', () => {
    expect(buildCampaignEmail({ ...base, audience: 'buyers' }).from).toBe('Active Paw <support@activepaw.co.uk>');
    expect(buildCampaignEmail({ ...base, audience: 'partners' }).from).toBe('Active Paw Partnerships <sales@activepaw.co.uk>');
  });
  it('test sends are labelled and em/en dashes never reach the wire', () => {
    const m = buildCampaignEmail({ ...base, subject: 'Sale — now', bodyText: 'Deal – today.', audience: 'buyers', testTag: true });
    expect(m.subject).toBe('[Test] Sale - now');
    expect(m.text).not.toMatch(/[—–]/);
    expect(m.html).not.toMatch(/[—–]/);
  });
});

describe('validateCampaignPayload', () => {
  it('accepts a well-formed draft and rejects bad audiences/empty bodies', () => {
    expect(validateCampaignPayload({ audience: 'buyers', subject: 'S', bodyText: 'Ten chars!!' }).ok).toBe(true);
    expect(validateCampaignPayload({ audience: 'everyone', subject: 'S', bodyText: 'Ten chars!!' }).ok).toBe(false);
    expect(validateCampaignPayload({ audience: 'buyers', subject: '', bodyText: 'Ten chars!!' }).ok).toBe(false);
    expect(validateCampaignPayload({ audience: 'buyers', subject: 'S', bodyText: 'short' }).ok).toBe(false);
  });
});

describe('sendCampaignBatch', () => {
  const OPTS = { now: NOW, sendGapMs: 0 };
  it('sends to every recipient once and a re-run sends nothing (ledger dedup)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    const sends: { body: Record<string, unknown> }[] = [];
    const r = await sendCampaignBatch(makeEnv(), store, cp, ['a@x.com', 'B@x.com'], POSTAL, { ...OPTS, fetchImpl: captureFetch(sends) });
    expect(r.ok && r.sent).toBe(2);
    expect(r.ok && r.status).toBe('sent');
    expect(sends.length).toBe(2);
    const again = await sendCampaignBatch(makeEnv(), store, (await store.getCampaign(cp.id))!, ['a@x.com', 'B@x.com'], POSTAL, { ...OPTS, fetchImpl: captureFetch(sends) });
    expect(again.ok && again.sent).toBe(0);
    expect(again.ok && again.already).toBe(2);
    expect(sends.length).toBe(2); // nobody emailed twice
    const row = await store.getCampaign(cp.id);
    expect(row?.status).toBe('sent');
    expect(row?.sent_count).toBe(2);
    expect(row?.recipient_count).toBe(2);
  });
  it('suppresses unsubscribed addresses and reports them', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.recordUnsubscribe('out@x.com', new Date(NOW).toISOString());
    const cp = await seedCampaign(store);
    const sends: { body: Record<string, unknown> }[] = [];
    const r = await sendCampaignBatch(makeEnv(), store, cp, ['out@x.com', 'in@x.com'], POSTAL, { ...OPTS, fetchImpl: captureFetch(sends) });
    expect(r.ok && r.suppressed).toBe(1);
    expect(r.ok && r.sent).toBe(1);
    expect(sends.length).toBe(1);
    expect((sends[0].body.to as string[])[0]).toBe('in@x.com');
    expect((await store.getCampaign(cp.id))?.recipient_count).toBe(1); // suppressed excluded
  });
  it('bounded batches resume where they stopped', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    const sends: { body: Record<string, unknown> }[] = [];
    const first = await sendCampaignBatch(makeEnv(), store, cp, ['a@x.com', 'b@x.com', 'c@x.com'], POSTAL, { ...OPTS, batchMax: 2, fetchImpl: captureFetch(sends) });
    expect(first.ok && first.sent).toBe(2);
    expect(first.ok && first.remaining).toBe(1);
    expect(first.ok && first.status).toBe('sending');
    const second = await sendCampaignBatch(makeEnv(), store, (await store.getCampaign(cp.id))!, ['a@x.com', 'b@x.com', 'c@x.com'], POSTAL, { ...OPTS, batchMax: 2, fetchImpl: captureFetch(sends) });
    expect(second.ok && second.sent).toBe(1);
    expect(second.ok && second.already).toBe(2);
    expect(second.ok && second.remaining).toBe(0);
    expect(sends.length).toBe(3);
    expect((await store.getCampaign(cp.id))?.status).toBe('sent');
  });
  it('a failed send stays retryable (not in the ledger) and holds the campaign at sending', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    const r = await sendCampaignBatch(makeEnv(), store, cp, ['a@x.com'], POSTAL, { ...OPTS, fetchImpl: captureFetch([], 500) });
    expect(r.ok && r.failed).toBe(1);
    expect(r.ok && r.remaining).toBe(1);
    expect(r.ok && r.status).toBe('sending');
    expect(await store.hasCampaignSend(cp.id, 'a@x.com')).toBe(false);
  });
  it('refuses to send without a postal address or RESEND key', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    expect((await sendCampaignBatch(makeEnv(), store, cp, ['a@x.com'], '  ', OPTS)).ok).toBe(false);
    expect((await sendCampaignBatch(makeEnv({ RESEND_API_KEY: undefined }), store, cp, ['a@x.com'], POSTAL, OPTS)).ok).toBe(false);
  });
  it('every outbound campaign email carries the unsubscribe footer', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    const sends: { body: Record<string, unknown> }[] = [];
    await sendCampaignBatch(makeEnv(), store, cp, ['a@x.com'], POSTAL, { ...OPTS, fetchImpl: captureFetch(sends) });
    const body = sends[0].body as { text: string; html: string; headers: Record<string, string> };
    expect(body.text).toContain('/unsubscribe?shop=');
    expect(body.html).toContain('/unsubscribe?shop=');
    expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(body.text).toContain(POSTAL);
  });
});

describe('sendCampaignTest', () => {
  it('sends the labelled test without touching the ledger', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    const sends: { body: Record<string, unknown> }[] = [];
    const r = await sendCampaignTest(makeEnv(), store, cp, 'owner@x.com', POSTAL, captureFetch(sends));
    expect(r.ok).toBe(true);
    expect((sends[0].body.subject as string).startsWith('[Test] ')).toBe(true);
    expect(await store.hasCampaignSend(cp.id, 'owner@x.com')).toBe(false);
  });
});

// --- Lifecycle controls (2026-07-06): edit, pause/resume, stop, duplicate ---

describe('campaignSendBlock', () => {
  it('lets drafts and in-flight sends through, blocks the rest with a reason', () => {
    expect(campaignSendBlock('draft')).toBeNull();
    expect(campaignSendBlock('sending')).toBeNull();
    expect(campaignSendBlock('paused')).toContain('paused');
    expect(campaignSendBlock('sent')).toContain('already been sent');
    expect(campaignSendBlock('cancelled')).toContain('stopped');
  });
});

describe('campaign lifecycle (store)', () => {
  it('updateCampaignDraft edits a draft and refuses once sending has started', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    expect(await store.updateCampaignDraft(cp.id, { audience: 'partners', subject: 'New subject', bodyText: 'Rewritten body text.' })).toBe(true);
    const edited = (await store.getCampaign(cp.id))!;
    expect(edited.audience).toBe('partners');
    expect(edited.subject).toBe('New subject');
    expect(edited.body_text).toBe('Rewritten body text.');

    await store.setCampaignStatus(cp.id, 'sending', ['draft']);
    expect(await store.updateCampaignDraft(cp.id, { audience: 'buyers', subject: 'Too late', bodyText: 'Should not stick.' })).toBe(false);
    expect((await store.getCampaign(cp.id))!.subject).toBe('New subject');
  });

  it('setCampaignStatus only fires from an allowed source status', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    // a draft cannot be paused
    expect(await store.setCampaignStatus(cp.id, 'paused', ['sending'])).toBe(false);
    await store.setCampaignStatus(cp.id, 'sending', ['draft']);
    // pause -> resume round-trip
    expect(await store.setCampaignStatus(cp.id, 'paused', ['sending'])).toBe(true);
    expect(await store.setCampaignStatus(cp.id, 'sending', ['paused'])).toBe(true);
    // stop is terminal: no resume, no re-pause
    expect(await store.setCampaignStatus(cp.id, 'cancelled', ['sending', 'paused'])).toBe(true);
    expect(await store.setCampaignStatus(cp.id, 'sending', ['paused'])).toBe(false);
    expect((await store.getCampaign(cp.id))!.status).toBe('cancelled');
  });

  it('a pause clicked mid-batch survives the batch finishing (progress cannot un-pause)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cp = await seedCampaign(store);
    await store.setCampaignStatus(cp.id, 'sending', ['draft']);
    await store.setCampaignStatus(cp.id, 'paused', ['sending']);
    // the racing batch reports partial progress with status 'sending'
    await store.updateCampaignProgress(cp.id, { recipientCount: 10, sentDelta: 5, status: 'sending', sentAt: null });
    const row = (await store.getCampaign(cp.id))!;
    expect(row.status).toBe('paused');   // pause held
    expect(row.sent_count).toBe(5);      // bookkeeping still recorded
    // but full completion is the truth regardless of the pause
    await store.updateCampaignProgress(cp.id, { recipientCount: 10, sentDelta: 5, status: 'sent', sentAt: new Date(NOW).toISOString() });
    expect((await store.getCampaign(cp.id))!.status).toBe('sent');
  });
});
