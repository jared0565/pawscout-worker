import { describe, it, expect } from 'vitest';
import { resolveFromAddress } from '../src/inbox/partnership';

describe('resolveFromAddress', () => {
  it('partnership lane → sales@ partnerships identity', () => {
    expect(resolveFromAddress({ partnershipLane: true, toAddr: 'support@activepaw.co.uk' }))
      .toBe('Active Paw Partnerships <sales@activepaw.co.uk>');
  });
  it('non-partnership replies from the address written to (own domain)', () => {
    expect(resolveFromAddress({ partnershipLane: false, toAddr: 'contact@activepaw.co.uk' }))
      .toBe('Active Paw <contact@activepaw.co.uk>');
  });
  it('falls back to support@ when the to-address is unknown or off-domain', () => {
    expect(resolveFromAddress({ partnershipLane: false, toAddr: null }))
      .toBe('Active Paw <support@activepaw.co.uk>');
    expect(resolveFromAddress({ partnershipLane: false, toAddr: 'someone@gmail.com' }))
      .toBe('Active Paw <support@activepaw.co.uk>');
  });
});
