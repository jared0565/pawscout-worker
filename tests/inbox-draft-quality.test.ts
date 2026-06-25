import { describe, it, expect } from 'vitest';
import { hasFillerBookend, countWords, affirmsDelivery, statesDayRange, findDraftIssues, refineUntilClean } from '../src/inbox/draft-quality';

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

describe('findDraftIssues (runtime quality gate)', () => {
  it('returns no issues for a crisp, filler-free, on-length reply', () => {
    const good = "Yes, we ship to the US, including NYC. Delivery usually takes about 7-23 days, and you'll get a tracking link the moment it's on its way.";
    expect(findDraftIssues(good, { maxWords: 70 })).toEqual([]);
  });

  it('flags filler padding with actionable feedback', () => {
    const padded = 'Thank you for getting in touch! We do ship to the US.';
    const issues = findDraftIssues(padded, { maxWords: 70 });
    expect(issues.some((i) => /filler|do not hesitate|getting in touch/i.test(i))).toBe(true);
  });

  it('flags an over-long reply with the word count and the target', () => {
    const longText = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
    const issues = findDraftIssues(longText, { maxWords: 70 });
    expect(issues.some((i) => /90 words/.test(i) && /70/.test(i))).toBe(true);
  });

  it('when the customer asked if we deliver, requires an up-front affirmation', () => {
    const buried = 'We are a small team focused on quality. Regarding shipping, we can ship there.';
    const issues = findDraftIssues(buried, { maxWords: 70, askedDelivery: true });
    expect(issues.some((i) => /affirm|yes|first sentence/i.test(i))).toBe(true);
  });

  it('does not require an affirmation when the customer did NOT ask about delivery', () => {
    const buried = 'We are a small team focused on quality and customer care.';
    expect(findDraftIssues(buried, { maxWords: 70, askedDelivery: false })).toEqual([]);
  });
});

describe('refineUntilClean (runtime self-correction loop)', () => {
  const CLEAN = { bodyText: 'Yes, we ship to the US, including NYC. Tracking follows on dispatch.' };
  const FILLER = { bodyText: 'Thank you for getting in touch! We ship to the US.' };

  it('returns the draft untouched and never revises when it already passes', async () => {
    let calls = 0;
    const revise = async () => { calls++; return CLEAN; };
    const out = await refineUntilClean(CLEAN, revise, { maxWords: 70 });
    expect(out).toBe(CLEAN);
    expect(calls).toBe(0);
  });

  it('revises a failing draft once and returns the clean result', async () => {
    let calls = 0;
    const revise = async (_prev: typeof FILLER, issues: string[]) => {
      calls++;
      expect(issues.length).toBeGreaterThan(0); // feedback handed to the reviser
      return CLEAN;
    };
    const out = await refineUntilClean(FILLER, revise, { maxWords: 70 });
    expect(out).toBe(CLEAN);
    expect(calls).toBe(1);
  });

  it('keeps the best (fewest-issue) candidate when revisions never fully pass', async () => {
    const STILL_BAD = { bodyText: 'Thank you for getting in touch, here is more padding do not hesitate.' };
    let calls = 0;
    const revise = async () => { calls++; return STILL_BAD; };
    const out = await refineUntilClean(FILLER, revise, { maxWords: 70 }, 2);
    expect(calls).toBe(2);               // exhausts attempts
    expect(out).toBe(FILLER);            // STILL_BAD is no better, so keep the original
  });

  it('falls back to the current draft if the reviser fails (returns null)', async () => {
    const revise = async () => null;
    const out = await refineUntilClean(FILLER, revise, { maxWords: 70 });
    expect(out).toBe(FILLER);
  });
});
