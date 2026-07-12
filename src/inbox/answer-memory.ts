// src/inbox/answer-memory.ts
//
// Inbox answer memory (2026-07-12): approved-answers RETRIEVAL GROUNDING.
// Every reply the owner approves (or auto-sends) is stored as a vetted
// question->answer pair; when a similar question arrives - even reworded -
// the top matches are injected into the drafter's prompt so replies stay
// consistent in facts, policy and voice. This is deliberately NOT a verbatim
// cache: the model still personalizes, live facts always override, and the
// prompt forbids copying personal details from past answers.
// Spec: docs/superpowers/specs/2026-07-12-inbox-answer-memory-design.md

import type { TenantStore } from '../tenant-store';
import { stripQuotedReply } from './quote';
import { isPartnershipLane } from './partnership';

/** Categories whose sends are never remembered (no reusable substance). */
const EXCLUDED_CATEGORIES = new Set(['spam', 'automated', 'affiliate']);

// Courtesy/grammar words carry no matching signal; product and commerce words
// (ship, order, refund, sizes, numbers) are the signal and are kept.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'i', 'im', 'we', 'you', 'your', 'yours', 'our', 'ours', 'me', 'my',
  'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'not',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'as',
  'that', 'this', 'these', 'those', 'there', 'here', 'if', 'then', 'than', 'so', 'too', 'also', 'just', 'very', 'really',
  'how', 'what', 'when', 'where', 'which', 'who', 'why',
  'please', 'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'regards', 'kind', 'best',
  'any', 'some', 'have', 'has', 'had', 'get', 'got', 'let', 'know', 'want', 'wanted', 'wondering',
  'question', 'ask', 'asking', 'looking', 'forward', 'hearing', 'reply', 'response', 'help', 'need', 'like', 'am', 'only',
]);

/** Canonical matching tokens: lowercase, alphanumeric runs only, no stopwords
 * or 1-char tokens, numbers kept (sizes/quantities carry meaning), unique, sorted. */
export function normalizeQuestion(text: string): string[] {
  const raw = (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  return [...new Set(raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t)))].sort();
}

/** FNV-1a 64-bit as 16-char hex (sync, dependency-free; collision odds are
 * irrelevant at catalog scale and a collision only merges two memory slots). */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function qhashOf(category: string, questionNorm: string): string {
  return fnv1a64(`${category}|${questionNorm}`);
}

// The deterministic wrapper our pipeline adds around every reply: the
// applySalutation greeting ("Hi Name,\n\n") and the applyFooter block
// ("Best Regards,\n<department>"), with the P.S. slot after the footer.
// Only the substance between them is worth remembering.
const LEADING_SALUTATION = /^\s*hi\s[^\n]{0,60},\s*\n+/i;
const FOOTER_ONWARD = /\n\s*best regards,\s*\n[\s\S]*$/i;

export function stripAnswerSubstance(sentBody: string): string {
  return (sentBody ?? '').replace(LEADING_SALUTATION, '').replace(FOOTER_ONWARD, '').trim();
}

const RECALL_WINDOW_DAYS = 180;   // facts drift; older answers age out of recall
const RECALL_TOP = 2;
const RECALL_MIN_OVERLAP = 2;
const RECALL_MIN_SCORE = 0.45;
const SAME_CATEGORY_BONUS = 0.1;  // applied BEFORE the threshold test
const PROMPT_Q_CAP = 200;
const PROMPT_A_CAP = 500;
const STORE_Q_CAP = 1500;
const STORE_A_CAP = 2000;

/** Top matching vetted pairs for a new question (deterministic set-cosine on
 * normalized tokens; zero LLM). Bumps usage stats on the recalled pairs. */
export async function recallAnswers(
  store: TenantStore, category: string | null, question: string
): Promise<{ question: string; answer: string }[]> {
  const a = new Set(normalizeQuestion(question));
  if (a.size < RECALL_MIN_OVERLAP) return [];
  const since = new Date(Date.now() - RECALL_WINDOW_DAYS * 86400_000).toISOString();
  const candidates = await store.listRecallCandidates(since, 500);
  const scored: { qhash: string; question: string; answer: string; score: number; updatedAt: string }[] = [];
  for (const c of candidates) {
    const b = c.question_norm.split(' ').filter(Boolean);
    if (!b.length) continue;
    let inter = 0;
    for (const t of b) if (a.has(t)) inter++;
    if (inter < RECALL_MIN_OVERLAP) continue;
    const score = inter / Math.sqrt(a.size * b.length) + (category && c.category === category ? SAME_CATEGORY_BONUS : 0);
    if (score < RECALL_MIN_SCORE) continue;
    scored.push({ qhash: c.qhash, question: c.question_text, answer: c.answer_text, score, updatedAt: c.updated_at });
  }
  scored.sort((x, y) => y.score - x.score || (y.updatedAt < x.updatedAt ? -1 : 1));
  const top = scored.slice(0, RECALL_TOP);
  if (top.length) await store.bumpAnswerUsage(top.map((t) => t.qhash));
  return top.map((t) => ({ question: t.question.slice(0, PROMPT_Q_CAP), answer: t.answer.slice(0, PROMPT_A_CAP) }));
}

