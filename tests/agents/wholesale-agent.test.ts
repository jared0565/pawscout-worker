import { describe, it, expect } from 'vitest';
import { wholesaleAgent } from '../../src/inbox/agents/wholesale';

describe('wholesaleAgent', () => {
  it('declines trade terms without implying a programme exists', async () => {
    const g = await wholesaleAgent.ground({} as any);
    const p = wholesaleAgent.promptFragment(g).toLowerCase();
    expect(p).toContain('not offering');
    expect(p).toContain('do not imply');
  });
});
