import { describe, it, expect } from 'vitest';
import { otherAgent } from '../../src/inbox/agents/other';

describe('otherAgent', () => {
  it('is the safe generic fallback with no commercial objective', async () => {
    expect(otherAgent.category).toBe('other');
    expect(otherAgent.commercial).toBe(false);
    const g = await otherAgent.ground({} as any);
    expect(g.confident).toBe(true);
    expect(otherAgent.deterministicAppendix(g)).toBeNull();
  });
});
