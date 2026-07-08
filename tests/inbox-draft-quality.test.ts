import { describe, it, expect } from 'vitest';
import { hasFillerBookend, countWords, substanceWordCount, affirmsDelivery, statesDayRange, findDraftIssues, refineUntilClean, asksDoYouDeliver, claimsBusinessBiography } from '../src/inbox/draft-quality';
import { SHARED_SCAFFOLDING } from '../src/inbox/agents/scaffolding';

// The live fabrication this gate exists to catch (Azan's thread, 2026-07-05):
// asked "how long have you been running your store", the drafter invented both
// the store's age and a customer base. Verbatim from the superseded draft.
const AZAN_FABRICATION =
  "Thank you for your kind words, we really appreciate it. We've been running Active Paw for a good number of years now and we're proud to have built a loyal customer base across the UK and internationally. If you have any other questions about our store or products, please do not hesitate to get in touch.";
// The compliant correction that replaced it - a privacy decline that NAMES the
// question without answering it. Must never be flagged.
const AZAN_CORRECTION =
  'Thank you for the kind words, that is genuinely appreciated. Much like our shipping arrangements, details about the business itself are something we keep private, so how long we have been trading is not something we share. If there is anything you would like to know about our products or an order, we are always happy to help.';

describe('claimsBusinessBiography (fabricated business history/scale)', () => {
  it('flags the live Azan fabrication (store age + customer base)', () => {
    expect(claimsBusinessBiography(AZAN_FABRICATION)).toBe(true);
  });
  it('flags founding-year and customer-count inventions', () => {
    expect(claimsBusinessBiography('We were established in 2019 and have grown ever since.')).toBe(true);
    expect(claimsBusinessBiography('Active Paw has served thousands of happy customers.')).toBe(true);
    expect(claimsBusinessBiography('Our store has been operating for over five years.')).toBe(true);
  });
  it('passes the compliant privacy decline (mentions trading without claiming a duration)', () => {
    expect(claimsBusinessBiography(AZAN_CORRECTION)).toBe(false);
  });
  it('passes real grounded replies and product-longevity lines', () => {
    expect(claimsBusinessBiography('Yes, we are open and taking orders. You can browse our full range of dog and cat products on the website.')).toBe(false);
    expect(claimsBusinessBiography('Delivery to the USA typically takes around 5-12 days with our fastest options.')).toBe(false);
    expect(claimsBusinessBiography('This rope toy is bite resistant and typically lasts for years of daily chewing.')).toBe(false);
  });
});

describe('business-biography wiring (gate + prompt)', () => {
  it('findDraftIssues raises the invented-facts issue on the Azan draft and none on the correction', () => {
    expect(findDraftIssues(AZAN_FABRICATION).some((i) => i.includes('facts about the business itself'))).toBe(true);
    expect(findDraftIssues(AZAN_CORRECTION)).toEqual([]);
  });
  it('the shared scaffolding forbids business-self facts and prescribes the privacy decline', () => {
    expect(SHARED_SCAFFOLDING).toContain('BUSINESS ITSELF');
    expect(SHARED_SCAFFOLDING).toContain('details about the business are something we keep private');
  });
});

describe('hasFillerBookend (courtesy detector - allowed, used for substance stripping)', () => {
  it('detects the "do not hesitate to get in touch" courtesy', () => {
    const padded = 'Yes, we ship to the US. If you have any other questions or need any further assistance, please do not hesitate to get in touch.';
    expect(hasFillerBookend(padded)).toBe(true);
  });

  it('detects the "thank you for getting in touch" courtesy opener', () => {
    expect(hasFillerBookend('Thank you for getting in touch! We do ship to the US.')).toBe(true);
  });

  it('false for a reply with no courtesy phrase', () => {
    const crisp = "Yes, we ship to the US, including NYC. Delivery usually takes about 7-23 days, and you'll get a tracking link the moment it's on its way.";
    expect(hasFillerBookend(crisp)).toBe(false);
  });
});

describe('substanceWordCount', () => {
  it('counts the real answer even when wrapped in courtesy', () => {
    // courtesy stripped, leaving "we do ship to the US" (6 words)
    expect(substanceWordCount('Thank you for getting in touch! We do ship to the US.')).toBeGreaterThanOrEqual(6);
  });
  it('collapses to near zero when the reply is only courtesy + sign-off', () => {
    const allCourtesy = 'Thank you for getting in touch. We really appreciate you. Best regards, Active Paw Customer Support.';
    expect(substanceWordCount(allCourtesy)).toBeLessThan(6);
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

  it('ALLOWS courtesy that wraps a real answer (owner voice = warm wrapper)', () => {
    const warm = 'Thank you for getting in touch! Yes, we do ship to the US, and a tracking link follows on dispatch.';
    expect(findDraftIssues(warm, { maxWords: 110 })).toEqual([]);
  });

  it('flags a courtesy-only reply that carries no substance', () => {
    const empty = 'Thank you for getting in touch. We really appreciate you. Best regards, Active Paw Customer Support.';
    const issues = findDraftIssues(empty);
    expect(issues.some((i) => /substance|actual answer|what the customer/i.test(i))).toBe(true);
  });

  it('flags an over-long reply with the word count and the target', () => {
    const longText = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ');
    const issues = findDraftIssues(longText, { maxWords: 110 });
    expect(issues.some((i) => /130 words/.test(i) && /110/.test(i))).toBe(true);
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

describe('asksDoYouDeliver', () => {
  it('true for direct yes/no delivery questions', () => {
    expect(asksDoYouDeliver('Did you ship globally???')).toBe(true);
    expect(asksDoYouDeliver('do you ship to the United States?')).toBe(true);
    expect(asksDoYouDeliver('Do you currently offer international shipping?')).toBe(true);
    expect(asksDoYouDeliver('can you deliver to NYC?')).toBe(true);
  });
  it('false for a delivery-TIME question (handled by the grounded day-range, not a yes)', () => {
    expect(asksDoYouDeliver('how long does shipping take to NYC?')).toBe(false);
  });
  it('false for unrelated questions and the "thank you" red herring', () => {
    expect(asksDoYouDeliver('what inspired you to start Active Paw?')).toBe(false);
    expect(asksDoYouDeliver('Thank you, shipping looked fine.')).toBe(false);
  });
});

describe('refineUntilClean (runtime self-correction loop)', () => {
  const CLEAN = { bodyText: 'Yes, we ship to the US, including NYC. Tracking follows on dispatch.' };
  // courtesy-only, no substance -> fails the gate (needs revision)
  const FILLER = { bodyText: 'Thank you for getting in touch. We really appreciate you. Best regards, Active Paw Customer Support.' };

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
    const STILL_BAD = { bodyText: 'Thank you for getting in touch. Best regards, Active Paw Customer Support.' };
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
