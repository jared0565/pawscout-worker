import { describe, it, expect } from 'vitest';
import { wholesaleAgent } from '../../src/inbox/agents/wholesale';

describe('wholesaleAgent', () => {
  it('declines trade terms without implying a programme exists', async () => {
    const g = await wholesaleAgent.ground({} as any);
    const p = wholesaleAgent.promptFragment(g).toLowerCase();
    expect(p).toContain('not offering');
    expect(p).toContain('do not imply');
  });

  // Sofia thread (2026-09-20): "I have 5 customers who need this product for an
  // event ... is it available?" was labelled wholesale-b2b, and this agent opened
  // with "we are not offering wholesale or trade terms" although she never asked
  // for any. Owner rule 2026-09-21: a quantity is a purchase, never a reason to
  // turn a buyer away; the decline is owed only to someone who ASKS for terms.
  it('declines ONLY when the sender asked for trade terms, and never turns a purchase away', async () => {
    const p = wholesaleAgent.promptFragment(await wholesaleAgent.ground({} as any));
    expect(p).toMatch(/ONLY if the customer's own words ask for/);
    expect(p).toMatch(/never mention wholesale/i);
    expect(p).toMatch(/never refuse, discourage or turn away a purchase/i);
  });

  // Measured at the live checkout on 2026-09-21 (a China-held item, UK and US
  // addresses, 1 and 5 units): the delivery line is one flat rate per order per
  // origin, the same for 1 as for 5. The first version of this prompt said the
  // cost "depends on the number of items", which is what the supplier charges
  // us, not what the customer pays. The customer-facing sentence is destination
  // and basket contents, and the exact total at checkout.
  it('tells a quantity buyer how to order and where the delivery cost is shown, without claiming it rises per item', async () => {
    const p = wholesaleAgent.promptFragment(await wholesaleAgent.ground({} as any));
    expect(p).toMatch(/any quantity/i);
    expect(p).toMatch(/destination and what is in the basket/i);
    expect(p).toMatch(/shown at checkout before payment/i);
    expect(p).toMatch(/which product/i);
    expect(p).not.toMatch(/number of items/i);
  });

  it('advances the sale like the lead agent does', () => {
    expect(wholesaleAgent.commercial).toBe(true);
  });
});
