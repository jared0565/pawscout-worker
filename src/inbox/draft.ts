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

// Owner rule (2026-07-12): URLs in outbound replies must be REAL anchors -
// recipient-side auto-linking of bare text is unreliable (Outlook desktop
// often renders dead text). Matches full http(s) URLs plus BARE mentions of
// the store domain (optionally www./pathed); the lookbehind keeps email
// addresses (support@activepaw.co.uk) out of it. Runs on the RAW text with
// per-segment escaping, so no LLM-produced HTML ever reaches the wire.
const LINKIFY_RE = /(https?:\/\/[^\s<>"']+)|((?<![\w.@-])(?:www\.)?activepaw\.co\.uk(?:\/[^\s<>"']*)?)/g;

function linkifySegment(raw: string): string {
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(LINKIFY_RE)) {
    out += escapeHtml(raw.slice(last, m.index));
    let url = m[0];
    // Trailing punctuation is prose, not URL ("...see https://x.com/a.")
    const trail = /[.,;:!?)]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    out += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>${escapeHtml(trail ? trail[0] : '')}`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(raw.slice(last));
}

/** Build the SENT html from the drafter's plain text - escaped + paragraph-wrapped,
 * with URLs (and bare store-domain mentions) as real clickable anchors. */
export function renderReplyHtml(text: string): string {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => `<p>${linkifySegment(p).replace(/\n/g, '<br>')}</p>`).join('\n');
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

// The one true store host. A drafting model that is never shown the URL guesses
// "activepaw.com" from the brand name (it did: Ben Francis thread, 2026-07-11), so any
// wrong-TLD variant of the brand host is rewritten to the canonical domain. The negative
// lookahead protects the real host and its subdomains; an optional leading "www."
// collapses so we never emit a www host we do not serve. Paths, query strings and email
// local parts survive because the match covers only the host's TLD span.
const WRONG_STORE_DOMAIN = /\b(?:www\.)?activepaw\.(?!co\.uk\b)[a-z]{2,6}(?:\.[a-z]{2,6})?\b/gi;

/** Deterministic outbound guarantees - every customer-facing body passes through here,
 * so even if the LLM or a template slips one of these in, the customer never sees it:
 *  - dash glyphs that read as an AI tell (em-dash U+2014, en-dash U+2013, horizontal
 *    bar U+2015) collapse to a plain hyphen, spacing preserved ("a, b" style stays
 *    "a - b"). (Escapes, not literal glyphs, so the codebase-wide dash scrub never
 *    corrupts this matcher.)
 *  - a hallucinated store domain (activepaw.com and friends) becomes activepaw.co.uk,
 *    the only domain we own. */
export function sanitizeOutbound(text: string): string {
  return text.replace(/[\u2014\u2013\u2015]/g, '-').replace(WRONG_STORE_DOMAIN, 'activepaw.co.uk');
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

/** Department signature lines for the deterministic footer (the owner's exact format).
 * Four desks so a reply is recognisable/auditable by the team that signed it: Sales
 * (leads, wholesale), Customer Support (shipping, order status, complaints, general),
 * Partnerships (affiliate lane), Technical Team (product/spec questions). The
 * partnership funnel signs "Active Paw Partnerships" directly on its own templates. */
export const DEPARTMENT_SIGNATURES: Record<import('./agents/types').Department, string> = {
  sales: 'Active Paw Sales Team',
  service: 'Active Paw Customer Support',
  partnership: 'Active Paw Partnerships',
  tech: 'Active Paw Technical Team',
};

// A trailing sign-off block the model may have added despite being told not to
// ("Best regards,\nActive Paw" / "Kind regards"). Anchored to the END: the phrase
// must start its own line and be essentially the whole line, followed by at most
// two short lines (team/sender name). A real sentence that merely contains
// "many thanks" mid-line is never eaten.
const TRAILING_SIGNOFF =
  /\n\s*(?:best regards|kind regards|warm regards|warmest regards|best wishes|many thanks|with thanks|sincerely|cheers|all the best)[,.!]?\s*(?:\n[^\n]{0,60}){0,2}\s*$/i;

/** Remove a trailing LLM sign-off so the deterministic footer is never doubled. */
export function stripTrailingSignoff(text: string): string {
  return text.replace(TRAILING_SIGNOFF, '').trimEnd();
}

/** Append the deterministic department footer. The footer lives IN the draft body
 * (never added at send time), so HITL review sees exactly what the customer gets. */
export function applyFooter(bodyText: string, department: import('./agents/types').Department): string {
  const body = stripTrailingSignoff(bodyText.trimEnd());
  return sanitizeOutbound(`${body}\n\nBest Regards,\n${DEPARTMENT_SIGNATURES[department]}`);
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
  opts: { hasLatest: boolean; guidance?: string; shippingFact?: string; revisionIssues?: string[]; recall?: { question: string; answer: string }[] }
): string {
  return (
    SHARED_SCAFFOLDING + ' ' + STORE_FACTS + ' ' +
    (opts.shippingFact ? opts.shippingFact + ' ' : '') +
    agent.promptFragment(grounding) + ' ' +
    (grounding.facts ? `Grounded facts you MAY rely on for this reply: ${grounding.facts} ` : '') +
    (opts.recall?.length
      ? 'Previously approved answers to similar past questions - use them to stay consistent in facts, policy and voice. If anything in them conflicts with the store facts or grounded facts above, the facts above WIN (past answers can be out of date). NEVER copy personal details from them: names, destinations, addresses, quantities, prices or order numbers belong to OTHER customers. ' +
        opts.recall.map((r) => `[Q: ${r.question} A: ${r.answer}]`).join(' ') + ' '
      : '') +
    (agent.commercial ? COMMERCIAL_GUARDRAILS + ' ' : '') +
    (opts.hasLatest
      ? 'Reply to the customer\'s MOST RECENT message specifically (provided as latestMessage); earlier conversation is background. If the latest message has no new question (only a quote, thank-you, or acknowledgement), reply with a short warm acknowledgement, do not re-answer a previous turn. '
      : '') +
    (opts.guidance ? `Owner guidance - follow exactly; it OVERRIDES defaults including tone: ${opts.guidance} ` : '') +
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
  latest: string, baseUser: string, previousBody: string, issues: string[], shippingFact: string,
  recall: { question: string; answer: string }[] | undefined
): Promise<DraftResult | null> {
  const system = buildDraftSystem(agent, grounding, { hasLatest: !!latest, guidance, shippingFact, revisionIssues: issues, recall });
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
  input: { agent: CategoryAgent; grounding: Grounding; subject: string; conversation: string; latestMessage?: string; customerName?: string | null; customerEmail?: string | null; recall?: { question: string; answer: string }[] }
): Promise<DraftResult | null> {
  if (!llm.available || !cfg.inbox.enabled) return null;
  const chain = resolveChain(cfg, 'text');
  const guidance = cfg.inbox.replyGuidance?.trim();
  const latest = (input.latestMessage ?? '').trim();
  const { agent, grounding } = input;
  // Shipping cost is destination-calculated and shown at checkout (STORE_FACTS); the
  // ONLY concrete shipping-cost fact is free UK delivery, and only while the owner's
  // verify-then-flip gbFreeUkLive gate is on. Inject it live so a gate flip can never
  // leave a stale "free UK" (or a stale flat rate) in a reply.
  const shippingFact = cfg.fulfil?.gbFreeUkLive === true
    ? 'UK delivery is currently free (checkout charges GBP 0 to UK addresses); you MAY state that UK delivery is free. For all other destinations, shipping is calculated by location and shown at checkout before payment.'
    : '';

  const system = buildDraftSystem(agent, grounding, { hasLatest: !!latest, guidance, shippingFact, recall: input.recall });
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
    (prev, issues) => reviseDraft(llm, store, chain, agent, grounding, guidance, latest, baseUser, prev.bodyText, issues, shippingFact, input.recall),
    qctx, 2
  );

  return { ...refined, bodyText: applySalutation(refined.bodyText, input.customerName, input.customerEmail) };
}
