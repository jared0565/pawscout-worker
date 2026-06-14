import { describe, it, expect } from 'vitest';
import { firecrawlCjSearch } from '../src/firecrawl';

describe('firecrawlCjSearch', () => {
  it('targets the CJ website search URL and extracts the products array', async () => {
    let sent: { url: string; body: string } | null = null;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = { url: String(input), body: String(init?.body ?? '') };
      return new Response(JSON.stringify({ success: true, data: { json: { products: [
        { title: 'Durable Dog Chew Toy', price: '£7.99' },
        { title: 'Squeaky Plush Dog Toy' }
      ] } } }), { status: 200 });
    }) as typeof fetch;
    const out = await firecrawlCjSearch('fc-key', 'dog toy', fakeFetch);
    expect(sent!.url).toBe('https://api.firecrawl.dev/v1/scrape');
    expect(sent!.body).toContain('cjdropshipping.com/search/dog+toy.html');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: 'Durable Dog Chew Toy', price: '£7.99' });
  });
  it('returns [] when no products and throws on HTTP error', async () => {
    const empty = (async () => new Response(JSON.stringify({ data: { json: {} } }), { status: 200 })) as typeof fetch;
    expect(await firecrawlCjSearch('k', 'x', empty)).toEqual([]);
    const err = (async () => new Response('nope', { status: 402 })) as typeof fetch;
    await expect(firecrawlCjSearch('k', 'x', err)).rejects.toThrow('Firecrawl HTTP 402');
  });
});
