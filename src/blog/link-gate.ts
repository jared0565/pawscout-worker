// src/blog/link-gate.ts
//
// THE LINK HARD GATE for blog articles. One job, nothing else: guarantee that
// no article body reaching Shopify links anywhere outside activepaw.co.uk.
//
// WHY THIS EXISTS (2026-07-27, owner directive after repeat recurrences).
// The previous defence was src/blog/sources.ts `scrubExternalLinks`, an
// ALLOWLIST + SILENT SCRUB. It failed twice over, and both failures are
// designed out here:
//
//   1. The allowlist was wrong. It admitted cats.org.uk and bluecross.org.uk
//      as "non-commercial by construction" while both run online shops selling
//      competing cat products (verified live: cats.org.uk/shop and
//      shop.bluecross.org.uk both return 200). An article about scratching
//      posts shipped a link to a charity guide on how to BUILD a scratching
//      post. So: this gate has NO allowlist and NO external exceptions. The
//      only allowed destination is our own storefront.
//   2. The scrub was silent. It rewrote the body and reported nothing, so a
//      wrong allowlist entry produced no signal and survived several rounds of
//      "already fixed". So: this gate RETURNS A VERDICT. A violation it cannot
//      repoint BLOCKS the draft, and every violation is reported to the caller
//      for recording.
//
// DETERMINISTIC ON PURPOSE. No LLM call anywhere in this file. A hard gate that
// depends on a model is a gate that fails open the day the model is down or
// rate-limited, which is exactly when a bad draft would slip through.

/** What the gate did with one offending link. */
export interface LinkViolation {
  url: string;              // the offending href, or the bare URL found in text
  anchorText: string;       // visible text (empty for a bare-text URL)
  action: 'repointed' | 'blocked' | 'stripped';
  repointedTo?: string;     // internal path we sent it to, when repointed
  reason: string;           // human-readable, goes straight into the record
}

/** The verdict. `ok: false` means DO NOT PUBLISH. */
export interface LinkGateVerdict {
  ok: boolean;
  bodyHtml: string;          // gated body: safe to publish only when ok
  violations: LinkViolation[];
  externalLinkCount: number; // total offending links seen (any action)
}

/** A product the gate may repoint to. Structurally compatible with
 *  GroundedProduct from ./types, so a FactPack's products pass straight in. */
export interface RepointCandidate {
  title: string;
  handle: string;
  path: string;      // /products/<handle>
  available?: boolean;
}

/** Optional attribution: when a link came from a known research source we keep
 *  the source NAME as plain text after repointing, so a cited figure does not
 *  become an unattributed claim. Customer-facing copy stays defensible. */
export interface SourceAttribution {
  url: string;
  name: string;
}

const OWN_HOST_RE = /(^|\.)activepaw\.co\.uk$/;

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// A bare URL sitting in the prose with no anchor around it. The old scrubber
// was regex-on-anchors only and could not see these at all.
const BARE_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;

/** Words that carry no matching signal, so they never earn congruence. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'your', 'you', 'to', 'of', 'in', 'on', 'at',
  'is', 'are', 'be', 'can', 'that', 'this', 'it', 'its', 'as', 'so', 'up', 'out', 'from',
  'they', 'them', 'their', 'not', 'but', 'if', 'when', 'how', 'why', 'what', 'best', 'more',
  'most', 'must', 'should', 'will', 'have', 'has', 'do', 'does', 'get', 'keep', 'make'
]);

/** Lowercase hostname of an http(s) URL, or null for anything else. URL parsing
 *  handles userinfo tricks (https://activepaw.co.uk@evil.com resolves to
 *  evil.com), trailing dots and case, so we never hand-parse a host. */
function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Is this href allowed to survive? Allowed: a page fragment, a site-relative
 * path, or an absolute URL on our own domain. EVERYTHING else is a violation,
 * including protocol-relative //host/path (which is NOT a relative path) and
 * every non-http scheme.
 */
