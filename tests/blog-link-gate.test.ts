import { describe, it, expect } from 'vitest';
import {
  reviewArticleLinks, isInternalHref, pickCongruentProduct, describeVerdict,
  type RepointCandidate
} from '../src/blog/link-gate';

// Mirrors the real products on the article that triggered this work
// (activepaw.co.uk/blogs/guides/indoor-cat-summer-boredom-...).
const CANDIDATES: RepointCandidate[] = [
  { title: '63cm Cat Scratching Post with Sisal Rope', handle: 'pawhut-63cm-cat-scratching-post-with-sisal-rope', path: '/products/pawhut-63cm-cat-scratching-post-with-sisal-rope' },
  { title: '88cm Cat Tree with Sisal Scratching Post and Hanging Toys', handle: 'pawhut-88cm-cat-tree', path: '/products/pawhut-88cm-cat-tree' },
  { title: 'Interactive Squeaky Mouse Toy for Cats', handle: 'squeaky-mouse', path: '/products/squeaky-mouse' }
];

describe('isInternalHref', () => {
  it('allows fragments, site-relative paths and our own domain including subdomains', () => {
    expect(isInternalHref('#faq')).toBe(true);
    expect(isInternalHref('/products/x')).toBe(true);
    expect(isInternalHref('/collections/pet-toys')).toBe(true);
    expect(isInternalHref('https://activepaw.co.uk/products/x')).toBe(true);
    expect(isInternalHref('https://shop.activepaw.co.uk/x')).toBe(true);
    expect(isInternalHref('https://ACTIVEPAW.CO.UK/x')).toBe(true);
  });

  it('rejects every external shape, including the ones that look internal', () => {
    expect(isInternalHref('https://www.cats.org.uk/x')).toBe(false);
    expect(isInternalHref('//www.cats.org.uk/x')).toBe(false);          // protocol-relative
    expect(isInternalHref('https://activepaw.co.uk@evil.com/x')).toBe(false); // userinfo trick
    expect(isInternalHref('https://notactivepaw.co.uk/x')).toBe(false);
    expect(isInternalHref('https://activepaw.co.uk.evil.com/x')).toBe(false);
    expect(isInternalHref('javascript:alert(1)')).toBe(false);
    expect(isInternalHref('')).toBe(false);
  });
});

describe('pickCongruentProduct', () => {
  it('picks the product sharing real vocabulary with the claim', () => {
    const p = pickCongruentProduct('Scratching posts should be at least 60cm tall so the cat can fully stretch', CANDIDATES);
    expect(p?.handle).toBe('pawhut-63cm-cat-scratching-post-with-sisal-rope');
  });

  it('picks the cat tree for a tiered/hiding-place claim', () => {
    const p = pickCongruentProduct('A tiered scratching post provides hiding places and a high shelf', CANDIDATES);
    expect(p).not.toBeNull();
    expect(['pawhut-63cm-cat-scratching-post-with-sisal-rope', 'pawhut-88cm-cat-tree']).toContain(p!.handle);
  });

  it('returns null when nothing is congruent, so the gate blocks instead of guessing', () => {
    expect(pickCongruentProduct('Annual dog licence renewal deadlines', CANDIDATES)).toBeNull();
    expect(pickCongruentProduct('the and of it', CANDIDATES)).toBeNull();
  });

  it('never picks an unavailable product', () => {
    const out = pickCongruentProduct('scratching post', [{ ...CANDIDATES[0], available: false }]);
    expect(out).toBeNull();
  });
});

