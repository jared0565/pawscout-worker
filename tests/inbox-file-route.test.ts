/// <reference types="@cloudflare/vitest-plugin" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { app } from '../src/index';
import { fileUrl, contentDispositionFor, FILE_LINK_TTL_SECONDS, r2KeyFor } from '../src/inbox/attachments';
import type { Env } from '../src/types';

// Design 2026-11-14 (inbox attachments), 5.5: a stored file is reachable only
// through a signed, short-lived, download-only link, never rendered inline.
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const SECRET = 'test-file-link-secret';
const BASE = 'https://pawscout.example.com';
const BYTES = new TextEncoder().encode('%PDF-1.4 the catalogue');
const E = () => ({ ...env, SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: BASE }) as unknown as Env;
const now = () => Math.floor(Date.now() / 1000);

async function seedFile(shop = SHOP, filename = 'Catalogue-2026.pdf', status: 'stored' | 'skipped_type' = 'stored') {
  const store = new TenantStore(env.DB, shop);
  const t = await store.createThread({ contactEmail: 'jane@x.com', subject: 'Cat', subjectNorm: 'cat', receivedAt: '2026-11-14T09:00:00Z', initialStatus: 'new' });
  const id = crypto.randomUUID();
  const key = r2KeyFor(shop, t, id);
  if (status === 'stored') await env.INBOX_FILES.put(key, BYTES);
  await store.insertAttachment({ id, thread_id: t, message_id: 'm1', filename, content_type: 'text/html', size_bytes: BYTES.byteLength, status, r2_key: status === 'stored' ? key : null });
  return { id, key, threadId: t };
}

const pathOf = (url: string) => url.slice(BASE.length);

describe('GET /inbox-file/:id', () => {
  it('a good link downloads the bytes with every safety header', async () => {
    const { id } = await seedFile();
    const url = await fileUrl(BASE, SECRET, SHOP, id, now());
    const res = await app.request(pathOf(url), {}, E());
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    // The declared type (text/html here) is never used to serve.
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('a link past its expiry is 410 with the reopen line', async () => {
    const { id } = await seedFile();
    const url = await fileUrl(BASE, SECRET, SHOP, id, now() - FILE_LINK_TTL_SECONDS - 5);
    const res = await app.request(pathOf(url), {}, E());
    expect(res.status).toBe(410);
    expect(await res.text()).toBe('This link has expired. Open the thread in PawScout again for a fresh link.');
  });

  it('a tampered sig, shop or id is 403', async () => {
    const { id } = await seedFile();
    const url = await fileUrl(BASE, SECRET, SHOP, id, now());
    const sig = new URL(url).searchParams.get('sig')!;
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect((await app.request(pathOf(url).replace(sig, flipped), {}, E())).status).toBe(403);
    expect((await app.request(pathOf(url).replace('shop=a.myshopify.com', 'shop=b.myshopify.com'), {}, E())).status).toBe(403);
    const other = crypto.randomUUID();
    expect((await app.request(pathOf(url).replace(id, other), {}, E())).status).toBe(403);
    expect((await app.request(`/inbox-file/${id}`, {}, E())).status).toBe(403);
  });

  it('a non-myshopify shop parameter is 403', async () => {
    const { id } = await seedFile();
    const url = await fileUrl(BASE, SECRET, 'evil.example.com', id, now());
    expect((await app.request(pathOf(url), {}, E())).status).toBe(403);
  });

  it("a valid link for another shop never reaches this shop's row", async () => {
    const { id } = await seedFile(SHOP);
    // Shop B signs shop A's id with its own name: the lookup is scoped by shop.
    const url = await fileUrl(BASE, SECRET, 'b.myshopify.com', id, now());
    expect((await app.request(pathOf(url), {}, E())).status).toBe(404);
  });

  it('a skipped row or a missing object is 404', async () => {
    const skipped = await seedFile(SHOP, 'prices.xlsm', 'skipped_type');
    expect((await app.request(pathOf(await fileUrl(BASE, SECRET, SHOP, skipped.id, now())), {}, E())).status).toBe(404);
    const gone = await seedFile();
    await env.INBOX_FILES.delete(gone.key);
    expect((await app.request(pathOf(await fileUrl(BASE, SECRET, SHOP, gone.id, now())), {}, E())).status).toBe(404);
  });
});

describe('contentDispositionFor', () => {
  // Review Focus 2: a Chinese supplier's filename survives, percent-encoded.
  it('encodes a non-ASCII name with an ASCII fallback', () => {
    expect(contentDispositionFor('产品目录 2026.pdf')).toBe(`attachment; filename="____ 2026.pdf"; filename*=UTF-8''%E4%BA%A7%E5%93%81%E7%9B%AE%E5%BD%95%202026.pdf`);
  });

  it('never lets a quote or backslash break out of the fallback', () => {
    expect(contentDispositionFor('a"b\\c.pdf')).toBe(`attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`);
  });
});
