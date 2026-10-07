import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../../src/tenant-store';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_FULFIL, DEFAULT_LLM } from '../../src/types';
import type { CjClient, CjDetail } from '../../src/cj';
import { LlmClient } from '../../src/llm';
import { productAgent } from '../../src/inbox/agents/product';
import { NO_MATCH_FACTS } from '../../src/inbox/agents/sourcing';

const mkCtx = (admin: any, latest = 'is the blue harness good for puppies?') => ({
  store: {} as any, cfg: {} as any, admin, thread: { subject: '' }, conversation: latest,
  latestMessage: latest, contactEmail: 'a@b.com', customerName: null
}) as any;

const singleProductAdmin = async () => ({
  products: { edges: [{ node: { id: 'p1', title: 'Blue Harness', variants: { edges: [{ node: { id: 'v1', title: 'M', sku: 'BH-M', price: '12.00', availableForSale: true, inventoryQuantity: 5 } }] } } }] }
});

describe('productAgent department', () => {
  // Product/spec questions ("does this come in large?", "is the material pet-safe?")
  // are the shop's "technical questions" bucket, so they sign as the Technical Team.
  it('signs as the Technical Team desk', () => {
    expect(productAgent.department).toBe('tech');
  });
});

describe('productAgent.ground', () => {
  it('hedges when admin is null (not authed)', async () => {
    const g = await productAgent.ground(mkCtx(null));
    expect(g.confident).toBe(false);
  });
  it('grounds a single resolved product', async () => {
    const g = await productAgent.ground(mkCtx(singleProductAdmin));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
  });
  it('asks which item on ambiguous (no figure)', async () => {
    const admin = async () => ({ products: { edges: [
      { node: { id: 'p1', title: 'Blue Harness S', variants: { edges: [{ node: { id: 'v1', title: 'S', price: '12', availableForSale: true, inventoryQuantity: 3 } }] } } },
      { node: { id: 'p2', title: 'Blue Harness L', variants: { edges: [{ node: { id: 'v2', title: 'L', price: '14', availableForSale: true, inventoryQuantity: 3 } }] } } }
    ] } });
    const g = await productAgent.ground(mkCtx(admin));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).toContain('which');
  });

  it('ambiguous variants of ONE product -> confident, facts contain title + both variant options', async () => {
    // Both variants belong to the same product (same id 'p1')
    const admin = async () => ({ products: { edges: [
      { node: { id: 'p1', title: 'Blue Harness', variants: { edges: [
        { node: { id: 'v1', title: 'S', price: '12.00', availableForSale: true, inventoryQuantity: 3 } },
        { node: { id: 'v2', title: 'L', price: '14.00', availableForSale: true, inventoryQuantity: 2 } }
      ] } } }
    ] } });
    const g = await productAgent.ground(mkCtx(admin));
    expect(g.confident).toBe(true);
    expect(g.quotesFigure).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts).toContain('S');
    expect(g.facts).toContain('L');
  });

  it('ambiguous candidates spanning two different productIds -> hedge (not confident)', async () => {
    // Each variant belongs to a different product
    const admin = async () => ({ products: { edges: [
      { node: { id: 'p1', title: 'Blue Harness', variants: { edges: [{ node: { id: 'v1', title: 'S', price: '12.00', availableForSale: true, inventoryQuantity: 3 } }] } } },
      { node: { id: 'p2', title: 'Red Harness', variants: { edges: [{ node: { id: 'v2', title: 'S', price: '13.00', availableForSale: true, inventoryQuantity: 3 } }] } } }
    ] } });
    const g = await productAgent.ground(mkCtx(admin));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).toContain('which');
  });

  // Task 19: warehouse supplement tests
  it('appends warehouse stock info when D1 row is available', async () => {
    const store = {
      getLinkByShopifyProductId: async (_id: string) => ({ cj_pid: 'cj-p1' }),
      getWarehouseProduct: async (_pid: string) => ({
        stock: 40,
        status: 'available',
        detail: JSON.stringify({ material: 'nylon' })
      })
    };
    const ctx = {
      store, cfg: {} as any, admin: singleProductAdmin,
      thread: { subject: '' }, conversation: 'blue harness',
      latestMessage: 'blue harness', contactEmail: 'a@b.com', customerName: null
    } as any;
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts.toLowerCase()).toContain('stock');
    expect(g.facts).toContain('40');
  });

  it('includes categoryName and petClass spec fields when warehouse detail has them', async () => {
    const store = {
      getLinkByShopifyProductId: async (_id: string) => ({ cj_pid: 'p1' }),
      getWarehouseProduct: async (_pid: string) => ({
        stock: 12,
        status: 'available',
        detail: JSON.stringify({ categoryName: 'Harnesses', petClass: 'dog' })
      })
    };
    const ctx = {
      store, cfg: {} as any, admin: singleProductAdmin,
      thread: { subject: '' }, conversation: 'blue harness',
      latestMessage: 'blue harness', contactEmail: 'a@b.com', customerName: null
    } as any;
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Category: Harnesses');
    expect(g.facts).toContain('For: dog');
  });

  it('stays confident and keeps price/title when no warehouse row exists', async () => {
    const store = {
      getLinkByShopifyProductId: async (_id: string) => null,
    };
    const ctx = {
      store, cfg: {} as any, admin: singleProductAdmin,
      thread: { subject: '' }, conversation: 'blue harness',
      latestMessage: 'blue harness', contactEmail: 'a@b.com', customerName: null
    } as any;
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts).toContain('12.00');
  });
});

