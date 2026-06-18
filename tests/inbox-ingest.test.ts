/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { ingestParsed } from '../src/inbox/ingest';
import type { ParsedEmail } from '../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

function pe(over: Partial<ParsedEmail>): ParsedEmail {
  return {
    messageId: '<m1@x>', inReplyTo: null, references: [], from: { email: 'jane@x.com', name: 'Jane' },
    to: ['support@activepaw.co.uk'], subject: 'Do you ship to IE?', date: '2026-06-18T10:00:00Z',
    text: 'Hi, do you ship to Ireland?', html: null, headers: {}, ...over
  };
}

describe('ingestParsed', () => {
  it('creates a contact, thread and message; status new for a human email', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({}));
    expect(r.deduped).toBe(false);
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('new');
    expect(got?.thread.contact_email).toBe('jane@x.com');
    expect(got?.messages[0].body_text).toContain('Ireland');
  });

  it('marks a DMARC-fail email as spam (no classification needed)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({
      messageId: '<spam@x>', headers: { 'authentication-results': 'mx; spf=fail dmarc=fail' }
    }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('spam');
  });

  it('marks bulk/auto mail as automated and pre-classified', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({ messageId: '<auto@x>', headers: { precedence: 'bulk' } }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('closed');
    expect(got?.labels).toContain('automated');
    expect(got?.thread.classified_at).not.toBeNull(); // skips the LLM sweep
  });

  it('dedupes a re-delivered Message-ID and threads a reply', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({}));
    const dup = await ingestParsed(store, pe({})); // same Message-ID
    expect(dup.deduped).toBe(true);
    expect(dup.threadId).toBe(a.threadId);
    const reply = await ingestParsed(store, pe({
      messageId: '<m2@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'], subject: 'Re: Do you ship to IE?'
    }));
    expect(reply.threadId).toBe(a.threadId); // same thread
  });

  it('uses the real visitor from a Shopify contact-form notification', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({
      messageId: '<n@shopify>', from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      subject: 'New customer message',
      headers: { 'reply-to': 'John Buyer <john@buyer.com>' },
      text: 'Name: John Buyer\nEmail: john@buyer.com\n\nMessage:\nIs the large bed in stock?'
    }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.contact_email).toBe('john@buyer.com');
  });
});
