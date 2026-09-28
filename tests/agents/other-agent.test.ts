import { describe, it, expect } from 'vitest';
import { otherAgent } from '../../src/inbox/agents/other';

describe('otherAgent', () => {
  it('is the safe generic fallback with no commercial objective', async () => {
    expect(otherAgent.category).toBe('other');
    expect(otherAgent.commercial).toBe(false);
    const g = await otherAgent.ground({} as any);
    expect(g.confident).toBe(true);
    expect(otherAgent.deterministicAppendix(g)).toBeNull();
  });

  // The catch-all lane signs as Customer Support (it used to sign as Sales, which
  // read oddly on a general enquiry or an uncategorised thread).
  it('signs as the Customer Support desk', () => {
    expect(otherAgent.department).toBe('service');
  });

  // 2026-07-04 owner directive (the azanwatch3 case): the draft declined a
  // "collaboration" the MESSAGE never offered - the subject line alone tripped
  // the pitch branch. Replies must judge by the sender's actual text; an
  // ambiguous message gets its question answered (the owner's 50/50 rule),
  // never a pre-emptive decline.
  it('judges pitch-vs-question from the message text, never the subject alone', () => {
    const p = otherAgent.promptFragment({} as any);
    expect(p).toContain('subject line is context');
    expect(p).toContain('MESSAGE TEXT');
    expect(p).toContain('never a pre-emptive decline');
    // the worked ambiguous example from the live case
    expect(p).toContain('Is your store ready for order?');
  });

  // Owner rule 2026-09-17 (prove-first): "we are receiving too many offers on
  // their services and we are just declining them blankly". A service offer
  // made IN the message text is no longer declined: it is answered with the
  // filter (everyone starts with their own affiliate discount code, tracked
  // orders decide). A goods supplier is thanked for the listing, not declined.
  it('answers a service offer with the prove-first filter and thanks a goods supplier, never a blank decline', () => {
    const p = otherAgent.promptFragment({} as any);
    expect(p).not.toContain('Decline brief, WARM and gracious');
    expect(p).not.toContain('You decline ONLY when');
    expect(p).toContain('SERVICE OFFERS');
    expect(p).toContain('GOODS SUPPLIERS');
    expect(p).toContain('starts with their own affiliate discount code');
    expect(p).toMatch(/welcome to email/i);
    expect(p).toMatch(/website or online store link/i);
  });
});
