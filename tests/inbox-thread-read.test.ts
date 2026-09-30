/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { validateReading, safeLink, readThread, readingPromptBlock, isSupplierRole, THREAD_READER_MARKER } from '../src/inbox/thread-read';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_LLM } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const base = { senderRole: 'customer', openAsks: ['Do you ship to Germany?'], offered: '', alreadyAnswered: [], replyNeeded: true };

describe('safeLink', () => {
  it('keeps http and https only, and caps the length', () => {
    expect(safeLink('https://www.loffepet.cn')).toBe('https://www.loffepet.cn/');
    expect(safeLink('http://www.magicpet.com.cn')).toBe('http://www.magicpet.com.cn/');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,<b>x</b>')).toBeNull();
    expect(safeLink('www.example.com')).toBeNull();
    expect(safeLink('https://x.com/' + 'a'.repeat(400))).toBeNull();
    expect(safeLink(42)).toBeNull();
  });

  it('rejects a raw input under the cap whose normalised form (percent-encoded) is over it', () => {
    expect(safeLink('https://x.com/' + 'é'.repeat(280))).toBeNull();
  });
});

describe('validateReading', () => {
  it('accepts a customer reading and drops a supplier block that does not belong', () => {
    const r = validateReading({ ...base, supplier: { company: 'X' } });
    expect(r?.senderRole).toBe('customer');
    expect(r?.supplier).toBeNull();
  });

  it('rejects garbage and unknown roles', () => {
    expect(validateReading(null)).toBeNull();
    expect(validateReading('x')).toBeNull();
    expect(validateReading({ ...base, senderRole: 'pirate' })).toBeNull();
  });

  it('defaults replyNeeded to true when it is not a boolean (fail safe: draft)', () => {
    expect(validateReading({ ...base, replyNeeded: 'no' })?.replyNeeded).toBe(true);
  });

  it('caps strings and lists, filters links, and escapes nothing itself (the console escapes)', () => {
    const r = validateReading({
      ...base, senderRole: 'goods-supplier', openAsks: Array(20).fill('q'.repeat(500)), offered: 'o'.repeat(900),
      supplier: { company: '<b>Douke</b>' + 'c'.repeat(300), contactName: 'Sabrina', website: 'javascript:alert(1)',
        storeLinks: ['https://douke.en.alibaba.com', 'ftp://x', 'data:x'], kind: 'goods', productLines: ['tofu cat litter'],
        shipsFrom: 'CN', nicheFit: 'on-niche', dropship: 'maybe' }
    });
    expect(r?.openAsks.length).toBe(8);
    expect(r?.openAsks[0].length).toBe(200);
    expect(r?.offered.length).toBe(300);
    expect(r?.supplier?.company?.length).toBe(120);
    expect(r?.supplier?.website).toBeNull();
    expect(r?.supplier?.storeLinks).toEqual(['https://douke.en.alibaba.com/']);
    expect(r?.supplier?.dropship).toBe('unknown');
  });

  it('a logistics sender is always kind logistics and never carries a dropshipping answer', () => {
    const r = validateReading({ ...base, senderRole: 'logistics', supplier: { company: 'MBE Liberec', kind: 'goods', nicheFit: 'adjacent', dropship: 'yes', storeLinks: [], productLines: [] } });
    expect(r?.supplier?.kind).toBe('logistics');
    expect(r?.supplier?.dropship).toBe('unknown');
  });

  it('a supplier role with no usable supplier block still gets a minimal one', () => {
    const r = validateReading({ ...base, senderRole: 'goods-supplier' });
    expect(r?.supplier).toEqual({ company: null, contactName: null, website: null, storeLinks: [], kind: 'goods', productLines: [], shipsFrom: null, nicheFit: 'adjacent', dropship: 'unknown' });
  });
});

describe('isSupplierRole', () => {
  it('is true for goods suppliers and logistics only', () => {
    expect(isSupplierRole('goods-supplier')).toBe(true);
    expect(isSupplierRole('logistics')).toBe(true);
    expect(isSupplierRole('marketer')).toBe(false);
    expect(isSupplierRole(null)).toBe(false);
  });
});

