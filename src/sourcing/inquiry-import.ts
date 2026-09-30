import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import type { CjClient, CjDetail } from '../cj';
import { bestLocalQty, inquiryWarehouses, localWarehousesFor } from '../local-markets';
import { getDetailPreferWarehouse } from '../proxy/import';
import { laneRouteFor } from './lane-route';

export interface InquiryImportDeps {
  store: TenantStore;
  cj: CjClient;
  cfg: TenantConfig;
  /** confirmAndImport with the route's curate/pickHero/competitorCheck and the given warehouses. */
  runImport: (detail: CjDetail, localWarehouses: string[]) => Promise<unknown>;
  waitUntil: (p: Promise<unknown>) => void;
}

/** An 'importing' row older than this was cut off (the runtime ends waitUntil
 *  work after the response) or died without reaching .catch, so it may be
 *  retried; a live import writes 'imported' or 'failed' well inside it. */
export const STALE_IMPORTING_MS = 10 * 60_000;

export function isStaleImporting(link: { state: string; updated_at: string } | null | undefined, now: number = Date.now()): boolean {
  if (link?.state !== 'importing') return false;
  const at = Date.parse(link.updated_at);
  return !Number.isFinite(at) || now - at > STALE_IMPORTING_MS;
}

export type InquiryImportResult =
  | { ok: true; state: 'importing' | 'imported' | 'draft'; handle: string | null }
  | { ok: false; error: 'unknown_product' | 'not_deliverable' | 'no_stock' | 'stock_unknown' };

/**
 * Owner-triggered import of a supplier item for a customer's inquiry (owner
 * rule 2026-09-30). Local stock uses the lane alone; an item only the China
 * hub stocks may use the lane plus CN, and only when a fresh route reaches
 * the buyer. confirmAndImport runs in the background with every gate intact.
 */
export async function startInquiryImport(deps: InquiryImportDeps, pid: string, dest: string): Promise<InquiryImportResult> {
  const { store, cj, cfg } = deps;
  const link = await store.getLink(pid);
  if (link?.state === 'imported') return { ok: true, state: 'imported', handle: link.handle };
  // Already created as a Shopify draft for the owner's profit review: importing
  // again would re-run every gate against a product that exists.
  if (link?.state === 'draft') return { ok: true, state: 'draft', handle: link.handle };
  if (link?.state === 'importing' && !isStaleImporting(link)) return { ok: true, state: 'importing', handle: null };

  const detail = await getDetailPreferWarehouse(store, cj, pid);
  if (!detail) return { ok: false, error: 'unknown_product' };
  // Live stock by warehouse, always: the detail may be a 30-day-old cache, and
  // confirmAndImport skips its own origins lookup when origins are supplied.
  let origins: Record<string, number>;
  try { origins = await cj.originsByPid(pid); } catch { return { ok: false, error: 'stock_unknown' }; }
  // The truthful refusal first: no lane at all, then too little stock anywhere
  // this buyer may be served from, then no route from the warehouse that has it.
  if (!inquiryWarehouses(dest).length) return { ok: false, error: 'not_deliverable' };
  if (bestLocalQty(origins, inquiryWarehouses(dest)) < cfg.floors.stockFloor) return { ok: false, error: 'no_stock' };
  const route = await laneRouteFor(store, cfg, origins, dest);
  if (!route) return { ok: false, error: 'not_deliverable' };
  const warehouses = route.overseas ? inquiryWarehouses(dest) : localWarehousesFor(dest);
  if (bestLocalQty(origins, warehouses) < cfg.floors.stockFloor) return { ok: false, error: 'no_stock' };

  await store.putLink({ cjPid: pid, state: 'importing' });
  deps.waitUntil(
    deps.runImport({ ...detail, origins }, warehouses).catch(async (e) => {
      // A thrown import would otherwise leave the link 'importing' forever and
      // block every retry; the gates' own refusals already write 'failed'.
      await store.putLink({ cjPid: pid, state: 'failed', failReason: 'import-error', failDetail: String((e as Error).message).slice(0, 200) });
    })
  );
  return { ok: true, state: 'importing', handle: null };
}

/**
 * The thread's held offer was drafted before the item existed, so it carries
 * no product link. Once the import lands, a pending draft held for
 * 'sourcing_offer' and written before the import finished is regenerated: the
 * product agent then finds the imported item and links its page. A draft
 * written after the import, or held for anything else, is left alone.
 */
export async function refreshSourcingDraft(
  store: TenantStore,
  threadId: string,
  pid: string,
  /** True when a replacement draft was written (regenerateDraft keeps the old one on failure). */
  regenerate: (draftId: string) => Promise<boolean>
): Promise<boolean> {
  const link = await store.getLink(pid);
  if (link?.state !== 'imported') return false;
  const draft = await store.getPendingDraft(threadId);
  if (!draft) return false;
  let holds: unknown = [];
  try { holds = JSON.parse(draft.hold_reasons ?? '[]'); } catch { /* unreadable holds: not ours */ }
  if (!Array.isArray(holds) || !holds.includes('sourcing_offer')) return false;
  if (!(Date.parse(draft.created_at) < Date.parse(link.updated_at))) return false;
  return regenerate(draft.id);
}

/** The console's poll: where the import stands, and why it failed if it did. */
export async function inquiryImportStatus(store: TenantStore, pid: string): Promise<{ ok: true; state: string; handle: string | null; failReason: string | null; failDetail: string | null }> {
  const link = await store.getLink(pid);
  return {
    ok: true,
    state: isStaleImporting(link) ? 'stalled' : (link?.state ?? 'unknown'),
    handle: link?.state === 'imported' ? link.handle : null,
    failReason: link?.fail_reason ?? null,
    failDetail: link?.fail_detail ?? null,
  };
}
