/// <reference types="@cloudflare/vitest-plugin" />
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { handleInboundEmail } from '../src/index';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL } from '../src/types';
import { DEFAULT_INBOX } from '../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const RAW = [
  'From: Jane <jane@example.com>', 'To: support@activepaw.co.uk', 'Subject: Bed sizing',
  'Message-ID: <h1@example.com>', 'Date: Wed, 18 Jun 2026 10:00:00 +0000', 'Content-Type: text/plain', '',
  'Which bed fits a 20kg dog?'
].join('\r\n');

function fakeMessage(raw: string) {
  const bytes = new TextEncoder().encode(raw);
  let forwarded: string | null = null;
  return {
    msg: {
      raw: new Response(bytes).body!, // ReadableStream
      from: 'jane@example.com', to: 'support@activepaw.co.uk',
      forward: async (addr: string) => { forwarded = addr; },
      setReject: () => {}
    },
    forwardedTo: () => forwarded
  };
}

describe('handleInboundEmail', () => {
  it('stores an inbound email against the active shop', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await store.seedConfig({ collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 });

    const { msg } = fakeMessage(RAW);
    const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;
    await handleInboundEmail(msg as any, env as any, ctx);

    const list = await store.listThreads(null, 10);
    expect(list).toHaveLength(1);
    expect(list[0].subject).toBe('Bed sizing');
  });

  it('does nothing (no throw) when no shop is configured', async () => {
    const { msg } = fakeMessage(RAW);
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    await expect(handleInboundEmail(msg as any, env as any, ctx)).resolves.toBeUndefined();
  });

  it('logs a one-line summary of the file parts even with no shop configured (staging diagnosis)', async () => {
    const withFile = [
      'From: Kate <kate@supplier.example>', 'To: contact@activepaw.co.uk', 'Subject: Price list',
      'Message-ID: <p2@supplier.example>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="m2"', '',
      '--m2', 'Content-Type: text/plain', '', 'Price list attached.',
      '--m2', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK',
      '--m2--', '',
    ].join('\r\n');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      const { msg } = fakeMessage(withFile);
      const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
      await handleInboundEmail(msg as any, env as any, ctx);
    } finally { spy.mockRestore(); }
    expect(logs).toContain('inbound parts: application/pdf disp=attachment cid=- related=0 shown=0 9B');
  });

  it('forwards to INBOX_FORWARD_TO when set', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await store.seedConfig({ collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 });

    const { msg, forwardedTo } = fakeMessage(RAW);
    const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;
    const envWithFwd = { ...env, INBOX_FORWARD_TO: 'owner@gmail.com' } as any;
    await handleInboundEmail(msg as any, envWithFwd, ctx);

    expect(forwardedTo()).toBe('owner@gmail.com');
  });
});
