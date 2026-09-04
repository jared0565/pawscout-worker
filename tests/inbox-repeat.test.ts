import { describe, it, expect } from 'vitest';
import { normalizeForRepeat, isRepeatOf, repeatVerdict, repeatsPriorOutbound, outboundBodies, chooseTouch, looksLikeCustomerMessage } from '../src/inbox/repeat';

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

// Owner rule 2026-09-04, second half: "We never send the same message multiple
// times. If you need to send the same message at least make it shorter and more
// concise the second time." The guard below compares a candidate draft with the
// thread's earlier OUTBOUND messages and picks the touch: full body, then the
// shorter second touch, then a one-line pointer back to the earlier reply.
describe('no-repeat guard against prior outbound', () => {
  const FULL = 'Hi Jo,\n\nThank you for your interest in partnering with Active Paw. Our affiliate programme is the only partnership we run at the moment, and it is open to anyone. Applications go through our partner page, and it only takes a few minutes.\n\nBest Regards,\nActive Paw Partnerships';
  const SHORT = 'Hi Jo,\n\nThanks for coming back to us. Nothing has changed on our side: the application form is the next step and takes a few minutes.\n\nBest Regards,\nActive Paw Partnerships';
  const POINTER = 'Hi Jo,\n\nOur earlier reply on this thread still stands, and the application form there remains the next step.\n\nBest Regards,\nActive Paw Partnerships';

  it('repeatsPriorOutbound is true only when the candidate repeats one of the earlier sends', () => {
    expect(repeatsPriorOutbound(FULL, [FULL])).toBe(true);
    expect(repeatsPriorOutbound(SHORT, [FULL])).toBe(false);
    expect(repeatsPriorOutbound(FULL, [])).toBe(false);
    expect(repeatsPriorOutbound(FULL, [null, 'Yes, we ship to Ireland in five to seven working days from dispatch.'])).toBe(false);
  });

  it('outboundBodies keeps only our own messages, in thread order', () => {
    const msgs = [
      { direction: 'inbound', body_text: 'their question' },
      { direction: 'outbound', body_text: 'our first reply' },
      { direction: 'outbound', body_text: null },
    ];
    expect(outboundBodies(msgs)).toEqual(['our first reply', null]);
  });

  it('chooseTouch: full body when nothing repeats, second touch once the full body was sent, pointer once both were', () => {
    const bodies = { first: FULL, second: SHORT, pointer: POINTER };
    expect(chooseTouch([], bodies)).toEqual({ body: FULL, touch: 'first' });
    expect(chooseTouch([FULL], bodies)).toEqual({ body: SHORT, touch: 'second' });
    expect(chooseTouch([FULL, SHORT], bodies)).toEqual({ body: POINTER, touch: 'pointer' });
    // The pointer is the terminal touch (owner's choice): it is drafted again rather than nothing.
    expect(chooseTouch([FULL, SHORT, POINTER], bodies).touch).toBe('pointer');
  });
});

// Deterministic customer signal for the block rule: the sweep's classification
// may not exist yet when a 3rd copy lands, so the text itself must be enough to
// keep a customer's order or delivery query out of the block (aramid finding
// 114e2e7b, 2026-09-04).
describe('looksLikeCustomerMessage', () => {
  it('recognises order, tracking, parcel, refund, return and delivery queries', () => {
    for (const t of [
      'Hello, I placed order 1042 nine days ago and the tracking has not moved since Friday.',
      'My parcel has still not arrived, can you check?',
      'I would like a refund for the bed, it does not fit.',
      'How do I return the harness I received yesterday?',
      'Has my delivery been dispatched yet? Order #A1234.',
    ]) expect(looksLikeCustomerMessage(t), t).toBe(true);
  });
  it('does not fire on a pitch', () => {
    expect(looksLikeCustomerMessage(PITCH)).toBe(false);
    expect(looksLikeCustomerMessage('Can I speak with the owner of this brand? I have a proposal that could drive 40+ sales.')).toBe(false);
  });
});