/** Store one vetted pair (the core). Returns false when the send is not
 * memory-worthy: excluded category, partnership lane, or empty/unmatchable
 * question or answer after stripping. */
export async function captureAnswerPair(
  store: TenantStore, thread: { id: string; primary_category: string | null },
  questionStripped: string, sentBody: string, partnershipLane: boolean, at: string
): Promise<boolean> {
  const category = thread.primary_category ?? 'other';
  if (partnershipLane || EXCLUDED_CATEGORIES.has(category)) return false;
  const question = (questionStripped ?? '').trim();
  const answer = stripAnswerSubstance(sentBody);
  if (!question || !answer) return false;
  const tokens = normalizeQuestion(question);
  if (tokens.length < RECALL_MIN_OVERLAP) return false; // could never be recalled
  const questionNorm = tokens.join(' ');
  await store.upsertAnswerMemory({
    qhash: qhashOf(category, questionNorm), category,
    questionText: question.slice(0, STORE_Q_CAP), questionNorm,
    answerText: answer.slice(0, STORE_A_CAP), threadId: thread.id, at,
  });
  return true;
}

/** Send-time hook: pair the FINAL sent text with the thread's latest inbound
 * (quote-chain stripped). The caller passes the messages it already loaded. */
export async function captureAnswerFromSend(
  store: TenantStore, thread: { id: string; primary_category: string | null },
  messages: { direction: string; body_text: string | null }[],
  sentBody: string, partnershipLane: boolean, at: string
): Promise<boolean> {
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  if (!lastInbound) return false;
  return captureAnswerPair(store, thread, stripQuotedReply(lastInbound.body_text ?? ''), sentBody, partnershipLane, at);
}

export const ANSWER_BACKFILL_FLAG = 'job:answer-backfill';

/** One-time import of historical sends: pair each outbound with the nearest
 * preceding inbound, backdated to the send time. Idempotent via the qhash PK. */
export async function backfillAnswerMemory(store: TenantStore): Promise<number> {
  const threads = await store.listThreads(null, 500);
  let imported = 0;
  for (const t of threads) {
    try {
      const got = await store.getThreadWithMessages(t.id);
      if (!got) continue;
      const inboundToAddrs = got.messages.filter((m) => m.direction === 'inbound').map((m) => m.to_addr ?? '');
      const lane = isPartnershipLane({ inboundToAddrs, declaredIntent: got.thread.declared_intent ?? null, primaryCategory: t.primary_category ?? null });
      let lastInbound = '';
      for (const m of got.messages) {
        if (m.direction === 'inbound') { lastInbound = stripQuotedReply(m.body_text ?? ''); continue; }
        if (m.direction !== 'outbound') continue;
        if (await captureAnswerPair(store, { id: t.id, primary_category: t.primary_category ?? null }, lastInbound, m.body_text ?? '', lane, m.received_at)) imported++;
      }
    } catch (e) {
      console.warn(`answer backfill skipped thread ${t.id}: ${(e as Error).message}`);
    }
  }
  return imported;
}

/** Sweep hook: run the backfill exactly once per shop (search_cache flag).
 * A failure logs and leaves the flag unset so the next sweep retries; the
 * qhash PK makes a partial import harmless. Never throws (the sweep's
 * classify/draft work must proceed regardless). */
export async function ensureAnswerBackfill(store: TenantStore): Promise<void> {
  try {
    if (await store.getSearchCache(ANSWER_BACKFILL_FLAG)) return;
    const imported = await backfillAnswerMemory(store);
    await store.putSearchCache(ANSWER_BACKFILL_FLAG, JSON.stringify({ done: true, imported }), 3650);
    console.log(`answer memory backfill imported ${imported} pairs`);
  } catch (e) {
    console.warn(`answer backfill failed (will retry next sweep): ${(e as Error).message}`);
  }
}
