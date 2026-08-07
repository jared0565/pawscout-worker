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

  it('routes to the application page (owner policy 2026-07-18): no email screening', async () => {
    const g = await affiliateAgent.ground({} as any);
    const p = affiliateAgent.promptFragment(g);
    expect(p).toContain(AFFILIATE_APPLY_URL);           // the one place partnerships start
    const lower = p.toLowerCase();
    expect(lower).toContain('no qualifying questions'); // the form screens, not email
    expect(lower).toContain('never needed and never granted'); // store access is a hard no
    expect(lower).toContain('answer whatever they actually asked'); // grounded-reply rule intact
    expect(affiliateAgent.department).toBe('partnership');
  });

  // Owner ruling 2026-08-07, REVERSING the 2026-07-18 "no committed terms" rule
  // that this file used to pin with `expect(lower).toContain('never commit')`.
  // That instruction is why a live prospect asking "what percentage would you
  // offer?" was told we have no percentage offer at all. The rate is now stated
  // in the reply; what stays forbidden is inventing terms BEYOND it.
  it('states the commission rate and refuses to negotiate it', async () => {
    const g = await affiliateAgent.ground({} as any);
    const lower = affiliateAgent.promptFragment(g).toLowerCase();
    expect(lower).toContain('always state the commission in figures');
    expect(lower).toContain('2%');
    expect(lower).toContain('5%');
    expect(lower).toContain('never agree a different rate');
    expect(lower).toContain('only partnership');            // never imply we have none
    expect(lower).not.toContain('never commit in email to any commission rate');
    // Terms beyond the published rate are still off limits.
    expect(lower).toContain('never promise a discount code');
  });
});
