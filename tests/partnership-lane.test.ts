import { describe, it, expect } from 'vitest';
import { isPartnershipLane, detectPartnershipAsk } from '../src/inbox/partnership';

// Rose thread, 2026-09-05/06 (owner: "nowhere that I found a mention of them
// asking for any collaboration"). The classifier called it 'affiliate' and the
// category alone opened the funnel, so a canned signup invite answered a plain
// product question. The category is a guess; the sender's own words are the
// ground. Neither message asks to partner.
const ROSE_1 = 'https://activepaw.co.uk/products/portable-dog-water-bowl-bottle-attachment I came across your store and I am considering recommending it to a few people who are looking for products in this category. Before I do, I wanted to ask do the products normally arrive exactly as shown and described on the website?';
const ROSE_2 = 'just checking back in. I think our conversation got a little buried. I am still open to recommending your store, but I wanted to make sure I can reach you directly if anyone has questions before ordering. Whenever you get a chance, I would love to hear back from you';

describe('detectPartnershipAsk', () => {
  it('fires on the ways a sender actually asks to partner', () => {
    for (const t of [
      'I would love to partner with you on a giveaway',
      'Do you have an affiliate programme?',
      'What commission do you offer per sale?',
      'Open to a collab? I run a dog account',
      'I would like to become a brand ambassador for Active Paw',
      'Could we do a sponsored post together?',
      'I can promote your products to my followers',
      'What percentage would you offer if I bring you customers?',
      'Is there a referral fee for sending you buyers?',
      'I am a content creator and would love to work together',
      'I am interested in a partnership'
    ]) expect(detectPartnershipAsk(t), t).toBe(true);
  });
  it('stays quiet on ordinary customer text, including a recommendation that asks nothing of us', () => {
    for (const t of [
      ROSE_1, ROSE_2,
      'My partner and I have two dogs, does the bed fit a Labrador?',
      'Is there a promotion running this weekend?',
      'Does the harness work with your lead?',
      'Can I recommend a friend to your store?',
      ''
    ]) expect(detectPartnershipAsk(t), t).toBe(false);
  });
});

describe('isPartnershipLane', () => {
  it('true when classified affiliate AND a message actually asks to partner', () => {
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: 'affiliate', inboundTexts: ['Do you have an affiliate programme?'] })).toBe(true);
  });
  it('false when classified affiliate but no message asks to partner (the Rose thread)', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['contact@activepaw.co.uk'], declaredIntent: null, primaryCategory: 'affiliate', inboundTexts: [ROSE_1, ROSE_2] })).toBe(false);
  });
  it('false for wholesale-b2b - a trade buyer is a different conversation (excluded by design)', () => {
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: 'wholesale-b2b', inboundTexts: ['I want to buy 200 units at trade price'] })).toBe(false);
  });
  it('true when arrived on sales@ (case-insensitive), regardless of category or text', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['SALES@activepaw.co.uk'], declaredIntent: null, primaryCategory: 'product-question', inboundTexts: ['Is this bowl dishwasher safe?'] })).toBe(true);
  });
  it('true when declared intent is partnerships (Phase 2 signal), regardless of text', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['support@activepaw.co.uk'], declaredIntent: 'partnerships', primaryCategory: 'other', inboundTexts: ['Hello'] })).toBe(true);
  });
  it('false for an ordinary support thread', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['support@activepaw.co.uk'], declaredIntent: null, primaryCategory: 'product-question', inboundTexts: ['Does it come in blue?'] })).toBe(false);
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: null, inboundTexts: [] })).toBe(false);
  });
});

// aramid llm-review 2026-09-06 (finding 252c4ecf): a bare "percentage" matched
// "What percentage of the fabric is polyester?". The word counts only in
// commission context: offered, paid, given, earned, per sale or per order.
describe('detectPartnershipAsk: "percentage" needs commission context', () => {
  it('fires when a percentage is asked for as a cut', () => {
    for (const t of [
      'What percentage would you offer if I bring you customers?',
      'Is there a percentage per sale for people who send you buyers?',
      'What commission percentage do you pay?',
      'Could I earn a percentage on orders I refer?'
    ]) expect(detectPartnershipAsk(t), t).toBe(true);
  });
  it('stays quiet on a product or delivery percentage', () => {
    for (const t of [
      'What percentage of the fabric is polyester?',
      'What percentage of orders arrive within a week?',
      'Is the 20% off code still valid, or what percentage is the sale?'
    ]) expect(detectPartnershipAsk(t), t).toBe(false);
  });
});
