// The live test a model must pass before it can be saved into a slot (spec
// 5.5). It goes through the production client and request shape, because the
// two failures it exists to catch were invisible everywhere else: a model in a
// provider's docs that our key cannot call (2026-08, nine days), and a reasoning
// model that returns empty content when its token budget is too small.
import { describe, it, expect, beforeEach } from 'vitest';
import { LlmClient } from '../src/llm';
import { probeModel, probeCacheKey, PROBE_IMAGE_DATA_URI, type ProbeResult } from '../src/model-probe';

type Reply = { status?: number; model?: string; content?: string; error?: string };

let bodies: Record<string, any>[];
let logged: unknown[][];
let store: { mem: Map<string, string>; getSearchCache: (k: string) => Promise<string | null>; putSearchCache: (k: string, p: string) => Promise<void>; logLlmUsage: (...a: unknown[]) => Promise<void> };

/** A fetch that answers each call with the next reply (the last one repeats). */
function fakeFetch(...replies: Reply[]): typeof fetch {
  let i = 0;
  return (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.status && r.status !== 200) {
      return new Response(JSON.stringify({ error: { message: r.error ?? 'refused' } }), { status: r.status });
    }
    return new Response(JSON.stringify({
      model: r.model ?? 'x/m',
      choices: [{ message: { content: r.content ?? '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

const llmWith = (...replies: Reply[]) => new LlmClient({ openrouter: 'k' }, fakeFetch(...replies));
const MODEL = { id: 'x/m', canonicalSlug: null };
const reason = (r: ProbeResult) => (r.ok ? '' : r.reason);

beforeEach(() => {
  bodies = [];
  logged = [];
  const mem = new Map<string, string>();
  store = {
    mem,
    getSearchCache: async (k) => mem.get(k) ?? null,
    putSearchCache: async (k, p) => { mem.set(k, p); },
    logLlmUsage: async (...a) => { logged.push(a); },
  };
});

describe('probeModel', () => {
  it('passes, sends the production shape, and logs model-probe', async () => {
    const r = await probeModel(llmWith({}), store, MODEL, 'text');
    expect(r).toEqual({ ok: true });
    expect(bodies[0]).toMatchObject({ models: ['x/m'], max_tokens: 4800, response_format: { type: 'json_object' } });
    expect('reasoning' in bodies[0]).toBe(false);
    expect(logged).toEqual([['model-probe', 'x/m', 10, 5, 0.0001]]);
  });

  it('runs at the requested effort with the sized cap', async () => {
    await probeModel(llmWith({}), store, MODEL, 'text', 'high');
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'high' }, max_tokens: 24000 });
  });

  it('vision mode attaches the probe image', async () => {
    await probeModel(llmWith({}), store, MODEL, 'vision');
    expect(bodies[0].messages[1].content[1].image_url.url).toBe(PROBE_IMAGE_DATA_URI);
  });

  it('a cached pass skips the call; the cache is per mode and per effort', async () => {
    const llm = llmWith({});
    await probeModel(llm, store, MODEL, 'text');
    await probeModel(llm, store, MODEL, 'text');
    expect(bodies).toHaveLength(1);
    await probeModel(llm, store, MODEL, 'vision');
    expect(bodies).toHaveLength(2);
    await probeModel(llm, store, MODEL, 'text', 'high');
    expect(bodies).toHaveLength(3);
    expect(store.mem.has(probeCacheKey('x/m', 'text', 'high'))).toBe(true);
    expect(probeCacheKey('x/m', 'text')).toBe('modelprobe:x/m:text:default');
  });

  it('accepts the canonical slug as the answering model', async () => {
    const r = await probeModel(llmWith({ model: 'x/m-20261001' }), store, { id: 'x/m', canonicalSlug: 'x/m-20261001' }, 'text');
    expect(r).toEqual({ ok: true });
  });

  // Deferred minor (final review 2026-11-13): the answering model's call is
  // billed, so it is logged (under the model that answered) though it fails.
  it('fails when another model answered, logs that call, and caches no pass', async () => {
    const r = await probeModel(llmWith({ model: 'y/z' }), store, MODEL, 'text');
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain('different model (y/z)');
    expect(logged).toEqual([['model-probe', 'y/z', 10, 5, 0.0001]]);
    expect(store.mem.size).toBe(0);
  });

  // Deferred minor: a call that answers after the save gave up on it is still
  // billed. Its usage is logged through the deferral the route hands in
  // (waitUntil), and it never counts as a pass, since that save was refused.
  it('a call that answers after the timeout is logged through the deferral and never cached', async () => {
    const late = (() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({
      model: 'x/m', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
    }), { status: 200 })), 80))) as unknown as typeof fetch;
    const deferred: Promise<unknown>[] = [];
    const r = await probeModel(new LlmClient({ openrouter: 'k' }, late), store, MODEL, 'text', undefined, 20, (p) => { deferred.push(p); });
    expect(reason(r)).toMatch(/did not answer within/);
    expect(logged).toEqual([]);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(logged).toEqual([['model-probe', 'x/m', 10, 5, 0.0001]]);
    expect(store.mem.size).toBe(0);
  });

  it('explains an empty reply as a token budget problem', async () => {
    const r = await probeModel(llmWith({ content: '' }), store, MODEL, 'text');
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain('larger token budget');
  });

  it('fails when the JSON is not the test answer', async () => {
    const r = await probeModel(llmWith({ content: '{"ok":false}' }), store, MODEL, 'text');
    expect(r).toEqual({ ok: false, reason: 'did not return the expected test answer' });
  });

  it('surfaces an OpenRouter refusal in plain words', async () => {
    const r = await probeModel(llmWith({ status: 404, error: 'Project does not have access to model' }), store, MODEL, 'text');
    expect(r).toEqual({ ok: false, reason: 'OpenRouter refused the call: Project does not have access to model' });
  });

  it('times out instead of hanging', async () => {
    const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
    const r = await probeModel(new LlmClient({ openrouter: 'k' }, hang), store, MODEL, 'text', undefined, 50);
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/did not answer within/);
  });

  it('never caches a failure', async () => {
    const llm = llmWith({ status: 404 }, {});
    expect((await probeModel(llm, store, MODEL, 'text')).ok).toBe(false);
    expect(await probeModel(llm, store, MODEL, 'text')).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
  });
});
