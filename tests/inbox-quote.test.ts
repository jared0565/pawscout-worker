import { describe, it, expect } from 'vitest';
import { stripQuotedReply } from '../src/inbox/quote';

describe('stripQuotedReply', () => {
  it('keeps the new text and cuts a Gmail "On <date> ... wrote:" quote (the real Texas thread)', () => {
    const body = [
      'Good, I was just wondering, how long does shipping usually take to Texas',
      'for your products?',
      '',
      'On Tue, Jun 23, 2026 at 3:09 AM Active Paw <contact@activepaw.co.uk> wrote:',
      '',
      '> Hi Alina,',
      '>',
      '> Thank you for your enquiry! Yes, this is the correct email address.',
    ].join('\n');
    const out = stripQuotedReply(body);
    expect(out).toBe('Good, I was just wondering, how long does shipping usually take to Texas\nfor your products?');
    expect(out).not.toContain('activepaw.co.uk'); // footer gone -> no false UK destination
    expect(out).not.toContain('wrote:');
  });

  it('returns empty when the message is only a quoted reply (caller must not fabricate)', () => {
    const body = [
      'On Tue, Jun 23, 2026, 1:44 AM Active Paw <contact@activepaw.co.uk> wrote:',
      '> Hi Jericho,',
      '> Thank you for your enquiry! You can place an order any time.',
    ].join('\n');
    expect(stripQuotedReply(body)).toBe('');
  });

  it('cuts an Outlook "-----Original Message-----" divider', () => {
    const body = 'Can I change my address?\n\n-----Original Message-----\nFrom: Active Paw\nSent: ...';
    expect(stripQuotedReply(body)).toBe('Can I change my address?');
  });

  it('cuts an Outlook From:/Sent: header block', () => {
    const body = 'Any update on my order?\n\nFrom: Active Paw <support@activepaw.co.uk>\nSent: Tuesday\nSubject: Re';
    expect(stripQuotedReply(body)).toBe('Any update on my order?');
  });

  it('drops stray ">"-quoted lines even without an attribution header', () => {
    expect(stripQuotedReply('Yes please cancel it.\n> previous quoted line\n> more quote')).toBe('Yes please cancel it.');
  });

  it('leaves an unquoted message untouched and handles empty/null', () => {
    expect(stripQuotedReply('Do you ship to France?')).toBe('Do you ship to France?');
    expect(stripQuotedReply('')).toBe('');
    expect(stripQuotedReply(null)).toBe('');
    expect(stripQuotedReply(undefined)).toBe('');
  });

  it('does not over-cut on a normal sentence containing the word "wrote"', () => {
    const body = 'I wrote to you last week but had no reply, can you help?';
    expect(stripQuotedReply(body)).toBe(body); // no "On ... wrote:" attribution => untouched
  });
});
