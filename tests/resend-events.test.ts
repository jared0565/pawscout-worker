import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  verifySvixSignature, parseResendEvent, applyResendEvent,
  getTrackingStatus, enableTracking, ensureEventsWebhook, RESEND_EVENT_TYPES
} from '../src/resend-events';
import { sendEmail, sanitizeTag } from '../src/email';
import { sendCampaignBatch } from '../src/campaigns';
import { TenantStore } from '../src/tenant-store';
import type { Env } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const SECRET = 'whsec_' + btoa('test-webhook-secret-32-bytes!!!!');

async function signPayload(secret: string, id: string, ts: string, body: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

describe('verifySvixSignature', () => {
  const BODY = '{"type":"email.opened"}';
  const TS = '1750000000';
  const NOW = 1_750_000_000_000;

  it('accepts a correctly signed delivery', async () => {
    const sig = await signPayload(SECRET, 'msg_1', TS, BODY);
    expect(await verifySvixSignature(SECRET, { id: 'msg_1', timestamp: TS, signature: `v1,${sig}` }, BODY, NOW)).toBe(true);
  });
  it('accepts when ONE of several space-separated signatures matches (key rotation)', async () => {
    const sig = await signPayload(SECRET, 'msg_1', TS, BODY);
    expect(await verifySvixSignature(SECRET, { id: 'msg_1', timestamp: TS, signature: `v1,AAAA v1,${sig}` }, BODY, NOW)).toBe(true);
  });
  it('rejects a tampered body', async () => {
    const sig = await signPayload(SECRET, 'msg_1', TS, BODY);
    expect(await verifySvixSignature(SECRET, { id: 'msg_1', timestamp: TS, signature: `v1,${sig}` }, BODY + ' ', NOW)).toBe(false);
  });
  it('rejects the wrong secret', async () => {
    const sig = await signPayload('whsec_' + btoa('another-secret-entirely-here!!!!'), 'msg_1', TS, BODY);
    expect(await verifySvixSignature(SECRET, { id: 'msg_1', timestamp: TS, signature: `v1,${sig}` }, BODY, NOW)).toBe(false);
  });
  it('rejects a stale timestamp (replay window)', async () => {
    const sig = await signPayload(SECRET, 'msg_1', TS, BODY);
    const tenMinutesLater = NOW + 10 * 60 * 1000;
    expect(await verifySvixSignature(SECRET, { id: 'msg_1', timestamp: TS, signature: `v1,${sig}` }, BODY, tenMinutesLater)).toBe(false);
  });
  it('rejects missing headers', async () => {
    expect(await verifySvixSignature(SECRET, { id: undefined, timestamp: TS, signature: 'v1,x' }, BODY, NOW)).toBe(false);
    expect(await verifySvixSignature(SECRET, { id: 'msg_1', timestamp: undefined, signature: 'v1,x' }, BODY, NOW)).toBe(false);
    expect(await verifySvixSignature(SECRET, { id: 'msg_1', timestamp: TS, signature: undefined }, BODY, NOW)).toBe(false);
  });
});

function clickedPayload(over: Record<string, unknown> = {}) {
  return {
    type: 'email.clicked',
    created_at: '2026-07-05T15:00:00.000Z',
    data: {
      email_id: 'em_abc', to: ['Buyer@Example.com'],
      tags: { kind: 'campaign', campaign_id: 'cmp-1' },
      click: { link: 'https://activepaw.co.uk/products/x' },
      ...over
    }
  };
}

describe('parseResendEvent', () => {
  it('extracts type, recipient (lowercased), tags and the clicked link', () => {
    const e = parseResendEvent(clickedPayload());
    expect(e).toMatchObject({
      type: 'clicked', resendId: 'em_abc', email: 'buyer@example.com',
      kind: 'campaign', campaignId: 'cmp-1', threadId: null,
      link: 'https://activepaw.co.uk/products/x', permanentBounce: false
    });
  });
  it('flags a Permanent bounce; a Temporary one stays unflagged', () => {
    const perm = parseResendEvent({ type: 'email.bounced', created_at: 'x', data: { email_id: 'em_1', to: ['a@x.com'], bounce: { type: 'Permanent' } } });
    const temp = parseResendEvent({ type: 'email.bounced', created_at: 'x', data: { email_id: 'em_1', to: ['a@x.com'], bounce: { type: 'Temporary' } } });
    expect(perm?.permanentBounce).toBe(true);
    expect(temp?.permanentBounce).toBe(false);
  });
  it('returns null for non-email events and payloads without recipient or id', () => {
    expect(parseResendEvent({ type: 'contact.created', data: {} })).toBeNull();
    expect(parseResendEvent({ type: 'email.opened', data: { email_id: 'em_1', to: [] } })).toBeNull();
    expect(parseResendEvent({ type: 'email.opened', data: { to: ['a@x.com'] } })).toBeNull();
    expect(parseResendEvent(null)).toBeNull();
  });
});

describe('applyResendEvent', () => {
  it('stores the event once; the same svix id (a retry) is a no-op', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const e = parseResendEvent(clickedPayload())!;
    expect((await applyResendEvent(store, 'msg_1', e)).stored).toBe(true);
    expect((await applyResendEvent(store, 'msg_1', e)).stored).toBe(false);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_events WHERE shop = ?1`).bind(SHOP).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
  it('a spam complaint suppresses the address from all future marketing', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const e = parseResendEvent({ type: 'email.complained', created_at: 'x', data: { email_id: 'em_1', to: ['angry@x.com'] } })!;
    const r = await applyResendEvent(store, 'msg_c1', e);
    expect(r.suppressed).toBe(true);
    expect(await store.isEmailUnsubscribed('angry@x.com')).toBe(true);
  });
  it('a PERMANENT bounce suppresses; a temporary one does not', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const perm = parseResendEvent({ type: 'email.bounced', created_at: 'x', data: { email_id: 'em_1', to: ['gone@x.com'], bounce: { type: 'Permanent' } } })!;
    const temp = parseResendEvent({ type: 'email.bounced', created_at: 'x', data: { email_id: 'em_2', to: ['busy@x.com'], bounce: { type: 'Temporary' } } })!;
    await applyResendEvent(store, 'msg_b1', perm);
    await applyResendEvent(store, 'msg_b2', temp);
    expect(await store.isEmailUnsubscribed('gone@x.com')).toBe(true);
    expect(await store.isEmailUnsubscribed('busy@x.com')).toBe(false);
  });
});

describe('campaignEventStats', () => {
  it('counts UNIQUE recipients per event type and excludes campaign_test sends', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const ev = (svixId: string, type: string, email: string, kind = 'campaign') =>
      applyResendEvent(store, svixId, parseResendEvent({
        type: `email.${type}`, created_at: 'x', data: { email_id: 'em_x', to: [email], tags: { kind, campaign_id: 'cmp-1' } }
      })!);
    await ev('m1', 'opened', 'a@x.com');
    await ev('m2', 'opened', 'a@x.com');   // same person opens again: still 1
    await ev('m3', 'opened', 'b@x.com');
    await ev('m4', 'clicked', 'a@x.com');
    await ev('m5', 'delivered', 'a@x.com');
    await ev('m6', 'opened', 'owner@x.com', 'campaign_test'); // [Test] send: excluded
    const stats = await store.campaignEventStats();
    expect(stats.get('cmp-1')).toEqual({ opened: 2, clicked: 1, delivered: 1 });
  });
});

describe('send-time tags', () => {
  it('sanitizeTag coerces characters Resend rejects', () => {
    expect(sanitizeTag('camp-1_A9')).toBe('camp-1_A9');
    expect(sanitizeTag('a b@c.d')).toBe('a_b_c_d');
  });
  it('sendEmail forwards sanitized tags in the Resend payload', async () => {
    const sends: { body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sends.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    await sendEmail('re_x', { to: 'a@x.com', subject: 's', text: 't', tags: [{ name: 'kind', value: 'reply' }, { name: 'thread_id', value: 'th 1' }] }, fetchImpl);
    expect(sends[0].body.tags).toEqual([{ name: 'kind', value: 'reply' }, { name: 'thread_id', value: 'th_1' }]);
  });
  it('campaign sends carry kind + campaign_id tags and the ledger stores the Resend id', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const id = await store.insertCampaign({ audience: 'partners', subject: 'Hello', bodyText: 'A real announcement body.' });
    const campaign = (await store.getCampaign(id))!;
    const sends: { body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sends.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'em_77' }), { status: 200 });
    }) as unknown as typeof fetch;
    const testEnv = { DB: env.DB, RESEND_API_KEY: 're_x', SHOPIFY_API_SECRET: 's', SHOPIFY_APP_URL: 'https://x' } as unknown as Env;
    const r = await sendCampaignBatch(testEnv, store, campaign, ['p@x.com'], 'addr', { fetchImpl, sendGapMs: 0 });
    expect(r.ok).toBe(true);
    expect(sends[0].body.tags).toEqual([{ name: 'kind', value: 'campaign' }, { name: 'campaign_id', value: campaign.id }]);
    const row = await env.DB.prepare(`SELECT resend_id FROM campaign_sends WHERE shop = ?1 AND campaign_id = ?2`).bind(SHOP, campaign.id).first<{ resend_id: string }>();
    expect(row?.resend_id).toBe('em_77');
  });
});

describe('Resend management helpers', () => {
  function fakeResend(routes: Record<string, { status?: number; json: unknown }>): typeof fetch {
    return (async (url: string, init?: { method?: string }) => {
      const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
      const r = routes[key];
      if (!r) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 404 });
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
  }

  it('getTrackingStatus finds the domain and reads its tracking flags', async () => {
    const f = fakeResend({
      'GET /domains': { json: { data: [{ id: 'd1', name: 'activepaw.co.uk' }, { id: 'd2', name: 'other.com' }] } },
      'GET /domains/d1': { json: { id: 'd1', open_tracking: true, click_tracking: false } }
    });
    const r = await getTrackingStatus('re_x', 'activepaw.co.uk', f);
    expect(r.ok && r.status).toEqual({ domainId: 'd1', openTracking: true, clickTracking: false });
  });
  it('getTrackingStatus reports a missing domain without erroring', async () => {
    const f = fakeResend({ 'GET /domains': { json: { data: [] } } });
    const r = await getTrackingStatus('re_x', 'activepaw.co.uk', f);
    expect(r.ok && r.status.domainId).toBeNull();
  });
  it('enableTracking PATCHes the domain', async () => {
    const f = fakeResend({ 'PATCH /domains/d1': { json: { id: 'd1' } } });
    expect((await enableTracking('re_x', 'd1', f)).ok).toBe(true);
  });
  it('ensureEventsWebhook reuses an existing endpoint without minting a duplicate', async () => {
    const f = fakeResend({ 'GET /webhooks': { json: { data: [{ endpoint: 'https://x/webhooks/resend' }] } } });
    const r = await ensureEventsWebhook('re_x', 'https://x/webhooks/resend', f);
    expect(r.ok && !('error' in r) && r.created).toBe(false);
  });
  it('ensureEventsWebhook creates and returns the signing secret when absent', async () => {
    const f = fakeResend({
      'GET /webhooks': { json: { data: [] } },
      'POST /webhooks': { json: { id: 'wh_1', signing_secret: 'whsec_abc' } }
    });
    const r = await ensureEventsWebhook('re_x', 'https://x/webhooks/resend', f);
    expect(r.ok && r.created && r.signingSecret).toBe('whsec_abc');
  });
  it('subscribes to exactly the five engagement events', () => {
    expect([...RESEND_EVENT_TYPES]).toEqual(['email.delivered', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained']);
  });
});
