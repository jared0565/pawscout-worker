import { describe, it, expect } from 'vitest';
import {
  buildQualifyingEmail, buildPartnershipDecline, buildFormInvite, buildVoucherInvite, buildHoldingAck,
  buildServiceProveFirst, buildSupplierAck, buildSignupInvite, buildOperationsDecline, buildKeepToEmail, buildSecondTouch, buildPointerBack,
  buildCollaborationDecline, detectAlternativeCollaboration, countProgrammeIntroductions,
  TOUCH_TEMPLATES, QUALIFYING_MARKER, AFFILIATE_APPLY_URL, PARTNERSHIP_STANCE, STANDARD_COMMISSION_PCT, TIER_REVIEW_ORDERS, TIER_MAX_PCT
} from '../src/inbox/partnership';
import { countWords } from '../src/inbox/draft-quality';

describe('partnership composers', () => {
  it('qualifying email greets by name and asks the six screening questions', () => {
    const body = buildQualifyingEmail('Jane');
    expect(body.startsWith('Hi Jane,')).toBe(true);
    expect(body).toMatch(/where would you promote/i);   // Q1 channel
    expect(body).toMatch(/audience/i);                    // Q2
    expect(body).toMatch(/how would you plan to promote/i); // Q3 method
    expect(body).toMatch(/partnered with brands/i);       // Q4 experience
    expect(body).toMatch(/performance-based/i);           // Q6 terms
    expect(body).toMatch(/#ad/);                          // disclosure
    expect(body).toContain('Active Paw Partnerships');    // sign-off
  });
  it('falls back to a generic greeting when no name', () => {
    expect(buildQualifyingEmail(null).startsWith('Hi there,')).toBe(true);
  });
  // 2026-09-07: the decline goes out automatically to self-serve applicants the
  // hard gate turns down and on the owner's Decline click, so it must be true
  // under the OPEN programme: their application is not a fit right now. It must
  // never claim we take no partnerships (the old wording, false since the
  // signup page went live).
  it('decline is warm, truthful under the open programme, leaves a door open, signed by Partnerships', () => {
    const body = buildPartnershipDecline('Sam');
    expect(body.startsWith('Hi Sam,')).toBe(true);
    expect(body).toMatch(/appreciate/i);
    expect(body).toMatch(/not a fit for our affiliate programme/i);
    expect(body).not.toMatch(/not taking on new partnerships|no(t| longer) (accept|take|run)/i);
    expect(body).toMatch(/hear from you again/i);
    expect(body).toContain('Best Regards,\nActive Paw Partnerships');
  });
  it('form-invite and holding-ack greet by name and sign off', () => {
    expect(buildFormInvite('Jo')).toContain('Active Paw Partnerships');
    expect(buildHoldingAck('Jo')).toMatch(/taking a look|reviewing/i);
  });
  // 2026-07-05: both invites ASK for marketing opt-in (PECR: pitching us is not
  // consent to a mailing list). Consent itself is recorded by the owner in the
  // Partners view; silence means no.
  it('both invites carry the optional marketing opt-in ask', () => {
    for (const body of [buildFormInvite('Jo'), buildVoucherInvite('Jo')]) {
      expect(body).toMatch(/occasional partner updates/i);
      expect(body).toMatch(/leaving it unanswered simply means no/i);
    }
  });
});

// OWNER RULE 2026-08-14: "when affiliate is introduced, make sure to also give
// the direct link to the form." Every surface that TELLS a sender the programme
// exists must also tell them where to apply. The failure this pins is not a
// wrong statement, it is a dead end: buildServiceDecline used to say the
// programme "is open to anyone - just let us know and we will send you the
// details", leaving a willing creator with nothing to click and us with a
// promise to chase by hand. The form is live, self-serve and carries its own
// screener, so there is nothing to withhold.
describe('an affiliate mention always carries the apply link', () => {
  // Driven off the URL constant, so a copy rewrite that drops the link fails
  // here rather than shipping. Keep this list in step with any new body.
  const SURFACES: [string, string][] = [
    ['service prove-first', buildServiceProveFirst('Jo')],
    ['signup invite', buildSignupInvite('Jo')],
    ['form invite', buildFormInvite('Jo')],
    ['agent stance', PARTNERSHIP_STANCE],
  ];
  for (const [label, body] of SURFACES) {
    it(`${label} names the programme AND the apply URL`, () => {
      expect(body, label).toMatch(/affiliate|partner (?:programme|application)/i);
      expect(body, label).toContain(AFFILIATE_APPLY_URL);
    });
  }

  // The specific dead-end phrasings that prompted the rule. A body may still
  // invite a reply, but never as the ONLY route to the form.
  it('no surface promises to send the details later instead of linking them', () => {
    for (const [label, body] of SURFACES) {
      expect(body, label).not.toMatch(/we will send you the details/i);
      expect(body, label).not.toMatch(/we'll send that over shortly/i);
    }
  });

  // Owner rule 2026-09-17 ("we are receiving too many offers on their services
  // and we are just declining them blankly"): a service pitch is no longer
  // refused. The reply says we receive a lot of offers, that promised results
  // cannot be checked in advance, and that everyone starts with their own
  // affiliate discount code, so tracked orders decide who can actually deliver.
  // It filters rather than declines, states the rate, and never claims the old
  // in-house policy (which read as a blank no).
  it('the service prove-first answer explains the filter, links the code trial and states the rate, without declining', () => {
    const body = buildServiceProveFirst('Jo');
    expect(body.startsWith('Hi Jo,')).toBe(true);
    expect(body).toMatch(/receive a lot of offers/i);
    expect(body).toMatch(/no way to check in advance/i);
    expect(body).toMatch(/who can actually deliver/i);
    expect(body).toContain(AFFILIATE_APPLY_URL);
    expect(body).toContain(`${STANDARD_COMMISSION_PCT}% of the goods value`);
    expect(body).toContain(`${TIER_REVIEW_ORDERS} tracked orders`);
    expect(body).toContain(`up to ${TIER_MAX_PCT}%`);
    expect(body).toMatch(/further conversation/i);
    expect(body).toMatch(/no reply is needed/i);
    expect(body).not.toMatch(/in-house|settled policy|not something we take up|not a fit/i);
    expect(body).not.toMatch(/[\u2013\u2014]/);
    expect(body).toContain('Best Regards,\nActive Paw Partnerships');
  });

  // Owner rule 2026-09-17: a goods supplier (packaging, a "backup supplier"
  // with a catalogue) is neither declined nor sent to the code trial, which
  // cannot measure them. They are thanked for the listing and nothing is
  // promised.
  it('the supplier acknowledgement thanks them for the product information and commits to nothing', () => {
    const body = buildSupplierAck('Celia');
    expect(body.startsWith('Hi Celia,')).toBe(true);
    expect(body).toMatch(/thank you for sending/i);
    expect(body).toMatch(/product (?:information|listing|catalogue)/i);
    expect(body).toMatch(/for reference/i);
    expect(body).not.toMatch(/declin|not a fit|not something we|in-house|affiliate|commission/i);
    expect(body).not.toMatch(/we will (?:place|be placing) an order|order from you|next steps/i);
    expect(body).not.toMatch(/[\u2013\u2014]/);
    expect(body).toContain('Best Regards,\nActive Paw');
  });
});

// Owner rule 2026-09-04: a thread never gets the same message twice; when a
// point has to be made again it is made SHORTER. Every deterministic body has a
// concise second touch and a one-line pointer back to the earlier reply.
describe('second-touch and pointer variants', () => {
  const firstOf: Record<string, string> = {
    signup_invite: buildSignupInvite('Jo'), qualifying: buildQualifyingEmail('Jo', 'voucher'),
    voucher_invite: buildVoucherInvite('Jo'), form_invite: buildFormInvite('Jo'),
    partnership_decline: buildPartnershipDecline('Jo'), service_prove_first: buildServiceProveFirst('Jo'),
    operations_decline: buildOperationsDecline('Jo'), keep_to_email: buildKeepToEmail('Jo'), holding_ack: buildHoldingAck('Jo'),
    collaboration_decline: buildCollaborationDecline('Jo'), supplier_ack: buildSupplierAck('Jo'),
  };
  it('every template has a second touch shorter than the first, and a pointer shorter still', () => {
    expect(TOUCH_TEMPLATES.length).toBe(Object.keys(firstOf).length);
    for (const key of TOUCH_TEMPLATES) {
      const first = firstOf[key];
      const second = buildSecondTouch(key, 'Jo');
      const pointer = buildPointerBack(key, 'Jo');
      expect(first, key).toBeTruthy();
      expect(second.startsWith('Hi Jo,'), key).toBe(true);
      expect(pointer.startsWith('Hi Jo,'), key).toBe(true);
      expect(countWords(second), key).toBeLessThan(countWords(first));
      expect(countWords(pointer), key).toBeLessThan(countWords(second));
      expect(pointer, key).toMatch(/earlier/i);
      expect(second, key).toMatch(/\nActive Paw/); // signed
    }
  });
  it('link-bearing templates keep the apply link in both shorter forms', () => {
    for (const key of ['signup_invite', 'service_prove_first', 'form_invite', 'collaboration_decline'] as const) {
      expect(buildSecondTouch(key, 'Jo'), key).toContain(AFFILIATE_APPLY_URL);
      expect(buildPointerBack(key, 'Jo'), key).toContain(AFFILIATE_APPLY_URL);
    }
  });
  // 2026-09-17: the shorter prove-first touch tells the same filter story.
  it('the shorter prove-first touch keeps the filter story and the link, never the old refusal', () => {
    const second = buildSecondTouch('service_prove_first', 'Jo');
    expect(second).toMatch(/tracked/i);
    expect(second).toMatch(/deliver/i);
    expect(second).not.toMatch(/outside services|in-house/i);
  });
  it('the second-touch qualifying note does not carry the screening marker (it does not re-ask the questions)', () => {
    expect(buildSecondTouch('qualifying', 'Jo')).not.toContain(QUALIFYING_MARKER);
  });
  // 2026-09-07: the shorter decline must tell the same truth as the full one.
  it('the second-touch decline restates the fit decision, never that the programme is closed', () => {
    const second = buildSecondTouch('partnership_decline', 'Jo');
    expect(second).toMatch(/not a fit/i);
    expect(second).not.toMatch(/not taking on new partnerships/i);
  });
});

// Owner rule 2026-09-04 (Paul's thread): "if we have previously introduced the
// partnership program a couple of times and they insist on other form of
// collaboration, then our next reply is just to decline their offer but still
// in a friendly manner." The decline is final on the other arrangement, keeps
// the programme door open with its link, and asks for nothing back.
// 2026-09-17: it is final on SKIPPING THE TRIAL, in the prove-first framing:
// delivered results through a tracked code are the only basis we decide on.
describe('friendly collaboration decline (programme introduced twice, they insist on another arrangement)', () => {
  it('declines skipping the trial plainly, keeps the code trial open with the link, needs no reply', () => {
    const body = buildCollaborationDecline('Paul');
    expect(body.startsWith('Hi Paul,')).toBe(true);
    expect(body).toMatch(/appreciate/i);
    expect(body).toMatch(/do not skip the trial for anyone/i);
    expect(body).toMatch(/tracked code/i);
    expect(body).toMatch(/hands-on, consulting or results-based/i);
    expect(body).toMatch(/settled position/i);
    expect(body).toContain(AFFILIATE_APPLY_URL);
    expect(body).toMatch(/stays open to you/i);
    expect(body).toMatch(/no reply is needed/i);
    expect(body).toMatch(/every success/i);
    expect(body).toContain('Best Regards,\nActive Paw Partnerships');
    // The old partnership decline's falsehood must not come back through here.
    expect(body).not.toMatch(/not a fit for our affiliate programme/i);
    expect(body).not.toMatch(/[–—]/);
  });

  // Grounded in the MESSAGE TEXT only (standing rule). The positives are the
  // live phrasings; the negatives are the ordinary replies an invited applicant
  // sends, none of which may read as a refusal of the programme.
  it('detects insistence on a different arrangement from the sender\'s own words', () => {
    const paul = 'I\'m not looking to operate purely as a referral partner. What I had in mind is a more hands-on growth partnership, where I work alongside you to improve the customer journey, strengthen the store and marketing strategy, and increase conversions, on a results-based collaboration. I completely respect your existing referral structure, but I believe there is more value we could create together.';
    expect(detectAlternativeCollaboration(paul)).toBe(true);
    expect(detectAlternativeCollaboration('Rather than a referral arrangement, I would propose a monthly consulting retainer.')).toBe(true);
    expect(detectAlternativeCollaboration('I would prefer a different kind of partnership where I manage your ads for a share of the profit.')).toBe(true);
    expect(detectAlternativeCollaboration('Instead of the affiliate route, could we look at a performance-based partnership?')).toBe(true);
    for (const plain of [
      'Thanks, I have submitted the application form.',
      'What commission do you offer?',
      'I understand, thanks for the reply.',
      'Where do I find my discount code once approved?',
      'Great, I will apply through the link this week.',
    ]) expect(detectAlternativeCollaboration(plain), plain).toBe(false);
  });

  it('counts the outbound messages that introduced the programme (questions or apply link), never inbound echoes', () => {
    const msgs = [
      { direction: 'inbound', body_text: 'I run a dog page, can we work together?' },
      { direction: 'outbound', body_text: buildQualifyingEmail('Jo', 'voucher') },
      { direction: 'inbound', body_text: `You sent me ${AFFILIATE_APPLY_URL} but I want more than that` },
      { direction: 'outbound', body_text: 'Thanks, we will come back to you.' },
      { direction: 'outbound', body_text: buildSignupInvite('Jo') },
    ];
    expect(countProgrammeIntroductions(msgs)).toBe(2);
    expect(countProgrammeIntroductions(msgs.slice(0, 2))).toBe(1);
    expect(countProgrammeIntroductions([])).toBe(0);
  });
});