describe('reviewArticleLinks', () => {
  it('repoints an external citation to the congruent product and keeps the claim text', () => {
    const html = '<p><a href="https://www.cats.org.uk/cats-blog/how-to-make-a-scratching-post">Scratching posts should be at least 60cm tall</a></p>';
    const v = reviewArticleLinks(html, CANDIDATES);
    expect(v.ok).toBe(true);
    expect(v.bodyHtml).toContain('href="/products/pawhut-63cm-cat-scratching-post-with-sisal-rope"');
    expect(v.bodyHtml).toContain('Scratching posts should be at least 60cm tall');
    expect(v.bodyHtml).not.toContain('cats.org.uk');
    expect(v.violations[0].action).toBe('repointed');
  });

  it('keeps the source name as plain text so a cited figure stays attributed', () => {
    const html = '<p><a href="https://www.cats.org.uk/x">at least 60cm tall scratching post</a></p>';
    const v = reviewArticleLinks(html, CANDIDATES, [{ url: 'https://www.cats.org.uk/x', name: 'Cats Protection' }]);
    expect(v.bodyHtml).toContain('(Cats Protection)');
    expect(v.bodyHtml).not.toContain('href="https://www.cats.org.uk/x"');
  });

  it('BLOCKS when no congruent product exists, rather than silently unlinking', () => {
    const html = '<p><a href="https://www.bluecross.org.uk/advice/x">Annual licence renewal deadlines</a></p>';
    const v = reviewArticleLinks(html, CANDIDATES);
    expect(v.ok).toBe(false);
    expect(v.violations[0].action).toBe('blocked');
  });

  it('leaves internal links completely untouched', () => {
    const html = '<p><a href="/products/x">A</a><a href="/collections/pet-toys">B</a><a href="https://activepaw.co.uk/c">C</a></p>';
    const v = reviewArticleLinks(html, CANDIDATES);
    expect(v.ok).toBe(true);
    expect(v.violations).toHaveLength(0);
    expect(v.bodyHtml).toBe(html);
  });

  it('strips a bare external URL sitting in the prose (the old scrubber could not see these)', () => {
    const html = '<p>Read more at https://www.cats.org.uk/advice for details.</p>';
    const v = reviewArticleLinks(html, CANDIDATES);
    expect(v.bodyHtml).not.toContain('cats.org.uk');
    expect(v.violations.some((x) => x.action === 'stripped')).toBe(true);
  });

  it('catches a protocol-relative external link', () => {
    const html = '<p><a href="//www.cats.org.uk/x">scratching post advice</a></p>';
    const v = reviewArticleLinks(html, CANDIDATES);
    expect(v.bodyHtml).not.toContain('cats.org.uk');
    expect(v.violations).toHaveLength(1);
  });

  it('is idempotent: a gated body has nothing left to do', () => {
    const html = '<p><a href="https://www.cats.org.uk/x">Scratching posts at least 60cm tall</a></p>';
    const first = reviewArticleLinks(html, CANDIDATES);
    const second = reviewArticleLinks(first.bodyHtml, CANDIDATES);
    expect(second.violations).toHaveLength(0);
    expect(second.bodyHtml).toBe(first.bodyHtml);
  });

  // 'remediate' is for articles ALREADY LIVE, where blocking would leave the
  // bad link in front of customers.
  it('remediate mode UNLINKS instead of blocking when nothing is congruent', () => {
    const html = '<p><a href="https://www.bluecross.org.uk/advice/x">annual licence renewal deadlines</a></p>';
    const v = reviewArticleLinks(html, CANDIDATES, [], { mode: 'remediate' });
    expect(v.ok).toBe(true);                        // never blocks a live article
    expect(v.bodyHtml).not.toContain('bluecross');
    expect(v.bodyHtml).toContain('annual licence renewal deadlines'); // wording kept
    expect(v.violations[0].action).toBe('stripped');
  });

  it('remediate mode drops a digit-bearing sentence whole: a statistic must not outlive its source', () => {
    const html = '<p>Cats stretch. <a href="https://www.bluecross.org.uk/x">Gel pads stay cool for up to 3 hours and recharge in 20 minutes.</a> More.</p>';
    const v = reviewArticleLinks(html, CANDIDATES, [], { mode: 'remediate' });
    expect(v.bodyHtml).not.toContain('Gel pads stay cool');
    expect(v.bodyHtml).toContain('Cats stretch.');
  });

  it('remediate mode still prefers repointing when a congruent product exists', () => {
    const html = '<p><a href="https://www.cats.org.uk/x">Scratching posts should be at least 60cm tall</a></p>';
    const v = reviewArticleLinks(html, CANDIDATES, [], { mode: 'remediate' });
    expect(v.bodyHtml).toContain('href="/products/pawhut-63cm-cat-scratching-post-with-sisal-rope"');
    expect(v.violations[0].action).toBe('repointed');
  });

  // THE ACTUAL INCIDENT, 2026-07-27. Verbatim anchors from the live article
  // activepaw.co.uk/blogs/guides/indoor-cat-summer-boredom-scratching-posts-
  // activity-centres-keep-them-engaged. If this ever fails, that post class has
  // regressed.
  it('cleans the real published article: all three charity links, none survive', () => {
    const live =
      '<p><a href="https://www.cats.org.uk/cats-blog/behaviour-focus-scratching">Scratching posts must be tall enough for cats to stretch up on their toes while scratching and sturdy enough so cats can lean their body weight against the post without it wobbling.</a></p>' +
      '<p><a href="https://www.cats.org.uk/cats-blog/how-to-make-a-scratching-post">Scratching posts should be at least 60cm tall so that the cat can fully stretch.</a></p>' +
      '<p><a href="https://www.bluecross.org.uk/advice/dog-cat-degu-hamster">A tiered scratching post helps cats feel safe as it provides hiding places and a high shelf from which to watch the world go by.</a></p>' +
      '<p><a href="/products/pawhut-63cm-cat-scratching-post-with-sisal-rope">63cm Cat Scratching Post</a> and <a href="/collections/pet-toys">Pet Toys collection</a></p>';

    const v = reviewArticleLinks(live, CANDIDATES, [], { mode: 'remediate' });

    expect(v.bodyHtml).not.toContain('cats.org.uk');
    expect(v.bodyHtml).not.toContain('bluecross.org.uk');
    expect(v.violations).toHaveLength(3);
    expect(v.violations.every((x) => x.action === 'repointed')).toBe(true);
    // the 60cm claim lands on the 63cm post: the product provably satisfies it
    expect(v.bodyHtml).toContain('at least 60cm tall');
    // internal links are untouched, including the collection funnel link
    expect(v.bodyHtml).toContain('href="/collections/pet-toys"');
    expect(v.bodyHtml).toContain('href="/products/pawhut-63cm-cat-scratching-post-with-sisal-rope"');
  });

  it('describeVerdict names the article and every link, so a recurrence is visible', () => {
    const v = reviewArticleLinks('<p><a href="https://www.cats.org.uk/x">licence deadlines</a></p>', CANDIDATES);
    const line = describeVerdict('Indoor cat boredom', v);
    expect(line).toContain('BLOCKED');
    expect(line).toContain('cats.org.uk');
  });
});
