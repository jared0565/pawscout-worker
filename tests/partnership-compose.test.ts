import { describe, it, expect } from 'vitest';
import {
  buildQualifyingEmail, buildPartnershipDecline, buildFormInvite, buildVoucherInvite, buildHoldingAck,
  buildServiceDecline, buildSignupInvite, AFFILIATE_APPLY_URL, PARTNERSHIP_STANCE, STANDARD_COMMISSION_PCT
} from '../src/inbox/partnership';

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
  it('decline is warm, leaves a door open, signed by Partnerships', () => {
    const body = buildPartnershipDecline('Sam');
    expect(body.startsWith('Hi Sam,')).toBe(true);
    expect(body).toMatch(/appreciate/i);
    expect(body).toMatch(/not taking on new partnerships/i);
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
    ['service decline', buildServiceDecline('Jo')],
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

  // The service decline is the one place the programme is raised inside a
  // REFUSAL, so it has to stay a refusal: the link is an alternative door, not
  // a softening of the in-house policy.
  it('the service decline still declines the service while linking the programme', () => {
    const body = buildServiceDecline('Jo');
    expect(body).toMatch(/in-house/);
    expect(body).toMatch(/do not grant store, admin, or collaborator access/);
  });

  // Owner rule 2026-09-04: vendors who keep offering their services are told
  // about the ONE collaboration that exists, plainly and with its terms, so the
  // answer is complete and there is nothing left to follow up on. The old body
  // offered the programme only conditionally ("If you run a channel...") and
  // gave no rate, which read as a door left ajar.
  it('the service decline names the affiliate programme as the only collaboration on offer, with its rate', () => {
    const body = buildServiceDecline('Jo');
    expect(body).toMatch(/only collaboration we (?:currently )?run/i);
    expect(body).toContain(AFFILIATE_APPLY_URL);
    expect(body).toContain(`${STANDARD_COMMISSION_PCT}%`);
    expect(body).not.toMatch(/If you run a channel or audience/);
    expect(body).toMatch(/no reply is needed/i);
  });
});
