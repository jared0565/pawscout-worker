import { TenantStore } from '../tenant-store';
import { validateThreadStatus, validateLabels, validateInboxPayload } from '../validate';
import { DEFAULT_INBOX, type InboxConfig, type ThreadStatus } from './types';

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
  return { ok: true as const, thread: got.thread, messages: got.messages, labels: got.labels };
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
