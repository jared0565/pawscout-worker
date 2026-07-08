import { describe, it, expect, vi } from 'vitest';
import { LlmClient } from '../src/llm';

const ok = (model: string, content: string, cost = 0.001) => ({
  ok: true, status: 200,
  json: async () => ({ model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, cost } }),
});

const CHAIN = [{ provider: 'openrouter' as const, models: ['a/b'] }, { provider: 'openai' as const, model: 'gpt-5.4-mini' }];

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

  it('HTTP 400 invalid_request stops - does NOT advance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { type: 'invalid_request_error', message: 'bad' } }) });
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: [{ provider: 'openrouter', models: ['a/b'] }, { provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // stopped, no advance
  });

  it('429 insufficient_quota → advance immediately (no retry); OpenAI serves', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota', message: 'quota' } }) })
      .mockResolvedValueOnce(ok('gpt-5.4-mini', '{"v":3}'));
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: CHAIN, system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usage.provider).toBe('openai');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 OpenRouter (no retry) + 1 OpenAI
    expect((fetchImpl.mock.calls[0][0] as string)).toContain('openrouter.ai');
  });

  it('429 rate_limit_exceeded → retry SAME tier once; succeeds on retry without touching OpenAI', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }) })
      .mockResolvedValueOnce(ok('a/b', '{"v":4}'));
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: CHAIN, system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usage.provider).toBe('openrouter');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // both to OpenRouter
    expect((fetchImpl.mock.calls[0][0] as string)).toContain('openrouter.ai');
    expect((fetchImpl.mock.calls[1][0] as string)).toContain('openrouter.ai');
  });

  it('cross-tier 200-garbage → retries same tier once then advances to OpenAI', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok('a/b', 'not json at all'))  // OpenRouter attempt 1
      .mockResolvedValueOnce(ok('a/b', 'not json at all'))  // OpenRouter retry
      .mockResolvedValueOnce(ok('gpt-5.4-mini', '{"v":9}')); // OpenAI serves
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: CHAIN, system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ v: 9 });
      expect(r.usage.provider).toBe('openai');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((fetchImpl.mock.calls[2][0] as string)).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('web flag adds the OpenRouter web plugin; without it the body is unchanged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('a/b', '{"v":1}'));
    const llm = new LlmClient({ openrouter: 'k' }, fetchImpl as any);
    const chain = [{ provider: 'openrouter' as const, models: ['a/b'] }];
    await llm.jsonChain({ chain, system: 's', user: 'u', validate: (v: any) => v });
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as any).body).plugins).toBeUndefined(); // non-web: unchanged
    await llm.jsonChain({ chain, system: 's', user: 'u', web: { maxResults: 5 }, validate: (v: any) => v });
    expect(JSON.parse((fetchImpl.mock.calls[1][1] as any).body).plugins).toEqual([{ id: 'web', max_results: 5 }]);
  });

  it('web flag is ignored on the OpenAI tier (no plugins param)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok('gpt-5.4-mini', '{"v":1}'));
    const llm = new LlmClient({ openai: 'o' }, fetchImpl as any);
    await llm.jsonChain({ chain: [{ provider: 'openai', model: 'gpt-5.4-mini' }], system: 's', user: 'u', web: { maxResults: 5 }, validate: (v: any) => v });
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as any).body).plugins).toBeUndefined();
  });

  it('tier3 activation log fires when OpenAI tier serves', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota', message: 'quota' } }) })
      .mockResolvedValueOnce(ok('gpt-5.4-mini', '{"v":5}'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = new LlmClient({ openrouter: 'k', openai: 'o' }, fetchImpl as any);
    const r = await llm.jsonChain({ chain: CHAIN, system: 's', user: 'u', validate: (v: any) => v });
    expect(r.ok).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tier3\.activated/));
    warn.mockRestore();
  });
});
