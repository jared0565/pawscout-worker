/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
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
});
