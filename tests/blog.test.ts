import { describe, it, expect } from 'vitest';
import {
  findBlogIssues, findClaimFlags, hasStorefrontLink, htmlToText, countWords, refineBlogUntilClean
} from '../src/blog/quality';
import { factPackToPrompt } from '../src/blog/ground';
import { sanitizeBlogHtml, draftArticle } from '../src/blog/draft';
import { createDraftArticle, renameBlog, findBlog } from '../src/blog/article';
import { proposeBrief, seasonForMonth } from '../src/blog/research';
import { LlmClient } from '../src/llm';
import type { AdminGraphql } from '../src/shopify-admin';
import type { BlogDraft, FactPack } from '../src/blog/types';

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
