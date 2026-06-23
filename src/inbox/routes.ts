import { TenantStore } from '../tenant-store';
import { validateThreadStatus, validateLabels, validateInboxPayload } from '../validate';
import { DEFAULT_INBOX, type InboxConfig, type ThreadStatus } from './types';
import type { Env } from '../types';
import { sendReply } from './send';
import { composeDraftForThread } from './sweep';
import { defaultFetch } from '../safe-fetch';

export async function listInboxThreads(db: D1Database, shop: string, status: string | null) {
  const store = new TenantStore(db, shop);
  const rows = await store.listThreads(status, 100);
  return {
    ok: true as const,
    threads: rows.map((t) => ({
      id: t.id, contactEmail: t.contact_email, subject: t.subject, status: t.status,
      category: t.primary_category, intentScore: t.intent_score, summary: t.summary,
      lastMessageAt: t.last_message_at
    }))
  };
}

export async function getInboxThread(db: D1Database, shop: string, threadId: string) {
  const store = new TenantStore(db, shop);
  const got = await store.getThreadWithMessages(threadId);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  const draft = await store.getPendingDraft(threadId);
  const invoice = await store.getOpenInvoiceForThread(threadId);
  const applicant = await store.getApplicantByThread(threadId);
  return { ok: true as const, thread: got.thread, messages: got.messages, labels: got.labels, draft, invoice, applicant };
}

export async function setInboxStatus(db: D1Database, shop: string, threadId: string, status: unknown) {
  if (!validateThreadStatus(status)) return { ok: false as const, error: 'Invalid status' };
  const store = new TenantStore(db, shop);
  if (!(await store.getThreadWithMessages(threadId))) return { ok: false as const, error: 'Thread not found' };
  await store.setThreadStatus(threadId, status as ThreadStatus);
  return { ok: true as const, status };
}

export async function setInboxLabels(db: D1Database, shop: string, threadId: string, labels: unknown) {
  const v = validateLabels(labels);
  if (!v.ok) return { ok: false as const, error: v.error };
  const store = new TenantStore(db, shop);
  if (!(await store.getThreadWithMessages(threadId))) return { ok: false as const, error: 'Thread not found' };
  await store.setThreadLabels(threadId, v.value);
  return { ok: true as const, labels: v.value };
}

export async function getInboxConfig(db: D1Database, shop: string): Promise<InboxConfig> {
  const cfg = await new TenantStore(db, shop).getConfig();
  return cfg?.inbox ?? DEFAULT_INBOX;
}

export async function saveInboxConfig(db: D1Database, shop: string, body: unknown) {
  const v = validateInboxPayload(body);
  if (!v.ok) return { ok: false as const, error: v.error };
  await new TenantStore(db, shop).saveInbox(v.value);
  return { ok: true as const };
}

/**
 * Regenerate: discard the current draft and immediately produce a fresh one with
 * the LLM. Unlike the old "discard" (which closed the thread), this NEVER closes
 * the thread and NEVER auto-sends. The replacement is generated FIRST, so if the
 * LLM is unavailable the current draft is left untouched (no data loss). To
 * dismiss a thread without replying, set its status to closed via the status
 * control instead.
 */
export async function regenerateDraft(db: D1Database, env: Env, shop: string, draftId: string, fetchImpl: typeof fetch = defaultFetch) {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  const old = await store.getDraft(draftId);
  if (!cfg || !old || old.status !== 'pending') return { ok: false as const, error: 'No pending draft' };
  const got = await store.getThreadWithMessages(old.thread_id);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  // Generate the replacement FIRST so an LLM failure never loses the current draft.
  const r = await composeDraftForThread(env, store, cfg, got.thread, fetchImpl);
  if (!r) return { ok: false as const, error: 'Could not generate a new draft - model unavailable, try again.' };
  // Replacement is in (pending). Retire the old draft and keep the thread OPEN
  // for review - never close it (that was the discard trap). Regenerate never sends.
  await store.setDraftStatus(draftId, 'discarded');
  if (got.thread.status === 'closed') await store.setThreadStatus(old.thread_id, 'needs_reply');
  return { ok: true as const, draft: await store.getPendingDraft(old.thread_id) };
}

export async function approveDraft(db: D1Database, shop: string, env: Env, draftId: string, editedBody?: string) {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  const draft = await store.getDraft(draftId);
  if (!cfg || !draft || draft.status !== 'pending') return { ok: false as const, error: 'No pending draft' };
  const got = await store.getThreadWithMessages(draft.thread_id);
  if (!got) return { ok: false as const, error: 'Thread not found' };
  const body = typeof editedBody === 'string' && editedBody.trim() ? editedBody : undefined;
  const r = await sendReply(env, store, cfg, got.thread, draft, body);
  return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
}
