import { describe, it, expect } from 'vitest';
import { isPartnershipLane } from '../src/inbox/partnership';

describe('isPartnershipLane', () => {
  it('true when classified affiliate or wholesale-b2b', () => {
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: 'affiliate' })).toBe(true);
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: 'wholesale-b2b' })).toBe(true);
  });
  it('true when arrived on sales@ (case-insensitive), regardless of category', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['SALES@activepaw.co.uk'], declaredIntent: null, primaryCategory: 'product-question' })).toBe(true);
  });
  it('true when declared intent is partnerships (Phase 2 signal)', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['support@activepaw.co.uk'], declaredIntent: 'partnerships', primaryCategory: 'other' })).toBe(true);
  });
  it('false for an ordinary support thread', () => {
    expect(isPartnershipLane({ inboundToAddrs: ['support@activepaw.co.uk'], declaredIntent: null, primaryCategory: 'product-question' })).toBe(false);
    expect(isPartnershipLane({ inboundToAddrs: [], declaredIntent: null, primaryCategory: null })).toBe(false);
  });
});
