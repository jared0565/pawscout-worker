import type { TenantConfig } from './types';
import { DEFAULT_MODEL, SEARCH_MODEL, type LlmRole, type ChainTier } from './llm';
import { CURATED_MODELS } from './models-catalog';

/**
 * Turn a tenant's model selection into an ordered tier chain:
 *   1. OpenRouter, models:[primary, fallback] (native failover; blanks dropped,
 *      deduped, never empty - a blank primary falls back to the menu head).
 *   2. OpenAI-direct DEFAULT_MODEL (the system floor; gpt-5.6-luna since
 *      2026-08-02). Named by the constant rather than spelled out, so this
 *      comment cannot drift from src/llm.ts the way the last one did.
 * The chain is provider-aware; LlmClient.jsonChain walks it and skips a tier
 * whose provider key is absent. Pure - no env, no I/O.
 */
export function resolveChain(cfg: TenantConfig, role: LlmRole): ChainTier[] {
  const m = cfg.llm.models ?? {};
  const primary = (role === 'image' ? m.image : m.text) || CURATED_MODELS[0].slug;
  const models = [...new Set([primary, m.fallback].filter((s): s is string => !!s))];
  return [
    { provider: 'openrouter', models },
    { provider: 'openai', model: DEFAULT_MODEL },
  ];
}

/**
 * Chain for calls that REQUIRE live web search. Two deliberate differences from
 * `resolveChain`:
 *
 *  1. `SEARCH_MODEL` leads, with the tenant's own models as OpenRouter-native
 *     failover behind it. A model chosen for writing style should never decide
 *     whether research is possible - see SEARCH_MODEL in src/llm.ts for the
 *     nine-day outage that rule comes from.
 *  2. NO OpenAI tier. That provider cannot attach the search plugin at all, so
 *     including it could only ever produce an answer from model memory wearing a
 *     researched label. `web.required` in LlmClient enforces the same thing from
 *     the other side; this keeps the chain honest by construction.
 *
 * Pure - no env, no I/O.
 */
export function resolveSearchChain(cfg: TenantConfig): ChainTier[] {
  const m = cfg.llm.models ?? {};
  const models = [...new Set([SEARCH_MODEL, m.text, m.fallback].filter((s): s is string => !!s))];
  return [{ provider: 'openrouter', models }];
}
