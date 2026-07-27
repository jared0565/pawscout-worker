// src/blog/sources.ts
//
// External-source policy for blog content. The policy is now: THERE ARE NO
// APPROVED EXTERNAL SOURCES. Both lists below are deliberately empty.
//
// WHY (2026-07-27, owner directive). This file used to allowlist "non-commercial
// authorities" and the premise was simply false. Two entries, cats.org.uk and
// bluecross.org.uk, run online shops selling competing cat products (verified
// live: cats.org.uk/shop returns 200 "Shop | Help cats and kittens while you
// shop", shop.bluecross.org.uk returns 200 "Blue Cross Shop"), which broke this
// file's own rule that no allowlisted domain may sell products. The result
// shipped: an article selling scratching posts linked a charity guide on how to
// BUILD a scratching post.
//
// It also explains why the issue kept being reported as fixed. The 2026-07-10
// fix was real and it works (it stopped retailers and "best products"
// listicles), but charities were permitted BY DESIGN, so every audit of the
// enforcement found it healthy while the owner kept seeing external links.
//
// Keeping these arrays empty rather than deleting the mechanism is deliberate:
// the research step, the prompt line and the scrub all still read from one
// place, so the policy cannot drift back in through a single edit. The hard
// gate that actually enforces this at publish time is src/blog/link-gate.ts.

/** Hostname suffixes approved for citation. EMPTY: no external source qualifies. */
export const APPROVED_SOURCE_SUFFIXES: string[] = [];

/** Approved citation domains. EMPTY BY POLICY. Do not repopulate this list: a
 *  "non-commercial" domain is not the test, and the last attempt at that test
 *  admitted two shops. Blog articles link to activepaw.co.uk only. */
export const APPROVED_SOURCE_DOMAINS: { domain: string; name: string }[] = [];

/** Parsed lowercase hostname of an http(s) URL, or null for anything else
 *  (other schemes, garbage, userinfo tricks are all handled by URL parsing). */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

export function isApprovedSourceHost(host: string): boolean {
  const h = host.toLowerCase();
  if (APPROVED_SOURCE_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s))) return true;
  return APPROVED_SOURCE_DOMAINS.some(({ domain }) => h === domain || h.endsWith('.' + domain));
}

/** True only for an http(s) URL whose real hostname is an approved authority. */
export function isApprovedSourceUrl(url: string): boolean {
  const h = hostOf(url);
  return h !== null && isApprovedSourceHost(h);
}

const OWN_HOST_RE = /(^|\.)activepaw\.co\.uk$/;

/**
 * Strip every non-approved external link from article HTML. Relative links
 * (products, collections, other guides) and our own domain always survive;
 * approved-authority citations survive; everything else loses the anchor.
 * When the anchor text is a complete sentence carrying numbers, the whole
 * sentence goes too: an uncited statistic must not outlive its source
 * (customer-facing copy is only ever real and defensible). Otherwise the words
 * stay and only the link is removed. Idempotent.
 */
export function scrubExternalLinks(html: string): string {
  return html
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs: string, inner: string) => {
      const m = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').trim();
      if (!href || href.startsWith('#')) return whole;
      // NB: protocol-relative (//host/path) must not fall into the relative-path keep.
      if (href.startsWith('/') && !href.startsWith('//')) return whole;
      const host = hostOf(href.startsWith('//') ? 'https:' + href : href);
      if (host && OWN_HOST_RE.test(host)) return whole;
      if (host && isApprovedSourceHost(host)) return whole;
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const statSentence = /^[A-Z0-9]/.test(text) && /[.!?]$/.test(text) && /\d/.test(text);
      return statSentence ? '' : inner;
    })
    .replace(/ {2,}/g, ' ');
}

/** The research prompt's source-policy line, derived from the allowlist so the
 *  prompt and the hard filter can never drift apart. */
export function approvedSourcesPromptLine(): string {
  if (APPROVED_SOURCE_DOMAINS.length === 0 && APPROVED_SOURCE_SUFFIXES.length === 0) {
    return 'NO EXTERNAL SOURCES. Do not cite, quote, link or name any website other than activepaw.co.uk. ' +
      'Every link you write must be a relative Active Paw path (/products/..., /collections/..., /blogs/guides/...). ' +
      'A hard gate discards any draft containing an external link, so an outside citation cannot reach publication: do not spend a sentence on one. ' +
      'Ground every claim in the supplied product facts instead.';
  }
  const names = APPROVED_SOURCE_DOMAINS.map((d) => `${d.name} (${d.domain})`).join(', ');
  return 'APPROVED SOURCES ONLY: non-commercial veterinary, animal-welfare, government or academic pages. Approved domains: ' +
    names + ', plus any .gov, .gov.uk, .nhs.uk, .ac.uk or .edu page. ' +
    'A hard filter automatically discards facts from ANY other domain, including retailers, other pet shops, price-comparison or "best products" pages, news sites and their shopping sections, and personal blogs, so do not waste a slot on them.';
}
