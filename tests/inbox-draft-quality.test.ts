import { describe, it, expect } from 'vitest';
import { hasFillerBookend, countWords, substanceWordCount, affirmsDelivery, statesDayRange, findDraftIssues, refineUntilClean, asksDoYouDeliver, claimsBusinessBiography, volunteersTradeDecline, owesBasketDelivery, promisesSupplier, supplierAsksOwed, asksSupplierLink, appendSupplierAsks, claimsFileReceived, invitesFiles, mentionsAttachment, fileAsksOwed, appendFileAsks, fileHoldReasons, FILE_MISSING_SENTENCE, FILE_REFUSED_SENTENCE, repeatsThanks, collapseRepeatedThanks } from '../src/inbox/draft-quality';
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

// Sofia thread (2026-09-20), verbatim. She never asked for trade terms; the
// draft declined them anyway and turned a buyer away. Owner rule 2026-09-21: a
// quantity is a purchase. The prompts now say so, and this gate is the runtime
// half: a draft that volunteers a trade decline is sent back for a rewrite.
const SOFIA_ASK =
  "I have 5 customers who need this product for an event coming up in the next two weeks, and around 30% of my customers are also interested but haven't purchased yet. Since I don't have it in stock, I'm looking for a reliable store to order from. Is it available, and what's the best way to communicate for quick updates?";
const SOFIA_DECLINE =
  'Thank you for your enquiry. We are focused on individual retail orders and are not offering wholesale or trade terms at the moment. You are welcome to check the product listing and place individual orders through https://activepaw.co.uk.';
// The corrected sentence (2026-09-21, measured at the live checkout: one flat
// delivery rate per order, the same for 1 unit as for 5): destination and
// basket contents, exact total at checkout. Never "the number of items".
const SOFIA_GOOD =
  'Yes, you are welcome to order as many as you need through https://activepaw.co.uk. The delivery cost depends on your destination and what is in the basket, and the exact total for the whole order is shown at checkout before payment. Which product do you have in mind, so we can check it for you?';

describe('volunteersTradeDecline (a trade decline nobody asked for)', () => {
  it('flags the live Sofia draft against her own words', () => {
    expect(volunteersTradeDecline(SOFIA_DECLINE, SOFIA_ASK)).toBe(true);
  });
  it('passes the same decline when the customer DID ask for terms', () => {
    expect(volunteersTradeDecline(SOFIA_DECLINE, 'Can I buy 500 units wholesale?')).toBe(false);
    expect(volunteersTradeDecline(SOFIA_DECLINE, 'Do you give a discount if I take 40 of them?')).toBe(false);
    expect(volunteersTradeDecline(SOFIA_DECLINE, 'We are a pet shop, do you have a trade account or a price list for resellers?')).toBe(false);
  });
  it('passes a reply that simply helps the buyer order', () => {
    expect(volunteersTradeDecline(SOFIA_GOOD, SOFIA_ASK)).toBe(false);
  });
  it('is silent when the customer text is unknown (nothing to compare with)', () => {
    expect(volunteersTradeDecline(SOFIA_DECLINE, '')).toBe(false);
  });
  it('findDraftIssues raises it only with the customer text in the context', () => {
    const issues = findDraftIssues(SOFIA_DECLINE, { customerText: SOFIA_ASK });
    expect(issues.some((i) => i.includes('did not ask for wholesale'))).toBe(true);
    expect(issues.join(' ')).not.toMatch(/number of items/i);
    expect(findDraftIssues(SOFIA_DECLINE).some((i) => i.includes('did not ask for wholesale'))).toBe(false);
    expect(findDraftIssues(SOFIA_GOOD, { customerText: SOFIA_ASK })).toEqual([]);
  });
});

