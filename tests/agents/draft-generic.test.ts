// tests/agents/draft-generic.test.ts
import { describe, it, expect } from 'vitest';
import { draftReply } from '../../src/inbox/draft';
import type { CategoryAgent, Grounding } from '../../src/inbox/agents/types';

// Minimal fake LlmClient: returns a fixed JSON object and records the system prompt.
function fakeLlm(capture: { system?: string }) {
  return {
    available: true,
    async jsonChain(opts: any) {
      capture.system = opts.system;
      const value = opts.validate({ customerAsks: ['x'], bodyText: 'Sure, here is the answer.', confidence: 88, quotesPriceOrOrder: false, commercialIntent: true });
      return { ok: true, value, usage: { model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0 } };
    }
  } as any;
}
const fakeStore = { async logLlmUsage() {} } as any;
const cfg = { inbox: { enabled: true, replyGuidance: '' }, llm: {} } as any;

const stubAgent: CategoryAgent = {
  category: 'product-question', displayName: 'X', description: '', department: 'sales', commercial: true,
  async ground() { return { confident: true, facts: 'FACT-TOKEN', quotesFigure: false }; },
  promptFragment() { return 'FRAGMENT-TOKEN'; },
  deterministicAppendix() { return null; }
};

describe('generic draftReply', () => {
  it('injects the agent fragment + grounded facts into the system prompt', async () => {
    const cap: { system?: string } = {};
    const g: Grounding = { confident: true, facts: 'FACT-TOKEN', quotesFigure: false };
    const r = await draftReply(fakeLlm(cap), fakeStore, cfg, { agent: stubAgent, grounding: g, subject: '', conversation: 'hi', latestMessage: 'hi', customerName: 'Jo' });
    expect(cap.system).toContain('FRAGMENT-TOKEN');
    expect(cap.system).toContain('FACT-TOKEN');
    expect(r?.commercialIntent).toBe(true);
    expect(r?.bodyText.startsWith('Hi Jo,')).toBe(true); // salutation applied
  });
});
