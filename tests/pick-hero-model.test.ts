import { describe, it, expect } from 'vitest';
import { pickHeroImage } from '../src/llm';

// Stub the LLM client: capture the model passed to the vision call, and return
// the shape pickHeroImage expects (value + usage). A no-op logLlmUsage store
// keeps this a pure unit test (no D1).
function stubLlm(capture: { model?: string }) {
  return {
    available: true,
    json: async (args: any) => {
      capture.model = args.model;
      return { ok: true, value: { index: 0, drop: [], reason: 'x' }, usage: { model: args.model, promptTokens: 1, completionTokens: 1, costUsd: 0 } };
    },
  } as any;
}
const store = { logLlmUsage: async () => {} } as any;
const cfg = (llm: any) => ({ llm: { enabled: true, ...llm } } as any);

describe('pickHeroImage model resolution', () => {
  it('prefers visionModel over curationModel and model', async () => {
    const cap: { model?: string } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({ model: 'm/base', curationModel: 'm/cur', visionModel: 'm/vis' }), 'Dog bed', ['a', 'b']);
    expect(cap.model).toBe('m/vis');
  });
  it('falls back to curationModel when visionModel unset', async () => {
    const cap: { model?: string } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({ model: 'm/base', curationModel: 'm/cur' }), 'Dog bed', ['a', 'b']);
    expect(cap.model).toBe('m/cur');
  });
  it('falls back to base model when neither visionModel nor curationModel set', async () => {
    const cap: { model?: string } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({ model: 'm/base' }), 'Dog bed', ['a', 'b']);
    expect(cap.model).toBe('m/base');
  });
});
