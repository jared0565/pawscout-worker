import { describe, it, expect } from 'vitest';
import {
  findBlogIssues, findClaimFlags, hasStorefrontLink, htmlToText, countWords, refineBlogUntilClean
} from '../src/blog/quality';
import { factPackToPrompt, groundCollection } from '../src/blog/ground';
import { sanitizeBlogHtml, draftArticle } from '../src/blog/draft';
import { createDraftArticle, renameBlog, findBlog, updateArticleAssets } from '../src/blog/article';
import { extractProductHandles, selectShopBlock } from '../src/blog/select';
import { proposeBrief, proposeTopics, seasonForMonth } from '../src/blog/research';
import { resolvePipelineBrief } from '../src/blog/pipeline';
import { LlmClient } from '../src/llm';
import type { AdminGraphql } from '../src/shopify-admin';
import type { BlogBrief, BlogDraft, FactPack, GroundedProduct } from '../src/blog/types';

const CFG: any = { llm: { models: {} } };
const STORE: any = { logLlmUsage: async () => {} };

// A minimal OpenRouter-shaped fake LLM that returns each object in sequence.
function fakeLlm(objs: unknown[]): LlmClient {
  let i = 0;
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(objs[Math.min(i++, objs.length - 1)]) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 }, model: 'test'
  }), { status: 200 })) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'k' }, fetchImpl);
}

const GOOD_BODY =
  '<p>Intro paragraph that is genuinely useful and sets up the guide for the reader in a warm way. ' +
  Array.from({ length: 60 }, (_, i) => `helpful sentence ${i} about caring for your pet at home.`).join(' ') +
  '</p><h2>First section</h2><p>More real content here that helps the owner decide, linking to ' +
  '<a href="/products/2-2l-automatic-pet-water-fountain">the fountain</a> naturally.</p>' +
  '<h2>Second section</h2><p>Closing advice and a nudge to <a href="/collections/pet-health">Pet Health</a>.</p>';

const GOOD_DRAFT: BlogDraft = {
  title: 'Why won\'t my cat drink enough water?',
  bodyHtml: GOOD_BODY,
  excerpt: 'Cats are famously reluctant drinkers. Here is why, and how to help at home.',
  metaTitle: 'Why won\'t my cat drink enough water?',
  metaDescription: 'Cats are famously reluctant drinkers. Here is why it happens and simple ways to help your cat stay hydrated.',
  tag: 'pet-health'
};

describe('blog quality gate', () => {
  it('passes a well-formed draft', () => {
    expect(findBlogIssues(GOOD_DRAFT)).toEqual([]);
  });
  it('flags a too-short draft, a missing product link, no headings, and a bad meta description', () => {
    const bad: BlogDraft = { title: 'Too thin', bodyHtml: '<p>Short.</p>', excerpt: '', metaTitle: 'x', metaDescription: 'short', tag: 'pet-health' };
    const issues = findBlogIssues(bad).join(' | ');
    expect(issues).toMatch(/too short/i);
    expect(issues).toMatch(/no section headings/i);
    expect(issues).toMatch(/does not link to any real product/i);
    expect(issues).toMatch(/meta description/i);
    expect(issues).toMatch(/excerpt/i);
  });
  it('hasStorefrontLink only matches real product/collection paths', () => {
    expect(hasStorefrontLink('<a href="/products/x-1">x</a>')).toBe(true);
    expect(hasStorefrontLink('<a href="/collections/pet-health">c</a>')).toBe(true);
    expect(hasStorefrontLink('<a href="https://example.com/blog">no</a>')).toBe(false);
    expect(hasStorefrontLink('no links here')).toBe(false);
  });
  it('htmlToText + countWords strip tags', () => {
    expect(htmlToText('<p>one <strong>two</strong> three</p>')).toBe('one two three');
    expect(countWords(htmlToText('<p>a b c</p>'))).toBe(3);
  });
  it('findClaimFlags surfaces medical, dosage, and guarantee claims for review', () => {
    const flags = findClaimFlags(
      '<p>This supplement cures anxiety in dogs.</p>' +
      '<p>Give 5 mg per kg twice a day.</p>' +
      '<p>It is 100% safe and guaranteed.</p>' +
      '<p>A cat often prefers running water.</p>'
    );
    const concerns = flags.map((f) => f.concern);
    expect(concerns).toContain('medical/treatment claim');
    expect(concerns).toContain('dosage/quantity claim');
    expect(concerns).toContain('safety guarantee');
    // the benign lifestyle sentence is NOT flagged
    expect(flags.find((f) => /running water/.test(f.sentence))).toBeUndefined();
  });
  it('refineBlogUntilClean returns the best candidate and degrades on a null reviser', async () => {
    const short: BlogDraft = { ...GOOD_DRAFT, bodyHtml: '<p>short</p>' };
    const fixed = await refineBlogUntilClean(short, async () => GOOD_DRAFT);
    expect(findBlogIssues(fixed)).toEqual([]);
    const stuck = await refineBlogUntilClean(short, async () => null);
    expect(stuck).toBe(short); // reviser unavailable -> keep the best (the initial)
  });
});

