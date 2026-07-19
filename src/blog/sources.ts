// src/blog/sources.ts
//
// The APPROVED-SOURCE gate for external links in blog content. Articles exist
// to earn bundled sales; an external link may ONLY point at a non-commercial
// authority (veterinary bodies, animal-welfare charities, government/academic
// pages). Retailer blogs, price-comparison pages, "best products" listicles and
// news shopping sections compete for the same buyer and must NEVER receive a
// link, no matter what the research LLM returns. Enforcement is DETERMINISTIC
// (fact validator + draft body scrub + the nightly article sweep), never
// prompt-only: prompt-only enforcement already failed once in production
// (2026-07-10 post cited two shopping listicles and a competitor pet shop).

/** Hostname suffixes that are non-commercial by construction. */
export const APPROVED_SOURCE_SUFFIXES = ['.gov', '.gov.uk', '.ac.uk', '.edu', '.nhs.uk'];

/** Curated non-commercial pet-care authorities. Extend deliberately; never add
 *  a domain that sells or ranks products (a "best X" page is a competitor). */
export const APPROVED_SOURCE_DOMAINS: { domain: string; name: string }[] = [
  { domain: 'rspca.org.uk', name: 'RSPCA' },
  { domain: 'pdsa.org.uk', name: 'PDSA' },
  { domain: 'bluecross.org.uk', name: 'Blue Cross' },
  { domain: 'dogstrust.org.uk', name: 'Dogs Trust' },
  { domain: 'cats.org.uk', name: 'Cats Protection' },
  { domain: 'icatcare.org', name: 'International Cat Care' },
  { domain: 'battersea.org.uk', name: 'Battersea' },
  { domain: 'thekennelclub.org.uk', name: 'The Kennel Club' },
  { domain: 'bva.co.uk', name: 'British Veterinary Association' },
  { domain: 'rcvs.org.uk', name: 'Royal College of Veterinary Surgeons' },
  { domain: 'msdvetmanual.com', name: 'MSD Veterinary Manual' }
];

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
  const names = APPROVED_SOURCE_DOMAINS.map((d) => `${d.name} (${d.domain})`).join(', ');
  return 'APPROVED SOURCES ONLY: non-commercial veterinary, animal-welfare, government or academic pages. Approved domains: ' +
    names + ', plus any .gov, .gov.uk, .nhs.uk, .ac.uk or .edu page. ' +
    'A hard filter automatically discards facts from ANY other domain, including retailers, other pet shops, price-comparison or "best products" pages, news sites and their shopping sections, and personal blogs, so do not waste a slot on them.';
}
