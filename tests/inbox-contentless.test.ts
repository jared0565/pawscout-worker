import { describe, it, expect } from 'vitest';
import { hasNoNewWords, openBatchHasNoNewWords } from '../src/inbox/contentless';

describe('hasNoNewWords', () => {
  it.each(['', 'Hi active paw', 'Hello 👋', '?', '???', 'Activepaw', 'Good morning team', 'Hi\n\nSent from my iPhone', 'Get Outlook for Android'])('%j adds no new words', (t) => expect(hasNoNewWords(t)).toBe(true));
  it.each(['Are you there?', 'Yes', 'Hola', 'Thanks', '𝑯𝒆𝒍𝒍𝒐', 'Can I order 3?'])('%j counts as content', (t) => expect(hasNoNewWords(t)).toBe(false));
  // Final review, Critical 1: our order agent asks for the order number, and
  // the answer is digits only. A number is content.
  it.each(['#1043', '1043', '3', '07700 900123', '£25'])('%j (digits) counts as content', (t) => expect(hasNoNewWords(t)).toBe(false));
});

describe('openBatchHasNoNewWords', () => {
  let n = 0;
  const inb = (t: string) => ({ id: `m${n++}`, direction: 'inbound', body_text: t });
  const out = (t: string) => ({ id: `m${n++}`, direction: 'outbound', body_text: t });
  const quoted = 'On Fri, Sep 25, 2026, 12:34 PM Active Paw <sales@activepaw.co.uk> wrote:\n> Hi Sam,\n> Thanks for writing.';
  it('a bump that only quotes our reply', () => expect(openBatchHasNoNewWords([inb('Do you ship to Ireland?'), out('Yes, we do.'), inb(`Hi active paw\n\n${quoted}`)], 'Shipping')).toBe(true));
  it('content anywhere in the open batch counts', () => expect(openBatchHasNoNewWords([inb('Hi'), out('Hello!'), inb('Hi'), inb('Can I order 3?')], 'Hello')).toBe(false));
  it('nothing open (our reply is last) is not a bump', () => expect(openBatchHasNoNewWords([inb('Hi'), out('Hello!')], 'Hello')).toBe(false));
  it('never replied: the subject counts as content', () => expect(openBatchHasNoNewWords([inb('')], 'Do you ship to Ireland?')).toBe(false));
  it('never replied: an empty body and a filler subject', () => expect(openBatchHasNoNewWords([inb('Hi')], 'Re: Hello')).toBe(true));
  it('a file-only reply is content', () => {
    const photo = inb('');
    expect(openBatchHasNoNewWords([inb('My bowl arrived cracked'), out('Please send a photo.'), photo], 'Damaged', new Set([photo.id]))).toBe(false);
  });
  it('a bump with no recorded file is still a bump', () => expect(openBatchHasNoNewWords([inb('Hi'), out('Hello!'), inb('Hi')], 'Hello', new Set())).toBe(true));
  // Final review, Critical 1 and Important 2: real answers the gate silenced.
  const attribution = 'On Fri, Sep 25, 2026, 12:34 PM Active Paw <support@activepaw.co.uk> wrote:';
  it('an order number above our quoted question is content', () =>
    expect(openBatchHasNoNewWords([inb('Where is my order?'), out('Could you share your order number?'), inb(`#1043\n\n${attribution}\n> Could you share your order number?`)], 'Order')).toBe(false));
  it('an answer written below a Gmail quote is content', () =>
    expect(openBatchHasNoNewWords([inb('Do you have the bed in grey?'), out('Which size would you like?'), inb(`${attribution}\n> Which size would you like?\nLarge please`)], 'Bed')).toBe(false));
  it('an answer written between quoted lines, under a bare greeting, is content', () =>
    expect(openBatchHasNoNewWords([inb('Do you have the bed in grey?'), out('Which size would you like?'), inb(`Hi\n\n${attribution}\n> Which size would you like?\nLarge please, and in grey\n> Thanks`)], 'Bed')).toBe(false));
  it('an Outlook-style quote below a bare greeting is still a bump', () =>
    expect(openBatchHasNoNewWords([inb('Do you ship to Ireland?'), out('Yes, we do.'), inb('Hi\n\nFrom: Active Paw <support@activepaw.co.uk>\nSent: Friday, September 25, 2026 12:34 PM\nTo: Sam\nSubject: Re: Shipping\n\nYes, we do.')], 'Shipping')).toBe(true));
  // Final review, Important 3: a small pasted photo leaves no attachment row
  // (it is dropped like a signature logo), so the HTML itself is the evidence.
  it('a reply whose HTML shows an inline image is content', () => {
    const photo = { ...inb(''), body_html: '<div><img src="cid:ii_m1a2b3" alt="image.png" width="300"></div>' };
    expect(openBatchHasNoNewWords([inb('My bowl arrived cracked'), out('Please send a photo.'), photo], 'Damaged')).toBe(false);
  });
});