// Same thread, first draft from the REAL model after the fix went live
// (2026-09-21 07:48Z), verbatim: it welcomed the purchase but left out the one
// fact the owner had named, that delivery for a basket depends on the number of
// items and is shown at checkout, because she had not asked about delivery and
// the workflow rule says to answer only what was asked. A buyer of several is
// owed that sentence; the gate asks for it on the buying lanes only, so "I
// placed 2 orders last week, where are they?" never gets it.
const SOFIA_NO_DELIVERY =
  'Thank you for your enquiry! Which product do you mean? The product page shows its current availability, and you are welcome to order any quantity the website allows through https://activepaw.co.uk. We keep conversations on email rather than WhatsApp, so please contact contact@activepaw.co.uk or reply here for updates, and the team replies within one working day.';

describe('owesBasketDelivery (a buyer of several is told where the delivery cost appears)', () => {
  it('flags the live draft that welcomed five but never mentioned checkout', () => {
    expect(owesBasketDelivery(SOFIA_NO_DELIVERY, SOFIA_ASK)).toBe(true);
  });
  it('passes a reply that says the delivery cost is shown at checkout', () => {
    expect(owesBasketDelivery(SOFIA_GOOD, SOFIA_ASK)).toBe(false);
  });
  it('is not satisfied by "checkout" alone: the sentence has to be about delivery', () => {
    const checkoutOnly = 'Which product do you mean? You can order any quantity through https://activepaw.co.uk and pay at checkout.';
    expect(owesBasketDelivery(checkoutOnly, SOFIA_ASK)).toBe(true);
    const deliveryOnly = 'Which product do you mean? Delivery depends on where you are and what you order.';
    expect(owesBasketDelivery(deliveryOnly, SOFIA_ASK)).toBe(true);
  });
  it('reads a quantity in words, in digits, and "several"', () => {
    expect(owesBasketDelivery(SOFIA_NO_DELIVERY, 'If five customers from the same location place orders at the same time, can you fulfil them?')).toBe(true);
    expect(owesBasketDelivery(SOFIA_NO_DELIVERY, 'I would like to buy 12 of these for my club.')).toBe(true);
    expect(owesBasketDelivery(SOFIA_NO_DELIVERY, 'Can I order several units for an event?')).toBe(true);
  });
  it('asks nothing of a reply to a customer who mentioned no quantity', () => {
    expect(owesBasketDelivery(SOFIA_NO_DELIVERY, 'Is the large dog bed available?')).toBe(false);
    expect(owesBasketDelivery(SOFIA_NO_DELIVERY, '')).toBe(false);
  });
  it('findDraftIssues raises it on a buying lane only, and never tells the reviser that delivery rises per item', () => {
    const issues = findDraftIssues(SOFIA_NO_DELIVERY, { customerText: SOFIA_ASK, buyingLane: true });
    expect(issues.some((i) => i.includes('add ONE sentence'))).toBe(true);
    expect(issues.join(' ')).not.toMatch(/number of items/i);
    expect(findDraftIssues(SOFIA_NO_DELIVERY, { customerText: SOFIA_ASK, buyingLane: false }).some((i) => i.includes('add ONE sentence'))).toBe(false);
    expect(findDraftIssues(SOFIA_NO_DELIVERY, { customerText: SOFIA_ASK }).some((i) => i.includes('add ONE sentence'))).toBe(false);
    expect(findDraftIssues(SOFIA_GOOD, { customerText: SOFIA_ASK, buyingLane: true })).toEqual([]);
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

// Owner rule 2026-09-04: never send the same message twice on a thread. For LLM
// drafts the repeat is a QUALITY ISSUE, so the existing self-correction loop asks
// the reviser for a shorter reply that does not repeat what we already sent.
describe('findDraftIssues: repeating a reply we already sent', () => {
  const SENT = 'Thank you for those details, much appreciated. We are taking a look and reviewing the fit, and we will be in touch shortly with the next step.';
  it('flags a candidate that repeats a prior outbound on the thread and asks for a shorter, non-repeating reply', () => {
    const issues = findDraftIssues(SENT, { priorOutbound: ['Hi Jo,\n\n' + SENT + '\n\nBest Regards,\nActive Paw'] });
    expect(issues.some((i) => /already sent/i.test(i) && /shorter/i.test(i))).toBe(true);
  });
  it('does not flag a fresh reply, and skips the check when no prior outbound is given', () => {
    expect(findDraftIssues('Yes, we ship to Ireland; delivery takes five to seven working days from dispatch.', { priorOutbound: [SENT] })).toEqual([]);
    expect(findDraftIssues(SENT, {})).toEqual([]);
  });
});

describe('promisesSupplier (supplier lane, owner decision 2026-09-27)', () => {
  const clean = 'Thank you for sharing your tofu and pine cat litter lines. You are welcome to email over your catalogue. If you have a website or an Alibaba store, please send us the link for our reference, and let us know whether you offer dropshipping, that is, sending single orders directly to our customers. We keep supplier details on file for reference.';
  it('passes a clean acknowledgement, including the dropshipping question', () => {
    expect(promisesSupplier(clean)).toBe(false);
    expect(promisesSupplier('We keep supplier contact on email and are not arranging samples or calls.')).toBe(false);
  });
  it.each([
    'We will be in touch if anything fits.',
    "We'll review your catalogue next week.",
    'We would consider placing an order.',
    'We will contact you soon.',
    'We look forward to working with you.',
    'We are open to a partnership.',
    'Please send us some samples.',
    "We'd be happy to arrange a call.",
    'Happy to schedule a quick meeting.',
    "Let's continue on WhatsApp.",
    'We are not ordering at this stage.',
    'Nothing is needed for now.',
    'Apply at https://activepaw.co.uk/apps/pawscout/affiliate/apply',
    'Our affiliate programme pays 2% commission.',
  ])('flags %s', (t) => { expect(promisesSupplier(t)).toBe(true); });

  it('findDraftIssues raises it only on the supplier lane', () => {
    const t = 'Thank you for your catalogue of felt pet beds. We will be in touch soon about an order.';
    expect(findDraftIssues(t, { supplierLane: true }).join(' ')).toMatch(/promise/i);
    expect(findDraftIssues(t, {}).join(' ')).not.toMatch(/promise/i);
  });

  it.each([
    'We\'d love to try a sample.',
    'Happy to jump on a call.',
    'Let\'s set up a trial order.',
    'Could we set up a quick call next week?',
  ])('flags (new patterns fix 2026-09-27) %s', (t) => { expect(promisesSupplier(t)).toBe(true); });

  it('flags promises with curly apostrophes', () => {
    const curly = String.fromCharCode(8217);
    expect(promisesSupplier('We' + curly + 'll review your catalogue next week.')).toBe(true);
  });

  it.each([
    'Thank you for the offer of samples.',
    'Please send your catalogue by email and we keep it on file for reference.',
    'Let us know whether you offer dropshipping.',
    'We keep supplier contact on email and are not arranging samples or calls.',
  ])('stays clean (new patterns fix 2026-09-27) %s', (t) => { expect(promisesSupplier(t)).toBe(false); });

  // Fix round 2 (2026-09-27): promisesSupplier was flagging correct refusals.
  // A negation guard clears a guarded pattern's match when one of a fixed set
  // of negation words appears in its own clause, within 30 characters before
  // the match start.
  it.each([
    'There is no need to send samples.',
    'We are not able to set up a call.',
    'Please do not send us samples.',
    'We cannot jump on a call right now.',
  ])('a correct refusal stays clean (negation guard) %s', (t) => { expect(promisesSupplier(t)).toBe(false); });

  it.each([
    // Unguarded "at this stage" pattern: still flags despite a nearby "not".
    'We will not be placing orders at this stage.',
    // Unguarded partnership pattern: still flags regardless of negation.
    'Thank you for your partnership proposal.',
    // The negation in the first clause ("cannot") must not bleed across the
    // comma into the second, unrelated clause's genuine promise ("we will
    // review your catalogue").
    'We cannot promise anything, but we will review your catalogue.',
    // A conjunction without a comma still opens a new clause (final review).
    'Not sure yet but we will place an order soon.',
    'We cannot promise anything but we will review your catalogue.',
    'We do not need a call and we will review your catalogue.',
  ])('the negation guard never clears an unguarded pattern or a different clause %s', (t) => { expect(promisesSupplier(t)).toBe(true); });

  it('the negation guard matches whole words only, never a substring inside another word', () => {
    // "noted" contains "not" as a substring; a naive substring check would
    // wrongly clear the later, unrelated "we will review it" promise.
    expect(promisesSupplier('We have noted your catalogue and we will review it.')).toBe(true);
  });
});

// The live miss these checks exist to catch (Douke preview, 2026-09-28 22:36Z):
// the reading said no website, no store link and no dropshipping answer, and
// the draft asked for neither. Verbatim body, without greeting and sign-off.
const DOUKE_MISS = 'Thank you for the information. We will keep your supplier details on file for reference. If you have any other questions, please do not hesitate to get in touch.';
const GOODS = { website: null, storeLinks: [] as string[], kind: 'goods' as const, dropship: 'unknown' as const };
const ASKS_BOTH = 'Thank you for sharing your tofu cat litter range. You are welcome to email over your catalogue. Please send us your website or Alibaba store link for our reference, and let us know whether you offer dropshipping, that is sending single orders directly to our customers. We keep supplier details on file for reference.';

describe('supplier asks (owner decision 2026-09-28: the draft must ask what the supplier has not told us)', () => {
  it('owes both asks when they gave no link, have not answered on dropshipping, and we never asked', () => {
    expect(supplierAsksOwed(GOODS, [])).toEqual({ link: true, dropship: true });
  });

  it('owes nothing without a supplier reading', () => {
    expect(supplierAsksOwed(null, [])).toEqual({ link: false, dropship: false });
  });

  it('does not owe the link once they gave a website or a store link', () => {
    expect(supplierAsksOwed({ ...GOODS, website: 'https://x.cn' }, []).link).toBe(false);
    expect(supplierAsksOwed({ ...GOODS, storeLinks: ['https://x.en.alibaba.com'] }, []).link).toBe(false);
  });

  it('asks each question once: an earlier reply of ours that asked it counts (Andasea, 2026-09-18)', () => {
    const ownersEdit = 'It is better if you can leave your website address or preferably alibaba store if you have for our later reference.';
    expect(supplierAsksOwed(GOODS, [ownersEdit])).toEqual({ link: false, dropship: true });
    expect(supplierAsksOwed(GOODS, [null, 'Do you offer dropshipping?']).dropship).toBe(false);
  });

  it('never owes the dropshipping question to a logistics sender, or once they answered it', () => {
    expect(supplierAsksOwed({ ...GOODS, kind: 'logistics' }, [])).toEqual({ link: true, dropship: false });
    expect(supplierAsksOwed({ ...GOODS, dropship: 'yes' }, []).dropship).toBe(false);
    expect(supplierAsksOwed({ ...GOODS, kind: 'packaging' }, []).dropship).toBe(true);
  });

  it('flags the Douke draft for both missing asks, and only on the supplier lane', () => {
    const issues = findDraftIssues(DOUKE_MISS, { supplierLane: true, supplierOwes: { link: true, dropship: true } }).join(' ');
    expect(issues).toMatch(/website/i);
    expect(issues).toMatch(/dropshipping/i);
    expect(findDraftIssues(DOUKE_MISS, { supplierOwes: { link: true, dropship: true } })).toEqual([]);
  });

  it('passes a draft that asks both, and a draft that owes nothing', () => {
    expect(findDraftIssues(ASKS_BOTH, { supplierLane: true, supplierOwes: { link: true, dropship: true } })).toEqual([]);
    expect(findDraftIssues(DOUKE_MISS, { supplierLane: true, supplierOwes: { link: false, dropship: false } })).toEqual([]);
  });

  it('does not read a mention of OUR website as asking for theirs', () => {
    expect(asksSupplierLink('You can see our full range on our website.')).toBe(false);
    expect(asksSupplierLink('Please send us the link to your website or online store.')).toBe(true);
  });

  it('appends the fixed questions a draft still misses, and nothing it already asks', () => {
    const both = appendSupplierAsks(DOUKE_MISS, { link: true, dropship: true });
    expect(both.startsWith(DOUKE_MISS)).toBe(true);
    expect(asksSupplierLink(both)).toBe(true);
    expect(both).toMatch(/dropshipping/i);
    expect(appendSupplierAsks(ASKS_BOTH, { link: true, dropship: true })).toBe(ASKS_BOTH);
    expect(appendSupplierAsks(DOUKE_MISS, { link: false, dropship: false })).toBe(DOUKE_MISS);
    expect(promisesSupplier(both)).toBe(false);
  });
});

describe('one thank-you at the top (design 2026-11-14, 7.3)', () => {
  it('removes a second thank-you sentence at the top', () => {
    const b = 'Thank you for informing us! Thank you for sharing details of your pet bowls range. Could you send your website link?';
    expect(repeatsThanks(b)).toBe(true);
    expect(collapseRepeatedThanks(b)).toBe('Thank you for informing us! Could you send your website link?');
    expect(findDraftIssues(b).join(' ')).toContain('The reply thanks them twice at the start. Keep only the first thank-you and continue with the answer.');
  });
  it('leaves a single thank-you alone', () => {
    expect(repeatsThanks('Thank you for your enquiry! Yes, we ship to Ireland.')).toBe(false);
    expect(collapseRepeatedThanks('Thank you for your enquiry! Yes, we ship to Ireland.')).toBe('Thank you for your enquiry! Yes, we ship to Ireland.');
  });
  it('also catches the second thank-you opening the next paragraph', () => {
    const b = 'Thank you for informing us!\n\nThanks for sharing your range. Could you send your website link?';
    expect(repeatsThanks(b)).toBe(true);
    expect(collapseRepeatedThanks(b)).toBe('Thank you for informing us!\n\nCould you send your website link?');
  });
  it('a thank-you later in the reply is not a repeat', () => {
    const b = 'Thank you for your enquiry! Yes, we ship to Ireland. Thank you for your patience.';
    expect(repeatsThanks(b)).toBe(false);
  });
  it('removes the repeat when it is the last sentence', () => {
    expect(collapseRepeatedThanks('Thank you for informing us! Thanks again.')).toBe('Thank you for informing us!');
  });
});

describe('honest replies about files (design 2026-11-14, section 6)', () => {
  const NONE = { held: [], refused: [], openHasRecord: false };
  // FOOFEE thread 2d6559b9: the reply thanked them for a catalogue we never held.
  const FOOFEE = 'Thank you for sending the FOOFEE catalogue and the details of your range. We have received the information.';
  // Thread de23fa70: the reply asked for a catalogue that had arrived.
  const DE23 = 'You are welcome to email over your catalogue, price list or specifications.';

  it('rule A: a receipt claim with nothing held is an issue and a file_claim hold', () => {
    expect(claimsFileReceived(FOOFEE)).toBe(true);
    expect(findDraftIssues(FOOFEE, { files: NONE }).join(' ')).toMatch(/claim that a file arrived/i);
    expect(fileHoldReasons(FOOFEE, NONE, true)).toEqual(['file_claim']);
    expect(fileHoldReasons(FOOFEE, NONE, false)).toEqual(['file_claim']); // every lane
    expect(fileHoldReasons(FOOFEE, { held: ['FOOFEE.pdf'], refused: [], openHasRecord: true }, true)).toEqual([]);
    expect(findDraftIssues(FOOFEE, { files: { held: ['FOOFEE.pdf'], refused: [], openHasRecord: true } })).toEqual([]);
  });

  it('rule A stays quiet on information in the email body', () => expect(claimsFileReceived('Thank you for the information in your email about your bowls.')).toBe(false));

  it('rule A stays quiet on a negated, conditional or missing-file sentence', () => {
    expect(claimsFileReceived('We have not received the catalogue you mentioned.')).toBe(false);
    expect(claimsFileReceived('If you have got a catalogue, you are welcome to email it.')).toBe(false);
    expect(claimsFileReceived(FILE_MISSING_SENTENCE)).toBe(false);
    expect(claimsFileReceived(FILE_REFUSED_SENTENCE)).toBe(false);
    expect(claimsFileReceived('Thanks for sharing your price list.')).toBe(true);
  });

  it('rule B: inviting a file we already hold is a file_reinvite hold, supplier lane only', () => {
    expect(invitesFiles(DE23)).toBe(true);
    const held = { held: ['cat.pdf'], refused: [], openHasRecord: true };
    expect(fileHoldReasons(DE23, held, true)).toEqual(['file_reinvite']);
    expect(fileHoldReasons(DE23, NONE, true)).toEqual([]);
    expect(fileHoldReasons(DE23, held, false)).toEqual([]);
    expect(findDraftIssues(DE23, { supplierLane: true, files: held }).join(' ')).toMatch(/already sent/i);
    expect(invitesFiles('Please send us the link to your website.')).toBe(false);
    expect(invitesFiles(FILE_MISSING_SENTENCE)).toBe(false);
    expect(invitesFiles(FILE_REFUSED_SENTENCE)).toBe(false);
  });

  it('rule C: an attachment mentioned but not received is owed the missing-file sentence', () => {
    for (const s of ['Please find attached our offer.', 'See the attachment for details.', 'I have enclosed our price list.', 'Attached is our catalogue.']) {
      expect(mentionsAttachment(s)).toBe(true);
    }
    expect(mentionsAttachment('We are attached to quality.')).toBe(false);
    expect(mentionsAttachment('I will send the catalogue.')).toBe(false);
    const open = 'Please find our catalogue attached.';
    expect(fileAsksOwed(NONE, open)).toEqual({ missing: true, refused: false });
    expect(fileAsksOwed({ ...NONE, openHasRecord: true }, open).missing).toBe(false);
    expect(fileAsksOwed({ ...NONE, held: ['old.pdf'] }, open).missing).toBe(false);
    expect(fileAsksOwed({ ...NONE, offNiche: true }, open).missing).toBe(false);
    expect(fileAsksOwed(undefined, open)).toEqual({ missing: false, refused: false });
    expect(findDraftIssues('Thank you for your message about your bowls range.', { files: NONE, openText: open }).join(' ')).toMatch(/did not reach us/i);
  });

  // Final review 2026-11-14 (Important 1): the bare word "attachment" is not a
  // mention of a file sent to us. A confidentiality footer and a product part
  // ("comb attachment") made replies say a file did not reach us.
  it('rule C stays quiet on a confidentiality footer and on a product attachment', () => {
    for (const s of [
      'This email and any attachments are confidential and intended solely for the addressee.',
      'This message and any attached files are confidential. If you are not the intended recipient, please delete it.',
      'Does the clipper come with a comb attachment?',
      'Is the hose attachment included with the pet dryer?',
    ]) expect(mentionsAttachment(s), s).toBe(false);
    expect(fileAsksOwed(NONE, 'Hello, do you stock dog beds?\n\nThis email and any attachments are confidential.')).toEqual({ missing: false, refused: false });
    // A real mention still counts, also beside a footer.
    expect(mentionsAttachment('Please see the attached price list.\n\nThis email and any attachments are confidential.')).toBe(true);
    for (const s of ["We've attached it here.", 'Kindly check the attachment.', 'The details are in the attachment.', 'Please see attached.']) {
      expect(mentionsAttachment(s), s).toBe(true);
    }
  });

  // Final review 2026-11-14 (Important 3): "on file" and "file a claim" name no
  // document. "We keep supplier details on file" is the supplier lane's own
  // sentence, and beside "received" it was held as a false file claim.
  it('rule A stays quiet on "on file" and on "file a return"', () => {
    for (const s of [
      'We have received your details and keep them on file for reference.',
      'Thank you for sharing your company details, which we keep on file for reference.',
      'We have got your message and keep supplier details on file.',
      'We have received your request to file a return.',
    ]) expect(claimsFileReceived(s), s).toBe(false);
    expect(fileHoldReasons('We have received your details and keep them on file for reference.', NONE, true)).toEqual([]);
    // A real claim beside the idiom, or in the passive, still counts.
    expect(claimsFileReceived('We have received your catalogue and keep it on file.')).toBe(true);
    expect(claimsFileReceived('Your price list has been received.')).toBe(true);
  });

  it('rule D: a refused file is owed the refused-file sentence, except off-niche', () => {
    const files = { held: [], refused: ['p.xlsm'], openHasRecord: true };
    expect(fileAsksOwed(files, 'Prices attached.')).toEqual({ missing: false, refused: true });
    expect(fileAsksOwed({ ...files, offNiche: true }, 'Prices attached.').refused).toBe(false);
    expect(findDraftIssues('Thank you for your message about your bowls range.', { files, openText: 'Prices attached.' }).join(' ')).toMatch(/could not accept/i);
  });

  it('appendFileAsks appends each sentence once, as its own paragraph', () => {
    const body = 'Thank you for your message about your bowls range.';
    expect(appendFileAsks(body, { missing: true, refused: true })).toBe(`${body}\n\n${FILE_MISSING_SENTENCE}\n\n${FILE_REFUSED_SENTENCE}`);
    expect(appendFileAsks(body, { missing: false, refused: false })).toBe(body);
    const said = `${body} Unfortunately the file did not reach us, so please send it again. We were not able to accept the spreadsheet either.`;
    expect(appendFileAsks(said, { missing: true, refused: true })).toBe(said);
    const once = appendFileAsks(body, { missing: true, refused: false });
    expect(appendFileAsks(once, { missing: true, refused: false })).toBe(once);
  });

  it('the no-promises reviser text never invites a catalogue we already hold (design section 6, item 3)', () => {
    const promising = 'Thank you for your range. We will be in touch about an order.';
    const held = findDraftIssues(promising, { supplierLane: true, files: { held: ['cat.pdf'], refused: [], openHasRecord: true } }).join(' ');
    expect(held).toMatch(/promise/i);
    expect(held).not.toMatch(/welcome to email/i);
    const none = findDraftIssues(promising, { supplierLane: true, files: NONE }).join(' ');
    expect(none).toMatch(/welcome to email/i);
  });

  it('off-niche suppliers: no asks, no catalogue invitation, no file sentences, 40 words (design 8.2)', () => {
    expect(supplierAsksOwed({ website: null, storeLinks: [], kind: 'goods', dropship: 'unknown', nicheFit: 'off-niche' }, [])).toEqual({ link: false, dropship: false });
    expect(supplierAsksOwed({ website: null, storeLinks: [], kind: 'goods', dropship: 'unknown', nicheFit: 'adjacent' }, [])).toEqual({ link: true, dropship: true });
    const invite = 'Thank you for informing us! You are welcome to send us your catalogue.';
    expect(findDraftIssues(invite, { supplierLane: true, offNiche: true }).join(' ')).toMatch(/do not invite a catalogue/i);
    expect(findDraftIssues(invite, { supplierLane: true })).toEqual([]);
    const words45 = Array.from({ length: 45 }, (_, i) => (i === 0 ? 'Noted' : 'word')).join(' ') + '.';
    expect(findDraftIssues(words45, { maxWords: 40 }).join(' ')).toMatch(/too long/i);
    expect(fileAsksOwed({ ...NONE, offNiche: true }, 'catalogue attached')).toEqual({ missing: false, refused: false });
  });

  it('the fixed sentences never echo a filename', () => {
    expect(FILE_MISSING_SENTENCE).toBe('Unfortunately the file you mentioned did not reach us. Could you send it again, or share a link to it?');
    expect(FILE_REFUSED_SENTENCE).toBe('We were not able to accept the file you sent. Could you send it as a PDF, or share a link to it?');
  });
});
