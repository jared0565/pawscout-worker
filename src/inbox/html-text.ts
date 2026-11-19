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

const BLOCKQUOTE_INNERMOST = /<blockquote\b[^>]*>((?:(?!<blockquote\b)[\s\S])*?)<\/blockquote\s*>/i;

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
  let s = html
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Source whitespace means nothing in HTML; only the markup breaks lines.
    .replace(/\s+/g, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n');
  // Innermost first, so a nested quote ends up "> > ".
  for (let m = BLOCKQUOTE_INNERMOST.exec(s); m; m = BLOCKQUOTE_INNERMOST.exec(s)) {
    const quoted = m[1].replace(/^\n+|\n+$/g, '').split('\n').map((line) => `> ${line}`).join('\n');
    s = s.slice(0, m.index) + `\n${quoted}\n` + s.slice(m.index + m[0].length);
  }
  s = decodeEntities(s.replace(/<[^>]*>/g, ''));
  return s
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
