import { describe, it, expect, vi } from 'vitest';
import { LlmClient } from '../src/llm';

const ok = (model: string, content: string, cost = 0.001) => ({
  ok: true, status: 200,
  json: async () => ({ model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost } }),
});

describe('LlmClient.jsonChain', () => {
  it('OpenRouter tier sends models[] + max_tokens + usage:{include}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('a/b', '{"v":1}'));
    const llm = new LlmClient({ openrouter: 'k' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b', 'c/d'] }, { provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as any).body);
    expect(body.models).toEqual(['a/b', 'c/d']);
    expect(body.max_tokens).toBeDefined();
    expect(body.usage).toEqual({ include: true });
  });

  it('advances to OpenAI floor on OpenRouter 404; OpenAI body uses max_completion_tokens + reasoning_effort medium, no usage', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: { message: 'no model', code: 'model_not_found' } }) })
      .mockResolvedValueOnce(ok('gpt-5.4-mini', '{"v":2}'));
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b'] }, { provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', maxTokens: 200, validate: (v: any) => v });
    expect(r.ok && r.value).toEqual({ v: 2 });
    const oaiReq = JSON.parse((fetchImpl.mock.calls[1][1] as any).body);
    expect(oaiReq.max_completion_tokens).toBe(3000); // floored
    expect(oaiReq.reasoning_effort).toBe('medium');
    expect(oaiReq.max_tokens).toBeUndefined();
    expect(oaiReq.usage).toBeUndefined();
    expect((fetchImpl.mock.calls[1][0] as string)).toBe('https://api.openai.com/v1/chat/completions');
    if (r.ok) { expect(r.usage.provider).toBe('openai'); expect(r.usage.costUsd).toBeCloseTo(10/1e6*0.75 + 5/1e6*4.50); }
  });

  it('HTTP 400 invalid_request stops — does NOT advance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error', message: 'bad' } }) });
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b'] }, { provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // stopped, no advance
  });
});
