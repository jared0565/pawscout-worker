import { describe, it, expect } from 'vitest';
import { leadAgent } from '../../src/inbox/agents/lead';

describe('leadAgent', () => {
  it('is commercial and prompts for one concrete next step', async () => {
    expect(leadAgent.commercial).toBe(true);
    const g = await leadAgent.ground({} as any);
    expect(leadAgent.promptFragment(g).toLowerCase()).toContain('next step');
  });
});
