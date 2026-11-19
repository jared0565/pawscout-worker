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
});

describe('isNewsletterShaped', () => {
  const tags = (imgs: number, links: number) => '<img src="x">'.repeat(imgs) + '<a href="y">z</a>'.repeat(links);
  it('is true at 6 images and 6 links', () => expect(isNewsletterShaped(tags(6, 6))).toBe(true));
  it('is false for a short personal email', () => expect(isNewsletterShaped('<p>Do you ship to Ireland?</p>')).toBe(false));
  it('is false at 4 images and 5 links (the largest non-newsletter measured)', () => expect(isNewsletterShaped(tags(4, 5))).toBe(false));
});
