import { describe, it, expect } from 'vitest';
import { isPartnershipLane } from '../src/inbox/partnership';

describe('isPartnershipLane', () => {
  it('true when classified affiliate', () => {
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: 'affiliate' })).toBe(true);
  });
  it('false for wholesale-b2b - a trade buyer is a different conversation (excluded by design)', () => {
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: 'wholesale-b2b' })).toBe(false);
  });
  it('false for a buyer question sent to sales@ - classification still owns the funnel', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['SALES@activepaw.co.uk'], declaredIntent: null, primaryCategory: 'product-question' })).toBe(false);
  });
  it('true when declared intent is partnerships (Phase 2 signal)', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['support@activepaw.co.uk'], declaredIntent: 'partnerships', primaryCategory: 'other' })).toBe(true);
  });
  it('false for an ordinary support thread', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['support@activepaw.co.uk'], declaredIntent: null, primaryCategory: 'product-question' })).toBe(false);
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: null })).toBe(false);
  });
});
