import { describe, it, expect } from 'vitest';
import { complaintAgent } from '../../src/inbox/agents/complaint';

describe('complaintAgent', () => {
  it('is excluded from the commercial objective and de-escalates', async () => {
    expect(complaintAgent.commercial).toBe(false);
    const g = await complaintAgent.ground({} as any);
    const p = complaintAgent.promptFragment(g).toLowerCase();
    expect(p).toContain('apolog');
    expect(p).toContain('do not upsell');
  });
});
