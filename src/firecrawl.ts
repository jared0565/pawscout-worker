import { defaultFetch } from './safe-fetch';

export interface FcProduct {
  title: string;
  price?: string;
}

/**
 * Scrape CJ's own website search via Firecrawl (runs from Firecrawl's servers,
 * so it gets past CJ's bot protection and renders the JS product grid). Returns
 * the relevance-ranked product list the website actually shows - the ground
 * truth for comparing against our `listV2` results.
 *
 * Firecrawl v1 /scrape with structured-JSON extraction. Never throws past the
 * caller's try/catch; returns [] on any failure.
 */
export async function firecrawlCjSearch(
  apiKey: string,
  query: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<FcProduct[]> {
  const slug = encodeURIComponent(query.trim()).replace(/%20/g, '+');
  const target = `https://www.cjdropshipping.com/search/${slug}.html`;
  const resp = await fetchImpl('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: target,
      formats: ['json'],
      waitFor: 9000,
      timeout: 60000,
      jsonOptions: {
        prompt:
          'This is a product search results page. Extract every product card shown in the main results grid. For each, return its title/name and its price exactly as displayed.',
        schema: {
          type: 'object',
          properties: {
            products: {
              type: 'array',
              items: {
                type: 'object',
                properties: { title: { type: 'string' }, price: { type: 'string' } },
                required: ['title']
              }
            }
          },
          required: ['products']
        }
      }
    })
  });
  if (!resp.ok) {
    let body = '';
    try { body = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`Firecrawl HTTP ${resp.status}${body ? ` - ${body}` : ''}`);
  }
  const data = (await resp.json()) as { data?: { json?: { products?: FcProduct[] } } };
  const products = data?.data?.json?.products;
  return Array.isArray(products) ? products : [];
}
