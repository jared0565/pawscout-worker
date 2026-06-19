import type { TenantConfig } from './types';
import { DEFAULT_MODEL, type LlmRole, type ChainTier } from './llm';
import { CURATED_MODELS } from './models-catalog';

/**
 * Turn a tenant's model selection into an ordered tier chain:
 *   1. OpenRouter, models:[primary, fallback] (native failover; blanks dropped,
 *      deduped, never empty — a blank primary falls back to the menu head).
 *   2. OpenAI-direct gpt-5.4-mini (the system floor).
 * The chain is provider-aware; LlmClient.jsonChain walks it and skips a tier
 * whose provider key is absent. Pure — no env, no I/O.
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
