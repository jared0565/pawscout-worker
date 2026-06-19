import type { ModelsConfig } from './types';

const slug = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Derive the models block from a legacy llm blob, preserving today's effective
 *  resolution: image = visionModel ?? curationModel ?? model; text = curationModel
 *  ?? model; fallback = model. Empty when the blob carries no slug fields. */
export function deriveModels(legacy: Record<string, unknown>): ModelsConfig {
  const model = slug(legacy.model);
  const curation = slug(legacy.curationModel);
  const vision = slug(legacy.visionModel);
  const out: ModelsConfig = {};
  const image = vision ?? curation ?? model;
  const text = curation ?? model;
  if (image) out.image = image;
  if (text) out.text = text;
  if (model) out.fallback = model;
  return out;
}
