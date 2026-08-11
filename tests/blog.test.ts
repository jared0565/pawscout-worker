import { describe, it, expect } from 'vitest';
import {
  findBlogIssues, findClaimFlags, hasStorefrontLink, htmlToText, countWords, refineBlogUntilClean, quickAnswerText
} from '../src/blog/quality';
import { factPackToPrompt, groundCollection } from '../src/blog/ground';
import { sanitizeBlogHtml, draftArticle, validateFaq } from '../src/blog/draft';
import { createDraftArticle, renameBlog, findBlog, updateArticleAssets, getPublishedMap } from '../src/blog/article';
import { extractProductHandles, selectShopBlock, pickHeroFields } from '../src/blog/select';
import { pickComboHandles, availableByHandle } from '../src/blog/combo';
import { pickBlogHeroImage, getProductImages } from '../src/blog/hero';
import { proposeBrief, proposeTopics, seasonForMonth, publishWindow, validateDemandSignals, validateSourcedFacts, collectSourcedFacts } from '../src/blog/research';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
import { isApprovedSourceUrl, scrubExternalLinks, approvedSourcesPromptLine } from '../src/blog/sources';
import { resolvePipelineBrief } from '../src/blog/pipeline';
import { LlmClient } from '../src/llm';
import type { AdminGraphql } from '../src/shopify-admin';
import type { BlogBrief, BlogDraft, FactPack, GroundedProduct } from '../src/blog/types';

const CFG: any = { llm: { models: {} } };
const CFG_LLM_ON: any = { llm: { enabled: true, models: {} } };
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

// Opens the body: a standalone 49-word quick answer (the AI-citation gate wants
// one 25-80 word <p> before the first <h2>).
const QUICK_ANSWER =
  '<p>Cats drink too little because still water bores them, bowls sit in busy spots, and whisker fatigue makes narrow dishes unpleasant. ' +
  'Move water away from food, offer a wide fresh bowl daily, and consider a quiet fountain. ' +
  'Most cats drink noticeably more within a week of these small changes.</p>';

const GOOD_BODY =
  QUICK_ANSWER +
  '<h2>First section</h2><p>Genuinely useful guidance that sets up the guide for the reader in a warm way. ' +
  Array.from({ length: 60 }, (_, i) => `helpful sentence ${i} about caring for your pet at home.`).join(' ') +
  ' More real content here that helps the owner decide, linking to ' +
  '<a href="/products/2-2l-automatic-pet-water-fountain">the fountain</a> naturally.</p>' +
  '<h2>Second section</h2><p>Closing advice and a nudge to <a href="/collections/pet-health">Pet Health</a>.</p>';

const GOOD_FAQ = [
  { q: 'How much water should a cat drink each day?', a: 'A healthy cat needs roughly fifty millilitres per kilo of body weight daily, and wet food supplies part of that. Offer fresh water in a wide bowl away from food, and speak to your vet if drinking suddenly changes, because a sharp shift can matter.' },
  { q: 'Do water fountains really help cats drink more?', a: 'Many cats prefer moving water because it reads as fresher, so a quiet fountain often nudges reluctant drinkers to visit more. Keep it clean weekly, place it away from the litter tray, and keep one still-water bowl available so your cat always has a choice it likes.' },
  { q: 'Where should I put my cat\'s water bowl?', a: 'Pick a calm spot away from food, litter and busy walkways. Cats dislike drinking where they eat, and many prefer a couple of stations around the home. A wide, shallow bowl avoids whisker fatigue, and refreshing the water daily keeps the station genuinely inviting.' }
];

const GOOD_DRAFT: BlogDraft = {
  title: 'Why won\'t my cat drink enough water?',
  bodyHtml: GOOD_BODY,
  excerpt: 'Cats are famously reluctant drinkers. Here is why, and how to help at home.',
  metaTitle: 'Why won\'t my cat drink enough water?',
  metaDescription: 'Cats are famously reluctant drinkers. Here is why it happens and simple ways to help your cat stay hydrated.',
  tag: 'pet-health',
  faq: GOOD_FAQ
};

