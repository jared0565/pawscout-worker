import type { LlmClient } from '../llm';
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { resolveChain } from '../llm-resolve';
import type { DraftResult } from './types';
import { SHARED_SCAFFOLDING, STORE_FACTS, COMMERCIAL_GUARDRAILS, OUTPUT_CONTRACT } from './agents/scaffolding';
import type { CategoryAgent, Grounding } from './agents/types';
import { refineUntilClean, asksDoYouDeliver, type DraftQualityContext } from './draft-quality';

const DRAFT_MAX_WORDS = 110; // conciseness ceiling: a warm courtesy wrapper + a grounded answer

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

// Honorifics - never greet with these ("Hi Mr"); skip past to the real name token.
const TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'sir', 'madam', 'madame', 'rev', 'reverend',
]);

/** A safe first NAME for the greeting, or null if we have nothing usable. Walks the name
 * tokens, SKIPS leading honorifics (so "Mr Dhikirullah" greets "Dhikirullah", not "Mr"),
 * rejects emails / role addresses / non-alphabetic junk, and Title-cases the result so a
 * shouty "JANE" renders "Jane".
 *
 * Surname-first display names ("Adedigba Ridwan") are disambiguated against the email
 * local part: the given name almost always LEADS the email, so if the local part STARTS
 * WITH a later token we greet that one ("ridwanadedigba41@" -> "Ridwan"). "starts-with"
 * (not "contains") is deliberate so an initial+surname email ("jsmith@") never makes us
 * greet the surname for "John Smith". No email, or no match, keeps the first token. */
