import { describe, it, expect } from 'vitest';
import { leadAgent } from '../../src/inbox/agents/lead';

describe('leadAgent', () => {
  it('is commercial and prompts for one concrete next step', async () => {
    expect(leadAgent.commercial).toBe(true);
    const g = await leadAgent.ground({} as any);
    expect(leadAgent.promptFragment(g).toLowerCase()).toContain('next step');
  });

  // Mary (thread c291f953) got a draft claiming we'd been "supporting pet owners for a
  // number of years" - a fabricated tenure. A relationship-probing lead must be answered
  // warmly WITHOUT inventing company history/tenure/backstory.
  it('forbids fabricating company history or tenure for brand-curious leads', async () => {
    const g = await leadAgent.ground({} as any);
    const p = leadAgent.promptFragment(g);
    expect(p).toMatch(/(?:do not|don't|never)\s+(?:invent|fabricate|make up)[^.]*\b(?:history|tenure|backstory|years|how long)\b/i);
  });
});
