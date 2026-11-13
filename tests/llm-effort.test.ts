// Reasoning effort on the OpenRouter tier (spec 5.10). OpenRouter turns an
// effort into a thinking budget carved out of max_tokens for Anthropic models
// (0.95 of it at max/xhigh, 0.8 at high), so the cap must grow with the effort
// or the answer starves: the "empty content reads as non-JSON" failure of
// 2026-08 (see REASONING_HEADROOM). With no effort set, the request body must be
// exactly what it was before efforts existed.
import { describe, it, expect } from 'vitest';
import { LlmClient, effortMaxTokens, EFFORT_TOKEN_CEILING, type ChainTier } from '../src/llm';
import type { ReasoningEffort } from '../src/types';

function recordingFetch(bodies: Record<string, unknown>[]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      model: 'a/b',
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function bodyFor(tier: ChainTier): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const llm = new LlmClient({ openrouter: 'k', openai: 'k' }, recordingFetch(bodies));
  const r = await llm.jsonChain({ chain: [tier], system: 's', user: 'u', maxTokens: 1200, validate: (v) => v });
  expect(r.ok).toBe(true);
  return bodies[0];
}

describe('effortMaxTokens', () => {
  it('no effort keeps the old floor', () => {
    expect(effortMaxTokens(1200)).toBe(3000);
    expect(effortMaxTokens(4800)).toBe(4800);
  });

  it('sizes the cap by the share left for the answer', () => {
    const at = (e: ReasoningEffort) => effortMaxTokens(1200, e);
    expect([at('none'), at('minimal'), at('low'), at('medium'), at('high'), at('xhigh'), at('max')])
      .toEqual([3000, 3334, 3750, 6000, 15000, 60000, 60000]);
    expect(effortMaxTokens(4800, 'high')).toBe(24000);
    expect(effortMaxTokens(4800, 'max')).toBe(EFFORT_TOKEN_CEILING);
  });
});

describe('LlmClient request body', () => {
  it('sends reasoning.effort and the sized cap only when an effort is set', async () => {
    const withEffort = await bodyFor({ provider: 'openrouter', models: ['a/b'], effort: 'high' });
    expect(withEffort.reasoning).toEqual({ effort: 'high' });
    expect(withEffort.max_tokens).toBe(15000);

    const without = await bodyFor({ provider: 'openrouter', models: ['a/b'] });
    expect('reasoning' in without).toBe(false);
    expect(without.max_tokens).toBe(3000);
  });

  it('leaves the OpenAI floor unchanged', async () => {
    const body = await bodyFor({ provider: 'openai', model: 'gpt-x' });
    expect(body.reasoning_effort).toBe('medium');
    expect('reasoning' in body).toBe(false);
  });
});