describe('blog grounding prompt', () => {
  it('lists only available products with exact paths', () => {
    const pack: FactPack = {
      collectionHandle: 'pet-health', collectionTitle: 'Pet Health', collectionPath: '/collections/pet-health',
      products: [
        { title: 'Fountain', handle: 'fountain', path: '/products/fountain', priceGbp: 47.99, available: true },
        { title: 'Sold Out Bowl', handle: 'bowl', path: '/products/bowl', priceGbp: 9.99, available: false }
      ]
    };
    const text = factPackToPrompt(pack);
    expect(text).toContain('/collections/pet-health');
    expect(text).toContain('Fountain (link: /products/fountain, price: GBP 47.99)');
    expect(text).not.toContain('Sold Out Bowl'); // unavailable products are not offered
  });

  it('groundCollection marks a product available only when it is on the Online Store (not just availableForSale)', async () => {
    const admin: AdminGraphql = (async () => ({
      collections: { nodes: [{ handle: 'pet-grooming', title: 'Pet Grooming', products: { nodes: [
        { handle: 'on-store', title: 'On Store', onlineStoreUrl: 'https://shop/products/on-store', featuredImage: { url: 'https://img/a.jpg', width: 1200, height: 1200 }, variants: { nodes: [{ price: '9.99', availableForSale: true }] } },
        { handle: 'phantom', title: 'Phantom', onlineStoreUrl: null, featuredImage: { url: 'https://img/b.jpg', width: 1200, height: 1200 }, variants: { nodes: [{ price: '9.99', availableForSale: true }] } }
      ] } }] }
    })) as unknown as AdminGraphql;
    const pack = await groundCollection(admin, 'pet-grooming');
    expect(pack!.products.find((p) => p.handle === 'on-store')!.available).toBe(true);
    expect(pack!.products.find((p) => p.handle === 'phantom')!.available).toBe(false); // availableForSale but 404 on the storefront
    const text = factPackToPrompt(pack!);
    expect(text).toContain('On Store');
    expect(text).not.toContain('Phantom'); // the drafter is never offered a phantom product to link
  });
});

describe('blog article creation (Admin ops)', () => {
  it('createDraftArticle sends isPublished:false, SEO metafields, the tag, and never publishes', async () => {
    let vars: any = {};
    const admin: AdminGraphql = (async (_q: string, v?: any) => {
      vars = v;
      return { articleCreate: { article: { id: 'gid://shopify/Article/1', handle: 'why-cat-water', title: GOOD_DRAFT.title, isPublished: false }, userErrors: [] } };
    }) as unknown as AdminGraphql;
    const created = await createDraftArticle(admin, { blogId: 'gid://blog/1', draft: GOOD_DRAFT, authorName: 'Active Paw' });
    expect(created.isPublished).toBe(false);
    const a = vars.article;
    expect(a.isPublished).toBe(false);               // the load-bearing invariant: DRAFT, never auto-publish
    expect(a.blogId).toBe('gid://blog/1');
    expect(a.tags).toEqual(['pet-health']);
    expect(a.author).toEqual({ name: 'Active Paw' });
    const seo = Object.fromEntries((a.metafields as any[]).map((m) => [m.key, m.value]));
    expect(seo.title_tag).toBe(GOOD_DRAFT.metaTitle);
    expect(seo.description_tag).toBe(GOOD_DRAFT.metaDescription);
  });
  it('renameBlog preserves the handle (sends title only) so the indexed URL survives', async () => {
    let vars: any = {};
    const admin: AdminGraphql = (async (_q: string, v?: any) => {
      vars = v;
      return { blogUpdate: { blog: { id: 'gid://blog/1', handle: 'news', title: 'Pet Care Guides' }, userErrors: [] } };
    }) as unknown as AdminGraphql;
    const b = await renameBlog(admin, 'gid://blog/1', 'Pet Care Guides');
    expect(b.handle).toBe('news');
    expect(vars.blog).toEqual({ title: 'Pet Care Guides' }); // no handle sent -> not changed
  });
  it('createDraftArticle throws on a userError', async () => {
    const admin: AdminGraphql = (async () => ({ articleCreate: { article: null, userErrors: [{ message: 'nope' }] } })) as unknown as AdminGraphql;
    await expect(createDraftArticle(admin, { blogId: 'b', draft: GOOD_DRAFT, authorName: 'Active Paw' })).rejects.toThrow(/nope/);
  });
  it('findBlog matches by handle', async () => {
    const admin: AdminGraphql = (async () => ({ blogs: { nodes: [{ id: 'gid://blog/9', handle: 'news', title: 'News' }] } })) as unknown as AdminGraphql;
    expect((await findBlog(admin, 'news'))?.id).toBe('gid://blog/9');
    expect(await findBlog(admin, 'missing')).toBeNull();
  });
});