export function salutationName(rawName: string | null | undefined, email?: string | null): string | null {
  if (!rawName) return null;
  const candidates: string[] = [];
  for (const raw of rawName.trim().split(/\s+/)) {
    const tok = raw.replace(/[.,]+$/, ''); // drop trailing punctuation ("Mr." -> "Mr")
    if (!/^[\p{L}][\p{L}'-]{1,40}$/u.test(tok)) continue; // skip emails/junk/non-alpha/1-char
    const lower = tok.toLowerCase();
    if (TITLES.has(lower)) continue;        // honorific -> try the next token
    if (ROLE_NAMES.has(lower)) return null; // a role inbox, not a person
    candidates.push(tok);
  }
  if (!candidates.length) return null;
  let chosen = candidates[0];
  const local = (email ?? '').split('@')[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (local) {
    const starter = candidates.find((c) => c.length >= 3 && local.startsWith(c.toLowerCase()));
    if (starter) chosen = starter; // email leads with a later token => that is the given name
  }
  return chosen.charAt(0).toUpperCase() + chosen.slice(1).toLowerCase();
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
export function applySalutation(bodyText: string, customerName: string | null | undefined, email?: string | null): string {
  const first = salutationName(customerName, email);
  const greeting = first ? `Hi ${first},` : 'Hi there,';
  const stripped = bodyText.replace(LEADING_GREETING, '').trimStart();
  return sanitizeOutbound(`${greeting}\n\n${stripped}`);
}

/** Shared JSON validator for a drafter response (initial draft AND revision). */
function validateDraft(v: unknown): DraftResult | null {
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

/** Assemble the system prompt: shared safety/facts/format + the agent's own prompt.
 * When `revisionIssues` is supplied, appends a revision instruction so the model
 * rewrites its previous reply to clear the quality reviewer's specific objections. */
function buildDraftSystem(
  agent: CategoryAgent, grounding: Grounding,
  opts: { hasLatest: boolean; guidance?: string; revisionIssues?: string[] }
): string {
  return (
    SHARED_SCAFFOLDING + ' ' + STORE_FACTS + ' ' +
    agent.promptFragment(grounding) + ' ' +
    (grounding.facts ? `Grounded facts you MAY rely on for this reply: ${grounding.facts} ` : '') +
    (agent.commercial ? COMMERCIAL_GUARDRAILS + ' ' : '') +
    (opts.hasLatest
      ? 'Reply to the customer\'s MOST RECENT message specifically (provided as latestMessage); earlier conversation is background. If the latest message has no new question (only a quote, thank-you, or acknowledgement), reply with a short warm acknowledgement, do not re-answer a previous turn. '
      : '') +
    (opts.guidance ? `Owner guidance - follow exactly; it OVERRIDES defaults including tone and sign-off: ${opts.guidance} ` : '') +
    (opts.revisionIssues?.length
      ? `REVISION REQUIRED: your previous reply (provided as previousReply) was rejected by a quality reviewer. Rewrite it from scratch to fix EVERY issue below while staying accurate and grounded in the facts. Issues: ${opts.revisionIssues.join(' ')} `
      : '') +
    OUTPUT_CONTRACT
  );
}

/** LLM-backed reviser for the runtime self-correction loop. Re-prompts with the
 * reviewer's issues plus the previous reply; returns the raw (pre-salutation)
 * revised draft, or null on failure (the loop then keeps the best draft so far). */
async function reviseDraft(
  llm: LlmClient, store: TenantStore, chain: ReturnType<typeof resolveChain>,
  agent: CategoryAgent, grounding: Grounding, guidance: string | undefined,
  latest: string, baseUser: string, previousBody: string, issues: string[]
): Promise<DraftResult | null> {
  const system = buildDraftSystem(agent, grounding, { hasLatest: !!latest, guidance, revisionIssues: issues });
  const user = JSON.stringify({ ...JSON.parse(baseUser), previousReply: previousBody.slice(0, 2000) });
  const result = await llm.jsonChain<DraftResult>({ chain, maxTokens: 700, system, user, validate: validateDraft });
  if (!result.ok) { console.warn(`inbox revise failed: ${result.error}`); return null; }
  await store.logLlmUsage('inbox-revise', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  return result.value;
}

/** Draft a reply. LLM proposes only - returns null on ANY failure. The conversation
 * text is UNTRUSTED data; the prompt forbids following instructions inside it. The
 * agent supplies its category prompt and grounded facts; shared scaffolding/store
 * facts/output contract come from scaffolding.ts. A runtime quality loop then holds
 * the draft to the bar (concise, answer-first, no filler), revising via the LLM
 * until it passes - the worker self-corrects in production, no dev tuning needed. */
export async function draftReply(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  input: { agent: CategoryAgent; grounding: Grounding; subject: string; conversation: string; latestMessage?: string; customerName?: string | null; customerEmail?: string | null }
): Promise<DraftResult | null> {
  if (!llm.available || !cfg.inbox.enabled) return null;
  const chain = resolveChain(cfg, 'text');
  const guidance = cfg.inbox.replyGuidance?.trim();
  const latest = (input.latestMessage ?? '').trim();
  const { agent, grounding } = input;

  const system = buildDraftSystem(agent, grounding, { hasLatest: !!latest, guidance });
  const baseUser = JSON.stringify({ subject: input.subject.slice(0, 200), category: agent.category, latestMessage: latest.slice(0, 2000), conversation: input.conversation.slice(0, 4000) });

  const result = await llm.jsonChain<DraftResult>({ chain, maxTokens: 700, system, user: baseUser, validate: validateDraft });
  if (!result.ok) { console.warn(`inbox draft failed: ${result.error}`); return null; }
  await store.logLlmUsage('inbox-draft', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);

  // Runtime self-correction: hold the draft to the bar; revise via the LLM until it
  // passes (bounded). Runs on the pre-salutation body so the greeting never trips the
  // answer-first check; the salutation is applied once at the end.
  const qctx: DraftQualityContext = { maxWords: DRAFT_MAX_WORDS, askedDelivery: asksDoYouDeliver(latest) };
  const refined = await refineUntilClean(
    result.value,
    (prev, issues) => reviseDraft(llm, store, chain, agent, grounding, guidance, latest, baseUser, prev.bodyText, issues),
    qctx, 2
  );

  return { ...refined, bodyText: applySalutation(refined.bodyText, input.customerName, input.customerEmail) };
}
