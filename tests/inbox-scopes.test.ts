import { describe, it, expect } from 'vitest';
import { hasScope } from '../src/inbox/scopes';

describe('hasScope', () => {
  it('detects a granted scope and rejects a missing one', () => {
    expect(hasScope('read_products,write_draft_orders,read_customers', 'write_draft_orders')).toBe(true);
    expect(hasScope('read_products', 'write_draft_orders')).toBe(false);
    expect(hasScope(null, 'write_draft_orders')).toBe(false);
    expect(hasScope(' write_draft_orders , read_customers ', 'read_customers')).toBe(true);
  });
});
