import type { Addons, Gates, LlmConfig, Pricing, TenantConfig, SelfServeConfig } from './types';
import { DEFAULT_SEMANTIC, type SemanticConfig } from './types';
import { DEFAULT_INBOX, INBOX_LABELS, AFFILIATE_MODES, type AffiliateMode, type InboxConfig, type ThreadStatus } from './inbox/types';

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
 * stripped) so nothing un-vetted reaches tenant_config. `target` is optional -
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

/** Validate the /api/pricing body. Bounds are wide but sane - the rule must never invert. */
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
  // Optional margin cap: absent/null = no cap. When present it must sit strictly
  // above the minimum margin, or the floor and cap clauses would fight.
  let maxMargin: number | undefined;
  if (b.maxMarginGbp != null) {
    const v = b.maxMarginGbp;
    if (!finite(v) || v > 10000) {
      return { ok: false, error: 'maxMarginGbp must be a number up to 10000, or blank for no cap' };
    }
    if (v <= (b.minMarginGbp as number)) {
      return { ok: false, error: 'maxMarginGbp must be greater than minMarginGbp' };
    }
    maxMargin = v;
  }
  return {
    ok: true,
    value: {
      multiplier: b.multiplier as number,
      floor: b.floor as number,
      minMarginGbp: b.minMarginGbp as number,
      fxUsdToGbp: b.fxUsdToGbp as number,
      fxBufferPct: b.fxBufferPct as number,
      ...(maxMargin !== undefined ? { maxMarginGbp: maxMargin } : {})
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

/** Validate the /api/llm body. Models are free-text OpenRouter slugs in the `models` block. */
export function validateLlmPayload(body: unknown): Validation<LlmConfig> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (!finite(b.scoreThreshold) || (b.scoreThreshold as number) < 0 || (b.scoreThreshold as number) > 100) {
    return { ok: false, error: 'scoreThreshold must be a number between 0 and 100' };
  }
  const rawModels = (b.models && typeof b.models === 'object' && !Array.isArray(b.models)) ? b.models as Record<string, unknown> : {};
  const models: { image?: string; text?: string; fallback?: string } = {};
  for (const k of ['image', 'text', 'fallback'] as const) {
    const v = rawModels[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || v.length > 100 || !MODEL_SLUG.test(v)) return { ok: false, error: `${k} model must be an OpenRouter slug` };
    models[k] = v;
  }
  return { ok: true, value: { enabled: b.enabled, scoreThreshold: b.scoreThreshold as number, models } };
}

/** Validate the /api/affiliate/config body (selfServe toggles: the master
 *  switch + the four daily safety caps/thresholds). All fields required, same
 *  all-or-nothing shape as validateAddonsPayload - the console settings card
 *  always sends the whole block. Rejects (never clamps) an out-of-range or
 *  non-finite value, so a NaN/negative cap can never silently persist. */
export function validateSelfServePayload(body: unknown): Validation<SelfServeConfig> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  // Ceilings sit close to the blast-radius defaults (5 / GBP2 / 8 / 15), not
  // the old 1000/1000/10000 - those left the daily auto-issue rate and LLM
  // screening spend effectively unbounded for a typo or a malicious PATCH.
  const ranges: [keyof Omit<SelfServeConfig, 'enabled'>, number, number][] = [
    ['autoIssueCapPerDay', 0, 50],
    ['screenSpendCapGbpPerDay', 0, 20],
    ['scoreThreshold', 0, 12],
    ['starterUsageLimit', 1, 100]
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
      enabled: b.enabled,
      autoIssueCapPerDay: b.autoIssueCapPerDay as number,
      screenSpendCapGbpPerDay: b.screenSpendCapGbpPerDay as number,
      scoreThreshold: b.scoreThreshold as number,
      starterUsageLimit: b.starterUsageLimit as number
    }
  };
}