describe('readingPromptBlock', () => {
  it('lists what is still open and what we already said, and marks the source untrusted', () => {
    const block = readingPromptBlock(validateReading({ ...base, alreadyAnswered: ['we ship to the EU'] })!);
    expect(block).toContain('THREAD READING');
    expect(block).toContain('untrusted');
    expect(block).toContain('Do you ship to Germany?');
    expect(block).toContain('we ship to the EU');
    expect(block).not.toMatch(/[\u2013\u2014]/);
  });

  it('for a supplier, says whether a link and a dropshipping answer are already on the thread', () => {
    const block = readingPromptBlock(validateReading({ ...base, senderRole: 'goods-supplier', supplier: { website: 'https://x.cn', storeLinks: [], kind: 'goods', productLines: [], nicheFit: 'on-niche', dropship: 'yes' } })!);
    expect(block).toContain('website or store link already given: yes');
    expect(block).toContain('dropshipping answer already given: yes');
  });

  it('renders a "no" dropshipping answer as given, distinct from unknown', () => {
    const block = readingPromptBlock(validateReading({ ...base, senderRole: 'goods-supplier', supplier: { website: 'https://x.cn', storeLinks: [], kind: 'goods', productLines: [], nicheFit: 'on-niche', dropship: 'no' } })!);
    expect(block).toContain('dropshipping answer already given: yes (they said no)');
  });

  it('renders an unknown dropshipping answer as not given', () => {
    const block = readingPromptBlock(validateReading({ ...base, senderRole: 'goods-supplier', supplier: { website: 'https://x.cn', storeLinks: [], kind: 'goods', productLines: [], nicheFit: 'on-niche', dropship: 'unknown' } })!);
    expect(block).toContain('dropshipping answer already given: no');
  });
});

describe('readThread', () => {
  const cfg = { llm: DEFAULT_LLM, inbox: { ...DEFAULT_INBOX } } as any;
  it('returns the validated reading and logs usage', async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const sys = JSON.parse(String(init.body)).messages?.[0]?.content ?? '';
      expect(sys.startsWith(THREAD_READER_MARKER)).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(base) } }], usage: { cost: 0.0001 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await readThread(new LlmClient({ openrouter: 'k' }, fetchImpl), new TenantStore(env.DB, 'a.myshopify.com'), cfg,
      { subject: 'Shipping', transcript: 'Customer: Do you ship to Germany?', fromEmail: 'jane@x.com' });
    expect(r?.openAsks).toEqual(['Do you ship to Germany?']);
  });

  it('returns null when the model answers garbage (the caller then drafts as today)', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await readThread(new LlmClient({ openrouter: 'k' }, fetchImpl), new TenantStore(env.DB, 'a.myshopify.com'), cfg,
      { subject: 'x', transcript: 'Customer: hi', fromEmail: 'a@b.c' });
    expect(r).toBeNull();
  });

  it('returns null with no model available', async () => {
    const r = await readThread(new LlmClient({}), new TenantStore(env.DB, 'a.myshopify.com'), cfg, { subject: 'x', transcript: 'Customer: hi', fromEmail: 'a@b.c' });
    expect(r).toBeNull();
  });

  it('still returns the reading when logging usage fails (a D1 failure must not throw out of readThread)', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(base) } }], usage: { cost: 0.0001 } }), { status: 200 })) as unknown as typeof fetch;
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    vi.spyOn(store, 'logLlmUsage').mockRejectedValue(new Error('d1'));
    const r = await readThread(new LlmClient({ openrouter: 'k' }, fetchImpl), store, cfg,
      { subject: 'Shipping', transcript: 'Customer: Do you ship to Germany?', fromEmail: 'jane@x.com' });
    expect(r?.openAsks).toEqual(['Do you ship to Germany?']);
  });
});

describe('productQuery', () => {
  it('keeps a customer product phrase, trimmed and capped', () => {
    const r = validateReading({ senderRole: 'customer', openAsks: [], offered: '', alreadyAnswered: [], replyNeeded: true, productQuery: '  gps tracker dog collar ' });
    expect(r?.productQuery).toBe('gps tracker dog collar');
  });
  it('is null for a non-customer and when absent', () => {
    expect(validateReading({ senderRole: 'marketer', openAsks: [], productQuery: 'seo' })?.productQuery).toBeNull();
    expect(validateReading({ senderRole: 'customer', openAsks: [] })?.productQuery).toBeNull();
  });
});
