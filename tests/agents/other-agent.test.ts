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

  // 2026-07-04 owner directive (the azanwatch3 case): the draft declined a
  // "collaboration" the MESSAGE never offered - the subject line alone tripped
  // the pitch branch. Replies must judge by the sender's actual text; an
  // ambiguous message gets its question answered (the owner's 50/50 rule),
  // never a pre-emptive decline.
  it('judges pitch-vs-question from the message text, never the subject alone', () => {
    const p = otherAgent.promptFragment({} as any);
    expect(p).toContain('subject line is context');
    expect(p).toContain('MESSAGE TEXT');
    expect(p).toContain('never a pre-emptive decline');
    // the worked ambiguous example from the live case
    expect(p).toContain('Is your store ready for order?');
    // the decline branch survives for pitches made IN the message text
    expect(p).toContain('not something we are looking into right now');
  });
});
