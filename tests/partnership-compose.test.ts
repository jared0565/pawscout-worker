import { describe, it, expect } from 'vitest';
import { buildQualifyingEmail, buildPartnershipDecline, buildFormInvite, buildHoldingAck } from '../src/inbox/partnership';

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
});