describe('blog shop-block selection', () => {
  const P = (handle: string, available: boolean, imageUrl?: string) =>
    ({ title: handle[0].toUpperCase() + handle.slice(1), handle, path: `/products/${handle}`, priceGbp: 1, available, imageUrl });

  it('extractProductHandles pulls product handles in order, deduped, ignoring collections', () => {
    const html =
      '<a href="/products/alpha">a</a> <a href="/collections/pet-health">c</a> ' +
      '<a href="https://shop.example/products/beta?variant=9">b</a> <a href="/products/alpha">dup</a>';
    expect(extractProductHandles(html)).toEqual(['alpha', 'beta']);
    expect(extractProductHandles('<p>no links</p>')).toEqual([]);
  });

  it('puts linked+available products first, tops up to 4, skips unavailable, picks first image as hero', () => {
    const pack: FactPack = {
      collectionHandle: 'c', collectionTitle: 'C', collectionPath: '/collections/c',
      products: [
        P('alpha', true, 'https://img/alpha.jpg'),
        P('beta', true),
        P('gamma', true, 'https://img/gamma.jpg'),
        P('delta', true, 'https://img/delta.jpg'),
        P('epsilon', true, 'https://img/epsilon.jpg'),
        P('zeta', false, 'https://img/zeta.jpg')  // linked below, but unavailable
      ]
    };
    const body = '<a href="/products/gamma">g</a> <a href="/products/zeta">z</a>';
    const sel = selectShopBlock(pack, body);
    expect(sel.handles.length).toBe(4);
    expect(sel.handles[0]).toBe('gamma');            // linked + available leads
    expect(sel.handles).not.toContain('zeta');        // unavailable dropped even though linked
    expect(sel.heroImageUrl).toBe('https://img/gamma.jpg');
    expect(sel.heroSourceHandle).toBe('gamma');
  });

  it('with no body links, uses pack order and the first product that has an image as hero', () => {
    const pack: FactPack = {
      collectionHandle: 'c', collectionTitle: 'C', collectionPath: '/collections/c',
      products: [P('noimg', true), P('hasimg', true, 'https://img/h.jpg')]
    };
    const sel = selectShopBlock(pack, '<p>no links</p>');
    expect(sel.handles).toEqual(['noimg', 'hasimg']);
    expect(sel.heroImageUrl).toBe('https://img/h.jpg'); // first pick WITH an image
    expect(sel.heroSourceHandle).toBe('hasimg');
  });

  const PD = (handle: string, url: string, w: number, h: number) =>
    ({ title: handle, handle, path: `/products/${handle}`, priceGbp: 1, available: true, imageUrl: url, imageWidth: w, imageHeight: h });

  it('hero prefers a >=1200 square image over an earlier smaller one, without reordering the block', () => {
    const pack: FactPack = {
      collectionHandle: 'c', collectionTitle: 'C', collectionPath: '/collections/c',
      products: [PD('small', 'https://img/s.jpg', 1000, 1000), PD('big', 'https://img/b.jpg', 1500, 1500)]
    };
    const sel = selectShopBlock(pack, '<a href="/products/small">s</a>'); // small linked -> leads the block
    expect(sel.handles[0]).toBe('small');          // congruence order unchanged
    expect(sel.heroSourceHandle).toBe('big');       // hero still prefers the >=1200 source
    expect(sel.heroIsHighRes).toBe(true);
  });

  it('hero falls back to the first image and flags not-high-res when nothing reaches 1200', () => {
    const pack: FactPack = {
      collectionHandle: 'c', collectionTitle: 'C', collectionPath: '/collections/c',
      products: [PD('a', 'https://img/a.jpg', 1000, 1000), PD('b', 'https://img/b.jpg', 800, 800)]
    };
    const sel = selectShopBlock(pack, '<p>no links</p>');
    expect(sel.heroSourceHandle).toBe('a'); // first with an image
    expect(sel.heroIsHighRes).toBe(false);
  });
});

