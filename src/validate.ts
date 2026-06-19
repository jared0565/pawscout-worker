import type { Addons, Gates, LlmConfig, Pricing, TenantConfig } from './types';
import { DEFAULT_INBOX, INBOX_LABELS, type InboxConfig, type ThreadStatus } from './inbox/types';

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const RELEVANCE = new Set<Gates['relevance']>(['loose', 'title', 'strict']);
// Shopify-style handle / tag slug: lowercase alphanumerics and single hyphens, no leading/trailing hyphen.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
export const MAX_COLLECTIONS = 50;
export const MAX_TARGET = 200;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate the /api/gates body. Returns a *clean* object (unknown fields
 * stripped) so nothing un-vetted reaches tenant_config. `target` is optional —
 * absent means "leave the stored value alone".
 */
export function validateGatesPayload(body: unknown): Validation<{ gates: Gates; target?: number }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (!finite(b.popularityFloor) || b.popularityFloor < 0) {
    return { ok: false, error: 'popularityFloor must be a number >= 0' };
  }
  if (!finite(b.priceMin) || b.priceMin < 0) {
    return { ok: false, error: 'priceMin must be a number >= 0' };
  }
  if (!finite(b.priceMax) || b.priceMax < b.priceMin) {
    return { ok: false, error: 'priceMax must be a number >= priceMin' };
  }
  if (typeof b.relevance !== 'string' || !RELEVANCE.has(b.relevance as Gates['relevance'])) {
    return { ok: false, error: 'relevance must be one of: loose, title, strict' };
  }
  let target: number | undefined;
  if (b.target !== undefined) {
    if (!finite(b.target) || !Number.isInteger(b.target) || b.target < 1 || b.target > MAX_TARGET) {
      return { ok: false, error: `target must be an integer between 1 and ${MAX_TARGET}` };
    }
    target = b.target;
  }
  return {
    ok: true,
    value: {
      gates: {
        popularityFloor: b.popularityFloor,
        priceMin: b.priceMin,
        priceMax: b.priceMax,
        relevance: b.relevance as Gates['relevance']
      },
      target
    }
  };
}

/** Validate the /api/pricing body. Bounds are wide but sane — the rule must never invert. */
export function validatePricingPayload(body: unknown): Validation<Pricing> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const ranges: [keyof Pricing, number, number][] = [
    ['multiplier', 1, 10],
    ['floor', 1, 10],
    ['minMarginGbp', 0, 100],
    ['fxUsdToGbp', 0.1, 10],
    ['fxBufferPct', 0, 20]
  ];
  for (const [field, min, max] of ranges) {
    const v = b[field];
    if (!finite(v) || v < min || v > max) {
      return { ok: false, error: `${field} must be a number between ${min} and ${max}` };
    }
  }
  return {
    ok: true,
    value: {
      multiplier: b.multiplier as number,
      floor: b.floor as number,
      minMarginGbp: b.minMarginGbp as number,
      fxUsdToGbp: b.fxUsdToGbp as number,
      fxBufferPct: b.fxBufferPct as number
    }
  };
}

/** Validate the /api/addons body. The add-on band sits below the main price
 * range; floor can go to $0 but max is capped to keep it a "filler" lane. */
export function validateAddonsPayload(body: unknown): Validation<Addons> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (!finite(b.priceMinUsd) || b.priceMinUsd < 0) {
    return { ok: false, error: 'priceMinUsd must be a number >= 0' };
  }
  if (!finite(b.priceMaxUsd) || b.priceMaxUsd <= b.priceMinUsd) {
    return { ok: false, error: 'priceMaxUsd must be greater than priceMinUsd' };
  }
  if (b.priceMaxUsd > 50) return { ok: false, error: 'priceMaxUsd must be 50 or less' };
  if (!finite(b.poolSize) || !Number.isInteger(b.poolSize) || b.poolSize < 1 || b.poolSize > 50) {
    return { ok: false, error: 'poolSize must be an integer between 1 and 50' };
  }
  if (typeof b.suppressFromBrowse !== 'boolean') {
    return { ok: false, error: 'suppressFromBrowse must be true or false' };
  }
  return {
    ok: true,
    value: {
      enabled: b.enabled,
      priceMinUsd: b.priceMinUsd,
      priceMaxUsd: b.priceMaxUsd,
      poolSize: b.poolSize,
      suppressFromBrowse: b.suppressFromBrowse
    }
  };
}