describe('blog quality gate', () => {
  it('passes a well-formed draft', () => {
    expect(findBlogIssues(GOOD_DRAFT)).toEqual([]);
  });
  it('flags a too-short draft, a missing product link, no headings, a bad meta description, and no FAQ', () => {
    const bad: BlogDraft = { title: 'Too thin', bodyHtml: '<p>Short.</p>', excerpt: '', metaTitle: 'x', metaDescription: 'short', tag: 'pet-health' };
    const issues = findBlogIssues(bad).join(' | ');
    expect(issues).toMatch(/too short/i);
    expect(issues).toMatch(/no section headings/i);
    expect(issues).toMatch(/does not link to any real product/i);
    expect(issues).toMatch(/meta description/i);
    expect(issues).toMatch(/excerpt/i);
    expect(issues).toMatch(/quick answer/i);
    expect(issues).toMatch(/"faq"/);
  });
  it('quick-answer gate: flags a rambling opening paragraph and an <h2>-first body, passes a standalone 25-80 word opener', () => {
    const ramble = { ...GOOD_DRAFT, bodyHtml: GOOD_BODY.replace(QUICK_ANSWER, '<p>' + Array.from({ length: 40 }, () => 'many words that never answer anything directly').join(' ') + '</p>') };
    expect(findBlogIssues(ramble).join(' ')).toMatch(/quick answer/i);
    const h2First = { ...GOOD_DRAFT, bodyHtml: GOOD_BODY.replace(QUICK_ANSWER, '') };
    expect(findBlogIssues(h2First).join(' ')).toMatch(/quick answer/i);
    expect(findBlogIssues(GOOD_DRAFT)).toEqual([]); // the 49-word opener passes
  });
  it('quickAnswerText extracts only a <p> that appears before the first <h2>', () => {
    expect(quickAnswerText('<p>answer here</p><h2>s</h2>')).toBe('answer here');
    expect(quickAnswerText('<h2>s</h2><p>too late</p>')).toBe('');
    expect(quickAnswerText('no paragraphs')).toBe('');
  });
  it('faq gate: fewer than 3 entries is an issue, 3 clears it', () => {
    expect(findBlogIssues({ ...GOOD_DRAFT, faq: GOOD_FAQ.slice(0, 2) }).join(' ')).toMatch(/"faq"/);
    expect(findBlogIssues({ ...GOOD_DRAFT, faq: undefined }).join(' ')).toMatch(/"faq"/);
    expect(findBlogIssues(GOOD_DRAFT)).toEqual([]);
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
  it('renameBlog migrates the handle when one is passed (news -> guides)', async () => {
    let vars: any = {};
    const admin: AdminGraphql = (async (_q: string, v?: any) => {
      vars = v;
      return { blogUpdate: { blog: { id: 'gid://blog/1', handle: 'guides', title: 'Pet Care Guides' }, userErrors: [] } };
    }) as unknown as AdminGraphql;
    const b = await renameBlog(admin, 'gid://blog/1', 'Pet Care Guides', 'guides');
    expect(b.handle).toBe('guides');
    expect(vars.blog).toEqual({ title: 'Pet Care Guides', handle: 'guides' }); // handle migrated
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

  it('hero congruence outranks resolution: a linked 1000px subject beats an unlinked 1500px top-up (the water-bowl-on-a-beds-post defect)', () => {
    const pack: FactPack = {
      collectionHandle: 'c', collectionTitle: 'C', collectionPath: '/collections/c',
      products: [PD('small', 'https://img/s.jpg', 1000, 1000), PD('big', 'https://img/b.jpg', 1500, 1500)]
    };
    const sel = selectShopBlock(pack, '<a href="/products/small">s</a>'); // small linked -> the article's subject
    expect(sel.handles[0]).toBe('small');
    expect(sel.heroSourceHandle).toBe('small');   // the subject supplies the hero
    expect(sel.heroIsHighRes).toBe(false);        // trade-off surfaced, not hidden
  });

  it('hero resolution may still choose AMONG the linked prefix (all writer-chosen, all congruent)', () => {
    const pack: FactPack = {
      collectionHandle: 'c', collectionTitle: 'C', collectionPath: '/collections/c',
      products: [PD('small', 'https://img/s.jpg', 1000, 1000), PD('big', 'https://img/b.jpg', 1500, 1500)]
    };
    const sel = selectShopBlock(pack, '<a href="/products/small">s</a> <a href="/products/big">b</a>'); // BOTH linked
    expect(sel.handles.slice(0, 2)).toEqual(['small', 'big']);
    expect(sel.heroSourceHandle).toBe('big');     // high-res wins within the congruent prefix
    expect(sel.heroIsHighRes).toBe(true);
  });

  it('pickHeroFields with linkedCount: top-up images are used only when no linked product has ANY image', () => {
    const byHandle = new Map([
      ['noimg', { title: 'NoImg', handle: 'noimg', path: '/products/noimg', priceGbp: 1, available: true }],
      ['topup', PD('topup', 'https://img/t.jpg', 1600, 1600)]
    ] as [string, GroundedProduct][]);
    const hero = pickHeroFields(byHandle, ['noimg', 'topup'], 1); // linked prefix has no image
    expect(hero.heroSourceHandle).toBe('topup');  // fallback to the top-up region, in order
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

describe('blog hero image (vision, lifestyle-preferring)', () => {
  const CFG_ON: any = { llm: { enabled: true, models: {} } };
  const IMGS = [
    { url: 'https://img/white-bg.jpg', width: 1500, height: 1500 },   // clean product on white
    { url: 'https://img/dog-using-it.jpg', width: 1000, height: 1000 } // pet with product (smaller)
  ];

  const TITLES = { articleTitle: 'How to dry your dog fast after walks', productTitle: 'Dog drying towel' };

  it('returns the vision-chosen frame even when it is smaller than a product shot', async () => {
    const llm = fakeLlm([{ index: 1, reason: 'dog using product' }]);
    expect(await pickBlogHeroImage(llm, STORE, CFG_ON, TITLES, IMGS)).toEqual(IMGS[1]);
  });

  it('with 0-1 images returns the only image (or null) without consulting the model', async () => {
    const llm = fakeLlm([{ index: 9 }]); // invalid, but must not be consulted
    expect(await pickBlogHeroImage(llm, STORE, CFG_ON, TITLES, [IMGS[0]])).toEqual(IMGS[0]);
    expect(await pickBlogHeroImage(llm, STORE, CFG_ON, TITLES, [])).toBeNull();
  });

  it('returns null on an out-of-range index so the caller falls back to the featured image', async () => {
    const llm = fakeLlm([{ index: 5 }]);
    expect(await pickBlogHeroImage(llm, STORE, CFG_ON, TITLES, IMGS)).toBeNull();
  });

  it('honours a -1 rejection: nothing in the gallery fits the article -> null (featured image stands)', async () => {
    const llm = fakeLlm([{ index: -1, reason: 'gallery is a different product' }]);
    expect(await pickBlogHeroImage(llm, STORE, CFG_ON, TITLES, IMGS)).toBeNull();
  });

  it('getProductImages maps url + dimensions and tolerates an admin error', async () => {
    const admin: AdminGraphql = (async () => ({ products: { nodes: [{ images: { nodes: [
      { url: 'https://img/a.jpg', width: 1200, height: 1200 }, { url: 'https://img/b.jpg', width: 800, height: 800 }
    ] } }] } })) as unknown as AdminGraphql;
    expect(await getProductImages(admin, 'x')).toEqual([
      { url: 'https://img/a.jpg', width: 1200, height: 1200 }, { url: 'https://img/b.jpg', width: 800, height: 800 }
    ]);
    const bad: AdminGraphql = (async () => { throw new Error('boom'); }) as unknown as AdminGraphql;
    expect(await getProductImages(bad, 'x')).toEqual([]);
  });
});

describe('blog topic suggestions + brief passthrough', () => {
  const mkPack = (handle: string, title: string, n: number): FactPack => ({
    collectionHandle: handle, collectionTitle: title, collectionPath: `/collections/${handle}`,
    products: Array.from({ length: n }, (_, i): GroundedProduct =>
      ({ title: `${handle}-p${i}`, handle: `${handle}-p${i}`, path: `/products/${handle}-p${i}`, priceGbp: 9.99, available: true }))
  });
  const topic = (title: string, h: string) => ({ title, angle: 'a', targetKeyword: 'k', collectionHandle: h, whyNow: 'w', keyPoints: ['a', 'b', 'c'] });
  // proposeTopics now runs TWO calls: demand research, then topic generation.
  // fakeLlm replays its LAST entry once the queue drains, so a single-entry
  // queue answers both and the demand pass simply finds no `signals` key.
  const WINDOW = { season: 'autumn', months: ['September', 'October', 'November'] };
  const signalsPayload = (sigs: unknown[]) => ({ signals: sigs });

  it('proposeTopics returns validated candidates, drops a hallucinated collection, and carries live counts', async () => {
    const packs = [mkPack('pet-health', 'Pet Health', 4), mkPack('pet-toys', 'Pet Toys', 5)];
    const llm = fakeLlm([{ topics: [
      topic('Hydration guide', 'pet-health'),
      topic('Boredom busters', 'pet-toys'),
      topic('Ghost topic', 'not-real')   // dropped: collection is not in the gated set
    ] }]);
    const { candidates: cands } = await proposeTopics(llm, STORE, CFG, { packs, window: WINDOW });
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
    const { candidates: cands } = await proposeTopics(llm, STORE, CFG, { packs, window: WINDOW, count: 5 });
    expect(cands.filter((c) => c.brief.collectionHandle === 'pet-health').length).toBeLessThanOrEqual(3); // ceil(5/2)
    expect(cands.some((c) => c.brief.collectionHandle === 'pet-toys')).toBe(true);
  });

  // The regression the owner reported on 2026-08-11: suggestions had silently
  // stopped being demand-researched and were coming back as seasonal filler,
  // with nothing in the response to distinguish that from a researched run.
  it('proposeTopics reports demand as grounded and carries the researched term through', async () => {
    const packs = [mkPack('pet-health', 'Pet Health', 4), mkPack('pet-toys', 'Pet Toys', 4)];
    const llm = fakeLlm([
      signalsPayload([
        { term: 'dog joint supplements', collectionHandle: 'pet-health', why: 'rising UK interest into autumn', sourceName: 'Trade press', sourceUrl: 'https://example.org/pet-trends' },
        { term: 'indoor enrichment toys', collectionHandle: 'pet-toys', why: 'darker evenings drive indoor play' }
      ]),
      { topics: [
        { ...topic('Joint care guide', 'pet-health'), demandTerm: 'dog joint supplements' },
        { ...topic('Indoor play ideas', 'pet-toys'), demandTerm: 'indoor enrichment toys' }
      ] }
    ]);
    const { candidates, demand } = await proposeTopics(llm, STORE, CFG, { packs, window: WINDOW });
    expect(demand.grounded).toBe(true);
    expect(demand.signals.map((s) => s.term)).toEqual(['dog joint supplements', 'indoor enrichment toys']);
    expect(demand.signals[0].sourceUrl).toBe('https://example.org/pet-trends');
    expect(candidates.find((c) => c.brief.collectionHandle === 'pet-health')!.demandTerm).toBe('dog joint supplements');
    expect(demand.note).toContain('September');
  });

  it('proposeTopics still returns topics when demand research finds nothing, but says so', async () => {
    const packs = [mkPack('pet-health', 'Pet Health', 4)];
    const llm = fakeLlm([{ topics: [topic('Evergreen hydration guide', 'pet-health')] }]);
    const { candidates, demand } = await proposeTopics(llm, STORE, CFG, { packs, window: WINDOW });
    expect(candidates.length).toBe(1);
    expect(demand.grounded).toBe(false);       // degraded, and it admits it
    expect(demand.signals).toEqual([]);
    expect(demand.note).toMatch(/unavailable/i);
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
  // The bug the owner reported: on 11 August the topic chooser was told
  // "summer" and proposed summer topics, for a guide nobody reads until autumn.
  // publishWindow LEADS the calendar so the suggestions are for the months the
  // piece is actually read in.
  it('publishWindow leads the calendar instead of describing today', () => {
    expect(publishWindow(7)).toEqual({ season: 'autumn', months: ['September', 'October', 'November'] });
    expect(publishWindow(11)).toEqual({ season: 'winter', months: ['January', 'February', 'March'] });
    expect(publishWindow(0)).toEqual({ season: 'spring', months: ['February', 'March', 'April'] });
    // never anchors to the month it is called in
    for (let m = 0; m < 12; m++) expect(publishWindow(m).months[0]).not.toBe(MONTHS[m]);
  });
  it('validateDemandSignals keeps only stocked collections and real http sources', () => {
    const out = validateDemandSignals({ signals: [
      { term: 'joint supplements', collectionHandle: 'pet-health', why: 'w', sourceUrl: 'https://example.org/a', sourceName: 'Src' },
      { term: 'aquarium filters', collectionHandle: 'pet-fish', why: 'w' },              // dropped: we do not stock it
      { term: 'joint supplements', collectionHandle: 'pet-health', why: 'dupe' },        // dropped: duplicate term
      { term: 'nail clippers', collectionHandle: 'pet-health', why: 'w', sourceUrl: 'javascript:alert(1)' } // scheme rejected
    ] }, ['pet-health']);
    expect(out!.map((s) => s.term)).toEqual(['joint supplements', 'nail clippers']);
    expect(out![0].sourceUrl).toBe('https://example.org/a');
    expect(out![1].sourceUrl).toBeUndefined();   // the console renders this into an href
    expect(validateDemandSignals({ signals: [] }, ['pet-health'])).toBeNull();
  });
  it('proposeBrief rejects a hallucinated collection and accepts a real one', async () => {
    const w = { season: 'autumn', months: ['September', 'October', 'November'] };
    const bad = fakeLlm([{ title: 'X guide', angle: 'a', targetKeyword: 'k', collectionHandle: 'not-real', whyNow: 'w', keyPoints: ['a', 'b', 'c'] }]);
    expect(await proposeBrief(bad, STORE, CFG, { validHandles: ['pet-health'], window: w })).toBeNull();
    const good = fakeLlm([{ title: 'Cat water guide', angle: 'help cats drink', targetKeyword: 'cat hydration', collectionHandle: 'pet-health', whyNow: 'evergreen', keyPoints: ['why', 'signs', 'fixes'] }]);
    const brief = await proposeBrief(good, STORE, CFG, { validHandles: ['pet-health'], window: w });
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

describe('combo merchandiser (congruent cross-catalog shop block)', () => {
  const mkPack = (handle: string, title: string, products: [string, string][]): FactPack => ({
    collectionHandle: handle, collectionTitle: title, collectionPath: `/collections/${handle}`,
    products: products.map(([h, t]): GroundedProduct =>
      ({ title: t, handle: h, path: `/products/${h}`, priceGbp: 9.99, available: true, imageUrl: `https://img/${h}.jpg`, imageWidth: 1400, imageHeight: 1400 }))
  });
  const HEALTH = mkPack('pet-health', 'Pet Health', [['fountain', 'Cat Water Fountain'], ['scale', 'Digital Pet Scale'], ['ramp', 'Folding Dog Ramp']]);
  const ACCESSORIES = mkPack('pet-accessories', 'Pet Accessories', [['cooling-mat', 'Pet Cooling Mat'], ['crate', 'Dog Crate']]);
  const ARTICLE = { title: 'Keep your cat cool this summer', angle: 'hydration and cooling', bodyHtml: '<p>Use a <a href="/products/fountain">fountain</a> for fresh water.</p>' };

  it('availableByHandle merges packs, keeps only available, dedupes by handle', () => {
    const dupe = mkPack('x', 'X', [['fountain', 'Duplicate Fountain']]);
    const unavailable: FactPack = { ...mkPack('y', 'Y', [['ghost', 'Ghost']]), products: [{ title: 'Ghost', handle: 'ghost', path: '/products/ghost', priceGbp: 1, available: false }] };
    const map = availableByHandle([HEALTH, dupe, unavailable]);
    expect(map.get('fountain')!.title).toBe('Cat Water Fountain'); // first pack wins
    expect(map.get('fountain')!.collectionTitle).toBe('Pet Health');
    expect(map.has('ghost')).toBe(false);
  });

  it('keeps body-linked products first and appends only VALIDATED congruent picks (hallucinations dropped)', async () => {
    const llm = fakeLlm([{ handles: ['cooling-mat', 'invented-product'] }]);
    const sel = await pickComboHandles(llm, STORE, CFG_LLM_ON, { article: ARTICLE, packs: [HEALTH, ACCESSORIES], linkedHandles: ['fountain'] });
    expect(sel).toEqual({ handles: ['fountain', 'cooling-mat'], linkedCount: 1 }); // linked leads; hallucination dropped; scale/ramp NOT blind-padded
  });

  it('an empty top-up is a valid outcome (fewer congruent picks beat off-topic padding)', async () => {
    const llm = fakeLlm([{ handles: [] }]);
    expect(await pickComboHandles(llm, STORE, CFG_LLM_ON, { article: ARTICLE, packs: [HEALTH], linkedHandles: ['fountain'] }))
      .toEqual({ handles: ['fountain'], linkedCount: 1 });
  });

  it('falls back to linked-only on an invalid LLM payload, and to null when nothing was linked either', async () => {
    const bad = fakeLlm([{ nope: true }]);
    expect(await pickComboHandles(bad, STORE, CFG_LLM_ON, { article: ARTICLE, packs: [HEALTH], linkedHandles: ['fountain'] }))
      .toEqual({ handles: ['fountain'], linkedCount: 1 });
    const badAgain = fakeLlm([{ nope: true }]);
    expect(await pickComboHandles(badAgain, STORE, CFG_LLM_ON, { article: ARTICLE, packs: [HEALTH], linkedHandles: [] }))
      .toBeNull(); // caller keeps its deterministic selection
  });

  it('LLM disabled in config -> linked-only without consulting the model', async () => {
    const llm = fakeLlm([{ handles: ['cooling-mat'] }]); // must not be used
    expect(await pickComboHandles(llm, STORE, CFG, { article: ARTICLE, packs: [HEALTH, ACCESSORIES], linkedHandles: ['fountain'] }))
      .toEqual({ handles: ['fountain'], linkedCount: 1 });
  });

  it('four linked products fill the block deterministically, no LLM call needed', async () => {
    const big = mkPack('c', 'C', [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D'], ['e', 'E']]);
    const llm = fakeLlm([{ handles: ['e'] }]); // would be wrong if consulted
    expect(await pickComboHandles(llm, STORE, CFG_LLM_ON, { article: ARTICLE, packs: [big], linkedHandles: ['a', 'b', 'c', 'd', 'e'] }))
      .toEqual({ handles: ['a', 'b', 'c', 'd'], linkedCount: 4 });
  });

  it('pickHeroFields follows the FINAL handle set (a cross-collection pick can supply the hero)', () => {
    const map = availableByHandle([HEALTH, ACCESSORIES]);
    const hero = pickHeroFields(map, ['cooling-mat', 'fountain']);
    expect(hero.heroSourceHandle).toBe('cooling-mat'); // first pick with a >=1200 square image
    expect(hero.heroIsHighRes).toBe(true);
  });
});

describe('blog FAQ (drafter output -> metafield -> theme)', () => {
  it('validateFaq strips HTML, trims, caps at 5, drops malformed entries', () => {
    const faq = validateFaq([
      { q: '<strong>How often?</strong>', a: '<p>Twice a day is plenty.</p>' },
      { q: 'no answer' },
      { q: 'Q2', a: 'A2' }, { q: 'Q3', a: 'A3' }, { q: 'Q4', a: 'A4' }, { q: 'Q5', a: 'A5' }, { q: 'Q6', a: 'A6' }
    ]);
    expect(faq.length).toBe(5);
    expect(faq[0]).toEqual({ q: 'How often?', a: 'Twice a day is plenty.' });
    expect(validateFaq('not an array' as any)).toEqual([]);
  });

  it('createDraftArticle writes blog.faq_json when the draft carries a FAQ, omits it when absent', async () => {
    let vars: any = {};
    const admin: AdminGraphql = (async (_q: string, v?: any) => {
      vars = v;
      return { articleCreate: { article: { id: 'gid://shopify/Article/9', handle: 'h', title: GOOD_DRAFT.title, isPublished: false }, userErrors: [] } };
    }) as unknown as AdminGraphql;
    await createDraftArticle(admin, { blogId: 'b', draft: GOOD_DRAFT, authorName: 'Active Paw' });
    const mf = (vars.article.metafields as any[]).find((m) => m.key === 'faq_json');
    expect(mf.namespace).toBe('blog');
    expect(mf.type).toBe('json');
    expect(JSON.parse(mf.value)).toEqual(GOOD_FAQ);

    await createDraftArticle(admin, { blogId: 'b', draft: { ...GOOD_DRAFT, faq: [] }, authorName: 'Active Paw' });
    expect((vars.article.metafields as any[]).some((m) => m.key === 'faq_json')).toBe(false);
  });
});

describe('sourced facts (web research the drafter may cite)', () => {
  // 2026-07-27 policy change: there are NO approved external sources. The old
  // allowlist admitted cats.org.uk and bluecross.org.uk as "non-commercial"
  // while both run online shops selling competing products, so the whole
  // category is gone rather than the two domains that were caught.
  it('drops EVERY external fact now that no source is approved, including the old charities', () => {
    const facts = validateSourcedFacts({ facts: [
      { fact: 'Cats need about 50ml of water per kg daily', sourceUrl: 'https://icatcare.org/hydration', sourceName: 'International Cat Care' },
      { fact: 'no source', sourceUrl: 'from memory', sourceName: 'X' },
      { fact: 'self cite', sourceUrl: 'https://activepaw.co.uk/blogs/guides/x', sourceName: 'Active Paw' },
      { fact: 'f3', sourceUrl: 'https://rspca.org.uk/a', sourceName: 'RSPCA' },
      { fact: 'shop-running charity', sourceUrl: 'https://cats.org.uk/c', sourceName: 'Cats Protection' },
      { fact: 'shop-running charity', sourceUrl: 'https://bluecross.org.uk/c', sourceName: 'Blue Cross' }
    ] });
    expect(facts).toEqual([]);
    expect(validateSourcedFacts({})).toBeNull();
  });

  it('collectSourcedFacts returns [] for any payload: the drafter is now fully hermetic', async () => {
    const bad = fakeLlm([{ nope: 1 }]);
    expect(await collectSourcedFacts(bad, STORE, CFG, { title: 't', angle: 'a', keyPoints: ['k'] })).toEqual([]);
    const formerlyApproved = fakeLlm([{ facts: [{ fact: 'f', sourceUrl: 'https://rspca.org.uk/x', sourceName: 'RSPCA' }] }]);
    expect(await collectSourcedFacts(formerlyApproved, STORE, CFG, { title: 't', angle: 'a', keyPoints: ['k'] })).toEqual([]);
  });

  it('an empty facts list is a VALID research outcome (never pushed to invent)', () => {
    expect(validateSourcedFacts({ facts: [] })).toEqual([]);
  });

  it('drops retailers, listicles and news shopping (unchanged), and now charities too', () => {
    const facts = validateSourcedFacts({ facts: [
      { fact: 'listicle claim', sourceUrl: 'https://www.purewow.com/family/best-cooling-dog-beds', sourceName: 'PureWow' },
      { fact: 'competitor claim', sourceUrl: 'https://www.thebarklifeco.com/blog/best-cooling-dog-beds/', sourceName: 'Bark Life' },
      { fact: 'news shopping claim', sourceUrl: 'https://www.nbcnews.com/select/shopping/x', sourceName: 'NBC Select' },
      { fact: 'formerly approved', sourceUrl: 'https://www.rspca.org.uk/advice', sourceName: 'RSPCA' }
    ] });
    expect(facts).toEqual([]);
  });

  it('discards facts served by the OpenAI floor (no web plugin = source URLs are model memory)', async () => {
    // Same OpenRouter-shaped payload, but the client only has an OpenAI key, so
    // the chain's floor tier serves it: provider === 'openai' -> facts dropped.
    const fetchImpl = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ facts: [{ fact: 'f', sourceUrl: 'https://rspca.org.uk/x', sourceName: 'RSPCA' }] }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'gpt-5.4-mini'
    }), { status: 200 })) as unknown as typeof fetch;
    const floorLlm = new LlmClient({ openai: 'k' }, fetchImpl);
    expect(await collectSourcedFacts(floorLlm, STORE, CFG, { title: 't', angle: 'a', keyPoints: ['k'] })).toEqual([]);
  });
});

describe('approved-source gate (non-commercial authorities only)', () => {
  it('approves NOTHING: the allowlist is empty by policy', () => {
    for (const u of [
      'https://www.rspca.org.uk/advice/pets',
      'https://icatcare.org/hydration',
      'https://www.gov.uk/keeping-pets',
      'https://www.vet.cam.ac.uk/news',
      'https://www.nhs.uk/live-well',
      'https://vetmed.illinois.edu/pet-health',
      // the two that caused this: both run online shops selling competing products
      'https://www.cats.org.uk/cats-blog/how-to-make-a-scratching-post',
      'https://www.bluecross.org.uk/advice/cat/scratching'
    ]) expect(isApprovedSourceUrl(u), u).toBe(false);
  });

  it('rejects retailers, listicles, lookalike hosts and non-http schemes', () => {
    for (const u of [
      'https://www.thebarklifeco.com/blog/best-cooling-dog-beds/',
      'https://www.purewow.com/family/best-cooling-dog-beds',
      'https://www.nbcnews.com/select/shopping/how-to-keep-dogs-cool',
      'https://rspca.org.uk.evil.com/x',   // suffix spoof
      'https://rspca.org.uk@evil.com/x',   // userinfo trick: the real host is evil.com
      'https://evilrspca.org.uk/x',        // no dot boundary
      'ftp://rspca.org.uk/x',
      'not a url'
    ]) expect(isApprovedSourceUrl(u), u).toBe(false);
  });

  it('the research prompt tells the model there are NO external sources (no drift from the empty list)', () => {
    const line = approvedSourcesPromptLine();
    expect(line).toContain('NO EXTERNAL SOURCES');
    expect(line).toContain('activepaw.co.uk');
    expect(line).not.toContain('rspca.org.uk');
    expect(line).not.toContain('cats.org.uk');
  });
});

describe('external-link scrub (the body can never link a competitor)', () => {
  it('keeps relative and own-domain links, and now strips former "approved authority" links too', () => {
    const internal = '<p><a href="/products/x">buy</a> <a href="/collections/y">shop</a> ' +
      '<a href="https://activepaw.co.uk/blogs/guides/z">our guide</a></p>';
    expect(scrubExternalLinks(internal)).toBe(internal);
    // the charity link that shipped on a live article is no longer exempt
    expect(scrubExternalLinks('<p><a href="https://www.cats.org.uk/advice">advice</a></p>'))
      .toBe('<p>advice</p>');
  });

  it('unwraps a non-approved link but keeps the words when they are not an uncited statistic', () => {
    const html = '<p>Dogs cool by panting. <a href="https://www.purewow.com/x">as many owners know</a>.</p>';
    expect(scrubExternalLinks(html)).toBe('<p>Dogs cool by panting. as many owners know.</p>');
  });

  it('drops a digit-bearing full-sentence anchor entirely (a statistic must not outlive its source)', () => {
    const html = '<p>Gel pads store cold. <a href="https://www.nbcnews.com/select/x">Gel-based pads stay cool for up to 3 hours and recharge in 15 to 20 minutes.</a> They need chilling.</p>';
    expect(scrubExternalLinks(html)).toBe('<p>Gel pads store cold. They need chilling.</p>');
  });

  it('unwraps protocol-relative and non-http schemes, keeping inner formatting', () => {
    expect(scrubExternalLinks('<p><a href="//cdn.evil.com/x">text</a></p>')).toBe('<p>text</p>');
    expect(scrubExternalLinks('<p><a href="javascript:alert(1)">click</a></p>')).toBe('<p>click</p>');
    expect(scrubExternalLinks('<p><a href="https://x.com/y"><strong>bold words</strong></a></p>')).toBe('<p><strong>bold words</strong></p>');
  });

  const PACK: FactPack = { collectionHandle: 'pet-health', collectionTitle: 'Pet Health', collectionPath: '/collections/pet-health', products: [{ title: 'Automatic Pet Water Fountain', handle: 'fountain', path: '/products/fountain', priceGbp: 47.99, available: true }] };
  const BRIEF = { title: GOOD_DRAFT.title, angle: 'a', targetKeyword: 'k', collectionHandle: 'pet-health', whyNow: 'w', keyPoints: ['a', 'b', 'c'] };

  it('draftArticle BLOCKS the whole draft when an external link has no congruent product', async () => {
    // "this roundup" shares no vocabulary with the fountain, so the gate cannot
    // repoint it. A hard gate refuses rather than silently unlinking: silent
    // repair is what let a bad allowlist survive months of "already fixed".
    const withCompetitor = { ...GOOD_DRAFT, bodyHtml: GOOD_BODY + '<p>More at <a href="https://www.thebarklifeco.com/blog/best-cooling-dog-beds/">this roundup</a>.</p>' };
    const draft = await draftArticle(fakeLlm([withCompetitor, withCompetitor, withCompetitor]), STORE, CFG, BRIEF, PACK);
    expect(draft).toBeNull();
  });

  it('draftArticle REPOINTS an external link to the congruent product and keeps the claim', async () => {
    const withCitation = { ...GOOD_DRAFT, bodyHtml: GOOD_BODY + '<p><a href="https://www.cats.org.uk/x">An automatic water fountain encourages drinking</a>.</p>' };
    const draft = await draftArticle(fakeLlm([withCitation]), STORE, CFG, BRIEF, PACK);
    expect(draft).not.toBeNull();
    expect(draft!.bodyHtml).not.toContain('cats.org.uk');
    expect(draft!.bodyHtml).toContain('href="/products/fountain"');
    expect(draft!.bodyHtml).toContain('An automatic water fountain encourages drinking');
  });
});

describe('brief research web-first with hermetic fallback', () => {
  const goodBrief = { title: 'Summer cat cooling guide', angle: 'a', targetKeyword: 'k', collectionHandle: 'pet-health', whyNow: 'heatwave searches', keyPoints: ['x', 'y', 'z'] };
  it('falls back to the hermetic prompt when the web-grounded attempt yields nothing valid', async () => {
    const llm = fakeLlm([{ title: 'bad', collectionHandle: 'ghost' }, goodBrief]); // web attempt invalid -> hermetic succeeds
    const brief = await proposeBrief(llm, STORE, CFG, { validHandles: ['pet-health'], window: { season: 'autumn', months: ['September', 'October', 'November'] } });
    expect(brief?.title).toBe('Summer cat cooling guide');
  });
});

describe('published-status sync (D1 follows Shopify)', () => {
  it('getPublishedMap maps ids to isPublished and skips null nodes', async () => {
    const admin: AdminGraphql = (async () => ({ nodes: [
      { id: 'gid://shopify/Article/1', isPublished: true },
      { id: 'gid://shopify/Article/2', isPublished: false },
      null
    ] })) as unknown as AdminGraphql;
    const map = await getPublishedMap(admin, ['gid://shopify/Article/1', 'gid://shopify/Article/2', 'gid://shopify/Article/3']);
    expect(map.get('gid://shopify/Article/1')).toBe(true);
    expect(map.get('gid://shopify/Article/2')).toBe(false);
    expect(map.has('gid://shopify/Article/3')).toBe(false); // deleted article: absent, never flipped
    expect((await getPublishedMap(admin, [])).size).toBe(0); // no query when nothing is stale
  });
});
