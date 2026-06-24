import type { LlmClient } from '../llm';
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { resolveChain } from '../llm-resolve';
import type { DraftResult } from './types';
import { SHARED_SCAFFOLDING, STORE_FACTS, COMMERCIAL_GUARDRAILS, OUTPUT_CONTRACT } from './agents/scaffolding';
import type { CategoryAgent, Grounding } from './agents/types';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Build the SENT html from the drafter's plain text - escaped + paragraph-wrapped.
 * No LLM-produced HTML ever reaches the wire. */
export function renderReplyHtml(text: string): string {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

// Display names come from untrusted From headers - never these (role inboxes, not people).
const ROLE_NAMES = new Set([
  'info', 'support', 'sales', 'admin', 'contact', 'team', 'hello', 'help',
  'enquiries', 'inquiries', 'orders', 'noreply', 'no-reply', 'mail', 'office', 'customer',
]);

/** A safe first name for the greeting, or null if we have nothing usable. Takes the
 * first token, rejects emails / role addresses / non-alphabetic junk, and Title-cases
 * it so a shouty "JANE" renders "Jane". */
export function salutationName(rawName: string | null | undefined): string | null {
  if (!rawName) return null;
  const first = rawName.trim().split(/\s+/)[0] ?? '';
  if (!/^[\p{L}][\p{L}'-]{1,40}$/u.test(first)) return null; // letters/'/- only, ≥2 chars
  if (ROLE_NAMES.has(first.toLowerCase())) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// A leading greeting the model may have added despite being told not to. Comma- OR
// newline-terminated and length-bounded so it catches both "Hi Jane, thanks…" (inline)
// and "Hello there,\n\n…" (own line) without eating a real sentence that opens with "Hi".
const LEADING_GREETING = /^\s*(hi|hiya|hey|hello|dear|greetings|good (?:morning|afternoon|evening))\b[^\n,]{0,40}(?:,|\n)\s*/i;

/** Strip dash glyphs that read as an AI tell from customer-facing copy: em-dash
 * (U+2014), en-dash (U+2013) and horizontal bar (U+2015) all collapse to a plain
 * hyphen. Spacing is preserved (a spaced "a, b" style dash becomes "a - b"). This is
 * the deterministic guarantee: every outbound body passes through it, so even if the
 * LLM or a template slips a dash in, the customer never sees one. (Escapes, not literal
 * glyphs, so the codebase-wide dash scrub never corrupts this matcher.) */
export function sanitizeOutbound(text: string): string {
  return text.replace(/[\u2014\u2013\u2015]/g, '-');
}

/** Prepend a deterministic salutation. The model is told not to greet (so its name
 * guess never reaches the wire); we strip any greeting it added anyway, then open with
 * the customer's real first name from the contact record, or "Hi there," as fallback.
 * Also runs sanitizeOutbound so no em/en-dash survives into a customer-facing draft. */
export function applySalutation(bodyText: string, customerName: string | null | undefined): string {
  const first = salutationName(customerName);
  const greeting = first ? `Hi ${first},` : 'Hi there,';
  const stripped = bodyText.replace(LEADING_GREETING, '').trimStart();
  return sanitizeOutbound(`${greeting}\n\n${stripped}`);
}

/** Draft a reply. LLM proposes only - returns null on ANY failure. The conversation
 * text is UNTRUSTED data; the prompt forbids following instructions inside it. The
 * agent supplies its category-specific fragment and grounded facts; the shared
 * scaffolding, store facts, and output contract come from scaffolding.ts. */
export async function draftReply(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  input: { agent: CategoryAgent; grounding: Grounding; subject: string; conversation: string; latestMessage?: string; customerName?: string | null }
): Promise<DraftResult | null> {
  if (!llm.available || !cfg.inbox.enabled) return null;
  const chain = resolveChain(cfg, 'text');
  const guidance = cfg.inbox.replyGuidance?.trim();
  const latest = (input.latestMessage ?? '').trim();
  const { agent, grounding } = input;

  const system =
    SHARED_SCAFFOLDING + ' ' + STORE_FACTS + ' ' +
    agent.promptFragment(grounding) + ' ' +
    (grounding.facts ? `Grounded facts you MAY rely on for this reply: ${grounding.facts} ` : '') +
    (agent.commercial ? COMMERCIAL_GUARDRAILS + ' ' : '') +
    (latest
      ? 'Reply to the customer\'s MOST RECENT message specifically (provided as latestMessage); earlier conversation is background. If the latest message has no new question (only a quote, thank-you, or acknowledgement), reply with a short warm acknowledgement, do not re-answer a previous turn. '
      : '') +
    (guidance ? `Owner guidance - follow exactly; it OVERRIDES defaults including tone and sign-off: ${guidance} ` : '') +
    OUTPUT_CONTRACT;

  const result = await llm.jsonChain<DraftResult>({
    chain, maxTokens: 700, system,
    user: JSON.stringify({ subject: input.subject.slice(0, 200), category: agent.category, latestMessage: latest.slice(0, 2000), conversation: input.conversation.slice(0, 4000) }),
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return null;
      const bodyText = typeof o.bodyText === 'string' ? o.bodyText.trim() : '';
      if (!bodyText) return null;
      const confidence = Number(o.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
      const customerAsks = Array.isArray(o.customerAsks)
        ? o.customerAsks.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 200)).slice(0, 10)
        : undefined;
      return { bodyText: bodyText.slice(0, 4000), confidence: Math.round(confidence), quotesPriceOrOrder: o.quotesPriceOrOrder === true, commercialIntent: o.commercialIntent === true, customerAsks };
    }
  });
  if (!result.ok) { console.warn(`inbox draft failed: ${result.error}`); return null; }
  await store.logLlmUsage('inbox-draft', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  return { ...result.value, bodyText: applySalutation(result.value.bodyText, input.customerName) };
}
