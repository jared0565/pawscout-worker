// Formatted-only email (design 2026-11-19, 1a). Some senders send an HTML part
// and no plain text part. postal-mime then gives an empty `text`, so the inbox
// showed "(no body)" and the classifier, the reader and the drafter saw a
// blank: 56 inbound messages on the 2026-11-19 export, 54 of them holding a real
// message. This turns that HTML into text that keeps the shape the quote
// stripper relies on (line breaks, "On ... wrote:" and From:/Sent: lines, and
// "> " quoted lines). src/blog/quality.ts htmlToText is not suitable: it
// collapses every line break, which defeats quote stripping.

export const HTML_TEXT_MAX_CHARS = 20000;

// 2026-11-19 export: all 19 TikTok Shop mails have >=8 of each, and of the
// other 36 formatted-only mails none has more than 4 images or 5 links.
export const NEWSLETTER_MIN_IMAGES = 6;
export const NEWSLETTER_MIN_LINKS = 6;

// Inbound HTML is attacker-controlled (security review 2026-11-19): it is cut
// to this many characters BEFORE any work, and every pass below is linear.
// The largest real formatted-only mail on the 2026-11-19 export was 69,577.
export const HTML_INPUT_MAX_CHARS = 200000;

const BLOCKQUOTE_TAG = /(<blockquote\b[^<>]*>|<\/blockquote\s*>)/i;

/** Remove every <tag ...>...</tag> element in one linear pass. An unclosed
 * element loses only its opening tag, so a stray <head> never eats the
 * message. Once no closing tag is found from a point, none exists past it,
 * so the search is not repeated (that repeat is what makes lazy regexes
 * quadratic on unclosed tags). */
function dropElements(s: string, tag: string): string {
  const lower = s.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}`;
  let out = '';
  let i = 0;
  let from = 0;
  let closeMissing = false;
  for (;;) {
    const a = lower.indexOf(open, from);
    if (a < 0) break;
    const next = lower.charAt(a + open.length);
    if (next && !/[\s>/]/.test(next)) { from = a + open.length; continue; } // <header is not <head
    const openEnd = lower.indexOf('>', a);
    if (openEnd < 0) break;
    const b = closeMissing ? -1 : lower.indexOf(close, openEnd);
    if (b < 0) closeMissing = true;
    const closeEnd = b < 0 ? -1 : lower.indexOf('>', b);
    out += s.slice(i, a) + ' ';
    i = closeEnd < 0 ? openEnd + 1 : closeEnd + 1;
    from = i;
  }
  return out + s.slice(i);
}

/** Remove <!-- --> comments in one linear pass; an unclosed one loses only its opener. */
function dropComments(s: string): string {
  let out = '';
  let i = 0;
  let closeMissing = false;
  for (;;) {
    const a = s.indexOf('<!--', i);
    if (a < 0) break;
    const b = closeMissing ? -1 : s.indexOf('-->', a + 4);
    if (b < 0) closeMissing = true;
    out += s.slice(i, a) + ' ';
    i = b < 0 ? a + 4 : b + 3;
  }
  return out + s.slice(i);
}

/** One linear pass: track blockquote depth, and prefix each line of text at
 * depth d with d "> " markers, so a nested quote reads "> > ". */
function markQuotes(s: string): string {
  let depth = 0;
  let out = '';
  for (const part of s.split(BLOCKQUOTE_TAG)) {
    if (BLOCKQUOTE_TAG.test(part)) {
      depth = part[1] === '/' ? Math.max(0, depth - 1) : depth + 1;
      out += '\n';
    } else if (depth > 0) {
      const marker = '> '.repeat(depth);
      out += part.split('\n').map((line) => (line.trim() ? marker + line : line)).join('\n');
    } else {
      out += part;
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, '\'')
    .replace(/&amp;/gi, '&'); // last, so "&amp;lt;" reads "&lt;" and is not decoded twice
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  return code === 0xa0 ? ' ' : String.fromCodePoint(code);
}

/** The readable text of an email's HTML part, line structure and quote
 * markers kept, capped at `maxChars`. */
export function htmlToEmailText(html: string, maxChars: number = HTML_TEXT_MAX_CHARS): string {
  let s = dropComments(html.slice(0, HTML_INPUT_MAX_CHARS));
  for (const tag of ['head', 'style', 'script']) s = dropElements(s, tag);
  s = s
    // Source whitespace means nothing in HTML; only the markup breaks lines.
    .replace(/\s+/g, ' ')
    .replace(/<(?:br|hr)\b[^<>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n');
  // [^<>] (not [^>]) keeps the tag strip linear on a run of unclosed "<".
  return decodeEntities(markQuotes(s).replace(/<[^<>]*>/g, ''))
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

/** A platform newsletter, judged by its HTML: many images AND many links. */
export function isNewsletterShaped(html: string): boolean {
  const images = (html.match(/<img\b/gi) ?? []).length;
  const links = (html.match(/<a\s/gi) ?? []).length;
  return images >= NEWSLETTER_MIN_IMAGES && links >= NEWSLETTER_MIN_LINKS;
}
