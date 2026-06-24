import { describe, it, expect } from 'vitest';
import { mentionsMoney, autoSendDecision, AUTO_RATELIMIT_PER_SENDER_DAY } from '../src/inbox/autosend';

const base = { autosend: true, confidence: 95, threshold: 80, quotesPriceOrOrder: false, bodyText: 'Yes we ship to Ireland in 5-7 days.', category: 'product-question', recentAutoCount: 0 };

describe('mentionsMoney', () => {
  it('matches currency, prices, discounts, order/checkout', () => {
    for (const t of ['that is £19.99', '20% off today', 'pay the invoice', 'order now', '15 GBP']) expect(mentionsMoney(t)).toBe(true);
  });
  it('does not match plain prose', () => {
    for (const t of ['Yes we ship to Ireland.', 'The large bed fits a 20kg dog.']) expect(mentionsMoney(t)).toBe(false);
  });
  it('catches word-form prices, free offers, and BOGO', () => {
    for (const t of ['that is twenty pounds', 'free delivery on all orders', 'free shipping', 'half price this week', 'half off', 'buy one get one free', 'BOGO deal']) expect(mentionsMoney(t)).toBe(true);
  });
  it('does not match innocent uses of those words', () => {
    for (const t of ['feel free to ask us anything', 'I have two cats and one dog', 'we are happy to help']) expect(mentionsMoney(t)).toBe(false);
  });
});

describe('autoSendDecision', () => {
  it('sends a confident, price-free, safe-category reply under the rate limit', () => {
    expect(autoSendDecision(base).send).toBe(true);
  });
  it('holds when autosend is off', () => {
    const d = autoSendDecision({ ...base, autosend: false }); expect(d.send).toBe(false); expect(d.holdReasons).toContain('autosend_off');
  });
  it('holds low confidence', () => {
    expect(autoSendDecision({ ...base, confidence: 50 }).send).toBe(false);
  });
  it('holds when the LLM flags price/order', () => {
    expect(autoSendDecision({ ...base, quotesPriceOrOrder: true }).send).toBe(false);
  });
  it('holds when the mechanical money regex matches even if the LLM flag is false', () => {
    const d = autoSendDecision({ ...base, quotesPriceOrOrder: false, bodyText: 'Sure - that bundle is £29.99.' });
    expect(d.send).toBe(false); expect(d.holdReasons).toContain('mentions_money');
  });
  it('sends complaint, wholesale-b2b, and affiliate when autosend is true and floor passes', () => {
    expect(autoSendDecision({ ...base, category: 'complaint' }).send).toBe(true);
    expect(autoSendDecision({ ...base, category: 'wholesale-b2b' }).send).toBe(true);
    const aff = autoSendDecision({ ...base, category: 'affiliate' });
    expect(aff.send).toBe(true);
    expect(aff.holdReasons.length).toBe(0); // no always_hold_category reason
  });
  it('holds over the rate limit', () => {
    expect(autoSendDecision({ ...base, recentAutoCount: AUTO_RATELIMIT_PER_SENDER_DAY }).send).toBe(false);
  });
});
