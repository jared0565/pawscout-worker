/// <reference types="@cloudflare/vitest-pool-workers" />
// Trial-code queue (2026-07-06): qualify an applicant in the Inbox now, issue
// their code from Partners later. The queue is affiliate_partners rows with
// status 'queued'; issuing runs through upsertAffiliatePartner which flips the
// status back to 'active', so a queued row graduates without extra bookkeeping.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { getInboxThread, queuePartnerFromThread, setPartnerConsentFromThread } from '../src/inbox/routes';
import { getPartners, removeQueuedPartner } from '../src/console/routes';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function seedThread() {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertContact({ email: 'creator@x.com', name: 'Casey Creator', phone: null });
  const tid = await s.createThread({ contactEmail: 'creator@x.com', subject: 'Collab?', subjectNorm: 'collab', receivedAt: '2026-07-06T10:00:00Z', initialStatus: 'new' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<q@x>', inReplyTo: null, references: [], from: 'creator@x.com', to: 'support@activepaw.co.uk', subject: 'Collab?', bodyText: 'I answered your questions...', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-06T10:00:00Z' });
  return { s, tid };
}

const FUTURE = new Date(Date.now() + 30 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

describe('queueAffiliatePartner (store)', () => {
  it('queues a new email, reports duplicates, and lists newest first', async () => {
    const s = new TenantStore(env.DB, SHOP);
    expect(await s.queueAffiliatePartner({ contactEmail: 'A@x.com', name: 'A' })).toBe('queued');
    expect(await s.queueAffiliatePartner({ contactEmail: 'a@x.com' })).toBe('already_queued'); // case-insensitive
    const q = await s.listQueuedPartners();
    expect(q.length).toBe(1);
    expect(q[0].contact_email).toBe('a@x.com');
    expect(await s.partnerPoolState('a@x.com')).toBe('queued');
  });

  it('refuses to queue someone who already holds a live code', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const pid = await s.upsertAffiliatePartner({ contactEmail: 'live@x.com' });
    await s.createAffiliateVoucher({ partnerId: pid, code: 'LIVE5', pctOff: 5, commissionPct: 2, endsAt: FUTURE });
    expect(await s.queueAffiliatePartner({ contactEmail: 'live@x.com' })).toBe('live_partner');
    expect(await s.partnerPoolState('live@x.com')).toBe('live');
    expect((await s.listQueuedPartners()).length).toBe(0);
  });

  it('re-queues a former partner whose code expired (the reissue-later shape)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const pid = await s.upsertAffiliatePartner({ contactEmail: 'old@x.com' });
    await s.createAffiliateVoucher({ partnerId: pid, code: 'OLD5', pctOff: 5, commissionPct: 2, endsAt: PAST });
    expect(await s.partnerPoolState('old@x.com')).toBe('former');
    expect(await s.queueAffiliatePartner({ contactEmail: 'old@x.com' })).toBe('queued');
    expect(await s.partnerPoolState('old@x.com')).toBe('queued');
  });

  it('issuing graduates a queued row automatically (upsert flips status back)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.queueAffiliatePartner({ contactEmail: 'grad@x.com', name: 'Grad' });
    // What issueVoucher does after minting the Shopify code:
    const pid = await s.upsertAffiliatePartner({ contactEmail: 'grad@x.com', name: 'Grad' });
    await s.createAffiliateVoucher({ partnerId: pid, code: 'GRAD5', pctOff: 5, commissionPct: 2, endsAt: FUTURE });
    expect((await s.listQueuedPartners()).length).toBe(0);
    expect(await s.partnerPoolState('grad@x.com')).toBe('live');
    // Same partner row throughout - no duplicate was created.
    const q = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_partners WHERE shop = ?1 AND contact_email = 'grad@x.com'`).bind(SHOP).first<{ n: number }>();
    expect(q!.n).toBe(1);
  });

  it('unqueue removes without issuing and stays re-queueable', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.queueAffiliatePartner({ contactEmail: 'out@x.com' });
    const pid = (await s.listQueuedPartners())[0].id;
    expect(await s.unqueueAffiliatePartner(pid)).toBe(true);
    expect(await s.unqueueAffiliatePartner(pid)).toBe(false); // idempotent-ish: already out
    expect(await s.partnerPoolState('out@x.com')).toBe('former');
    expect(await s.queueAffiliatePartner({ contactEmail: 'out@x.com' })).toBe('queued');
  });
});

describe('queue routes', () => {
  it('queues from a thread with the contact name and surfaces in getPartners + thread GET', async () => {
    const { tid } = await seedThread();
    const before = await getInboxThread(env.DB, SHOP, tid);
    expect(before.ok && before.partnerPool).toBe('none');

    const r = await queuePartnerFromThread(env.DB, SHOP, tid);
    expect(r.ok && r.state).toBe('queued');

    const partners = await getPartners(env.DB, SHOP);
    expect(partners.queued.length).toBe(1);
    expect(partners.queued[0].email).toBe('creator@x.com');
    expect(partners.queued[0].name).toBe('Casey Creator');

    const after = await getInboxThread(env.DB, SHOP, tid);
    expect(after.ok && after.partnerPool).toBe('queued');
  });

  it('rejects a missing thread and a bad payload', async () => {
    expect((await queuePartnerFromThread(env.DB, SHOP, 'nope')).ok).toBe(false);
    expect((await queuePartnerFromThread(env.DB, SHOP, 42)).ok).toBe(false);
  });

  // "Just say yes in your reply and we'll add you" - the yes arrives in the
  // Inbox, so consent is recorded from the thread. Consent NEVER changes queue
  // or partner status; queued partners count in the campaign audience.
  it('records the updates opt-in from the thread, creating the row when none exists', async () => {
    const { s, tid } = await seedThread();
    const before = await getInboxThread(env.DB, SHOP, tid);
    expect(before.ok && before.partnerConsent).toBe(null); // no partner row yet

    const r = await setPartnerConsentFromThread(env.DB, SHOP, tid, true);
    expect(r.ok && r.consent).toBe(true);
    expect(await s.listConsentingPartnerEmails()).toEqual(['creator@x.com']);
    const after = await getInboxThread(env.DB, SHOP, tid);
    expect(after.ok && after.partnerConsent).toBe(true);

    // Change of mind: same switch, other direction.
    await setPartnerConsentFromThread(env.DB, SHOP, tid, false);
    expect(await s.listConsentingPartnerEmails()).toEqual([]);
  });

  it('consent on a queued partner keeps them queued and puts them in the audience', async () => {
    const { s, tid } = await seedThread();
    await queuePartnerFromThread(env.DB, SHOP, tid);
    const r = await setPartnerConsentFromThread(env.DB, SHOP, tid, true);
    expect(r.ok && r.consent).toBe(true);
    // Still queued - consent must never graduate (or end) a queue row.
    expect(await s.partnerPoolState('creator@x.com')).toBe('queued');
    const queued = (await getPartners(env.DB, SHOP)).queued;
    expect(queued.length).toBe(1);
    expect(queued[0].marketingConsent).toBe(true);
    // Queued + consented = in the campaign audience (their yes is a yes).
    expect(await s.listConsentingPartnerEmails()).toEqual(['creator@x.com']);
  });

  it('opt-out with no partner row is a quiet no-op, and bad payloads are rejected', async () => {
    const { s, tid } = await seedThread();
    const r = await setPartnerConsentFromThread(env.DB, SHOP, tid, false);
    expect(r.ok && r.consent).toBe(false);
    expect(await s.partnerIdByEmail('creator@x.com')).toBe(null); // no row created
    expect((await setPartnerConsentFromThread(env.DB, SHOP, tid, 'yes' as unknown)).ok).toBe(false);
    expect((await setPartnerConsentFromThread(env.DB, SHOP, 'nope', true)).ok).toBe(false);
  });

  it('queue-remove takes them out once and reports a second attempt', async () => {
    const { tid } = await seedThread();
    await queuePartnerFromThread(env.DB, SHOP, tid);
    const pid = (await getPartners(env.DB, SHOP)).queued[0].partnerId;
    expect((await removeQueuedPartner(env.DB, SHOP, pid)).ok).toBe(true);
    expect((await getPartners(env.DB, SHOP)).queued.length).toBe(0);
    const again = await removeQueuedPartner(env.DB, SHOP, pid);
    expect(again.ok).toBe(false);
  });
});
