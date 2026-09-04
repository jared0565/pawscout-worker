import { describe, it, expect } from 'vitest';
import { normalizeForRepeat, isRepeatOf, repeatVerdict } from '../src/inbox/repeat';

// Owner rule 2026-09-04: "if they keep sending the same message, consider them
// as spam and block their succeeding messages". These tests pin what "the same
// message" means, because the live inbox has two very different repeat shapes:
//  - 12 senders who re-sent a near-identical pitch (mass-mail or copy-paste), and
//  - 151 senders whose follow-ups are reworded ("just following up on my last
//    message") - those are NOT the same message and must not trip this rule.

const PITCH = `Hi there,

I am proposing a performance based collaboration where I will drive 40+ orders
with 5k+ targeted visitors within one week through my implementation. In
return, I would receive a 3% commission after the results started coming in.

Drop your WhatsApp number and I will guide you through the process.`;

describe('normalizeForRepeat', () => {
  it('strips the quoted chain, URLs, punctuation and case, and collapses whitespace', () => {
    const n = normalizeForRepeat(
      'Hello!  Check https://example.com/x?y=1 NOW...\n\nOn Wed, Aug 12, 2026 Active Paw <contact@activepaw.co.uk> wrote:\n> our earlier reply'
    );
    expect(n).toBe('hello check now');
  });

  it('treats curly apostrophes and straight ones the same', () => {
    expect(normalizeForRepeat('I’m here')).toBe(normalizeForRepeat("I'm here"));
  });
});

describe('isRepeatOf', () => {
  it('a byte-identical re-send is a repeat', () => {
    expect(isRepeatOf(PITCH, PITCH)).toBe(true);
  });

  it('the same pitch re-sent with different line wrapping and a quoted chain is still a repeat', () => {
    const rewrapped = PITCH.replace(/\n(?!\n)/g, ' ') + '\n\nOn Tue, Sep 1, 2026 Active Paw wrote:\n> Thank you for your interest';
    expect(isRepeatOf(rewrapped, PITCH)).toBe(true);
  });

  it('a reworded follow-up is NOT a repeat', () => {
    const followUp = 'Hello, wondering if you saw my last message on driving predictable sales? The system is generating real results for companies in your space. Open for a brief chat?';
    expect(isRepeatOf(followUp, PITCH)).toBe(false);
  });

  it('a different pitch from the same vendor is NOT a repeat', () => {
    const other = 'Our agency offers product listing services and can improve your site loading speed. We have 5 years of experience with Shopify stores.';
    expect(isRepeatOf(other, PITCH)).toBe(false);
  });

  it('short acknowledgements are never repeats, even when identical', () => {
    // "Okay", "Thanks", "Yes please" recur legitimately in real conversations.
    expect(isRepeatOf('Okay, thank you!', 'Okay, thank you!')).toBe(false);
    expect(isRepeatOf('Yes please', 'Yes please')).toBe(false);
  });

  it('an all-quote message (nothing new) is never a repeat', () => {
    const quoteOnly = 'On Tue, Sep 1, 2026 Active Paw wrote:\n> ' + PITCH.split('\n').join('\n> ');
    expect(isRepeatOf(quoteOnly, PITCH)).toBe(false);
  });
});

describe('repeatVerdict', () => {
  // The rule the owner chose (2026-09-04): a sender becomes spam on the 2nd copy
  // of a message we have ALREADY REPLIED to, or on the 3rd copy overall (a
  // mass-mailer that never waits for an answer).
  it('fires on the 2nd copy when we replied to the first', () => {
    expect(repeatVerdict(PITCH, [{ text: PITCH, repliedAfter: true }])).toBe(true);
  });

  it('does NOT fire on the 2nd copy when we never replied (an accidental double-send)', () => {
    expect(repeatVerdict(PITCH, [{ text: PITCH, repliedAfter: false }])).toBe(false);
  });

  it('fires on the 3rd copy even when we never replied', () => {
    expect(repeatVerdict(PITCH, [{ text: PITCH, repliedAfter: false }, { text: PITCH, repliedAfter: false }])).toBe(true);
  });

  it('ignores earlier messages that are not the same text', () => {
    const other = 'Do you ship to Ireland? I would like to order two of the grooming brushes.';
    expect(repeatVerdict(PITCH, [{ text: other, repliedAfter: true }, { text: other, repliedAfter: true }])).toBe(false);
  });
});
