import type { LlmClient, LlmUsage } from './llm';
import type { TenantStore } from './tenant-store';
import type { ReasoningEffort } from './types';

/**
 * The live test a model must pass before it can be saved into a slot (spec
 * 5.5). One small call through our own OpenRouter key, in the production
 * request shape (LlmClient.jsonChain: JSON mode, the slot's effort, an
 * effort-sized max_tokens), with `models: [slug]` alone so OpenRouter cannot
 * quietly answer with a different model. It catches the two failures that were
 * invisible elsewhere: a model our key is not entitled to (2026-08, a dead
 * floor for nine days) and a reasoning model starved into empty content.
 */

export type ProbeMode = 'text' | 'vision';
export type ProbeResult = { ok: true } | { ok: false; reason: string };

export const PROBE_TIMEOUT_MS = 60_000;
export const PROBE_CACHE_DAYS = 7;
/** The largest production task budget (src/blog/draft.ts), so the probe's
 *  max_tokens is the worst case production sends at the same effort: a cap a
 *  model refuses fails here rather than on a real call. */
export const PROBE_MAX_TOKENS = 4800;
/** 64x64 orange PNG. Inline on purpose (spec section 9): the test never depends
 *  on an outside host being reachable. Production sends https image links, so
 *  the image transport is the one way this call differs from production. */
export const PROBE_IMAGE_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItjWNOawAi+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgsbomGHIoj2rgAAAABJRU5ErkJggg==';

const SYSTEM = 'You are a connectivity test. Reply with exactly this JSON object and nothing else: {"ok": true}';

export function probeCacheKey(slug: string, mode: ProbeMode, effort?: ReasoningEffort): string {
  return `modelprobe:${slug}:${mode}:${effort ?? 'default'}`;
}

/** jsonChain's error strings, in words the owner can act on. */
function plainReason(error: string): string {
  if (error === 'LLM returned non-JSON') return 'did not return JSON (an empty reply usually means the model needs a larger token budget)';
  if (error === 'LLM JSON failed validation') return 'did not return the expected test answer';
  return `OpenRouter refused the call: ${error}`;
}

/**
 * `defer` keeps work alive after the response (the route passes waitUntil). It
 * is used once: a call that answers after the timeout was still billed, so its
 * usage is logged when it lands. It never caches a pass, because the save that
 * asked for it was already refused.
 */
export async function probeModel(
  llm: LlmClient,
  store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache' | 'logLlmUsage'>,
  model: { id: string; canonicalSlug: string | null },
  mode: ProbeMode,
  effort?: ReasoningEffort,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  defer?: (late: Promise<unknown>) => void,
): Promise<ProbeResult> {
  const key = probeCacheKey(model.id, mode, effort);
  if (await store.getSearchCache(key)) return { ok: true };
  // Every call that returns usage was billed, pass or fail, so it is logged
  // under the model that actually answered.
  const logUsage = (u: LlmUsage) => store.logLlmUsage('model-probe', u.model, u.promptTokens, u.completionTokens, u.costUsd);

  const call = llm.jsonChain<true>({
    chain: [{ provider: 'openrouter', models: [model.id], ...(effort ? { effort } : {}) }],
    system: SYSTEM,
    user: mode === 'vision' ? 'Look at the image, then return {"ok": true}.' : 'Return {"ok": true}.',
    images: mode === 'vision' ? [PROBE_IMAGE_DATA_URI] : undefined,
    maxTokens: PROBE_MAX_TOKENS,
    validate: (v) => (v && typeof v === 'object' && (v as { ok?: unknown }).ok === true ? true : null),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const out = await Promise.race([call, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (out === 'timeout') {
    defer?.(call.then((late) => (late.ok ? logUsage(late.usage) : undefined)).catch(() => undefined));
    return { ok: false, reason: `did not answer within ${Math.round(timeoutMs / 1000)} seconds` };
  }
  // A failed call's tokens are not logged: jsonChain returns no usage on failure,
  // which is how every task in this worker already behaves.
  if (!out.ok) return { ok: false, reason: plainReason(out.error) };
  await logUsage(out.usage);
  if (out.usage.model !== model.id && out.usage.model !== model.canonicalSlug) {
    return { ok: false, reason: `OpenRouter answered with a different model (${out.usage.model})` };
  }
  await store.putSearchCache(key, '1', PROBE_CACHE_DAYS);
  return { ok: true };
}
