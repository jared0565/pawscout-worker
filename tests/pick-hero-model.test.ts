import { describe, it, expect } from 'vitest';
import { pickHeroImage } from '../src/llm';
import { CURATED_MODELS } from '../src/models-catalog';

// Stub the LLM client: capture the chain passed to jsonChain, and return the
// shape pickHeroImage expects. A no-op logLlmUsage store keeps this a pure unit
// test (no D1).
function stubLlm(capture: { chain?: any[] }) {
  return {
    available: true,
    jsonChain: async (opts: any) => {
      capture.chain = opts.chain;
      return {
        ok: true,
        value: { index: 0, drop: [], reason: 'x' },
        usage: { provider: 'openrouter', model: 'x', promptTokens: 1, completionTokens: 1, costUsd: 0 },
      };
    },
  } as any;
}
const store = { logLlmUsage: async () => {} } as any;
const cfg = (models: any) => ({ llm: { enabled: true, scoreThreshold: 60, models } } as any);

describe('pickHeroImage model resolution', () => {
  it('sends the configured image model as the OpenRouter primary', async () => {
    const cap: { chain?: any[] } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({ image: 'm/vis' }), 'Dog bed', ['a', 'b']);
    expect(cap.chain![0].models[0]).toBe('m/vis');
  });

  it('falls back to the catalog head when image is blank', async () => {
    const cap: { chain?: any[] } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({}), 'Dog bed', ['a', 'b']);
    expect(cap.chain![0].models[0]).toBe(CURATED_MODELS[0].slug);
  });

  it('adds fallback as the second OpenRouter model', async () => {
    const cap: { chain?: any[] } = {};
    await pickHeroImage(stubLlm(cap), store, cfg({ image: 'm/vis', fallback: 'm/fb' }), 'Dog bed', ['a', 'b']);
    expect(cap.chain![0].models).toEqual(['m/vis', 'm/fb']);
  });
});
