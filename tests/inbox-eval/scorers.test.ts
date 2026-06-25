import { describe, it, expect } from 'vitest';
import { hasFillerBookend, countWords, affirmsDelivery, statesDayRange } from '../../src/inbox/eval/scorers';

describe('hasFillerBookend', () => {
  it('flags the "do not hesitate to get in touch" boilerplate', () => {
    const padded = 'Yes, we ship to the US. If you have any other questions or need any further assistance, please do not hesitate to get in touch.';
    expect(hasFillerBookend(padded)).toBe(true);
  });

  it('flags the generic "thank you for getting in touch" opener', () => {
    expect(hasFillerBookend('Thank you for getting in touch! We do ship to the US.')).toBe(true);
  });

  it('passes a crisp reply with no boilerplate', () => {
    const crisp = "Yes, we ship to the US, including NYC. Delivery usually takes about 7-23 days, and you'll get a tracking link the moment it's on its way.";
    expect(hasFillerBookend(crisp)).toBe(false);
  });
});

describe('countWords', () => {
  it('counts whitespace-separated words, ignoring extra spacing and newlines', () => {
    expect(countWords('Yes, we ship to the US.')).toBe(6);
    expect(countWords('  one   two\n\nthree  ')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('affirmsDelivery', () => {
  it('true when the reply affirms delivery in its first sentence', () => {
    expect(affirmsDelivery('Yes, we ship to the US, including NYC.')).toBe(true);
    expect(affirmsDelivery('We can certainly deliver to New York.')).toBe(true);
  });
  it('false when the answer is buried or hedged, not an up-front affirmation', () => {
    const buried = 'Thank you for your interest in our business. As a small team we focus on quality. Regarding shipping, we can ship there.';
    expect(affirmsDelivery(buried)).toBe(false);
  });
});

describe('statesDayRange', () => {
  it('true when a grounded day-range is present', () => {
    expect(statesDayRange('Delivery usually takes about 7-23 days.')).toBe(true);
    expect(statesDayRange('estimated 4-12 days')).toBe(true);
  });
  it('false when no day-range is stated', () => {
    expect(statesDayRange('Shipping times vary depending on the item selected.')).toBe(false);
  });
});
