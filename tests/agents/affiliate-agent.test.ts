import { describe, it, expect } from 'vitest';
import { affiliateAgent } from '../../src/inbox/agents/affiliate';
import { AFFILIATE_APPLY_URL } from '../../src/inbox/partnership';

describe('affiliateAgent', () => {
  it('is policy-based: always confident, no appendix, commits to nothing', async () => {
    const g = await affiliateAgent.ground({} as any);
    expect(g.confident).toBe(true);
    expect(affiliateAgent.deterministicAppendix(g)).toBeNull();
    expect(affiliateAgent.promptFragment(g).toLowerCase()).toContain('commission');
    expect(affiliateAgent.commercial).toBe(false);
  });

  it('routes to the application page (owner policy 2026-07-18): no email screening, no committed terms', async () => {
    const g = await affiliateAgent.ground({} as any);
    const p = affiliateAgent.promptFragment(g);
    expect(p).toContain(AFFILIATE_APPLY_URL);           // the one place partnerships start
    const lower = p.toLowerCase();
    expect(lower).toContain('no qualifying questions'); // the form screens, not email
    expect(lower).toContain('never commit');            // no rates/codes promised in email
    expect(lower).toContain('never needed and never granted'); // store access is a hard no
    expect(lower).toContain('answer whatever they actually asked'); // grounded-reply rule intact
    expect(affiliateAgent.department).toBe('partnership');
  });
});
