import { describe, it, expect } from 'vitest';
import { affiliateAgent } from '../../src/inbox/agents/affiliate';

describe('affiliateAgent', () => {
  it('is policy-based: always confident, no appendix, commits to nothing', async () => {
    const g = await affiliateAgent.ground({} as any);
    expect(g.confident).toBe(true);
    expect(affiliateAgent.deterministicAppendix(g)).toBeNull();
    expect(affiliateAgent.promptFragment(g).toLowerCase()).toContain('commission');
    expect(affiliateAgent.commercial).toBe(false);
  });

  it('declines ALL partnerships (owner policy 2026-07-03): no qualifying, no invites', async () => {
    const g = await affiliateAgent.ground({} as any);
    const p = affiliateAgent.promptFragment(g).toLowerCase();
    expect(p).toContain('not taking on');
    expect(p).toContain('decline');
    expect(p).toContain('do not ask qualifying questions');
    expect(affiliateAgent.department).toBe('partnership');
  });
});