export function isInternalHref(href: string): boolean {
  const h = href.trim();
  if (!h) return false;
  if (h.startsWith('#')) return true;
  if (h.startsWith('//')) return false;          // protocol-relative is external
  if (h.startsWith('/')) return true;            // site-relative
  const host = hostOf(h);
  return host !== null && OWN_HOST_RE.test(host);
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Pick the product most congruent with the anchor text, by shared meaningful
 * tokens. Deterministic and explainable: the winner is the product whose title
 * genuinely shares vocabulary with the sentence being linked. Returns null when
 * nothing shares a meaningful word, which is what makes the gate BLOCK rather
 * than silently attach an irrelevant product. Ties break on the earlier
 * candidate, so the merchandiser's own ordering wins.
 */
export function pickCongruentProduct(
  anchorText: string,
  candidates: RepointCandidate[]
): RepointCandidate | null {
  const want = new Set(tokens(anchorText));
  if (want.size === 0) return null;
  let best: RepointCandidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.available === false) continue;         // never send a reader to a dead product
    const score = tokens(c.title).filter((t) => want.has(t)).length;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore > 0 ? best : null;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Review every link in an article body and return a verdict.
 *
 * Behaviour on an external link, in order:
 *   1. Repoint it to the most congruent product from `candidates`, keeping the
 *      anchor text exactly as written (the claim is unchanged, only the
 *      destination moves). If the URL is a known research source, its name is
 *      appended as PLAIN TEXT so the claim keeps its attribution.
 *   2. If no candidate is congruent, the link is BLOCKED: ok goes false and the
 *      caller must not publish. We deliberately do not fall back to unlinking,
 *      because a silent repair is what let this recur for months.
 *
 * Bare-text external URLs (no anchor) are stripped and recorded: there is no
 * anchor text to repoint, and leaving a raw competitor URL in the prose is the
 * same leak in a different shape.
 *
 * PURE and idempotent: running it on its own output finds nothing to do.
 */
export function reviewArticleLinks(
  bodyHtml: string,
  candidates: RepointCandidate[] = [],
  sources: SourceAttribution[] = [],
  opts: { mode?: 'gate' | 'remediate' } = {}
): LinkGateVerdict {
  // 'gate' (default) is for content not yet published: an unrepointable link
  // BLOCKS, because refusing to publish costs nothing. 'remediate' is for
  // articles ALREADY LIVE, where blocking would leave the bad link in front of
  // customers: there we unlink it, keep the words, and record it. Never publish
  // with mode 'remediate'.
  const mode = opts.mode ?? 'gate';
  const violations: LinkViolation[] = [];
  const nameByUrl = new Map(sources.map((s) => [s.url.trim().toLowerCase(), s.name]));

  let body = bodyHtml.replace(ANCHOR_RE, (whole, attrs: string, inner: string) => {
    const m = HREF_RE.exec(attrs);
    const href = (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').trim();
    if (!href || isInternalHref(href)) return whole;

    const anchorText = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const target = pickCongruentProduct(anchorText, candidates);

    if (!target) {
      if (mode === 'remediate') {
        // Already live: unlink and keep the words. An uncited statistic must
        // not outlive its source, so a digit-bearing full sentence goes too.
        const statSentence = /^[A-Z0-9]/.test(anchorText) && /[.!?]$/.test(anchorText) && /\d/.test(anchorText);
        violations.push({
          url: href, anchorText, action: 'stripped',
          reason: statSentence
            ? 'no congruent product; uncited statistic sentence removed with its link'
            : 'no congruent product; link removed, wording kept'
        });
        return statSentence ? '' : inner;
      }
      violations.push({
        url: href,
        anchorText,
        action: 'blocked',
        reason: 'external link with no congruent product to repoint to'
      });
      return whole; // left in place: the verdict blocks publication anyway
    }

    const sourceName = nameByUrl.get(href.toLowerCase());
    const attribution = sourceName ? ` (${sourceName})` : '';
    violations.push({
      url: href,
      anchorText,
      action: 'repointed',
      repointedTo: target.path,
      reason: sourceName
        ? `repointed to ${target.handle}; "${sourceName}" kept as plain-text attribution`
        : `repointed to ${target.handle}`
    });
    return `<a href="${escapeAttr(target.path)}">${inner}</a>${attribution}`;
  });

  // Second pass: bare external URLs left loose in the prose. Anchors are gone
  // from consideration by now only in the sense that their hrefs are internal;
  // to avoid eating the href of a surviving anchor we only scan TEXT segments.
  body = body.replace(/>([^<]+)</g, (whole, text: string) => {
    const cleaned = text.replace(BARE_URL_RE, (url: string) => {
      const normalised = url.startsWith('www.') ? 'https://' + url : url;
      if (isInternalHref(normalised)) return url;
      violations.push({
        url,
        anchorText: '',
        action: 'stripped',
        reason: 'bare external URL in article text'
      });
      return '';
    });
    return cleaned === text ? whole : `>${cleaned.replace(/\s{2,}/g, ' ')}<`;
  });

  const blocked = violations.some((v) => v.action === 'blocked');
  return {
    ok: !blocked,
    bodyHtml: body,
    violations,
    externalLinkCount: violations.length
  };
}

/** One-line summary for the violation record and the console. */
export function describeVerdict(articleTitle: string, v: LinkGateVerdict): string {
  if (v.violations.length === 0) return `"${articleTitle}": links clean`;
  const parts = v.violations.map((x) => `${x.url} [${x.action}${x.repointedTo ? ' -> ' + x.repointedTo : ''}]`);
  return `"${articleTitle}": ${v.ok ? 'repaired' : 'BLOCKED'} ${v.violations.length} external link(s): ${parts.join('; ')}`;
}