/** Validate the semantic-library config. Missing fields fall back to defaults. */
export function validateSemanticPayload(body: unknown): Validation<SemanticConfig> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const enabled = b.enabled === undefined ? DEFAULT_SEMANTIC.enabled : b.enabled;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  const maxExpansions = b.maxExpansions === undefined ? DEFAULT_SEMANTIC.maxExpansions : b.maxExpansions;
  if (!finite(maxExpansions) || maxExpansions < 1 || maxExpansions > 50) return { ok: false, error: 'maxExpansions must be a number between 1 and 50' };
  const ttlDays = b.ttlDays === undefined ? DEFAULT_SEMANTIC.ttlDays : b.ttlDays;
  if (!finite(ttlDays) || ttlDays < 1 || ttlDays > 365) return { ok: false, error: 'ttlDays must be a number between 1 and 365' };
  let excludeCollections = DEFAULT_SEMANTIC.excludeCollections;
  if (b.excludeCollections !== undefined) {
    if (!Array.isArray(b.excludeCollections) || !b.excludeCollections.every((x) => typeof x === 'string')) {
      return { ok: false, error: 'excludeCollections must be an array of strings' };
    }
    excludeCollections = [...new Set(b.excludeCollections as string[])];
  }
  return { ok: true, value: { enabled, maxExpansions: maxExpansions as number, ttlDays: ttlDays as number, excludeCollections } };
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
  if (typeof b.autoConfidenceThreshold !== 'number' || !Number.isFinite(b.autoConfidenceThreshold) || b.autoConfidenceThreshold < 0 || b.autoConfidenceThreshold > 100) {
    return { ok: false, error: 'autoConfidenceThreshold must be a number between 0 and 100' };
  }
  if (b.replyGuidance !== undefined && (typeof b.replyGuidance !== 'string' || b.replyGuidance.length > 4000)) {
    return { ok: false, error: 'replyGuidance must be a string up to 4000 chars' };
  }
  if (b.autoInvoice !== undefined && typeof b.autoInvoice !== 'boolean') return { ok: false, error: 'autoInvoice must be true or false' };
  if (b.invoiceConfidenceThreshold !== undefined && (typeof b.invoiceConfidenceThreshold !== 'number' || !Number.isFinite(b.invoiceConfidenceThreshold) || b.invoiceConfidenceThreshold < 0 || b.invoiceConfidenceThreshold > 100)) return { ok: false, error: 'invoiceConfidenceThreshold must be 0-100' };
  if (b.invoiceValueCeiling !== undefined && (typeof b.invoiceValueCeiling !== 'number' || !Number.isFinite(b.invoiceValueCeiling) || b.invoiceValueCeiling <= 0)) return { ok: false, error: 'invoiceValueCeiling must be a positive number' };
  if (b.invoiceRateLimit !== undefined && (typeof b.invoiceRateLimit !== 'number' || !Number.isInteger(b.invoiceRateLimit) || b.invoiceRateLimit < 1)) return { ok: false, error: 'invoiceRateLimit must be a positive integer' };
  if (b.affiliateMode !== undefined && !(AFFILIATE_MODES as readonly string[]).includes(b.affiliateMode as string)) {
    return { ok: false, error: 'affiliateMode must be funnel_voucher, funnel_link or decline_all' };
  }
  if (b.autoIssueVoucher !== undefined && typeof b.autoIssueVoucher !== 'boolean') {
    return { ok: false, error: 'autoIssueVoucher must be true or false' };
  }
  // Marketing-footer postal address: omitted → preserved by saveInboxConfig;
  // '' → cleared; a string → set (bounded so it stays a footer line, not a letter).
  if (b.postalAddress !== undefined && (typeof b.postalAddress !== 'string' || b.postalAddress.length > 240)) {
    return { ok: false, error: 'postalAddress must be a string up to 240 chars' };
  }
  const postalAddress = typeof b.postalAddress === 'string' ? b.postalAddress.trim() : undefined;
  const labelsRes = validateLabels(b.labels ?? []);
  if (!labelsRes.ok) return labelsRes;
  // Per-agent auto toggle map: optional; keep only known labels with a boolean autosend.
  let agents: Record<string, { autosend: boolean }> | undefined;
  if (b.agents !== undefined) {
    if (typeof b.agents !== 'object' || b.agents === null || Array.isArray(b.agents)) {
      return { ok: false, error: 'agents must be a JSON object' };
    }
    const src = b.agents as Record<string, unknown>;
    const cleaned: Record<string, { autosend: boolean }> = {};
    for (const k of Object.keys(src)) {
      if (!(INBOX_LABELS as readonly string[]).includes(k)) continue; // drop unknown labels
      const v = src[k] as Record<string, unknown> | null;
      cleaned[k] = { autosend: !!(v && v.autosend === true) };
    }
    agents = cleaned;
  }
  return {
    ok: true,
    value: {
      enabled: b.enabled, autosend: b.autosend, intentThreshold: b.intentThreshold,
      labels: labelsRes.value, autoConfidenceThreshold: b.autoConfidenceThreshold,
      replyGuidance: typeof b.replyGuidance === 'string' ? b.replyGuidance : '',
      autoInvoice: typeof b.autoInvoice === 'boolean' ? b.autoInvoice : DEFAULT_INBOX.autoInvoice,
      invoiceConfidenceThreshold: typeof b.invoiceConfidenceThreshold === 'number' ? b.invoiceConfidenceThreshold : DEFAULT_INBOX.invoiceConfidenceThreshold,
      invoiceValueCeiling: typeof b.invoiceValueCeiling === 'number' ? b.invoiceValueCeiling : DEFAULT_INBOX.invoiceValueCeiling,
      invoiceRateLimit: typeof b.invoiceRateLimit === 'number' ? b.invoiceRateLimit : DEFAULT_INBOX.invoiceRateLimit,
      affiliateMode: typeof b.affiliateMode === 'string' ? (b.affiliateMode as AffiliateMode) : DEFAULT_INBOX.affiliateMode,
      autoIssueVoucher: b.autoIssueVoucher === true,
      ...(alertEmail ? { alertEmail } : {}),
      ...(agents ? { agents } : {}),
      ...(postalAddress ? { postalAddress } : {})
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

// --- Affiliate voucher trials (2026-07-04) ---

// Shopify accepts a wider charset for discount codes, but keeping registrations
// to A-Z, 0-9 and hyphens means the code survives copy/paste, email quoting and
// case-folding everywhere it travels.
const VOUCHER_CODE = /^[A-Za-z0-9-]{4,40}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PartnerRegistration {
  contactEmail: string;
  name: string | null;
  channelUrl: string | null;
  notes: string | null;
  code: string;           // normalised UPPERCASE
  pctOff: number;
  commissionPct: number;
  endsAt: string;         // ISO; a bare YYYY-MM-DD means end of that day (UTC)
  usageLimit: number | null;
}

function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined; // signal invalid
  const t = v.trim();
  if (t.length > max) return undefined;
  return t || null;
}

/** Validate the /api/partners/create body: register a collaborator + the
 *  voucher the owner issued them. Returns a clean, normalised object. */
export function validatePartnerPayload(body: unknown, now: () => number = Date.now): Validation<PartnerRegistration> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.email !== 'string' || !EMAIL_SHAPE.test(b.email.trim())) {
    return { ok: false, error: 'email must be a valid email address' };
  }
  const name = optionalText(b.name, 80);
  if (name === undefined) return { ok: false, error: 'name must be text up to 80 characters' };
  const channelUrl = optionalText(b.channel, 200);
  if (channelUrl === undefined) return { ok: false, error: 'channel must be text up to 200 characters' };
  const notes = optionalText(b.notes, 500);
  if (notes === undefined) return { ok: false, error: 'notes must be text up to 500 characters' };
  if (typeof b.code !== 'string' || !VOUCHER_CODE.test(b.code.trim())) {
    return { ok: false, error: 'code must be 4-40 letters, digits or hyphens' };
  }
  if (!finite(b.pctOff) || b.pctOff < 1 || b.pctOff > 50) {
    return { ok: false, error: 'pctOff must be a number between 1 and 50' };
  }
  if (!finite(b.commissionPct) || b.commissionPct < 0 || b.commissionPct > 20) {
    return { ok: false, error: 'commissionPct must be a number between 0 and 20' };
  }
  if (typeof b.endsAt !== 'string' || !b.endsAt.trim()) {
    return { ok: false, error: 'endsAt is required (when the voucher expires)' };
  }
  // A bare date from the form's date picker means "valid through that day".
  const endsAt = /^\d{4}-\d{2}-\d{2}$/.test(b.endsAt.trim()) ? `${b.endsAt.trim()}T23:59:59Z` : b.endsAt.trim();
  const endMs = Date.parse(endsAt);
  if (Number.isNaN(endMs)) return { ok: false, error: 'endsAt must be a valid date' };
  if (endMs <= now()) return { ok: false, error: 'endsAt must be in the future' };
  let usageLimit: number | null = null;
  if (b.usageLimit !== undefined && b.usageLimit !== null && b.usageLimit !== '') {
    if (!finite(b.usageLimit) || !Number.isInteger(b.usageLimit) || b.usageLimit < 1 || b.usageLimit > 10000) {
      return { ok: false, error: 'usageLimit must be a whole number between 1 and 10000' };
    }
    usageLimit = b.usageLimit;
  }
  return {
    ok: true,
    value: {
      contactEmail: b.email.trim().toLowerCase(),
      name, channelUrl, notes,
      code: b.code.trim().toUpperCase(),
      pctOff: b.pctOff,
      commissionPct: b.commissionPct,
      endsAt: new Date(endMs).toISOString(),
      usageLimit
    }
  };
}
