import { describe, it, expect } from 'vitest';
import { autoSendDecision, withExtraHolds } from '../../src/inbox/autosend';

const base = { confidence: 95, threshold: 80, quotesPriceOrOrder: false, bodyText: 'All good.', category: 'complaint', recentAutoCount: 0 };

describe('autoSendDecision per-agent', () => {
  it('sends when autosend (master&&agent) true and floor passes, even for complaint', () => {
    expect(autoSendDecision({ ...base, autosend: true }).send).toBe(true); // no ALWAYS_HOLD anymore
  });
  it('holds when autosend false', () => {
    const d = autoSendDecision({ ...base, autosend: false });
    expect(d.send).toBe(false);
    expect(d.holdReasons).toContain('autosend_off');
  });
  it('still holds on LLM-authored money regardless of toggle', () => {
    const d = autoSendDecision({ ...base, autosend: true, bodyText: 'That will be 20 GBP.' });
    expect(d.send).toBe(false);
    expect(d.holdReasons).toContain('mentions_money');
  });
});

describe('withExtraHolds', () => {
  it('adds the reasons and stops the send', () => {
    expect(withExtraHolds({ send: true, holdReasons: [] }, ['sourcing_offer'])).toEqual({ send: false, holdReasons: ['sourcing_offer'] });
  });
  it('leaves the decision alone when there is nothing extra', () => {
    expect(withExtraHolds({ send: true, holdReasons: [] }, [])).toEqual({ send: true, holdReasons: [] });
  });
});