// OpenRouter model slugs: "vendor/model" with dots, dashes, colons (variants).
const MODEL_SLUG = /^[\w.-]+\/[\w.:-]+$/;

/** Validate the /api/llm body. Model is a free-text OpenRouter slug — the cost-vs-quality knob. */
export function validateLlmPayload(body: unknown): Validation<LlmConfig> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (typeof b.model !== 'string' || b.model.length > 100 || !MODEL_SLUG.test(b.model)) {
    return { ok: false, error: 'model must be an OpenRouter slug like anthropic/claude-haiku-4.5' };
  }
  if (!finite(b.scoreThreshold) || b.scoreThreshold < 0 || b.scoreThreshold > 100) {
    return { ok: false, error: 'scoreThreshold must be a number between 0 and 100' };
  }
  for (const k of ['curationModel', 'digestModel', 'visionModel'] as const) {
    if (b[k] !== undefined && b[k] !== '' && (typeof b[k] !== 'string' || (b[k] as string).length > 100 || !MODEL_SLUG.test(b[k] as string))) {
      return { ok: false, error: `${k} must be an OpenRouter model slug` };
    }
  }
  return {
    ok: true,
    value: {
      enabled: b.enabled,
      model: b.model,
      scoreThreshold: b.scoreThreshold as number,
      ...(b.curationModel ? { curationModel: b.curationModel as string } : {}),
      ...(b.visionModel ? { visionModel: b.visionModel as string } : {}),
      ...(b.digestModel ? { digestModel: b.digestModel as string } : {})
    }
  };
}

const THREAD_STATUSES = new Set<ThreadStatus>(['new', 'needs_reply', 'awaiting_customer', 'converted', 'closed', 'spam']);
const LABEL_SET = new Set<string>(INBOX_LABELS);

export function validateThreadStatus(s: unknown): s is ThreadStatus {
  return typeof s === 'string' && THREAD_STATUSES.has(s as ThreadStatus);
}

export function validateLabels(body: unknown): Validation<string[]> {
  if (!Array.isArray(body)) return { ok: false, error: 'labels must be an array' };
  const clean = [...new Set(body)].filter((l): l is string => typeof l === 'string');
  if (clean.length !== body.length) return { ok: false, error: 'labels must be unique strings' };
  for (const l of clean) if (!LABEL_SET.has(l)) return { ok: false, error: `unknown label: ${l}` };
  return { ok: true, value: clean };
}

