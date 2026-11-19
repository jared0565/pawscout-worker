import { describe, it, expect } from 'vitest';
import { htmlToEmailText, isNewsletterShaped } from '../src/inbox/html-text';
import { stripQuotedReply } from '../src/inbox/quote';

describe('htmlToEmailText', () => {
  it('keeps paragraph and line breaks', () => {
    expect(htmlToEmailText('<p>Hi,<br /><br />Are you looking for a mobile app?</p><p>Lara</p>'))
      .toBe('Hi,\n\nAre you looking for a mobile app?\nLara');
  });
  it('decodes entities, including numeric ones', () => {
    expect(htmlToEmailText('<pre>I&#039;d like to know if you have &quot;slow feeders&quot; &amp; bowls</pre>'))
      .toBe('I\'d like to know if you have "slow feeders" & bowls');
  });
  it('drops head, style, script and comments', () => {
    expect(htmlToEmailText('<head><title>x</title><style>p{color:red}</style></head><!-- c --><script>alert(1)</script><div>Hello there</div>'))
      .toBe('Hello there');
  });
  it('prefixes blockquote lines so a Gmail quote is stripped', () => {
    const html = '<div dir="ltr">Thanks, see you</div><div class="gmail_quote"><div>On Mon, 6 Jul 2026, 18:20 Active Paw &lt;sales@activepaw.co.uk&gt; wrote:<br></div><blockquote class="gmail_quote">Hi Sam,<br>The next step is your code.</blockquote></div>';
    const text = htmlToEmailText(html);
    expect(text).toContain('> Hi Sam,');
    expect(stripQuotedReply(text)).toBe('Thanks, see you');
  });
  it('keeps an Outlook From/Sent header on separate lines so it is stripped', () => {
    const html = '<div>Thanks</div><hr><div><b>From:</b> Active Paw &lt;sales@activepaw.co.uk&gt;<br><b>Sent:</b> Monday, 6 July 2026 18:20<br><b>Subject:</b> Re: Hello</div><div>Hi Sam, the next step is your code.</div>';
    expect(stripQuotedReply(htmlToEmailText(html))).toBe('Thanks');
  });
  it('caps the text at maxChars', () => {
    expect(htmlToEmailText(`<p>${'a'.repeat(50)}</p>`, 10)).toHaveLength(10);
  });
  it('nests quote markers for a quote inside a quote', () => {
    expect(htmlToEmailText('<blockquote>outer<blockquote>inner</blockquote></blockquote>')).toBe('> outer\n> > inner');
  });
  // Security review 2026-11-19: inbound HTML is attacker-controlled, so the
  // conversion must stay linear. 20,000 nested quotes took minutes before.
  it('stays fast on thousands of nested blockquotes', () => {
    const n = 20000;
    const t0 = Date.now();
    htmlToEmailText('<blockquote>'.repeat(n) + 'x' + '</blockquote>'.repeat(n));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it.each([
    ['unclosed "<"', '<'.repeat(150000)],
    ['unclosed <head', '<head '.repeat(30000)],
    ['unclosed <style', '<style '.repeat(30000)],
    ['unclosed comments', '<!-- '.repeat(40000)],
  ])('stays fast on %s', (_, html) => {
    const t0 = Date.now();
    htmlToEmailText(html);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  // Second security review 2026-11-19: quote markers must not amplify the
  // output, and a close tag with no ">" must not restart the search per open.
  it('stays fast and bounded on deep nesting with many lines', () => {
    const t0 = Date.now();
    const out = htmlToEmailText('<blockquote>'.repeat(5000) + 'x<br>'.repeat(20000) + '</blockquote>'.repeat(5000));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(20000);
    expect(out.split('\n')[0]).toBe('> > > > > > > > x'); // the depth shown is capped at 8
  });
  it('stays fast on opens with a close tag that never ends', () => {
    const t0 = Date.now();
    htmlToEmailText('<head>'.repeat(30000) + '</head');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('an unclosed <head> drops only the tag, not the message', () => {
    expect(htmlToEmailText('<head><p>Do you ship to Ireland?</p>')).toBe('Do you ship to Ireland?');
  });
  it('a <header> element is not mistaken for <head>', () => {
    expect(htmlToEmailText('<header>Hello</header><p>Do you ship to Ireland?</p>')).toBe('HelloDo you ship to Ireland?');
  });
});

describe('isNewsletterShaped', () => {
  const tags = (imgs: number, links: number) => '<img src="x">'.repeat(imgs) + '<a href="y">z</a>'.repeat(links);
  it('is true at 6 images and 6 links', () => expect(isNewsletterShaped(tags(6, 6))).toBe(true));
  it('is false for a short personal email', () => expect(isNewsletterShaped('<p>Do you ship to Ireland?</p>')).toBe(false));
  it('is false at 4 images and 5 links (the largest non-newsletter measured)', () => expect(isNewsletterShaped(tags(4, 5))).toBe(false));
});