describe('blog article asset writes', () => {
  it('createDraftArticle adds the blog.related_products list metafield + image when given', async () => {
    let vars: any = {};
    const admin: AdminGraphql = (async (_q: string, v?: any) => {
      vars = v;
      return { articleCreate: { article: { id: 'gid://shopify/Article/2', handle: 'h', title: GOOD_DRAFT.title, isPublished: false }, userErrors: [] } };
    }) as unknown as AdminGraphql;
    await createDraftArticle(admin, { blogId: 'b', draft: GOOD_DRAFT, authorName: 'Active Paw', imageUrl: 'https://img/x.jpg', imageAlt: 'alt', relatedHandles: ['alpha', 'beta'] });
    const mf = (vars.article.metafields as any[]).find((m) => m.namespace === 'blog' && m.key === 'related_products');
    expect(mf.type).toBe('list.single_line_text_field');
    expect(JSON.parse(mf.value)).toEqual(['alpha', 'beta']);
    expect(vars.article.image).toEqual({ url: 'https://img/x.jpg', altText: 'alt' });
  });

  it('createDraftArticle omits the related metafield when no handles are given', async () => {
    let vars: any = {};
    const admin: AdminGraphql = (async (_q: string, v?: any) => {
      vars = v;
      return { articleCreate: { article: { id: 'gid://shopify/Article/3', handle: 'h', title: GOOD_DRAFT.title, isPublished: false }, userErrors: [] } };
    }) as unknown as AdminGraphql;
    await createDraftArticle(admin, { blogId: 'b', draft: GOOD_DRAFT, authorName: 'Active Paw' });
    expect((vars.article.metafields as any[]).some((m) => m.key === 'related_products')).toBe(false);
  });

  it('updateArticleAssets sends the metafield + image, and throws on userErrors', async () => {
    let vars: any = {};
    const ok: AdminGraphql = (async (_q: string, v?: any) => {
      vars = v; return { articleUpdate: { article: { id: 'a', handle: 'h' }, userErrors: [] } };
    }) as unknown as AdminGraphql;
    await updateArticleAssets(ok, { articleId: 'gid://shopify/Article/2', relatedHandles: ['a', 'b'], imageUrl: 'https://img/x.jpg', imageAlt: 'alt' });
    expect(JSON.parse((vars.article.metafields as any[])[0].value)).toEqual(['a', 'b']);
    expect(vars.article.image).toEqual({ url: 'https://img/x.jpg', altText: 'alt' });

    const bad: AdminGraphql = (async () => ({ articleUpdate: { userErrors: [{ message: 'boom' }] } })) as unknown as AdminGraphql;
    await expect(updateArticleAssets(bad, { articleId: 'a', relatedHandles: ['x'] })).rejects.toThrow(/boom/);
  });
});

