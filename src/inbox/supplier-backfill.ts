// One-time scan of the past inbox for suppliers (owner decision 2026-09-27).
// The console button only sets a cursor; each 15-minute sweep reads up to 20
// threads until 200 are read or none are left. It writes thread readings and
// register rows ONLY: no draft, no status change, no reply.
import type { Env, TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import { LlmClient } from '../llm';
import { readThread } from './thread-read';
import { buildDraftTranscript } from './draft';

export const SUPPLIER_BACKFILL_KEY = 'job:supplier-backfill';
const BATCH = 20;
const CAP = 200;
const WINDOW_DAYS = 90;
const CURSOR_TTL_DAYS = 30;

export interface BackfillCursor { since: string; afterCreatedAt: string | null; afterId: string | null; scanned: number; found: number; done: boolean }

export async function readBackfillCursor(store: TenantStore): Promise<BackfillCursor | null> {
  const raw = await store.getSearchCache(SUPPLIER_BACKFILL_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as BackfillCursor; } catch { return null; }
}

export async function startSupplierBackfill(store: TenantStore, now = new Date()): Promise<BackfillCursor> {
  const cursor: BackfillCursor = { since: new Date(now.getTime() - WINDOW_DAYS * 86400_000).toISOString(), afterCreatedAt: null, afterId: null, scanned: 0, found: 0, done: false };
  await store.putSearchCache(SUPPLIER_BACKFILL_KEY, JSON.stringify(cursor), CURSOR_TTL_DAYS);
  return cursor;
}

/** One batch. Null when no back-fill is running (never started, or finished). */
export async function runSupplierBackfillStep(env: Env, store: TenantStore, cfg: TenantConfig, fetchImpl: typeof fetch): Promise<BackfillCursor | null> {
  const cursor = await readBackfillCursor(store);
  if (!cursor || cursor.done) return null;
  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
  if (!llm.available) return cursor;
  const threads = await store.supplierBackfillThreads(cursor.since, cursor.afterCreatedAt, cursor.afterId, Math.min(BATCH, CAP - cursor.scanned));
  for (const t of threads) {
    try {
      const got = await store.getThreadWithMessages(t.id);
      if (!got) continue;
      const reading = await readThread(llm, store, cfg, { subject: t.subject ?? '', transcript: buildDraftTranscript(got.messages), fromEmail: t.contact_email });
      if (!reading) continue;
      await store.saveThreadReading(t.id, JSON.stringify(reading))
        .catch((e) => console.warn(`supplier back-fill reading save failed for ${t.id}: ${(e as Error).message}`));
      if (reading.supplier) {
        // .catch resolves to false on a failed write so a bad row never inflates
        // `found`, which Task 11's console shows the owner as a count of rows
        // actually registered.
        const registered = await store
          .upsertSupplier({ email: t.contact_email, threadId: t.id, facts: reading.supplier, seenAt: t.last_message_at, inboundCount: got.messages.filter((m) => m.direction === 'inbound').length })
          .then(() => true, (e: Error) => { console.warn(`supplier back-fill register write failed for ${t.id}: ${e.message}`); return false; });
        if (registered) cursor.found++;
      }
    } catch (e) {
      console.warn(`supplier back-fill skipped ${t.id}: ${(e as Error).message}`);
    } finally {
      cursor.scanned++;
      cursor.afterCreatedAt = t.created_at;
      cursor.afterId = t.id;
    }
  }
  cursor.done = threads.length < BATCH || cursor.scanned >= CAP;
  await store.putSearchCache(SUPPLIER_BACKFILL_KEY, JSON.stringify(cursor), CURSOR_TTL_DAYS);
  return cursor;
}
