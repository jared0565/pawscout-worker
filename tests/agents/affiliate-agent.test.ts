import { describe, it, expect } from 'vitest';
import { affiliateAgent } from '../../src/inbox/agents/affiliate';

describe('affiliateAgent', () => {
  it('is policy-based: always confident, no appendix, commits to nothing', async () => {
    const g = await affiliateAgent.ground({} as any);
    expect(g.confident).toBe(true);
    expect(affiliateAgent.deterministicAppendix(g)).toBeNull();
    expect(affiliateAgent.promptFragment(g).toLowerCase()).toContain('commission');
  });
});