describe('blog topic suggestions + brief passthrough', () => {
  const mkPack = (handle: string, title: string, n: number): FactPack => ({
    collectionHandle: handle, collectionTitle: title, collectionPath: `/collections/${handle}`,
    products: Array.from({ length: n }, (_, i): GroundedProduct =>
      ({ title: `${handle}-p${i}`, handle: `${handle}-p${i}`, path: `/products/${handle}-p${i}`, priceGbp: 9.99, available: true }))
  });
  const topic = (title: string, h: string) => ({ title, angle: 'a', targetKeyword: 'k', collectionHandle: h, whyNow: 'w', keyPoints: ['a', 'b', 'c'] });

  it('proposeTopics returns validated candidates, drops a hallucinated collection, and carries live counts', async () => {
    const packs = [mkPack('pet-health', 'Pet Health', 4), mkPack('pet-toys', 'Pet Toys', 5)];
    const llm = fakeLlm([{ topics: [
      topic('Hydration guide', 'pet-health'),
      topic('Boredom busters', 'pet-toys'),
      topic('Ghost topic', 'not-real')   // dropped: collection is not in the gated set
    ] }]);
    const cands = await proposeTopics(llm, STORE, CFG, { packs, season: 'summer' });
    expect(cands.length).toBe(2);
    expect(cands.map((c) => c.brief.collectionHandle).sort()).toEqual(['pet-health', 'pet-toys']);
    expect(cands.find((c) => c.brief.collectionHandle === 'not-real')).toBeUndefined();
    expect(cands.find((c) => c.brief.collectionHandle === 'pet-toys')!.liveProductCount).toBe(5);
    expect(cands[0].brief.keyPoints.length).toBeGreaterThanOrEqual(3); // a full brief, not just a title
  });

  it('proposeTopics caps repeats per collection so the list is diverse', async () => {
    const packs = [mkPack('pet-health', 'Pet Health', 4), mkPack('pet-toys', 'Pet Toys', 4)];
    const llm = fakeLlm([{ topics: [
      topic('H1', 'pet-health'), topic('H2', 'pet-health'), topic('H3', 'pet-health'),
      topic('H4', 'pet-health'), topic('T1', 'pet-toys')
    ] }]);
    const cands = await proposeTopics(llm, STORE, CFG, { packs, season: 'summer', count: 5 });
    expect(cands.filter((c) => c.brief.collectionHandle === 'pet-health').length).toBeLessThanOrEqual(3); // ceil(5/2)
    expect(cands.some((c) => c.brief.collectionHandle === 'pet-toys')).toBe(true);
  });

  it('resolvePipelineBrief reuses a valid picked brief and rejects undefined or a stale collection', () => {
    const brief: BlogBrief = { title: 'Winter paw care basics', angle: 'a', targetKeyword: 'k', collectionHandle: 'pet-health', whyNow: 'w', keyPoints: ['x', 'y', 'z'] };
    expect(resolvePipelineBrief(brief, ['pet-health', 'pet-toys'])).toEqual(brief); // written as-is, no re-research
    expect(resolvePipelineBrief(undefined, ['pet-health'])).toBeNull();             // -> pipeline researches
    expect(resolvePipelineBrief({ ...brief, collectionHandle: 'ghost' }, ['pet-health'])).toBeNull(); // stale/tampered rejected
  });
});

describe('blog research + draft agents (LLM-backed)', () => {
  it('seasonForMonth maps months to seasons', () => {
    expect(seasonForMonth(0)).toBe('winter');
    expect(seasonForMonth(3)).toBe('spring');
    expect(seasonForMonth(6)).toBe('summer');
    expect(seasonForMonth(9)).toBe('autumn');
  });
  it('proposeBrief rejects a hallucinated collection and accepts a real one', async () => {
    const bad = fakeLlm([{ title: 'X guide', angle: 'a', targetKeyword: 'k', collectionHandle: 'not-real', whyNow: 'w', keyPoints: ['a', 'b', 'c'] }]);
    expect(await proposeBrief(bad, STORE, CFG, { validHandles: ['pet-health'], season: 'summer' })).toBeNull();
    const good = fakeLlm([{ title: 'Cat water guide', angle: 'help cats drink', targetKeyword: 'cat hydration', collectionHandle: 'pet-health', whyNow: 'evergreen', keyPoints: ['why', 'signs', 'fixes'] }]);
    const brief = await proposeBrief(good, STORE, CFG, { validHandles: ['pet-health'], season: 'summer' });
    expect(brief?.collectionHandle).toBe('pet-health');
  });
  it('draftArticle sanitises em-dashes and returns a clean draft', async () => {
    const withDash = { ...GOOD_DRAFT, bodyHtml: GOOD_BODY + '<p>a line with an em-dash — right here.</p>' };
    const llm = fakeLlm([withDash]);
    const pack: FactPack = { collectionHandle: 'pet-health', collectionTitle: 'Pet Health', collectionPath: '/collections/pet-health', products: [{ title: 'Fountain', handle: 'fountain', path: '/products/fountain', priceGbp: 47.99, available: true }] };
    const brief = { title: GOOD_DRAFT.title, angle: 'a', targetKeyword: 'k', collectionHandle: 'pet-health', whyNow: 'w', keyPoints: ['a', 'b', 'c'] };
    const draft = await draftArticle(llm, STORE, CFG, brief, pack);
    expect(draft).not.toBeNull();
    expect(draft!.bodyHtml).not.toContain('—'); // em-dash stripped
    expect(draft!.tag).toBe('pet-health');
  });
  it('sanitizeBlogHtml strips em/en dashes', () => {
    expect(sanitizeBlogHtml('a — b – c')).toBe('a - b - c');
  });
});