describe('productAgent local-for-local availability (inquiry side of the market catalogs)', () => {
  const ctxWith = (latest: string, origins: Record<string, number> | null) => ({
    store: {
      getLinkByShopifyProductId: async (_id: string) => ({ cj_pid: 'cj-p1' }),
      getWarehouseProduct: async (_pid: string) => origins === null ? null : ({
        stock: 40, status: 'available',
        detail: JSON.stringify({ origins })
      })
    },
    cfg: {} as any, admin: singleProductAdmin,
    thread: { subject: '' }, conversation: latest,
    latestMessage: latest, contactEmail: 'a@b.com', customerName: null
  }) as any;

  it('cross-lane item + confident destination -> honest not-available, no price, no purchase push', async () => {
    // A UK sender asking about a US-warehoused item: the UK market does not sell it.
    const g = await productAgent.ground(ctxWith('does the blue harness ship to the UK?', { US: 60 }));
    expect(g.confident).toBe(true);
    expect(g.quotesFigure).toBe(false);
    expect(g.facts).toMatch(/not available for delivery to the UK/);
    expect(g.facts).not.toContain('12.00');
    expect(g.facts).not.toMatch(/in stock/i);
  });

  it('destination we have no market for -> plain no-delivery instruction', async () => {
    const g = await productAgent.ground(ctxWith('can I get the blue harness in Japan?', { CN: 900 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toMatch(/appears to be in Japan/);
    expect(g.facts).toMatch(/do not currently deliver/);
    expect(g.facts).not.toContain('12.00');
  });

  it('CN scaffolding item + EU destination stays a normal answer (transitional lane)', async () => {
    const g = await productAgent.ground(ctxWith('does the blue harness ship to Germany?', { CN: 900 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts).toContain('12.00');
  });

  it('lane-local item + its own destination stays a normal answer', async () => {
    const g = await productAgent.ground(ctxWith('is the blue harness available in the UK?', { GB: 12 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('12.00');
    expect(g.facts).not.toMatch(/not available/);
  });

  it('no destination signal -> unchanged behavior even for cross-lane stock', async () => {
    const g = await productAgent.ground(ctxWith('is the blue harness machine washable?', { US: 60 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('12.00');
  });

  it('unverified origins -> cannot determine, keeps the normal grounded answer', async () => {
    const g = await productAgent.ground(ctxWith('does the blue harness ship to the UK?', null));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('12.00');
  });
});

// Rose thread (2026-09-05): the product agent searched titles with the first
// 80 characters of a message that BEGAN with the product URL, matched nothing,
// and told a sender who had named the exact product that we "cannot verify the
// specific product details". A pasted link grounds the reply in that listing.
describe('productAgent.ground with a pasted product link', () => {
  const ROSE_1 = 'https://activepaw.co.uk/products/portable-dog-water-bowl-bottle-attachment\n\nI came across your store and I am considering recommending it to a few people who are looking for products in this category. Before I do, I wanted to ask do the products normally arrive exactly as shown and described on the website?';
  const ROSE_2 = 'just checking back in. I think our conversation got a little buried. I am still open to recommending your store, but I wanted to make sure I can reach you directly if anyone has questions before ordering.';
  const byHandleAdmin = async (query: string, vars?: Record<string, unknown>) => {
    if (query.includes('productByHandle')) {
      if (vars?.handle !== 'portable-dog-water-bowl-bottle-attachment') return { productByHandle: null };
      return { productByHandle: { id: 'gid://shopify/Product/7', title: 'Portable Dog Water Bowl', handle: 'portable-dog-water-bowl-bottle-attachment', variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/70', title: 'Default Title', sku: 'PDWB', price: '11.99', availableForSale: true, inventoryQuantity: 12 } }] } } };
    }
    return { products: { edges: [] } };
  };
  it('resolves the linked product from the latest message', async () => {
    const g = await productAgent.ground(mkCtx(byHandleAdmin, ROSE_1));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Portable Dog Water Bowl');
  });
  it('resolves a link from an EARLIER message in the thread when the latest has none', async () => {
    const ctx = { ...mkCtx(byHandleAdmin, ROSE_2), conversation: ROSE_1 + '\n\n' + ROSE_2 };
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Portable Dog Water Bowl');
  });
});

describe('productAgent on a catalog miss (inquiry sourcing)', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  const emptyAdmin = async () => ({ products: { edges: [] } });
  const TRACKER: CjDetail = { pid: 'T1', nameEn: 'Smart GPS Wireless Pet Tracker', images: ['https://i/t.jpg'], descriptionHtml: '<p>Clips to the collar. Needs a SIM card.</p>', variants: [{ vid: 'v', name: 'Black', sellPriceUsd: 12, sku: 's' }], listedNum: 10, categoryName: 'Pet', origins: { CN: 5429 } };
  const cj = {
    search: async () => [{ pid: 'T1', nameEn: TRACKER.nameEn, image: '', sellPriceUsd: 12, listedNum: 10, categoryName: 'Pet' }],
    detail: async () => TRACKER, detailBySku: async () => null, originsByPid: async () => TRACKER.origins,
    freightEstimate: async () => ({ priceUsd: 4, days: '5-9', name: 'CJPacket' }),
  } as unknown as CjClient;
  const cfg = { pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, fulfil: DEFAULT_FULFIL } as any;

  async function ctx(message: string, withCj = true) {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
    return { store, cfg, admin: emptyAdmin, cj: withCj ? cj : null, thread: { subject: 'Collar' }, conversation: message, latestMessage: message, contactEmail: 'aloha@example.com', customerName: 'Aloha', productQuery: 'gps tracker dog collar' } as any;
  }

  it('offers the supplier item with price, overseas note and delivery band, held for the owner', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar? I live in England.'));
    expect(g.confident).toBe(true);
    expect(g.holdReason).toBe('sourcing_offer');
    expect(g.facts).toContain('Smart GPS Wireless Pet Tracker');
    expect(g.facts).toMatch(/GBP \d+\.\d{2}/);
    expect(g.facts).toContain('ships from overseas');
    expect(g.facts).toMatch(/\d+-\d+ days/);
    expect(g.facts).not.toMatch(/\bChina\b|\bCJ\b/);
  });

  it('states no delivery time and asks for the country when it is unknown', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar?'));
    expect(g.holdReason).toBe('sourcing_offer');
    expect(g.facts).toContain('do not state a delivery time');
    expect(g.facts).not.toMatch(/\d+-\d+ days/);
  });

  it('never sends the customer to the website search when nothing matches', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar?', false));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).not.toContain('website');
    expect(g.facts).toContain('team will look into');
  });

  // aramid js-mutation e90e99d3 (2026-10-07): "productQuery || typed" -> "&&"
  // survived, because no test looked at WHICH phrase reached the supplier.
  const recordingCj = (seen: string[]) => ({ ...cj, search: async (q: string, n: number) => {
    seen.push(q); return (cj.search as (q: string, n: number) => Promise<unknown>)(q, n);
  } }) as unknown as CjClient;
  const ASK = 'Do you sell a trackable dog collar? I live in England.';

  it('searches the supplier with the reader\'s product phrase, or the message itself when there is none', async () => {
    const seen: string[] = [];
    const c = await ctx(ASK);
    await productAgent.ground({ ...c, cj: recordingCj(seen) });
    expect(seen[0]).toBe('gps tracker dog collar');
    seen.length = 0;
    await productAgent.ground({ ...c, cj: recordingCj(seen), productQuery: null });
    expect(seen[0]).toBe(ASK);
  });

  it('searches the supplier with the same phrase when the catalogue matcher finds nothing', async () => {
    const seen: string[] = [];
    const c = await ctx(ASK);
    c.admin = async (query: string) => query.includes('pawscoutCatalogList')
      ? { products: { nodes: [{ handle: 'cat-teaser', title: 'Cat Teaser', productType: '', description: 'A toy.', collections: { nodes: [] } }] }, collections: { nodes: [] } }
      : { products: { edges: [] } };
    c.cfg = { ...c.cfg, llm: DEFAULT_LLM };
    const llm = new LlmClient({ openrouter: 'k' }, (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"handles":[],"collection":null}' } }], usage: { cost: 0 } }), { status: 200 })) as unknown as typeof fetch);
    await productAgent.ground({ ...c, cj: recordingCj(seen), llm });
    expect(seen[0]).toBe('gps tracker dog collar');
    seen.length = 0;
    await productAgent.ground({ ...c, cj: recordingCj(seen), llm, productQuery: null });
    expect(seen[0]).toBe(ASK);
  });

  it('says we do not deliver to a country with no lane', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar? I live in Japan.'));
    expect(g.facts).toContain('do not currently deliver');
    expect(g.holdReason).toBeUndefined();
  });

  it('answers from the real listing, unheld, once the owner has imported the item', async () => {
    const c = await ctx('Do you sell a trackable dog collar? I live in England.');
    await c.store.putLink({ cjPid: 'T1', state: 'imported', handle: 'smart-gps-pet-tracker' });
    c.admin = async (query: string, vars?: Record<string, unknown>) => {
      if (query.includes('productByHandle') && vars?.handle === 'smart-gps-pet-tracker') {
        return { productByHandle: { id: 'gid://shopify/Product/9', title: 'GPS Pet Tracker for Dog Collars', handle: 'smart-gps-pet-tracker', variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/90', title: 'Default Title', sku: 'T1', price: '27.49', availableForSale: true, inventoryQuantity: 50 } }] } } };
      }
      return query.includes('productByHandle') ? { productByHandle: null } : { products: { edges: [] } };
    };
    const g = await productAgent.ground(c);
    expect(g.confident).toBe(true);
    expect(g.holdReason).toBeUndefined();
    expect(g.facts).toContain('GPS Pet Tracker for Dog Collars');
    expect(g.facts).toContain('27.49');
  });
  it('keeps the overseas note when the imported item is answered from its listing', async () => {
    const c = await ctx('Do you sell a trackable dog collar? I live in England.');
    await c.store.putLink({ cjPid: 'T1', state: 'imported', handle: 'smart-gps-pet-tracker' });
    c.admin = async (query: string, vars?: Record<string, unknown>) => {
      if (query.includes('pawscoutOrigin')) return { product: { origin: { value: 'CN' }, days: { value: '5-14' } } };
      if (query.includes('productByHandle') && vars?.handle === 'smart-gps-pet-tracker') {
        return { productByHandle: { id: 'gid://shopify/Product/9', title: 'GPS Pet Tracker for Dog Collars', handle: 'smart-gps-pet-tracker', variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/90', title: 'Default Title', sku: 'T1', price: '27.49', availableForSale: true, inventoryQuantity: 50 } }] } } };
      }
      return query.includes('productByHandle') ? { productByHandle: null } : { products: { edges: [] } };
    };
    const g = await productAgent.ground(c);
    expect(g.holdReason).toBeUndefined();
    expect(g.facts).toContain('27.49');
    expect(g.facts).toContain('ships from overseas');
  });
});

// Owner rule 2026-09-30: an item sold from an overseas warehouse carries a plain
// "ships from overseas" note. A sourced offer had it; the same item answered
// from the catalog once imported did not (the GBP 40.99 GPS collar, origin CN).
describe('productAgent catalog answer for an item that ships from overseas', () => {
  const PRODUCT = { id: 'gid://shopify/Product/5', title: 'GPS Tracker Collar', variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/50', title: 'Default Title', sku: 'G1', price: '40.99', availableForSale: true, inventoryQuantity: 9 } }] } };
  const TWO_VARIANTS = { ...PRODUCT, variants: { edges: [
    { node: { id: 'gid://shopify/ProductVariant/51', title: 'EU', price: '40.99', availableForSale: true, inventoryQuantity: 9 } },
    { node: { id: 'gid://shopify/ProductVariant/52', title: 'US', price: '42.99', availableForSale: true, inventoryQuantity: 9 } },
  ] } };
  /** The catalog search answers with `product`; the supplier metafield read answers with `origin`. */
  const adminFor = (origin: string | null, product: unknown = PRODUCT) => async (query: string) => {
    if (query.includes('pawscoutOrigin')) {
      return { product: origin === null ? null : { origin: { value: origin }, days: { value: '5-14' } } };
    }
    return { products: { edges: [{ node: product }] } };
  };
  const ask = (admin: unknown, msg: string) => productAgent.ground(mkCtx(admin, msg));

  it('says it ships from overseas and states the UK band to a UK buyer', async () => {
    const g = await ask(adminFor('CN'), 'does the gps tracker collar work for cats? I live in England.');
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('40.99');
    expect(g.facts).toContain('ships from overseas');
    expect(g.facts).toContain('5-14 days');
    expect(g.facts).not.toMatch(/\bCN\b|China/);
  });

  it('asks for the country, with no delivery time, when it is not known', async () => {
    const g = await ask(adminFor('CN'), 'does the gps tracker collar work for cats?');
    expect(g.facts).toContain('ships from overseas');
    expect(g.facts).toContain('do not state a delivery time');
    expect(g.facts).not.toContain('5-14');
  });

  it('states no UK band to a buyer in another country we serve', async () => {
    const g = await ask(adminFor('CN'), 'does the gps tracker collar work for cats? I live in the United States.');
    expect(g.facts).toContain('ships from overseas');
    expect(g.facts).not.toContain('5-14');
  });

  it('leaves a local item exactly as it was', async () => {
    const msg = 'does the gps tracker collar work for cats? I live in England.';
    const local = await ask(adminFor('GB'), msg);
    const unknown = await ask(adminFor(null), msg);
    expect(local.facts).toBe(unknown.facts);
    expect(local.facts).not.toContain('overseas');
  });

  it('keeps the normal answer when the origin cannot be read', async () => {
    const msg = 'does the gps tracker collar work for cats? I live in England.';
    const throwing = async (query: string) => {
      if (query.includes('pawscoutOrigin')) throw new Error('throttled');
      return { products: { edges: [{ node: PRODUCT }] } };
    };
    const g = await ask(throwing, msg);
    expect(g.confident).toBe(true);
    expect(g.facts).toBe((await ask(adminFor(null), msg)).facts);
  });

  it('adds the note when several variants of the one product match', async () => {
    const g = await ask(adminFor('CN', TWO_VARIANTS), 'does the gps tracker collar work for cats? I live in England.');
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('EU');
    expect(g.facts).toContain('ships from overseas');
  });
});

// Kehinde thread (2026-10-02): "any anti escape pet accessory in your store?"
// title-searched the whole phrase, matched nothing, and offered to source a car
// bag while a GPS tracker collar and a dog playpen were live. Imran thread
// (2026-10-04): "activepaw.co.uk for accessories?" was told "we do not stock a
// matching accessory" beside a live Pet Accessories collection. A question about
// a KIND of product is matched against the whole live catalogue.
describe('productAgent on a question about a kind of product (catalogue matcher)', () => {
  const variant = (id: string, price: string) => ({ edges: [{ node: { id, title: 'Default Title', sku: 'S', price, availableForSale: true, inventoryQuantity: 9 } }] });
  const PRODUCTS: Record<string, unknown> = {
    'gps-tracker-collar': { id: 'gid://shopify/Product/5', title: 'GPS Tracker Collar for Dogs and Cats', handle: 'gps-tracker-collar', variants: variant('gid://shopify/ProductVariant/50', '40.99') },
    'metal-dog-playpen': { id: 'gid://shopify/Product/6', title: '6-Panel Metal Dog Playpen', handle: 'metal-dog-playpen', variants: variant('gid://shopify/ProductVariant/60', '62.99') },
    'pet-glasses': { id: 'gid://shopify/Product/7', title: 'Pet Glasses Windproof Eye Protection Accessories', handle: 'pet-glasses', variants: variant('gid://shopify/ProductVariant/70', '10.99') },
  };
  const ORIGIN: Record<string, string> = { 'gid://shopify/Product/5': 'CN', 'gid://shopify/Product/6': 'GB', 'gid://shopify/Product/7': 'CN' };
  const LIST = {
    products: { nodes: [
      { handle: 'gps-tracker-collar', title: 'GPS Tracker Collar for Dogs and Cats', productType: '', description: 'A pet collar supplied with a GPS tracker for helping locate dogs and cats.', collections: { nodes: [{ handle: 'pet-accessories' }] } },
      { handle: 'metal-dog-playpen', title: '6-Panel Metal Dog Playpen', productType: '', description: 'Create a safe, secure space for your dog.', collections: { nodes: [{ handle: 'pet-accessories' }] } },
      { handle: 'pet-glasses', title: 'Pet Glasses Windproof Eye Protection Accessories', productType: 'Pet Accessories', description: 'Windproof eye protection.', collections: { nodes: [{ handle: 'pet-accessories' }] } },
    ] },
    collections: { nodes: [{ handle: 'pet-accessories', title: 'Pet Accessories' }] },
  };
  // The whole page of a picked item; the list above carries only the 240-character cut.
  const FULL: Record<string, string> = {
    'gps-tracker-collar': 'A pet collar supplied with a GPS tracker for helping locate dogs and cats. Connects over a 4G mobile network and shows its location in a phone app. The box holds the collar and tracker only; a SIM card with a data plan is not included.',
  };
  const admin = async (query: string, vars?: Record<string, unknown>) => {
    if (query.includes('pawscoutCatalogList')) return LIST;
    if (query.includes('pawscoutPicked')) {
      return { products: { nodes: Object.entries(FULL).filter(([h]) => String(vars?.q).includes(h)).map(([handle, description]) => ({ handle, description, descriptionHtml: `<p>${description}</p>` })) } };
    }
    if (query.includes('pawscoutOrigin')) return { product: { origin: { value: ORIGIN[String(vars?.id)] }, days: { value: '5-14' } } };
    if (query.includes('productByHandle')) return { productByHandle: PRODUCTS[String(vars?.handle)] ?? null };
    // The title search: any phrase with "accessories" in it finds the one product
    // with that word in its title, which is not what a range question asks for.
    return { products: { edges: [{ node: PRODUCTS['pet-glasses'] }] } };
  };
  const llmAnswering = (content: string) => new LlmClient({ openrouter: 'k' }, (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), { status: 200 })) as unknown as typeof fetch);
  const ctx = (message: string, matcher: string | null, productQuery: string | null = null) => ({
    store: { logLlmUsage: async () => {} }, cfg: { llm: DEFAULT_LLM }, admin, cj: null,
    llm: matcher === null ? null : llmAnswering(matcher),
    thread: { subject: '' }, conversation: message, latestMessage: message,
    contactEmail: 'kbadmus896@gmail.com', customerName: null, productQuery,
  }) as any;
  const ANTI_ESCAPE = 'Hi Activepaw, any anti escape pet accessory in your store please?';

  it('answers with the catalogue items that meet the need, each with its price, link and own description', async () => {
    const g = await productAgent.ground(ctx(ANTI_ESCAPE, '{"handles":["gps-tracker-collar","metal-dog-playpen"],"collection":null}', 'anti escape pet accessory'));
    expect(g.confident).toBe(true);
    expect(g.quotesFigure).toBe(true);
    expect(g.holdReason).toBeUndefined();
    for (const s of ['GPS Tracker Collar for Dogs and Cats', '40.99', '6-Panel Metal Dog Playpen', '62.99',
      'https://activepaw.co.uk/products/gps-tracker-collar', 'https://activepaw.co.uk/products/metal-dog-playpen',
      'helping locate dogs and cats', 'safe, secure space']) expect(g.facts).toContain(s);
    expect(g.facts).not.toContain('We do not stock');
    expect(g.facts).not.toContain('Not in our catalog');
  });

  it('describes a picked item from its whole page, so the collar keeps its network and SIM requirement', async () => {
    const g = await productAgent.ground(ctx(ANTI_ESCAPE, '{"handles":["gps-tracker-collar","metal-dog-playpen"],"collection":null}', 'anti escape pet accessory'));
    expect(g.facts).toContain('4G mobile network');
    expect(g.facts).toContain('a SIM card with a data plan is not included');
    // The playpen has no fuller page in this fixture: its catalogue words stay.
    expect(g.facts).toContain('safe, secure space');
  });

  it('keeps the overseas note on the item held overseas, and only on that one', async () => {
    const g = await productAgent.ground(ctx(ANTI_ESCAPE, '{"handles":["gps-tracker-collar","metal-dog-playpen"],"collection":null}', 'anti escape pet accessory'));
    expect(g.facts).toContain('6-Panel Metal Dog Playpen');
    expect(g.facts.match(/ships from overseas/g)?.length).toBe(1);
    expect(g.facts).toContain('do not state a delivery time');
    expect(g.facts).not.toMatch(/\bCN\b|China/);
  });

  it('answers one matched item exactly as the link path does, plus its own description', async () => {
    const g = await productAgent.ground(ctx('is there something to help find my cat if she gets out?', '{"handles":["gps-tracker-collar"],"collection":null}'));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Resolved product "GPS Tracker Collar for Dogs and Cats');
    expect(g.facts).toContain('40.99');
    expect(g.facts).toContain('helping locate dogs and cats');
    expect(g.facts).toContain('ships from overseas');
  });

  it('answers a whole-range question with the real collection and what it holds, quoting no price', async () => {
    const g = await productAgent.ground(ctx('activepaw.co.uk for accessories?', '{"handles":[],"collection":"pet-accessories"}'));
    expect(g.confident).toBe(true);
    expect(g.quotesFigure).toBe(false);
    expect(g.facts).toContain('https://activepaw.co.uk/collections/pet-accessories');
    expect(g.facts).toContain('Pet Accessories');
    expect(g.facts).toContain('GPS Tracker Collar for Dogs and Cats');
    expect(g.facts).not.toContain('We do not stock');
    expect(g.facts).not.toMatch(/GBP|\d+\.\d{2}/);
  });

  it('lets the matcher, not a title substring, decide a range question', async () => {
    const g = await productAgent.ground(ctx('do you sell pet accessories?', '{"handles":[],"collection":"pet-accessories"}', 'pet accessories'));
    expect(g.facts).not.toContain('Resolved product "Pet Glasses');
    expect(g.facts).toContain('https://activepaw.co.uk/collections/pet-accessories');
  });

  it('goes to the supplier lookup, not a title substring, when nothing in the catalogue fits', async () => {
    const g = await productAgent.ground(ctx('do you sell horse saddle accessories?', '{"handles":[],"collection":null}', 'horse saddle accessories'));
    expect(g.confident).toBe(false);
    expect(g.facts).toBe(NO_MATCH_FACTS);
  });

  it('keeps the title search when the matcher cannot answer (no model, garbage, or an invented handle)', async () => {
    for (const matcher of [null, 'not json', '{"handles":["gps-collar-xl"],"collection":null}']) {
      const g = await productAgent.ground(ctx('do you sell pet accessories?', matcher, 'pet accessories'));
      expect(g.facts).toContain('Resolved product "Pet Glasses Windproof Eye Protection Accessories');
    }
  });
});