/** Validate the /api/inbox config body. */
export function validateInboxPayload(body: unknown): Validation<InboxConfig> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (typeof b.autosend !== 'boolean') return { ok: false, error: 'autosend must be true or false' };
  if (typeof b.intentThreshold !== 'number' || !Number.isFinite(b.intentThreshold) || b.intentThreshold < 0 || b.intentThreshold > 100) {
    return { ok: false, error: 'intentThreshold must be a number between 0 and 100' };
  }
  let alertEmail: string | undefined;
  if (b.alertEmail !== undefined && b.alertEmail !== '') {
    if (typeof b.alertEmail !== 'string' || !b.alertEmail.includes('@')) return { ok: false, error: 'alertEmail must be a valid email' };
    alertEmail = b.alertEmail;
  }
  let classifyModel: string | undefined;
  if (b.classifyModel !== undefined && b.classifyModel !== '') {
    if (typeof b.classifyModel !== 'string' || b.classifyModel.length > 100 || !MODEL_SLUG.test(b.classifyModel)) {
      return { ok: false, error: 'classifyModel must be an OpenRouter model slug like google/gemini-2.5-flash-lite' };
    }
    classifyModel = b.classifyModel;
  }
  if (typeof b.autoConfidenceThreshold !== 'number' || !Number.isFinite(b.autoConfidenceThreshold) || b.autoConfidenceThreshold < 0 || b.autoConfidenceThreshold > 100) {
    return { ok: false, error: 'autoConfidenceThreshold must be a number between 0 and 100' };
  }
  if (b.replyGuidance !== undefined && (typeof b.replyGuidance !== 'string' || b.replyGuidance.length > 4000)) {
    return { ok: false, error: 'replyGuidance must be a string up to 4000 chars' };
  }
  let replyModel: string | undefined;
  if (b.replyModel !== undefined && b.replyModel !== '') {
    if (typeof b.replyModel !== 'string' || b.replyModel.length > 100 || !MODEL_SLUG.test(b.replyModel)) {
      return { ok: false, error: 'replyModel must be an OpenRouter model slug' };
    }
    replyModel = b.replyModel;
  }
  if (b.autoInvoice !== undefined && typeof b.autoInvoice !== 'boolean') return { ok: false, error: 'autoInvoice must be true or false' };
  if (b.invoiceConfidenceThreshold !== undefined && (typeof b.invoiceConfidenceThreshold !== 'number' || !Number.isFinite(b.invoiceConfidenceThreshold) || b.invoiceConfidenceThreshold < 0 || b.invoiceConfidenceThreshold > 100)) return { ok: false, error: 'invoiceConfidenceThreshold must be 0-100' };
  if (b.invoiceValueCeiling !== undefined && (typeof b.invoiceValueCeiling !== 'number' || !Number.isFinite(b.invoiceValueCeiling) || b.invoiceValueCeiling <= 0)) return { ok: false, error: 'invoiceValueCeiling must be a positive number' };
  if (b.invoiceRateLimit !== undefined && (typeof b.invoiceRateLimit !== 'number' || !Number.isInteger(b.invoiceRateLimit) || b.invoiceRateLimit < 1)) return { ok: false, error: 'invoiceRateLimit must be a positive integer' };
  const labelsRes = validateLabels(b.labels ?? []);
  if (!labelsRes.ok) return labelsRes;
  return {
    ok: true,
    value: {
      enabled: b.enabled, autosend: b.autosend, intentThreshold: b.intentThreshold,
      labels: labelsRes.value, autoConfidenceThreshold: b.autoConfidenceThreshold,
      replyGuidance: typeof b.replyGuidance === 'string' ? b.replyGuidance : '',
      replyModel: replyModel ?? DEFAULT_INBOX.replyModel,
      autoInvoice: typeof b.autoInvoice === 'boolean' ? b.autoInvoice : DEFAULT_INBOX.autoInvoice,
      invoiceConfidenceThreshold: typeof b.invoiceConfidenceThreshold === 'number' ? b.invoiceConfidenceThreshold : DEFAULT_INBOX.invoiceConfidenceThreshold,
      invoiceValueCeiling: typeof b.invoiceValueCeiling === 'number' ? b.invoiceValueCeiling : DEFAULT_INBOX.invoiceValueCeiling,
      invoiceRateLimit: typeof b.invoiceRateLimit === 'number' ? b.invoiceRateLimit : DEFAULT_INBOX.invoiceRateLimit,
      ...(alertEmail ? { alertEmail } : {}),
      ...(classifyModel ? { classifyModel } : {})
    }
  };
}

/**
 * Validate the /api/collections body: a map of slug → { handle, tag } where
 * every key, handle, and tag is a safe slug. Returns a clean copy.
 */
export function validateCollectionMap(body: unknown): Validation<TenantConfig['collectionMap']> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length > MAX_COLLECTIONS) {
    return { ok: false, error: `At most ${MAX_COLLECTIONS} collections allowed` };
  }
  const clean: TenantConfig['collectionMap'] = {};
  for (const [key, raw] of entries) {
    if (!SLUG.test(key)) return { ok: false, error: `Invalid collection key: ${JSON.stringify(key)}` };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `Entry ${JSON.stringify(key)} must be an object with handle and tag` };
    }
    const { handle, tag } = raw as Record<string, unknown>;
    if (typeof handle !== 'string' || !SLUG.test(handle)) {
      return { ok: false, error: `Entry ${JSON.stringify(key)}: handle must be a lowercase slug (a-z, 0-9, hyphens)` };
    }
    if (typeof tag !== 'string' || !SLUG.test(tag)) {
      return { ok: false, error: `Entry ${JSON.stringify(key)}: tag must be a lowercase slug (a-z, 0-9, hyphens)` };
    }
    clean[key] = { handle, tag };
  }
  return { ok: true, value: clean };
}
