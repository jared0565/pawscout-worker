import { describe, it, expect } from 'vitest';
import { hasNoNewWords, openBatchHasNoNewWords } from '../src/inbox/contentless';

describe('hasNoNewWords', () => {
  it.each(['', 'Hi active paw', 'Hello 👋', '?', '???', 'Activepaw', 'Good morning team', 'Hi\n\nSent from my iPhone', 'Get Outlook for Android'])('%j adds no new words', (t) => expect(hasNoNewWords(t)).toBe(true));
  it.each(['Are you there?', 'Yes', 'Hola', 'Thanks', '𝑯𝒆𝒍𝒍𝒐', 'Can I order 3?'])('%j counts as content', (t) => expect(hasNoNewWords(t)).toBe(false));
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
});
